import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { createContext, runInContext } from "node:vm";
import { createHash } from "node:crypto";
import { readSubstackPage } from "../packages/core/substack-page.ts";
import { normalizeSubstackCapture } from "../packages/core/substack-record.ts";
import { resolveCapture } from "../extension/src/core.ts";

const canonical="https://substack.com/@norvidstudies/note/c-362104813";
const tracked=canonical+"?r=1ir8aw&utm_medium=ios&utm_source=notes-share-";
const html=await Bun.file(new URL("./fixtures/substack-image-only-note-public.html",import.meta.url)).text();
const api=await Bun.file(new URL("./fixtures/substack-image-only-note-public.json",import.meta.url)).json();
const original=api.item.comment.attachments[0].imageUrl;
const endpoint="https://substack.com/api/v1/reader/comment/362104813";
function fetcher(page=html,record=api,calls:string[]=[]):typeof fetch {
 return (async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);calls.push(url);expect(init?.credentials).toBe("omit");
  if(url===canonical)return new Response(page,{headers:{"content-type":"text/html"}});
  if(url===endpoint)return Response.json(record);
  throw new Error("Unexpected fixture request: "+url);
 })as typeof fetch;
}

test("actual failing image-only Note captures the original image and no invented camera text for canonical/tracked URLs",async()=>{
 for(const source of[canonical,tracked]){
  const calls:string[]=[];
  const plan=await resolveCapture({primary:[source],extras:[],policy:{threadExpansion:"off"}},undefined,fetcher(html,api,calls));
  expect(plan.block.title).toBe("Note by @norvidstudies");expect(plan.block.canonicalSource).toBe(canonical);
  expect(plan.sources[0]!.text).toBe("");expect(plan.sources[0]!.substackCapture?.note.body).toEqual({status:"complete",html:""});
  expect(plan.sources[0]!.media).toMatchObject([{ref:"1.1",kind:"image",url:original,width:1448,height:1086}]);
  expect(plan.block.selectedMedia).toEqual(["1.1"]);expect(plan.block.markdown).not.toContain("📸");
  expect(calls).toEqual([canonical,endpoint]);
 }
});

test("nearby bodyless image shapes require matching source identity, empty authored body and all original images in order",async()=>{
 for(const change of[
  {body:"Missing authored text"},{body_json:{type:"doc",content:[]}},{id:362104814},{user_id:7},{handle:"someoneelse"},
  {attachments:[]},{attachments:[{...api.item.comment.attachments[0],imageUrl:original.replace("9fc436fc","different")}]},
  {attachments:[{...api.item.comment.attachments[0],type:"video"}]},
 ]){
  const record={item:{comment:{...api.item.comment,...change}}};
  const error:any=await readSubstackPage(canonical,{url:canonical,parseHTML:createDocument,fetcher:fetcher(html,record)}).catch(e=>e);
  expect(error).toBeInstanceOf(Error);expect(error.message).toBe("Couldn’t read the full Note. Open it in Substack and try sharing it again.");
  expect(error.cause.code).toBe("substack_note_body_unavailable");
 }
 const second=original.replace("9fc436fc-78b9-407e-9a44-70f18500a27d","fixture-second");
 const d=createDocument(html);const image=d.querySelector('[class*="imageGrid-"] img')!;const copy=image.parentElement!.cloneNode(true)as Element;
 copy.querySelector("img")!.setAttribute("src","https://substackcdn.com/image/fetch/w_560/"+encodeURIComponent(second));
 d.querySelector('[class*="imageGrid-"]')!.appendChild(copy);
 const record={item:{comment:{...api.item.comment,attachments:[...api.item.comment.attachments,{...api.item.comment.attachments[0],id:"fixture-second",imageUrl:second}]}}};
 const captured=normalizeSubstackCapture(await readSubstackPage(canonical,{url:canonical,parseHTML:createDocument,fetcher:fetcher(d.documentElement.outerHTML,record)}));
 expect(captured.note.media?.map(x=>x.url)).toEqual([original,second]);
});

test("ambiguous or missing prose uses readable copy and retains only bounded diagnostic identity/counts",async()=>{
 const d=createDocument(html),root=d.querySelector('[class*="feedPermalinkUnit-"]')!;
 for(let i=0;i<2;i++){const wrap=d.createElement("div");wrap.className="feedCommentBody-fixture";wrap.innerHTML='<div class="ProseMirror"><p>Ambiguous text</p></div>';root.appendChild(wrap);}
 const error:any=await readSubstackPage(canonical,{url:canonical,parseHTML:createDocument,fetcher:fetcher(d.documentElement.outerHTML)}).catch(e=>e);
 expect(error.message).not.toMatch(/unambiguous|ProseMirror|selector/);
 expect(error.cause).toEqual({code:"substack_note_body_unavailable",noteId:"362104813",reason:"selected_body_count",bodyCount:2});
});

test("the serialized browser/Safari reader accepts the same actual image Note",async()=>{
 const document=createDocument(html);const location={href:tracked};
 const context=createContext({document,location,URL,TextDecoder,AbortController,setTimeout,clearTimeout,Date,fetch:fetcher(),DOMParser:class{parseFromString(value:string){return createDocument(value);}}});
 const result=await runInContext(`(${readSubstackPage.toString()})()`,context);
 expect(normalizeSubstackCapture(result).note.media?.[0]?.url).toBe(original);
 expect(result.note.body.html).toBe("");expect(result.sourceUrl).toBe(canonical);
});

test("native bundled acquisition matches CLI fields and privately reports body diagnostics",async()=>{
 const bundle=await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js",import.meta.url)).text();
 async function run(page:string){
  let finish!:(value:any)=>void;const done=new Promise(resolve=>{finish=resolve;});const diagnostics:string[]=[];
  const context=createContext({nativeSHA256:(text:string)=>createHash("sha256").update(text).digest("hex"),
   setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms).unref(),clearTimeout,nativeCancelHTTP:()=>{},nativeSourceDiagnostic:(value:string)=>diagnostics.push(value),
   nativeHTTP:(id:number,raw:string)=>{const request=JSON.parse(raw);const isApi=request.url===endpoint;expect([canonical,endpoint]).toContain(request.url);
    queueMicrotask(()=>context.captureHTTPComplete(id,JSON.stringify({status:200,url:request.url,headers:{"content-type":isApi?"application/json":"text/html"},body:isApi?JSON.stringify(api):page})));},
   nativeResolveComplete:(_id:string,result:string|null,error:string|null)=>finish({result,error}),});
  runInContext(bundle,context);context.captureResolve("image-note",JSON.stringify([tracked]),JSON.stringify({threadExpansion:"off"}));
  return{...await done as any,diagnostics};
 }
 const native=await run(html);expect(native.error).toBeNull();const value=JSON.parse(native.result);
 const cli=await resolveCapture({primary:[tracked],extras:[],policy:{threadExpansion:"off"}},undefined,fetcher());
 expect(value.plan.block).toEqual(cli.block);expect(value.plan.sources[0].substackCapture.note.body.html).toBe("");
 const bad=await run(html.replace('imageGrid-TadIyX','feedCommentBody-missing-editor'));
 expect(bad.result).toBeNull();expect(bad.error).toContain("Couldn’t read the full Note");
 expect(JSON.parse(bad.diagnostics[0])).toMatchObject({code:"substack_note_body_unavailable",noteId:"362104813"});
});
