import {expect,test} from "bun:test";
import {createDocument} from "@mixmark-io/domino";
import {readSubstackPage} from "../packages/core/substack-page.ts";
import {normalizeSubstackCapture} from "../packages/core/substack-record.ts";
import {SubstackProvider} from "../packages/core/providers/substack.ts";
import {parseSource} from "../packages/core/url.ts";
import {assignMediaRefs} from "../packages/core/providers/provider.ts";
import {composePlan} from "../packages/core/compose.ts";
import {blockPlanSchema,planInputSchema} from "../packages/core/types.ts";
import {requiredPlanCapabilities} from "../src/plan-capabilities.ts";

async function fixture(name:string){return {html:await Bun.file(new URL(`./fixtures/substack-${name}-note-public.html`,import.meta.url)).text(),json:await Bun.file(new URL(`./fixtures/substack-${name}-note-public.json`,import.meta.url)).json()};}
async function capture(name:string,mutate?:(value:any)=>void){
 const {html,json}=await fixture(name);mutate?.(json);const c=json.item.comment,url=`https://substack.com/@${c.handle}/note/c-${c.id}`;
 const fetcher=(async (request:RequestInfo|URL,init?:RequestInit)=>{expect(init?.credentials).toBe("omit");if(String(request).includes("/api/")){expect(init?.redirect).toBe("error");return Response.json(json);}return new Response(html,{headers:{"content-type":"text/html"}});}) as unknown as typeof fetch;
 const record=normalizeSubstackCapture(await readSubstackPage(url,{url,fetcher,parseHTML:createDocument,method:"public-html"}));
 const post=assignMediaRefs(await new SubstackProvider([record]).resolve(parseSource(url)),0);return {record,post};
}
test("native video Note requires full attachment evidence rather than promoting its SSR poster",async()=>{
 const {record,post}=await capture("video");expect(record.note.body.html).toContain("Rob Stephenson");expect(record.note.attachmentEvidence?.bodyText).toStartWith("@Rob Stephenson");
 expect(post.media).toHaveLength(1);expect(post.media[0]).toMatchObject({kind:"video",durationSeconds:69.69463,acquisition:"substack-public-original"});
 expect(post.media[0]!.url).toBe("https://substack.com/api/v1/video/upload/9681d26c-5e44-4f6e-bd53-679694ab6da6/src?type=mp4");expect(post.media[0]!.posterUrl).toContain("/user/81309935/");
 expect(record.note.links).toEqual([]);const plan=composePlan([post]);expect(plan.block.kind).toBe("video");expect(blockPlanSchema.parse(plan)).toEqual(plan);expect(requiredPlanCapabilities(plan)).toContain("substack-note-attachments-v1");
});
test("article card preserves Note prose and independent card author/preview without fetching the article",async()=>{
 const {record,post}=await capture("article-card");expect(record.note.attachmentEvidence!.attachments[0]!.kind).toBe("article");expect(post.article).toBeUndefined();expect(post.media).toEqual([]);
 expect(post.author.handle).toBe("substack");expect(post.text).toContain("[Welcome to Always On");expect(post.text).toContain("Marina Hyde");expect(post.text).toContain("https://www.marinahyde.com/p/welcome-to-always-on");
 expect(post.text).toContain("Powered by Goalhanger");expect(blockPlanSchema.parse(composePlan([post])).sources[0]!.substackCapture).toEqual(record);
});
test("changed Note, attachment, upload, body or author identity refuses complete video capture",async()=>{
 for(const change of [(j:any)=>j.item.comment.user_id=1,(j:any)=>j.item.comment.attachments[0].comment_id=1,(j:any)=>j.item.comment.attachments[0].mediaUpload.user_id=1,(j:any)=>j.item.comment.attachments[0].mediaUpload.id=crypto.randomUUID(),(j:any)=>j.item.comment.attachments[0].mediaUpload.is_free_preview=true,(j:any)=>j.item.comment.body="Changed body",(j:any)=>j.item.comment.attachments=[],(j:any)=>j.item.comment.attachments.push({...j.item.comment.attachments[0]})])await expect(capture("video",change)).rejects.toThrow();
});
test("article preview cannot conceal changed source or unsupported clip/image selection",async()=>{
 for(const change of [(j:any)=>j.item.comment.attachments[0].post.canonical_url="https://other.com/p/wrong",(j:any)=>j.item.comment.attachments[0].post.title="Changed title",(j:any)=>j.item.comment.attachments[0].publication.id=1,(j:any)=>j.item.comment.attachments[0].clipInfo={id:1},(j:any)=>j.item.comment.attachments[0].type="unknown"])await expect(capture("article-card",change)).rejects.toThrow();
});
test("selected article passage keeps its own author and range without becoming full article prose",async()=>{
 const {record,post}=await capture("selected-article"),a=record.note.attachmentEvidence!.attachments[0]!;
 expect(a.kind).toBe("article");if(a.kind!=="article")throw Error("Wrong fixture");expect(a.selection!.startParagraph).toBe(32);expect(a.selection!.endParagraph).toBe(33);
 expect(post.author.handle).toBe("oatmilkallison");expect(post.text).toContain("Excerpt from [");expect(post.text).toContain("by SOFSET");expect(post.text).toContain("offshore holding company");expect(post.article).toBeUndefined();
 await expect(capture("selected-article",j=>j.item.comment.attachments[0].postSelection.post_id=1)).rejects.toThrow();
 const outer=await capture("video");outer.record.note.quote={url:record.note.url,expanded:record.note};
 const nested=await new SubstackProvider([outer.record]).resolve(parseSource(outer.record.sourceUrl));
 expect(requiredPlanCapabilities(composePlan([assignMediaRefs(nested,0)],{media:"none"}))).toContain("substack-note-attachments-v1");
});
test("automatically chosen preview cannot be labelled an intentional selected passage",async()=>{
 const {post,record}=await capture("selected-article",j=>j.item.comment.attachments[0].postSelection.is_auto_selection=true);
 expect(post.text).toContain("Preview of [");expect(post.text).not.toContain("Excerpt from [");
 const a=record.note.attachmentEvidence!.attachments[0]!;expect(a.kind==="article"&&a.selection!.isAutoSelection).toBe(true);
 await expect(capture("selected-article",j=>delete j.item.comment.attachments[0].postSelection.is_auto_selection)).rejects.toThrow();
});
test("older receiver cannot receive publication of Note attachment provenance",async()=>{
 const {ArenaBlockClient}=await import("../src/client.ts"),{post}=await capture("video"),paths:string[]=[];
 const fetcher=(async(input:RequestInfo|URL)=>{const path=new URL(String(input)).pathname;paths.push(path);return Response.json({version:"0.1.0",revision:"older",sourceId:"test",platform:"test",schemaVersion:1,packagePath:null,planCapabilities:["substack-browser-records-v1","substack-native-media-v1"]});})as typeof fetch;
 const client=new ArenaBlockClient("https://receiver.invalid","test-token",fetcher);
 await expect(client.publish(composePlan([post],{media:"none"}),["4622814"])).rejects.toThrow("No save was submitted");expect(paths).toEqual(["/v1/version"]);
});
test("normal Note helper resolution preflights acquisition before any source read and guards stripped results",async()=>{
 const {resolveWithNative}=await import("../extension/src/native-reddit.ts"),{requireSubstackPublicResult}=await import("../packages/core/substack-input-capabilities.ts");
 const {post}=await capture("video"),input={refs:[post.canonicalUrl],extraRefs:[],refresh:false,policy:{media:"none" as const}},calls:string[]=[];
 await expect(resolveWithNative(input,async action=>{calls.push(action);return {planCapabilities:["substack-browser-records-v1","substack-public-sources-v2","substack-native-media-v1"]};})).rejects.toThrow("Update the local helper and receiver to read this source.");expect(calls).toEqual(["ping"]);
 const plan=composePlan([post],{media:"none"});expect(await resolveWithNative(input,async action=>action==="ping"?{planCapabilities:["substack-note-attachments-v1","quoted-image-media-v1","quoted-video-audio-v1"]}:plan)).toEqual(plan);
 const stripped=structuredClone(plan);delete stripped.sources[0]!.substackCapture!.note.attachmentEvidence;
 expect(()=>requireSubstackPublicResult(input,stripped)).toThrow("incomplete capture");
});
test("native host stops an ordinary Note URL at a version read against an older daemon",async()=>{
 const {handle}=await import("../extension/native-host.ts"),{post}=await capture("video"),oldToken=process.env.ARENA_BLOCK_ACCESS_TOKEN,oldEndpoint=process.env.ARENA_BLOCK_ENDPOINT,paths:string[]=[];
 process.env.ARENA_BLOCK_ACCESS_TOKEN="test-token";process.env.ARENA_BLOCK_ENDPOINT="http://127.0.0.1:8790";
 const fetcher=(async(input:RequestInfo|URL)=>{paths.push(new URL(String(input)).pathname);return Response.json({version:"0.1.0",revision:null,sourceId:"test",platform:"test",schemaVersion:1,packagePath:null,planCapabilities:["substack-browser-records-v1","substack-public-sources-v2"]});})as typeof fetch;
 try {await expect(handle({id:"test",action:"resolve",input:planInputSchema.parse({refs:[post.canonicalUrl]})},fetcher)).rejects.toThrow("Update the local helper and receiver to read this source.");expect(paths).toEqual(["/v1/version"]);}
 finally {if(oldToken===undefined)delete process.env.ARENA_BLOCK_ACCESS_TOKEN;else process.env.ARENA_BLOCK_ACCESS_TOKEN=oldToken;if(oldEndpoint===undefined)delete process.env.ARENA_BLOCK_ENDPOINT;else process.env.ARENA_BLOCK_ENDPOINT=oldEndpoint;}
});
test("captured thread seed still requires the current descendant Note reader",async()=>{
 const {requiredSubstackResolutionCapabilities}=await import("../packages/core/substack-input-capabilities.ts"),{resolveWithNative}=await import("../extension/src/native-reddit.ts");
 const record=await Bun.file(new URL("./fixtures/substack-browser-capture.json",import.meta.url)).json();
 const input={refs:[record.sourceUrl],extraRefs:[],refresh:false,substackCaptures:[record],policy:{threadExpansion:"on" as const}},calls:string[]=[];
 expect(requiredSubstackResolutionCapabilities(input)).toContain("substack-note-attachments-v1");
 await expect(resolveWithNative(input,async action=>{calls.push(action);return {planCapabilities:["substack-browser-records-v1","substack-public-sources-v2"]};})).rejects.toThrow("Update the local helper and receiver to read this source.");expect(calls).toEqual(["ping"]);
});
test("thread capability and evidence guards share resolver deduplication and legacy primary roles",async()=>{
 const {requiredSubstackResolutionCapabilities,needsSubstackPublicV2,requireSubstackPublicResult}=await import("../packages/core/substack-input-capabilities.ts");
 const capture=await Bun.file(new URL("./fixtures/substack-browser-capture.json",import.meta.url)).json();
 const inputs=[{refs:[capture.sourceUrl,"https://substack.com/note/c-360829302"],policy:{threadExpansion:"on" as const}},
 {refs:[capture.sourceUrl,"https://x.com/writer/status/1"],policy:{threadExpansion:"on" as const,mediaOnlyPosts:[2]}}];
 for(const input of inputs){const full={...input,substackCaptures:[capture]};expect(needsSubstackPublicV2(full)).toBe(true);expect(requiredSubstackResolutionCapabilities(full)).toContain("substack-note-attachments-v1");
 const post=assignMediaRefs(await new SubstackProvider([capture]).resolve(parseSource(capture.sourceUrl)),0);const plan=composePlan([post],{media:"none"});expect(()=>requireSubstackPublicResult(full,plan)).toThrow("incomplete capture");}
});
