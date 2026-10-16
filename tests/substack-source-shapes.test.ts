import {expect,test} from "bun:test";
import {createDocument} from "@mixmark-io/domino";
import {createContext,runInContext} from "node:vm";
import {createHash} from "node:crypto";
import {readSubstackPage} from "../packages/core/substack-page.ts";
import {normalizeSubstackCapture} from "../packages/core/substack-record.ts";
import {resolveCapture} from "../extension/src/core.ts";
const id="347044458",quoteId="346876542",nestedId="348712218",base="https://substack.com/@joodaloop/note/c-";
const pages=new Map<string,string>(),records=new Map<string,any>();
for(const key of [id,quoteId,nestedId]){
 pages.set(base+key,await Bun.file(new URL(`./fixtures/substack-contrast-${key}.html`,import.meta.url)).text());
 records.set(`https://substack.com/api/v1/reader/comment/${key}`,await Bun.file(new URL(`./fixtures/substack-contrast-${key}.json`,import.meta.url)).json());
}
const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const url=String(input);expect(init?.credentials).toBe("omit");
 if(pages.has(url))return new Response(pages.get(url),{headers:{"content-type":"text/html"}});
 if(records.has(url))return Response.json(records.get(url));
 throw Error("Unexpected public source request: "+url);
})as typeof fetch;
const rootText="ok, starting with the first one i remember that blew my mind because of the sheer intensity of care for the details";
const quoteText="i think i’m going to start posting personal websites that i admire, as an act of reverence for the medium";

test("actual containing Note verifies shortened inline URL labels and retains both full quoted ancestors and images",async()=>{
 for(const suffix of ["","?r=1ir8aw&utm_medium=ios&utm_source=notes-share-"]){
  const plan=await resolveCapture({primary:[base+nestedId+suffix],extras:[],policy:{threadExpansion:"off",quoteDepth:2,media:"all"}},undefined,fetcher);
  const source=plan.sources[0]!;
  expect(source.id).toBe(nestedId);expect(source.text).toContain("DENSITY!!!");expect(source.text).toContain("[lucy-ives.com](<https://www.lucy-ives.com/>)");
  expect(source.text).not.toContain(rootText);expect(source.quote?.id).toBe(id);expect(source.quote?.text).toContain(rootText);
  expect(source.quote?.quote?.id).toBe(quoteId);expect(source.quote?.quote?.text.trim()).toBe(quoteText);
  expect(source.media.map(m=>m.url)).toEqual(["https://substack-post-media.s3.amazonaws.com/public/images/68a64432-2acb-43f4-bfa8-ed1f39bcef11_2560x1593.jpeg"]);
  expect(source.quote?.media.map(m=>m.url)).toEqual(["https://substack-post-media.s3.amazonaws.com/public/images/f0e3bd4a-3606-42e8-a300-be503eb4dae7_2560x1738.jpeg"]);
  // Existing composition selects the explicit post's media. The quoted image
  // remains in its own source node rather than being attributed to the root.
  expect(plan.block.selectedMedia).toHaveLength(1);expect(plan.block.quoteCoverage?.[0]).toMatchObject({availableDepth:2,renderedDepth:2,stopped:"end"});
 }
 const limitedCalls:string[]=[];
 const bounded=(async(input:RequestInfo|URL,init?:RequestInit)=>{limitedCalls.push(String(input));return fetcher(input,init);})as typeof fetch;
 const limited=normalizeSubstackCapture(await readSubstackPage(base+nestedId,{url:base+nestedId,parseHTML:createDocument,fetcher:bounded,maxDepth:1}));
 expect(limited.note.quote?.expanded?.quote?.status).toBe("depth_limit");expect(limitedCalls).not.toContain(base+quoteId);
 const excluded=await resolveCapture({primary:[base+nestedId],extras:[],policy:{threadExpansion:"off",quoteDepth:0}},undefined,fetcher);
 expect(excluded.block.markdown).toContain("DENSITY!!!");expect(excluded.block.markdown).not.toContain(rootText);expect(excluded.block.selectedMedia).toHaveLength(1);
});

test("URL-label comparison cannot mask changed prose, custom labels, destinations or quote preview text",async()=>{
 const actual=pages.get(base+nestedId)!;
 for(const changed of [actual.replace('DENSITY!!!','Changed prose'),actual.replace('>lucy-ives.com<','>invented label<'),actual.replace('href="https://www.lucy-ives.com/"','href="https://wrong.example/"')]){
  const error:any=await readSubstackPage(base+nestedId,{url:base+nestedId,document:createDocument(changed),parseHTML:createDocument,fetcher}).catch(e=>e);
  expect(error.cause?.reason).toBe("structured_text_mismatch");
 }
 const changedPreview=actual.replace(rootText,"A deliberately incomplete quote preview");
 const captured=normalizeSubstackCapture(await readSubstackPage(base+nestedId,{url:base+nestedId,document:createDocument(changedPreview),parseHTML:createDocument,fetcher}));
 expect(captured.note.quote?.expanded?.body.html).toContain(rootText);expect(captured.note.quote?.expanded?.quote?.expanded?.body.html).toContain(quoteText);
});

test("actual quoted/unquoted contrast preserves root writing, own image, separate link preview and full quote",async()=>{
 for(const key of [id,quoteId])for(const suffix of ["","?r=1ir8aw&utm_medium=ios&utm_source=notes-share-"]){
  const plan=await resolveCapture({primary:[base+key+suffix],extras:[],policy:{threadExpansion:"off"}},undefined,fetcher);
  const source=plan.sources[0]!;
  expect(plan.block.canonicalSource).toBe(base+key);expect(source.author.handle).toBe("joodaloop");
  if(key===quoteId){expect(source.text.trim()).toBe(quoteText);expect(source.quote).toBeUndefined();continue;}
  expect(source.text).toContain(rootText);expect(source.text).toContain("still online at");expect(source.text).not.toContain(quoteText);
  expect(source.substackCapture!.note.body.html).not.toContain(quoteText);
  expect(source.substackCapture!.note.links).toEqual([{kind:"link",role:"preview",url:"http://colly.com/v4",title:"Simon Collison | Colly | The Celebrated Miscellany",previewText:"This is the celebrated journal of Simon Collison (aka Colly); web designer, developer, author and speaker, Nottingham, UK."}]);
  expect(source.media).toHaveLength(1);expect(source.media[0]!.sourceRole).toBe("original");
  expect(source.quote?.id).toBe(quoteId);expect(source.quote?.author.name).toBe("Judah");expect(source.quote?.text.trim()).toBe(quoteText);
  expect(plan.block.markdown).toContain(quoteText);expect(plan.block.markdown).toContain("Preview of [Simon Collison");
  const noQuote=await resolveCapture({primary:[base+key],extras:[],policy:{threadExpansion:"off",quoteDepth:0}},undefined,fetcher);
  expect(noQuote.block.markdown).not.toContain(quoteText);expect(noQuote.block.markdown).toContain(rootText);expect(noQuote.sources[0]?.media).toEqual(source.media);
 }
});

test("detached link evidence cannot hide changed writing, card identities, previews, order or unsafe destinations",async()=>{
 for(const mutate of [
  (value:any)=>value.item.comment.body="changed",
  (value:any)=>value.item.comment.user_id=7,
  (value:any)=>value.item.comment.attachments.find((a:any)=>a.type==="link").linkMetadata.title="Changed title",
  (value:any)=>value.item.comment.attachments.find((a:any)=>a.type==="link").linkMetadata.description="Changed preview",
  (value:any)=>value.item.comment.attachments.find((a:any)=>a.type==="link").linkMetadata.url="http://user:secret@colly.com/v4",
  (value:any)=>value.item.comment.attachments=value.item.comment.attachments.filter((a:any)=>a.type!=="link"),
 ]){
  const changed=structuredClone(records.get(`https://substack.com/api/v1/reader/comment/${id}`));mutate(changed);
  const f=(async(input:RequestInfo|URL,init?:RequestInit)=>String(input).includes('/api/')?Response.json(changed):fetcher(input,init))as typeof fetch;
  const error:any=await readSubstackPage(base+id,{url:base+id,parseHTML:createDocument,fetcher:f}).catch(e=>e);
  expect(error.message).toContain("Couldn’t read the full Note");expect(error.cause.code).toBe("substack_note_body_unavailable");
 }
 const extra=pages.get(base+id)!.replace("still online at </p>","still online at CHANGED</p>");
 const error:any=await readSubstackPage(base+id,{url:base+id,document:createDocument(extra),parseHTML:createDocument,fetcher}).catch(e=>e);
 expect(error.cause.reason).toBe("structured_text_mismatch");
});

test("actual quote/card source works through serialized Safari and native bundled acquisition",async()=>{
 for(const key of [id,nestedId]){
  const context=createContext({document:createDocument(pages.get(base+key)!),location:{href:base+key},URL,TextDecoder,AbortController,setTimeout,clearTimeout,fetch:fetcher,DOMParser:class{parseFromString(value:string){return createDocument(value);}}});
  const browser=normalizeSubstackCapture(await runInContext(`(${readSubstackPage.toString()})()`,context));
  if(key===id){expect(browser.note.quote?.expanded?.body.html).toContain(quoteText);expect(browser.note.links[0]?.url).toBe("http://colly.com/v4");}
  else {expect(browser.note.body.html).toContain('href="https://www.lucy-ives.com/"');expect(browser.note.quote?.expanded?.quote?.expanded?.body.html).toContain(quoteText);}
 }
 const bundle=await Bun.file(new URL("../ios/Sources/CaptureRuntime/Resources/capture-core.js",import.meta.url)).text();
 for(const key of [id,quoteId,nestedId]){
  let finish!:(x:any)=>void;const done=new Promise<any>(resolve=>finish=resolve);
  const native=createContext({nativeSHA256:(text:string)=>createHash("sha256").update(text).digest("hex"),setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms).unref(),clearTimeout,nativeCancelHTTP:()=>{},
   nativeHTTP:(requestId:number,raw:string)=>{const req=JSON.parse(raw);void fetcher(req.url,{credentials:"omit"}).then(async response=>native.captureHTTPComplete(requestId,JSON.stringify({status:response.status,url:req.url,headers:{"content-type":response.headers.get("content-type")},body:await response.text()})));},
   nativeResolveComplete:(_id:string,result:string|null,error:string|null)=>finish({result,error})});
  runInContext(bundle,native);native.captureResolve("contrast",JSON.stringify([base+key]),JSON.stringify({threadExpansion:"off"}));
  const output=await done;expect(output.error).toBeNull();const cli=await resolveCapture({primary:[base+key],extras:[],policy:{threadExpansion:"off"}},undefined,fetcher);
  expect(JSON.parse(output.result).plan.block).toEqual(cli.block);
 }
});
