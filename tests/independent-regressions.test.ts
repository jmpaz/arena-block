import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient, ArenaPublisher, ArenaRequestError } from "../src/arena.ts";
import { renderPlan } from "../src/render.ts";
import { composePlan } from "../src/compose.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { ArenaBlockClient, PublicationError } from "../src/client.ts";
import { publicationWithProgress } from "../src/publication-progress.ts";
import { createCanvas } from "@napi-rs/canvas";

const directories: string[] = [];
const stores: ArenaBlockStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(directories.splice(0).map(path => rm(path, {recursive:true, force:true}))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve=r); return {promise, resolve}; }
function plan() { return composePlan([{provider:"x", id:"review", canonicalUrl:"https://x.com/review/status/1", author:{handle:"review"}, text:"Approved review fixture", media:[]}]); }
class Remote extends ArenaClient {
  creates = 0; updates = 0; connectCalls: string[][] = []; memberships = ["base"]; state="available";
  private identities = new Map([["base", 100]]);
  private channelId(slug:string) { if (!this.identities.has(slug)) this.identities.set(slug,100+this.identities.size); return this.identities.get(slug)!; }
  constructor() { super("fixture", "https://arena.invalid"); }
  override async channelIds(destinations:string[]) { return [...new Set(destinations.map(slug=>this.channelId(slug)))]; }
  override async createBlock(payload:Record<string,unknown>) {
    const targets = (payload.channel_ids ?? (payload.channels as Array<{id:number}>|undefined)?.map(channel=>channel.id)) as number[];
    this.memberships = [...new Set([...this.memberships,...[...this.identities].filter(([,id])=>targets.includes(id)).map(([slug])=>slug)])];
    return {id:1000 + ++this.creates};
  }
  override async block(id:number) { return {id, state:this.state, type:"Text", title:"Post by @review", content:{markdown:"Approved review fixture"}}; }
  override async updateBlock(id:number, _payload:Record<string,unknown>) { this.updates++; return this.block(id); }
  override async connections(_id:number) { return this.memberships.map(slug=>({slug,channelId:this.channelId(slug)})); }
  override async connect(_id:number, destinations:string[]) { this.connectCalls.push([...destinations]); this.memberships=[...new Set([...this.memberships,...destinations])]; return [1]; }
  override async connectionId(_id:number, slug:string) { return this.memberships.indexOf(slug)+1 || undefined; }
}
async function setup(client=new Remote()) {
 const dir=await mkdtemp(join(tmpdir(),"arena-independent-review-")); directories.push(dir);
 const store=new ArenaBlockStore(join(dir,"state.sqlite")); stores.push(store);
 const config={publicBaseUrl:"https://blocks.invalid",mediaDirectory:join(dir,"media"),pollIntervalMs:1,verifyTimeoutMs:50};
 return {client,dir,store,config,publisher:new ArenaPublisher(client,store,config)};
}
const request=()=>({plan:plan(),destinations:["base"],force:false});
test("a slow second instance rechecks the receipt after preparation and creates once", async () => {
 const {client,dir,store,config}=await setup(); const secondEntered=deferred(), firstDone=deferred();
 const one=new ArenaPublisher(client,store,{...config, render:async()=>{await secondEntered.promise; return undefined;}});
 const secondStore=new ArenaBlockStore(join(dir,"state.sqlite")); stores.push(secondStore);
 const two=new ArenaPublisher(client,secondStore,{...config,render:async()=>{secondEntered.resolve(); await firstDone.promise; return undefined;}});
 const first=one.publish(request()); const second=two.publish(request());
 const a=await first; firstDone.resolve(); const b=await second;
 expect(client.creates).toBe(1); expect(a.blockId).toBe(b.blockId); expect(a.id).toBe(b.id);
 console.log("duplicate-create",JSON.stringify({creates:client.creates,blockIds:[a.blockId,b.blockId]}));
});
test("a later placement preserves unfinished intent and resume recovers it without duplicating connections", async()=>{
 const {client,publisher,store}=await setup(); const base=await publisher.publish(request());
 const connect=client.connect.bind(client); let partial=true;
 client.connect=async (id,targets)=> { if(partial){partial=false; await connect(id,targets.slice(0,1)); throw new TypeError("Response lost after first connection");} return connect(id,targets); };
 await expect(publisher.publish({...request(),destinations:["a","b"]})).rejects.toThrow("Response lost");
 expect(store.receipt(base.id)?.pendingDestinations).toEqual(["a","b"]);
 await publisher.publish({...request(),destinations:["c"]});
 const current=store.receipt(base.id)!;
 expect(current.pendingDestinations).toBeUndefined(); expect(current.destinations).toEqual(["base","a","b","c"]);
 expect(client.memberships).toEqual(["base","a","b","c"]);
 const resumed=await publisher.resume(base.id,[...current.destinations,...(current.pendingDestinations??[])]);
 expect(client.memberships).toContain("b"); expect(resumed.pendingDestinations).toBeUndefined();
 expect(client.connectCalls).toEqual([["a"],["b"],["c"]]); expect(client.creates).toBe(1);
 console.log("lost-placement-intent",JSON.stringify({receipt:current,remote:client.memberships,resumed:resumed.destinations}));
});
test("an authoritative auth rejection releases its reservation while retaining an audit record", async()=>{
 const {client,publisher,store}=await setup();
 client.createBlock=async()=>{client.creates++; throw new ArenaRequestError("Are.na POST /blocks returned 401: invalid fixture credential",401);};
 const rejection=await publisher.publish(request()).catch(error=>error);
 expect(rejection.attempt.status).toBe("rejected");
 expect(store.creationAttempt(rejection.attempt.id)?.status).toBe("rejected");
 expect(store.unresolvedCreation(plan().hash)).toBeUndefined();
 client.createBlock=async()=>{client.creates++; return {id:2000};};
 await expect(publisher.publish({...request(),force:true})).resolves.toMatchObject({blockId:2000,status:"verified"});
 expect(client.creates).toBe(2); expect(store.unresolvedCreation(plan().hash)).toBeUndefined();
 console.log("auth-rejection-lockout",JSON.stringify(store.unresolvedCreation(plan().hash)));
});
test("concurrent service instances preserve both callers' confirmed placements", async()=>{
 const {client,publisher,store,dir,config}=await setup(); const base=await publisher.publish(request());
 const secondStore=new ArenaBlockStore(join(dir,"state.sqlite")); stores.push(secondStore);
 const two=new ArenaPublisher(client,secondStore,config);
 const connect=client.connect.bind(client), oneEntered=deferred(), twoDone=deferred();
 client.connect=async(id,targets)=>{if(targets.includes("a")){const accepted=await connect(id,targets);oneEntered.resolve();await twoDone.promise;return accepted;}return connect(id,targets);};
 const first=publisher.publish({...request(),destinations:["a"]}); await oneEntered.promise;
 const second=await two.publish({...request(),destinations:["b"]}); twoDone.resolve(); await first;
 expect(second.destinations).toContain("b"); expect(client.memberships).toEqual(["base","a","b"]);
 expect(store.receipt(base.id)?.destinations).toEqual(["base","a","b"]);
 expect(store.receipt(base.id)?.connectionIds).toEqual([1,2,3]);
 expect(store.receipt(base.id)?.pendingDestinations).toBeUndefined();
 console.log("stale-receipt-overwrite",JSON.stringify({receipt:store.receipt(base.id),remote:client.memberships}));
});
test("a stale membership snapshot refreshes after a concurrent receipt revision",async()=>{
 const {client,publisher,store,dir,config}=await setup(); const base=await publisher.publish(request());
 const secondStore=new ArenaBlockStore(join(dir,"state.sqlite")); stores.push(secondStore);
 const two=new ArenaPublisher(client,secondStore,config), readPaused=deferred(), otherDone=deferred();
 const connections=client.connections.bind(client); let pause=true,afterAReads=0;
 // Pause the final CAS membership read, after the per-target placement readback.
 client.connections=async(id)=>{const snapshot=await connections(id);if(pause && client.memberships.includes("a") && ++afterAReads===2){pause=false;readPaused.resolve();await otherDone.promise;}return snapshot;};
 const confirm=store.confirmPlacements.bind(store);let rejectedStale=0;
 store.confirmPlacements=(...args)=>{const next=confirm(...args);if(!next)rejectedStale++;return next;};
 const first=publisher.publish({...request(),destinations:["a"]});await readPaused.promise;
 await two.publish({...request(),destinations:["b"]});otherDone.resolve();await first;
 expect(rejectedStale).toBe(1);expect(store.receipt(base.id)?.destinations).toEqual(["base","a","b"]);
 expect(client.connectCalls).toEqual([["a"],["b"]]);expect(store.receipt(base.id)?.pendingDestinations).toBeUndefined();
});
for(const status of [403,503])test(`create ${status} ${status===403?"releases a proved rejection":"retains an ambiguous reservation"}`,async()=>{
 const {client,publisher,store}=await setup();
 client.createBlock=async()=>{client.creates++;throw new ArenaRequestError("Fixture rejection",status);};
 const error=await publisher.publish(request()).catch(error=>error);
 expect(error.attempt.status).toBe(status===403?"rejected":"creation_unknown");
 expect(Boolean(store.unresolvedCreation(plan().hash))).toBe(status===503);
});
for(const mode of ["fetch","body"])test(`a bounded image ${mode} deadline releases the queue before creation`,async()=>{
 const {client,store,config}=await setup();
 const publisher=new ArenaPublisher(client,store,{...config,render:(plan,dir,options)=>renderPlan(plan,dir,{...options,downloadTimeoutMs:10})});
 const value=composePlan([{...plan().sources[0]!,media:[{ref:"1.1",kind:"image",url:"https://fixture.invalid/stalled.png",alt:"",width:20,height:20}]}]);
 const originalFetch=globalThis.fetch;let cancelled=false;
 globalThis.fetch=(async()=>mode==="fetch"?new Promise<Response>(()=>{}):new Response(new ReadableStream({cancel(){cancelled=true;}}))) as unknown as typeof fetch;
 try{
  const started=Date.now();await expect(publisher.publish({plan:value,destinations:["base"],force:false})).rejects.toThrow();
  expect(Date.now()-started).toBeLessThan(500);expect(client.creates).toBe(0);expect(store.unresolvedCreation(value.hash)).toBeUndefined();
  if(mode==="body")expect(cancelled).toBe(true);
 }finally{globalThis.fetch=originalFetch;}
});
test("caller cancellation interrupts a stalled image body and releases the plan queue",async()=>{
 const {client,publisher,store}=await setup(); const png=await createCanvas(20,20).encode("png");
 const value=composePlan([{...plan().sources[0]!,media:[{ref:"1.1",kind:"image",url:"https://fixture.invalid/slow.png",width:20,height:20,alt:""}]}]);
 const originalFetch=globalThis.fetch, downloaded=deferred(); let finishDownload!:()=>void, mediaSignal:AbortSignal|undefined;
 globalThis.fetch=(async(_input,init)=>{mediaSignal=init?.signal??undefined;return new Response(new ReadableStream({start(controller){finishDownload=()=>{controller.enqueue(png);controller.close();};downloaded.resolve();}}));}) as typeof fetch;
 const abort=new AbortController(); let settled=false;
 try {
   const pending=publisher.publish({plan:value,destinations:["base"],force:false},abort.signal).finally(()=>{settled=true;});
   const error=pending.catch(error=>error);
   await downloaded.promise; abort.abort(new Error("User cancelled media"));
   await new Promise(r=>setTimeout(r,20));
   expect(mediaSignal?.aborted).toBe(true); expect(settled).toBe(true); expect(client.creates).toBe(0);
   expect(store.unresolvedCreation(value.hash)).toBeUndefined();
   expect((await error).message).toBe("User cancelled media");
   globalThis.fetch=(async()=>new Response(new Uint8Array(png))) as unknown as typeof fetch;
   client.block=async(id)=>({id,state:"available",type:"Link",title:value.block.title,content:{markdown:value.block.markdown},description:{markdown:value.block.markdown},source:{url:value.block.canonicalSource},image:{src:"https://fixture.invalid/copied.jpg"}});
   await expect(publisher.publish({plan:value,destinations:["base"],force:false})).resolves.toMatchObject({status:"verified"});
   console.log("image-cancellation",JSON.stringify({mediaSignal:true,settledBeforeBodyFinished:true,createsAfterRecovery:client.creates}));
 }finally{globalThis.fetch=originalFetch;}
});
test("receipt-specific resume cancellation reports the selected receipt even with a later force receipt",async()=>{
 const value=plan(), now=new Date().toISOString();
 const wrong={id:"later-receipt",planHash:value.hash,blockId:1002,blockUrl:"https://www.are.na/block/1002",destinations:["b"],connectionIds:[1],status:"verified" as const,createdAt:now,updatedAt:now};
 const daemon=new ArenaBlockClient("https://fixture.invalid","fixture");
 daemon.publicationState=async()=>({receipt:wrong});
 const selected={...wrong,id:"older-receipt",blockId:1001,blockUrl:"https://www.are.na/block/1001",destinations:["a"]};
 daemon.receipt=async(id)=>{expect(id).toBe(selected.id);return selected;};
 let requestedReceipt="";
 daemon.resume=async(id,_destinations,signal)=>{requestedReceipt=id; return new Promise((_,reject)=>{signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true});});};
 const pending=publicationWithProgress(daemon,value,["a"],signal=>daemon.resume("older-receipt",["a"],signal),"older-receipt");
 process.emit("SIGINT");
 const error=await pending.catch(error=>error);
 expect(error).toBeInstanceOf(PublicationError); expect(error.receipt.id).toBe("older-receipt");
 expect(requestedReceipt).toBe("older-receipt");
 console.log("wrong-cancellation-receipt",JSON.stringify({requestedReceipt,returnedReceipt:error.receipt.id}));
});
test("HTTP: independent publishers create once across a delayed destination read",async()=>{
 const {dir,store,config}=await setup();const secondStore=new ArenaBlockStore(join(dir,"state.sqlite"));stores.push(secondStore);
 const bothEntered=deferred(), firstDone=deferred();let channels=0,creates=0; const ledger:Array<{method:string,path:string}>=[];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  const url=new URL(request.url),path=url.pathname;ledger.push({method:request.method,path});
  if(path==="/channels/base"){const ordinal=++channels;if(ordinal===1)await bothEntered.promise;else if(ordinal===2){bothEntered.resolve();await firstDone.promise;}return Response.json({data:{id:100}});}
  if(path==="/blocks"&&request.method==="POST")return Response.json({data:{id:1000 + ++creates}});
  const match=path.match(/^\/blocks\/(\d+)$/);
  if(match)return Response.json({data:{id:Number(match[1]),state:"available",type:"Text",title:"Post by @review",content:{markdown:"Approved review fixture"}}});
  if(path.endsWith("/connections"))return Response.json({data:[{id:100,slug:"base"}]});
  if(path==="/channels/base/contents")return Response.json({data:[{id:1001,connection:{id:1}},{id:1002,connection:{id:2}}]});
  return Response.json({error:"Unexpected fixture path"},{status:404});
 }});
 try{
  const one=new ArenaPublisher(new ArenaClient("fixture",String(server.url).replace(/\/$/,"")),store,config);
  const two=new ArenaPublisher(new ArenaClient("fixture",String(server.url).replace(/\/$/,"")),secondStore,config);
  const first=one.publish(request()),second=two.publish(request());
  const a=await first;firstDone.resolve();const b=await second;
  expect(creates).toBe(1);expect(a.blockId).toBe(b.blockId);expect(a.id).toBe(b.id);
  console.log("http-duplicate-create",JSON.stringify({creates,blockIds:[a.blockId,b.blockId],ledger}));
 }finally{firstDone.resolve();bothEntered.resolve();server.stop(true);}
});
test("CONTROL: verified-block resume preserves later content edits and never creates",async()=>{
 const {client,publisher}=await setup(); const receipt=await publisher.publish(request());
 client.block=async()=>{throw new Error("Should not read or rewrite verified content");}; const updates=client.updates;
 const resumed=await publisher.resume(receipt.id,["base","later"]);
 expect(resumed.destinations).toEqual(["base","later"]); expect(client.creates).toBe(1); expect(client.updates).toBe(updates);
});
