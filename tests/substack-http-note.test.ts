import {expect,test} from "bun:test";
import {createDocument} from "@mixmark-io/domino";
import {createContext,runInContext} from "node:vm";
import {readSubstackPage} from "../packages/core/substack-page.ts";
import {normalizeSubstackCapture} from "../packages/core/substack-record.ts";
import {createHash} from "node:crypto";
import {resolveCapture} from "../extension/src/core.ts";

const url="https://substack.com/@joodaloop/note/c-360337718";
const html=await Bun.file(new URL("./fixtures/substack-contracts/360337718.html",import.meta.url)).text();
const noFetch=(async()=>{throw new Error("The complete captured Note must not require another source");})as unknown as typeof fetch;

test("actual Note360337718 preserves authored HTTP link and complete text with original images",async()=>{
 const capture=normalizeSubstackCapture(await readSubstackPage(url,{url,document:createDocument(html),parseHTML:createDocument,fetcher:noFetch,method:"public-html"}));
 expect(capture.note.body.status).toBe("complete");
 expect(capture.note.body.html).toContain('href="http://nicochilla.com"');
 expect(capture.note.body.html).toContain("keeping the density theme going");
 expect(capture.note.body.html).toContain("and a themed grid at that!");
 expect(capture.note.author.handle).toBe("joodaloop");
 expect(capture.note.media?.length).toBeGreaterThan(0);
 expect(capture.note.media?.every(m=>m.kind==="image"&&m.url.startsWith("https://substack-post-media.s3.amazonaws.com/"))).toBe(true);
});

test("HTTP presentation comparison still rejects altered writing, destinations and custom labels",async()=>{
 for(const change of [
  (d:Document)=>{d.querySelector('[class*="feedCommentBody-"] .ProseMirror p')!.firstChild!.textContent="different prose ";},
  (d:Document)=>{d.querySelector('a[href="http://nicochilla.com"]')!.setAttribute("href","http://different.example");},
  (d:Document)=>{d.querySelector('a[href="http://nicochilla.com"]')!.textContent="custom authored label";},
 ]){
  const doc=createDocument(html);change(doc);
  const error:any=await readSubstackPage(url,{url,document:doc,parseHTML:createDocument,fetcher:noFetch}).catch(e=>e);
  expect(error.cause?.reason).toBe("structured_text_mismatch");
 }
});

test("self-contained browser/Safari reader accepts the exact HTTP Note without rewriting its retained URL",async()=>{
 const context=createContext({document:createDocument(html),location:{href:url},URL,AbortController,setTimeout,clearTimeout,fetch:noFetch,TextDecoder,Uint8Array});
 const capture=normalizeSubstackCapture(await runInContext(`(${readSubstackPage.toString()})()`,context));
 expect(capture.note.body.html).toContain('href="http://nicochilla.com"');
 expect(capture.note.body.status).toBe("complete");
});

test("exact root and quote have matching CLI/helper and bundled native plans with thread expansion off",async()=>{
 const quoteURL="https://substack.com/@joodaloop/note/c-357819575";
 const quote=await Bun.file(new URL("./fixtures/substack-contracts/357819575.html",import.meta.url)).text();
 const fetcher=(async(input:RequestInfo|URL)=>{
  const address=String(input);if(![url,quoteURL].includes(address))throw Error("Unexpected source "+address);
  return new Response(address===url?html:quote,{headers:{"content-type":"text/html"}});
 })as unknown as typeof fetch;
 const plan=await resolveCapture({primary:[url],extras:[],policy:{threadExpansion:"off"}},undefined,fetcher);
 expect(plan.sources).toHaveLength(1);expect(plan.sources[0]!.quote?.text).toBeTruthy();
 expect(plan.block.markdown).toContain("http://nicochilla.com");
 let finish!:(value:any)=>void;const done=new Promise<any>(resolve=>finish=resolve);
 const native=createContext({nativeSHA256:(text:string)=>createHash("sha256").update(text).digest("hex"),setTimeout,clearTimeout,nativeCancelHTTP:()=>{},
  nativeHTTP:(id:number,raw:string)=>{const request=JSON.parse(raw);void fetcher(request.url).then(async response=>native.captureHTTPComplete(id,JSON.stringify({status:response.status,url:request.url,headers:{"content-type":"text/html"},body:await response.text()})));},
  nativeResolveComplete:(_id:string,result:string|null,error:string|null)=>finish({result,error})});
 runInContext(await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js",import.meta.url)).text(),native);
 native.captureResolve("actual-http-note",JSON.stringify([url]),JSON.stringify({threadExpansion:"off"}));
 const output=await done;expect(output.error).toBeNull();expect(JSON.parse(output.result).plan.block).toEqual(plan.block);
});
