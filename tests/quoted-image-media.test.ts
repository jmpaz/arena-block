import {expect,test} from "bun:test";
import {composePlan} from "../packages/core/compose.ts";
import {assignMediaRefs} from "../packages/core/providers/provider.ts";
import {planMedia,mediaSources,requireAddressableQuoteImages} from "../packages/core/media-tree.ts";
import {captureRenderRecipe} from "../packages/core/render-recipe.ts";
import {blockPlanSchema,type ResolvedPost,type MediaAsset} from "../packages/core/types.ts";
import {requiredPlanCapabilities} from "../src/plan-capabilities.ts";
const image=(id:string,sourceRole:"original"|"preview"="original")=>({ref:"0.0",kind:"image"as const,url:`https://images.example/${id}.png`,width:800,height:600,alt:`Original ${id}`,sourceRole});
const post=(id:string,quote?:ResolvedPost,media:MediaAsset[]=[image(id)]):ResolvedPost=>({provider:"x",id,canonicalUrl:`https://x.com/author${id}/status/${id}`,author:{handle:`author${id}`},text:`Authored ${id}`,media,...(quote?{quote}:{})});
const tree=()=>assignMediaRefs(post("100",post("200",post("300"))),0);
const refs=(layout:any):string[]=>!layout?[]:layout.kind==="media"?[layout.ref]:layout.children.flatMap(refs);

test("new quoted images compose in source order with separate owners and exact render tiles",()=>{
 const root=tree(),plan=blockPlanSchema.parse(composePlan([root],{media:"all",quoteDepth:"full"}));
 expect(plan.block.selectedMedia).toEqual(["1.1","1.2","1.3"]);expect(refs(plan.block.layout)).toEqual(plan.block.selectedMedia);
 expect(mediaSources(plan.sources).map(n=>[n.source.author.handle,n.quoteDepth,n.media.map(a=>a.ref)])).toEqual([["author100",0,["1.1"]],["author200",1,["1.2"]],["author300",2,["1.3"]]]);
 expect(planMedia(plan).map(a=>[a.url,a.sourceRole])).toEqual([[image("100").url,"original"],[image("200").url,"original"],[image("300").url,"original"]]);
 const recipe=captureRenderRecipe(plan)!;expect(recipe.tiles.map(t=>t.ref)).toEqual(plan.block.selectedMedia);expect(new Set(recipe.tiles.map(t=>JSON.stringify(t.rect))).size).toBe(3);
 expect(plan.block.markdown).toContain("@author200");expect(plan.block.markdown).toContain("@author300");expect(requiredPlanCapabilities(plan)).toContain("quoted-image-media-v1");
});

test("quote depth suppresses quoted tiles without discarding explicit inclusion and order preferences",()=>{
 const root=tree(),policy={media:"selected"as const,selectedMedia:["1.1","1.2","1.3"],mediaOrder:["1.3","1.2","1.1"]};
 for(const [depth,want] of [[0,["1.1"]],[1,["1.2","1.1"]],[2,["1.3","1.2","1.1"]]]as const){
  const plan=composePlan([root],{...policy,quoteDepth:depth});expect(plan.block.selectedMedia).toEqual([...want]);expect(refs(plan.block.layout)).toEqual([...want]);expect(plan.policy.selectedMedia).toEqual(policy.selectedMedia);
 }
 expect(composePlan([root],{...policy,quote:"omit"}).block.selectedMedia).toEqual(["1.1"]);
 expect(()=>composePlan([root],{media:"selected",selectedMedia:["1.99"]})).toThrow("references do not exist");
 expect(()=>composePlan([root],{media:"selected",selectedMedia:["1.2","1.2"]})).toThrow();
 expect(()=>composePlan([root],{...policy,quoteDepth:0,mediaOrder:["1.3","1.3","1.1"]})).toThrow("exactly once");
});

test("multiple sources have unambiguous quote refs, previews stay previews, and existing video handling remains intact",()=>{
 const a=tree(),b=assignMediaRefs(post("400",post("500",undefined,[image("preview","preview"),image("500")])),1);
 const plan=composePlan([a,b],{media:"all",quoteDepth:1});expect(plan.block.selectedMedia).toEqual(["1.1","1.2","2.1","2.2"]);expect(planMedia(plan).some(a=>a.sourceRole==="preview")).toBe(false);
 const video={ref:"0.0",kind:"video"as const,url:"https://video.example/original.mp4",posterUrl:"https://images.example/poster.png",durationSeconds:700,alt:"Original video"};
 const mixed=assignMediaRefs(post("100",post("200"),[video]),0),framed=blockPlanSchema.parse(composePlan([mixed],{videoFrameThresholdSeconds:600}));
 expect(framed.block.selectedMedia).toEqual(["1.1"]);expect(framed.block.frameMedia).toEqual([{ref:"1.1",url:video.posterUrl}]);expect(captureRenderRecipe(framed)!.tiles.map(t=>t.kind)).toEqual(["image"]);
 const legacyVideo=assignMediaRefs(post("100",post("200",undefined,[video])),0);legacyVideo.quote!.media[0]!.ref="quote.1";expect(composePlan([legacyVideo]).block.selectedMedia).toEqual(["1.1"]);
});

test("actual .2 queued plan retains its hash and source fields while only explicit inclusion adds its quoted original",async()=>{
 const old=await Bun.file(new URL('./fixtures/substack-legacy-containing-note-plan.json',import.meta.url)).json();
 expect(composePlan(old.sources,old.policy)).toEqual(old);expect(requiredPlanCapabilities(old)).not.toContain("quoted-image-media-v1");
 const fresh=composePlan(old.sources.map(assignMediaRefs),old.policy);expect(fresh.block.selectedMedia).toEqual(["1.1"]);expect(fresh.block.markdown).toBe(old.block.markdown);expect(fresh.sources[0]!.quote!.author).toEqual(old.sources[0].quote.author);
 expect(composePlan(fresh.sources,{...old.policy,media:"all"}).block.selectedMedia).toEqual(["1.1","1.2"]);
 expect(()=>requireAddressableQuoteImages(old)).toThrow("matching receiver");expect(()=>requireAddressableQuoteImages(fresh)).not.toThrow();
 const stopped={...post("100")};stopped.quote=stopped;expect(()=>assignMediaRefs(stopped,0)).toThrow("repeats a source");
});

test("quoted selections, including hidden preferences, stop at an older receiver version read",async()=>{
 const {ArenaBlockClient}=await import("../src/client.ts");
 for(const quoteDepth of [0,2]){
  const plan=composePlan([tree()],{media:"selected",selectedMedia:["1.1","1.2"],quoteDepth}),paths:string[]=[];
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{paths.push(`${init?.method??"GET"} ${new URL(String(input)).pathname}`);return Response.json({version:"0.1.0",revision:"older",sourceId:"fixture",platform:"test",schemaVersion:1,packagePath:null,planCapabilities:[]});})as typeof fetch;
  await expect(new ArenaBlockClient("https://receiver.invalid","fixture",fetcher).publish(plan,["901"])).rejects.toThrow("quoted-image-media-v1");
  expect(paths).toEqual(["GET /v1/version"]);
 }
});

test("receiver journal retains exact quoted sources and a full save capsule before any publication",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {ArenaBlockStore}=await import("../src/store.ts"),{prepareSaveIntent}=await import("../src/save-intent.ts"),{saveSnapshotSchema}=await import("../src/provenance-schema.ts"),{userConfigSchema}=await import("../src/config.ts");
 const dir=await mkdtemp(join(tmpdir(),"quoted-media-journal-")),store=new ArenaBlockStore(join(dir,"state.sqlite"));
 try{
  const raw=await Bun.file(new URL('./fixtures/substack-legacy-containing-note-plan.json',import.meta.url)).json();
  const plan=blockPlanSchema.parse(composePlan(raw.sources.map(assignMediaRefs),raw.policy));store.savePlan(plan);expect(store.plan(plan.hash)?.plan).toEqual(plan);
  const config=userConfigSchema.parse({remoteInbox:{channel:"901",mode:"always"},provenance:{remoteSnapshot:"full"}});
  const intent=prepareSaveIntent(plan,config,{origin:"cli",initiator:{kind:"human"},destinations:["901"],operation:"publish"});
  const retained=saveSnapshotSchema.parse(JSON.parse(JSON.stringify(intent.snapshot)));
  expect(retained).toEqual(intent.snapshot);expect(JSON.stringify(retained)).toContain(plan.sources[0]!.quote!.media[0]!.url);
  expect(composePlan(plan.sources,plan.policy)).toEqual(plan);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test("CLI image rendering matches the native recipe when quoted originals have no reported dimensions",async()=>{
 const {createCanvas,loadImage}=await import("@napi-rs/canvas"),{renderPlan}=await import("../src/render.ts");
 const {mkdtemp,rm}=await import("node:fs/promises"),{join}=await import("node:path"),{tmpdir}=await import("node:os");
 const root=assignMediaRefs(post("100",post("200")),0);for(const node of mediaSources([root]))for(const asset of node.media){delete asset.width;delete asset.height;}
 const shapes=[[400,200,"red"],[200,200,"blue"]]as const;
 const bytes=await Promise.all(shapes.map(async([w,h,color])=>{const c=createCanvas(w,h);c.getContext("2d").fillStyle=color;c.getContext("2d").fillRect(0,0,w,h);return c.encode("png");}));
 const nodes=mediaSources([root]);nodes.forEach((node,index)=>node.media[0]!.url=`data:image/png;base64,${bytes[index]!.toString("base64")}`);
 const plan=composePlan([root],{media:"all"}),dir=await mkdtemp(join(tmpdir(),"quoted-render-"));
 try{
  const output=await renderPlan(plan,dir);
  const decoded=await loadImage(await Bun.file(output!.path).arrayBuffer());
  const recipe=captureRenderRecipe(plan,{"1.1":{width:400,height:200,duration:0,fps:0,audio:false},"1.2":{width:200,height:200,duration:0,fps:0,audio:false}})!;
  expect([decoded.width,decoded.height]).toEqual([recipe.width,recipe.height]);expect(recipe.tiles.map(t=>t.ref)).toEqual(["1.1","1.2"]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
