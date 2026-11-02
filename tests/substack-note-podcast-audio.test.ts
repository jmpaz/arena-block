import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { SubstackProvider } from "../packages/core/providers/substack.ts";
import { parseSource } from "../packages/core/url.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { composePlan } from "../packages/core/compose.ts";
import { blockPlanSchema, type ResolvedPost } from "../packages/core/types.ts";
import { readSubstackPage } from "../packages/core/substack-page.ts";
import { normalizeSubstackCapture, requireRetainedSubstackCaptures } from "../packages/core/substack-record.ts";
import { requiredSubstackResolutionCapabilities } from "../packages/core/substack-input-capabilities.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";

const url="https://substack.com/@evadmartain/note/c-311363713";
const articleURL="https://on.substack.com/p/transcription";
async function fixtures(){
  const read=(name:string)=>Bun.file(new URL(`./fixtures/${name}.json`,import.meta.url)).json();
  return {html:await Bun.file(new URL("./fixtures/substack-podcast-note-public.html",import.meta.url)).text(),
    note:await read("substack-podcast-note-public"),article:await read("substack-note-podcast-article-public"),inline:await read("substack-note-podcast-inline-public")};
}
async function resolve(mutate?:(data:Awaited<ReturnType<typeof fixtures>>)=>void){
  const data=await fixtures();mutate?.(data);const paths:string[]=[];
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const address=String(input);paths.push(address);expect(init?.credentials).toBe("omit");
    if(address===url)return new Response(data.html,{headers:{"content-type":"text/html"}});
    expect(init?.redirect).toBe("error");
    if(address==="https://substack.com/api/v1/reader/comment/311363713")return Response.json(data.note);
    if(address==="https://on.substack.com/api/v1/posts/transcription")return Response.json(data.article);
    if(address==="https://on.substack.com/api/v1/video/upload/ab191d8b-b513-4b5e-be9a-cf0a26445db5")return Response.json(data.inline);
    throw Error(`Unexpected request ${address}`);
  })as typeof fetch;
  const captured=normalizeSubstackCapture(await readSubstackPage(url,{url,fetcher,parseHTML:createDocument,method:"public-html"}));
  const post=assignMediaRefs(await new SubstackProvider([captured],fetcher).resolve(parseSource(url)),0);
  return{captured,post,paths,plan:blockPlanSchema.parse(composePlan([post]))};
}

test("actual Note podcast player acquires article audio with independent byline and complete article evidence",async()=>{
  const {post,plan,captured,paths}=await resolve();
  expect(post.author).toMatchObject({handle:"evadmartain"});expect(post.article).toBeUndefined();
  expect(post.text).toStartWith("AUDIO GRAM");expect(post.text).toContain("Preview of [Introducing new audio transcription tools");
  expect(post.text).not.toContain("We’ve just shipped some new features");
  expect(plan.block.kind).toBe("audio");expect(plan.block.selectedMedia).toEqual(["1.1"]);expect(plan.block.canonicalSource).toBe(url);
  expect(post.media[0]).toMatchObject({kind:"audio",durationSeconds:241.42368,sourceAttribution:{kind:"substack-podcast",url:articleURL,authors:["Hamish McKenzie"]}});
  expect(plan.block.markdown).toContain("Audio from [Introducing new audio transcription tools");
  expect(plan.block.markdown).toContain("by Hamish McKenzie");expect(plan.block.title).toBe("Note by @evadmartain");
  expect(requiredPlanCapabilities(plan)).toContain("substack-note-podcast-audio-v1");
  expect(()=>requireRetainedSubstackCaptures(plan,[captured])).not.toThrow();
  expect(paths).toHaveLength(4);
  const a=post.substackCapture!.note.attachmentEvidence!.attachments[0]!;
  expect(a.kind==="article"&&a.podcast?.article?.id).toBe(136544895);
  expect(a.kind==="article"&&a.podcast?.article?.bodyEvidence.status).toBe("complete");
  expect(a.kind==="article"&&a.podcast?.article&&"bodyHtml" in a.podcast.article).toBe(false);
  const {SubstackProvider:Provider}=await import("../packages/core/providers/substack.ts");
  const replay=assignMediaRefs(await new Provider([post.substackCapture!],(async()=>{throw Error("Frozen plan must not reread sources");})as unknown as typeof fetch).resolve(parseSource(url)),0);
  expect(composePlan([replay])).toEqual(plan);
});

test("mismatched card, audio, author, full body or preview evidence fails before audio rendering",async()=>{
  const mutations:Array<(d:Awaited<ReturnType<typeof fixtures>>)=>void>=[
    d=>d.note.item.comment.attachments[0].post.podcastUpload.post_id=1,
    d=>d.note.item.comment.attachments[0].post.podcastUpload.is_free_preview=true,
    d=>d.note.item.comment.attachments[0].post.podcast_url="https://audio.example/other.mp3",
    d=>d.article.audience="only_paid",
    d=>d.article.body_html=null,
    d=>d.article.id=1,
    d=>d.article.publishedBylines[0].id=1,
    d=>d.article.podcastUpload.duration+=10,
    d=>d.article.podcastUpload.id=crypto.randomUUID(),
  ];
  for(const mutate of mutations)await expect(resolve(mutate)).rejects.toThrow();
  const {plan,captured}=await resolve();
  const selected=structuredClone(captured);const card=selected.note.attachmentEvidence!.attachments[0]!;
  if(card.kind!=="article")throw Error("Wrong fixture");
  card.selection={id:crypto.randomUUID(),postId:card.postId,startParagraph:0,endParagraph:0,startOffset:0,endOffset:4,text:"A passage",isAutoSelection:false};
  expect(()=>normalizeSubstackCapture(selected)).toThrow("selected article excerpt");
  for(const mutate of [(p:any)=>p.sources[0].media=[],(p:any)=>delete p.sources[0].media[0].sourceAttribution,(p:any)=>p.sources[0].media[0].sourceAttribution.authors=["Wrong author"],(p:any)=>delete p.sources[0].substackCapture.note.attachmentEvidence.attachments[0].podcast.article]){
    const altered=structuredClone(plan);mutate(altered);expect(()=>blockPlanSchema.parse(altered)).toThrow();
  }
});

test("older queued card-only Note remains byte-for-byte equivalent and makes no article read",async()=>{
  const old=await Bun.file(new URL("./fixtures/substack-podcast-note-legacy-plan.json",import.meta.url)).json();
  expect(composePlan(old.sources,old.policy)).toEqual(old);
  const provider=new SubstackProvider([old.sources[0].substackCapture],(async()=>{throw Error("No new article read for a legacy capture");})as unknown as typeof fetch);
  const source=assignMediaRefs(await provider.resolve(parseSource(url)),0);
  expect(source.media).toEqual([]);expect(composePlan([source],old.policy).block).toEqual(old.block);
});

test("podcast audio follows its Note's quote depth and source order without becoming article prose",async()=>{
  const {post}=await resolve();
  const outer:ResolvedPost={provider:"x",id:"123",canonicalUrl:"https://x.com/outer/status/123",author:{handle:"outer"},text:"Outer writing",media:[],quote:post};
  const root=assignMediaRefs(outer,0),automatic=blockPlanSchema.parse(composePlan([root]));
  expect(automatic.block.kind).toBe("text");expect(automatic.block.selectedMedia).toEqual([]);
  expect(automatic.block.markdown).toContain("@evadmartain");expect(automatic.block.markdown).toContain("Hamish McKenzie");
  const plan=blockPlanSchema.parse(composePlan([root],{media:"audio"}));
  expect(plan.block.kind).toBe("audio");expect(plan.block.selectedMedia).toEqual(["1.1"]);
  expect(composePlan([root],{quoteDepth:0,media:"audio"}).block.selectedMedia).toEqual([]);
  expect(composePlan([root],{quoteDepth:1}).block.selectedMedia).toEqual([]);
  expect(composePlan([root],{quoteDepth:1,media:"audio"}).block.selectedMedia).toEqual(["1.1"]);
  expect(requiredPlanCapabilities(plan)).toContain("quoted-video-audio-v1");
});

test("new ordinary Note and retained podcast cards preflight the receiving capability without any save",async()=>{
  const {captured,plan}=await resolve();
  for(const input of [{refs:[url],policy:{quoteDepth:0 as const}},{refs:[url],substackCaptures:[captured]}])expect(requiredSubstackResolutionCapabilities(input)).toContain("substack-note-podcast-audio-v1");
  const {ArenaBlockClient}=await import("../src/client.ts");const requests:string[]=[];
  const client=new ArenaBlockClient("https://receiver.invalid","fixture",(async(input:RequestInfo|URL,init?:RequestInit)=>{
    requests.push(`${init?.method??"GET"} ${new URL(String(input)).pathname}`);
    return Response.json({version:"0.1.0",revision:null,sourceId:"old",platform:"test",schemaVersion:1,packagePath:null,planCapabilities:["quoted-video-audio-v1","substack-note-attachments-v1","substack-public-sources-v2","substack-native-media-v1","substack-browser-records-v1"]});
  })as typeof fetch);
  await expect(client.publish(plan,["901"])).rejects.toThrow("substack-note-podcast-audio-v1");expect(requests).toEqual(["GET /v1/version"]);
});

test("renderer reads the card's complete audio evidence, preserves bytes and refuses a stripped owner before downloading",async()=>{
  const {renderPlan}=await import("../src/render.ts");const {mkdtemp,rm}=await import("node:fs/promises");const {join}=await import("node:path");const {tmpdir}=await import("node:os");
  const {plan}=await resolve();const asset=plan.sources[0]!.media[0]!;
  const bytes=Buffer.alloc(44+Math.floor(asset.durationSeconds!*8000)*2);bytes.write("RIFF");bytes.writeUInt32LE(bytes.length-8,4);bytes.write("WAVEfmt ",8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write("data",36);bytes.writeUInt32LE(bytes.length-44,40);
  const dir=await mkdtemp(join(tmpdir(),"note-podcast-render-")),calls:string[]=[];
  const fetcher=(async(input:RequestInfo|URL)=>{calls.push(String(input));return new Response(Uint8Array.from(bytes));})as typeof fetch;
  try{
    const output=await renderPlan(plan,dir,{fetcher});expect(output!.extension).toBe("wav");expect(Buffer.from(await Bun.file(output!.path).arrayBuffer())).toEqual(bytes);expect(calls).toEqual([asset.url]);
    const stripped=structuredClone(plan);const a=stripped.sources[0]!.substackCapture!.note.attachmentEvidence!.attachments[0]!;if(a.kind!=="article")throw Error("Wrong fixture");delete a.podcast!.article;
    await expect(renderPlan(stripped,dir,{fetcher})).rejects.toThrow("consistent complete public source evidence");expect(calls).toHaveLength(1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("note podcast provenance survives source snapshots and receiving journals",async()=>{
  const {saveSnapshotSchema,prepareSaveIntent}=await import("../src/save-intent.ts");const {userConfigSchema}=await import("../src/config.ts");const {ArenaBlockStore}=await import("../src/store.ts");
  const {mkdtemp,rm}=await import("node:fs/promises");const {join}=await import("node:path");const {tmpdir}=await import("node:os");const {plan}=await resolve();
  const dir=await mkdtemp(join(tmpdir(),"note-podcast-receiver-")),store=new ArenaBlockStore(join(dir,"journal.sqlite"));
  try{const config=userConfigSchema.parse({remoteInbox:{channel:"901",mode:"always"},provenance:{remoteSnapshot:"full"}});const intent=prepareSaveIntent(plan,config,{origin:"cli",initiator:{kind:"human"},destinations:["901"],operation:"publish"});expect(saveSnapshotSchema.parse(JSON.parse(JSON.stringify(intent.snapshot))).plan).toEqual(plan);store.savePlan(plan);expect(store.plan(plan.hash)?.plan).toEqual(plan);}finally{store.close();await rm(dir,{recursive:true,force:true});}
});
