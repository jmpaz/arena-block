import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ArenaClient, ArenaPublisher, ArenaRequestError } from "../src/arena.ts";
import { ArenaBlockStore } from "../src/store.ts";
import { composePlan } from "../src/compose.ts";
import { renderPlan } from "../src/render.ts";
import { ArenaBlockClient, PublicationError } from "../src/client.ts";
import { publicationWithProgress } from "../src/publication-progress.ts";

const dirs:string[]=[], stores:ArenaBlockStore[]=[];
afterEach(async()=>{for(const store of stores.splice(0))store.close();await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
const defer=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{resolve,promise};};
const plan=()=>composePlan([{provider:"x",id:"recheck",canonicalUrl:"https://x.com/review/status/9",author:{handle:"review"},text:"Approved text",media:[]}]);
class Remote extends ArenaClient{
 creates=0; updates=0; content="Approved text"; memberships=["base"]; connects:string[][]=[];
 private identities=new Map([["base",100]]);
 private channelId(slug:string){if(!this.identities.has(slug))this.identities.set(slug,100+this.identities.size);return this.identities.get(slug)!;}
 constructor(){super("fixture-only","https://arena.invalid");}
 override async createBlock(payload:Record<string,unknown>){const targets=(payload.channel_ids ?? (payload.channels as Array<{id:number}>|undefined)?.map(channel=>channel.id)) as number[];this.memberships=[...new Set([...this.memberships,...[...this.identities].filter(([,id])=>targets.includes(id)).map(([slug])=>slug)])];return{id:++this.creates+1000};}
 override async channelIds(targets:string[]){return [...new Set(targets.map(slug=>this.channelId(slug)))];}
 override async block(id:number){return{id,state:"available",type:"Text",title:"Post by @review",content:{markdown:this.content}};}
 override async updateBlock(id:number,payload:Record<string,unknown>){this.updates++;this.content=String(payload.content);return this.block(id);}
 override async connections(){return this.memberships.map(slug=>({slug,channelId:this.channelId(slug)}));}
 override async connectionId(_id:number,slug:string){const i=this.memberships.indexOf(slug);return i<0?undefined:i+1;}
 override async connect(_id:number,targets:string[]){this.connects.push([...targets]);this.memberships=[...new Set([...this.memberships,...targets])];return[1];}
}
async function fixture(){const dir=await mkdtemp(join(tmpdir(),"arena-independent-rereview-"));dirs.push(dir);const store=new ArenaBlockStore(join(dir,"state.sqlite"));stores.push(store);const remote=new Remote();const config={publicBaseUrl:"https://blocks.invalid",mediaDirectory:join(dir,"media"),verifyTimeoutMs:100,pollIntervalMs:1};return{dir,store,remote,config,publisher:new ArenaPublisher(remote,store,config)};}
const req=(targets=["base"])=>({plan:plan(),destinations:targets,force:false});
test("a paused unfinished resume preserves authored edits after another instance verifies",async()=>{
 const {dir,store,remote,config,publisher}=await fixture();store.savePlan(plan());const now=new Date().toISOString();
 store.saveReceipt({id:"unfinished",planHash:plan().hash,blockId:1001,blockUrl:"https://www.are.na/block/1001",destinations:["base"],connectionIds:[],status:"needs_attention",stage:"processing",createdAt:now,updatedAt:now});
 const secondStore=new ArenaBlockStore(join(dir,"state.sqlite"));stores.push(secondStore);const second=new ArenaPublisher(remote,secondStore,config);
 const paused=defer(),release=defer(),read=remote.block.bind(remote);let first=true;
 remote.block=async(id)=>{const result=await read(id);if(first){first=false;paused.resolve();await release.promise;}return result;};
 const pending=publisher.resume("unfinished",["base"]);await paused.promise;
 await second.resume("unfinished",["base"]);expect(store.receipt("unfinished")?.status).toBe("verified");
 remote.content="Later deliberate edit";const before=remote.updates;release.resolve();await pending;
 expect(remote.content).toBe("Later deliberate edit");expect(remote.updates).toBe(before);
 console.log("stale-unfinished-content",JSON.stringify({statusAtResume:"needs_attention",statusBeforeStaleUpdate:"verified",edited:"Later deliberate edit",after:remote.content,extraUpdates:remote.updates-before}));
});
test("independent finalizers verify without rewriting content and retain both placements", async () => {
 const {dir,store,remote,config,publisher}=await fixture();
 store.savePlan(plan()); const now=new Date().toISOString();
 store.saveReceipt({id:"unfinished",planHash:plan().hash,blockId:1001,blockUrl:"https://www.are.na/block/1001",destinations:["base"],connectionIds:[],status:"needs_attention",createdAt:now,updatedAt:now});
 const otherStore=new ArenaBlockStore(join(dir,"state.sqlite")); stores.push(otherStore);
 const other=new ArenaPublisher(remote,otherStore,config);
 const entered=defer(),release=defer(),read=remote.block.bind(remote);let reads=0;
 remote.block=async(id)=>{const result=await read(id);if(++reads===2){entered.resolve();await release.promise;}return result;};
 const first=publisher.resume("unfinished",["a"]); await entered.promise;
 const second=other.resume("unfinished",["b"]);
 await new Promise(resolve=>setTimeout(resolve,10));
 expect(remote.updates).toBe(0); release.resolve();
 await Promise.all([first,second]);
 expect(remote.updates).toBe(0);
 expect(store.receipt("unfinished")?.status).toBe("verified");
 expect(new Set(store.receipt("unfinished")?.destinations)).toEqual(new Set(["base","a","b"]));
});
test("a cancelled waiter cannot release another finalizer's reservation", async () => {
 const {store,remote,publisher}=await fixture(); store.savePlan(plan()); const now=new Date().toISOString();
 store.saveReceipt({id:"unfinished",planHash:plan().hash,blockId:1001,blockUrl:"https://www.are.na/block/1001",destinations:["base"],connectionIds:[],status:"needs_attention",createdAt:now,updatedAt:now});
 expect(store.reserveFinalization("unfinished","active-owner")).toBe("acquired");
 const controller=new AbortController(); const pending=publisher.resume("unfinished",["a"],controller.signal);
 await new Promise(resolve=>setTimeout(resolve,5)); controller.abort();
 await expect(pending).rejects.toThrow("aborted");
 expect(store.reserveFinalization("unfinished","another-owner")).toBe("busy");
 expect(remote.updates).toBe(0);
 store.releaseFinalization("unfinished","active-owner");
 await publisher.resume("unfinished",["a"]);
 expect(remote.updates).toBe(0);
});
test("a dead finalizer can be reclaimed after restart while a live process cannot", async () => {
 const {dir,store}=await fixture(); const now=new Date().toISOString();
 store.saveReceipt({id:"unfinished",planHash:plan().hash,blockId:1001,blockUrl:"https://www.are.na/block/1001",destinations:["base"],connectionIds:[],status:"needs_attention",createdAt:now,updatedAt:now});
 const child=Bun.spawn([Bun.which("bun")!,"-e",`import {ArenaBlockStore} from ${JSON.stringify(join(process.cwd(),"src/store.ts"))};const store=new ArenaBlockStore(process.argv[1]);console.log(store.reserveFinalization("unfinished","child-owner"));setInterval(()=>{},1000);`,join(dir,"state.sqlite")],{stdout:"pipe",stderr:"pipe"});
 try {
  const reader=child.stdout.getReader(); const output=await reader.read(); reader.releaseLock();
  expect(new TextDecoder().decode(output.value)).toContain("acquired");
  expect(store.reserveFinalization("unfinished","parent-owner")).toBe("busy");
  child.kill(); await child.exited;
  const reopened=new ArenaBlockStore(join(dir,"state.sqlite")); stores.push(reopened);
  expect(reopened.reserveFinalization("unfinished","parent-owner")).toBe("acquired");
  reopened.releaseFinalization("unfinished","child-owner");
  expect(store.reserveFinalization("unfinished","different-owner")).toBe("busy");
  reopened.releaseFinalization("unfinished","parent-owner");
 } finally { child.kill(); await child.exited; }
});
test("forced operations retain only their own outcome across restart and repeat safely", async () => {
 const {dir,store,remote,publisher,config}=await fixture(); const old=await publisher.publish(req());
 const operationId=crypto.randomUUID(); remote.createBlock=async()=>{throw new TypeError("Lost response");};
 const error=await publisher.publish({...req(["new-target"]),force:true,operationId}).catch(error=>error);
 const reopened=new ArenaBlockStore(join(dir,"state.sqlite")); stores.push(reopened);
 expect(reopened.operationState(operationId)).toMatchObject({operationId,attempt:{id:error.attempt.id,status:"creation_unknown"}});
 expect(reopened.operationState(operationId)?.receipt).toBeUndefined();
 expect(reopened.receipt(old.id)?.status).toBe("verified");
 const other=new ArenaPublisher(remote,reopened,config);
 await expect(other.publish({...req(["new-target"]),force:true,operationId})).rejects.toThrow("unresolved creation");
 // Resolve this fixture's deliberately ambiguous attempt as rejected, then retry it.
 reopened.saveCreation({...error.attempt,status:"rejected"});
 remote.createBlock=async()=>{remote.memberships.push("new-target");return{id:1002};};
 const created=await other.publish({...req(["new-target"]),force:true,operationId});
 expect(reopened.operationState(operationId)).toMatchObject({operationId,receipt:{id:created.id}});
 expect(reopened.operationState(operationId)?.attempt).toBeUndefined();
 remote.createBlock=async()=>{throw new Error("A repeated operation must not create again");};
 expect((await other.publish({...req(["new-target"]),force:true,operationId})).id).toBe(created.id);
 expect(()=>other.publish({...req(),plan:{...plan(),hash:"a".repeat(64)},operationId})).toThrow("different snapshot");
});
test("verified content remains placement-only after a failed connection", async () => {
 const {remote,store,publisher}=await fixture(); const connect=remote.connect.bind(remote);
 remote.connect=async(id,targets)=>{await connect(id,targets);throw new TypeError("Connection response lost");};
 const error=await publisher.publish(req(["base","a"])).catch(error=>error);
 expect(store.receipt(error.receipt.id)?.status).toBe("verified");
 expect(store.receipt(error.receipt.id)?.pendingDestinations).toContain("a");
 remote.content="Later deliberate edit"; const before=remote.updates;
 remote.connect=async()=>{throw new Error("A confirmed placement must not be POSTed again");};
 await publisher.resume(error.receipt.id,["a"]);
 expect(remote.content).toBe("Later deliberate edit"); expect(remote.updates).toBe(before);
});
test("uncorrelated cancellation reports the uncertain attempt without an unrelated receipt",async()=>{
 const value=plan(),now=new Date().toISOString(),old={id:"old-success",planHash:value.hash,blockId:1001,blockUrl:"https://www.are.na/block/1001",destinations:["old-target"],connectionIds:[1],status:"verified" as const,createdAt:now,updatedAt:now};
 const daemon=new ArenaBlockClient("https://fixture.invalid","fixture-only");daemon.publicationState=async()=>({receipt:old,attempt:{id:"new-force-attempt",planHash:value.hash,destinations:["new-target"],status:"creation_unknown",createdAt:now}});
 let force=false;daemon.publish=async(_plan,_targets,isForce,signal)=>{force=!!isForce;return new Promise((_,reject)=>{signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true});});};
 const pending=publicationWithProgress(daemon,value,["new-target"],signal=>daemon.publish(value,["new-target"],true,signal));process.emit("SIGINT");const error=await pending.catch(error=>error);
 expect(force).toBe(true);expect(error).toBeInstanceOf(PublicationError);expect(error.receipt).toBeUndefined();expect(error.attempt?.id).toBe("new-force-attempt");
 console.log("force-cancel-correlated-attempt",JSON.stringify({force,reportedReceipt:error.receipt?.id,reportedAttempt:error.attempt.id}));
});
test("CLI force cancellation observes its operation and suppresses old-block recovery",async()=>{
 const {dir}=await fixture(),value=plan(),now=new Date().toISOString(),old={id:"old-success",planHash:value.hash,blockId:1001,blockUrl:"https://www.are.na/block/1001",destinations:["old-target"],connectionIds:[1],status:"verified",createdAt:now,updatedAt:now};
 const attempt={id:"new-force-attempt",planHash:value.hash,destinations:["new-target"],status:"creation_unknown",createdAt:now},preload=join(dir,"preload.ts"),planFile=join(dir,"plan.json");
 await Bun.write(planFile,JSON.stringify(value));await Bun.write(preload,`const old=${JSON.stringify(old)},attempt=${JSON.stringify(attempt)};let operationId;globalThis.fetch=async(input,init)=>{const path=new URL(String(input)).pathname;if(path==="/v1/save-policy")return Response.json({credential:{profile:"shared",arenaTokenEnv:"ARENA_WRITE_ACCESS_TOKEN"},mcpPublishingEnabled:false});const state=()=>({saveId:operationId,operationId,phase:"unknown",active:false,cancelRequested:true,authentication:{accountId:47,credentialProfile:"shared",authenticatedAccountVerified:true},attempt});if(path==="/v1/saves/"+operationId+"/cancel")return Response.json(state());if(path==="/v1/saves/"+operationId)return Response.json(state());if(init?.body){const body=JSON.parse(init.body);if(!body.snapshot?.invocation.force || !body.snapshot?.saveId)throw new Error("Expected correlated force fixture");operationId=body.snapshot.saveId;const timer=setInterval(()=>{},100);setTimeout(()=>process.kill(process.pid,"SIGINT"),10);return new Promise((resolve,reject)=>init.signal.addEventListener("abort",()=>{clearInterval(timer);reject(init.signal.reason);},{once:true}));}if(new URL(String(input)).pathname==="/v1/publication-operations/"+operationId)return Response.json({operationId,attempt});return Response.json({receipt:old,attempt});};`);
 const child=Bun.spawn([Bun.which("bun")!,"--preload",preload,"src/cli.ts","publish","--force","--plan",planFile,"--to","new-target"],{env:{...process.env,HOME:dir,ARENA_BLOCK_ACCESS_TOKEN:"fixture-only",ARENA_BLOCK_ENDPOINT:"https://fixture.invalid"},stdout:"pipe",stderr:"pipe"});
 const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(status).toBe(1);expect(stdout).toBe("");expect(stderr).not.toContain("Block retained");expect(stderr).not.toContain("old-success");expect(stderr).not.toContain("arena-block resume");expect(stderr).toContain("arena-block attempt new-force-attempt");
 await Bun.write("../audit/rereview-force-cancel-after.txt",stderr);console.log("force-cancel-cli",JSON.stringify({status,stdout,stderr}));
});
test("CONTROL: independent placement intents survive restart and an unrelated placement",async()=>{
 const {dir,store,remote,publisher,config}=await fixture();const base=await publisher.publish(req());const connect=remote.connect.bind(remote);let partial=true;
 remote.connect=async(id,targets)=>{if(partial){partial=false;await connect(id,targets.slice(0,1));throw new TypeError("Lost connection response");}return connect(id,targets);};
 await expect(publisher.publish(req(["a","b"]))).rejects.toThrow("Lost connection response");
 const reopened=new ArenaBlockStore(join(dir,"state.sqlite"));stores.push(reopened);const other=new ArenaPublisher(remote,reopened,config);
 await other.publish(req(["c"]));const saved=reopened.receipt(base.id)!;expect(saved.destinations).toEqual(["base","a","b","c"]);expect(saved.pendingDestinations).toBeUndefined();
 const final=await other.resume(base.id,[...saved.destinations,...(saved.pendingDestinations??[])]);expect(final.pendingDestinations).toBeUndefined();expect(remote.connects).toEqual([["a"],["b"],["c"]]);expect(remote.creates).toBe(1);
});
test("CONTROL: a pre-repair database imports legacy pending intent and migrates its revision",async()=>{
 const {dir,remote,config}=await fixture(),value=plan(),now=new Date().toISOString(),file=join(dir,"legacy.sqlite"),db=new Database(file);
 db.exec("CREATE TABLE publications(id TEXT PRIMARY KEY,plan_hash TEXT NOT NULL,block_id INTEGER NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
 const receipt={id:"legacy",planHash:value.hash,blockId:1001,blockUrl:"https://www.are.na/block/1001",destinations:["base"],connectionIds:[1],status:"verified",stage:"connecting",pendingDestinations:["b"],error:"Legacy interruption",createdAt:now,updatedAt:now};
 db.query("INSERT INTO publications VALUES(?,?,?,?,?,?)").run(receipt.id,value.hash,1001,JSON.stringify(receipt),now,now);db.close();
 const legacy=new ArenaBlockStore(file);stores.push(legacy);legacy.savePlan(value);const publisher=new ArenaPublisher(remote,legacy,config);
 await expect(publisher.publish(req(["c"]))).rejects.toThrow("previously attempted placement");
 expect(legacy.receipt("legacy")?.pendingDestinations).toEqual(["b","c"]);expect(remote.connects).toEqual([]);
 // Reconcile the old ambiguous batch from membership proof before advancing.
 remote.memberships.push("b");await publisher.publish(req(["c"]));
 expect(legacy.receipt("legacy")?.pendingDestinations).toBeUndefined();expect(remote.connects).toEqual([["c"]]);expect(legacy.receiptSnapshot("legacy").revision).toBeGreaterThan(0);expect(remote.creates).toBe(0);
});
for(const status of [401,403,429,500])test(`CONTROL: create ${status} retry classification survives reopening`,async()=>{
 const {dir,store,remote,publisher,config}=await fixture();let writes=0;remote.createBlock=async()=>{writes++;throw new ArenaRequestError("Fixture API response",status);};const error=await publisher.publish(req()).catch(error=>error);
 const reopened=new ArenaBlockStore(join(dir,"state.sqlite"));stores.push(reopened);const next=new ArenaPublisher(remote,reopened,config);remote.createBlock=async()=>{writes++;return{id:1001};};
 if(status===401||status===403){expect(reopened.creationAttempt(error.attempt.id)?.status).toBe("rejected");await expect(next.publish(req())).resolves.toMatchObject({status:"verified"});expect(writes).toBe(2);}
 else{expect(reopened.unresolvedCreation(plan().hash)?.status).toBe("creation_unknown");await expect(next.publish({...req(),force:true})).rejects.toThrow("may already have reached");expect(writes).toBe(1);}
});
test("CONTROL: a mid-body deadline rejects without waiting for cancellation acknowledgement",async()=>{
 const {dir}=await fixture(),value=composePlan([{...plan().sources[0]!,media:[{ref:"1.1",kind:"image",url:"https://fixture.invalid/stalled",alt:"",width:20,height:20}]}]);
 const original=globalThis.fetch;let cancelled=false;globalThis.fetch=(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));},cancel(){cancelled=true;return new Promise(()=>{});}}))) as unknown as typeof fetch;
 try{const started=Date.now();await expect(renderPlan(value,dir,{downloadTimeoutMs:15})).rejects.toMatchObject({name:"TimeoutError"});expect(Date.now()-started).toBeLessThan(500);expect(cancelled).toBe(true);}finally{globalThis.fetch=original;}
});
test("CONTROL: a failed selected image cancels its stalled sibling",async()=>{
 const {dir}=await fixture(),value=composePlan([{...plan().sources[0]!,media:[{ref:"1.1",kind:"image",url:"https://fixture.invalid/bad",alt:"",width:20,height:20},{ref:"1.2",kind:"image",url:"https://fixture.invalid/stall",alt:"",width:20,height:20}]}],{media:"all"});
 const original=globalThis.fetch;let signal:AbortSignal|undefined,cancelled=false;globalThis.fetch=(async(input,init)=>{if(String(input).endsWith("bad"))return new Response("Unavailable",{status:503});signal=init?.signal??undefined;return new Response(new ReadableStream({cancel(){cancelled=true;}}));}) as typeof fetch;
 try{await expect(renderPlan(value,dir)).rejects.toThrow("503");await new Promise(r=>setTimeout(r,5));expect(signal?.aborted).toBe(true);expect(cancelled).toBe(true);}finally{globalThis.fetch=original;}
});
