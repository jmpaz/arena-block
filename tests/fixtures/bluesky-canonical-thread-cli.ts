// Fictional writing with the four-post shape and facet marker of the reported thread.
import { writeFileSync } from "node:fs";
const did="did:plc:4pklmqyj4mew3wftz7edg4fy", ids=["3my3fqho7as2e","3my3fqhqsb22e","3my3fqpb2qc2e","3my3ni6snus23"];
const uri=(id:string)=>`at://${did}/app.bsky.feed.post/${id}`;
const posts=ids.map((id,index)=>({uri:uri(id),cid:`cid-${id}`,author:{did,handle:"stephango.com"},replyCount:index===3?0:1,
 record:{$type:"app.bsky.feed.post",text:index===2?"A linked reference.":`Fictional selected post ${index+1}.`,createdAt:`2026-10-17T12:00:0${index}.000Z`,
 ...(index?{reply:{root:{uri:uri(ids[0]!),cid:`cid-${ids[0]}`},parent:{uri:uri(ids[index-1]!),cid:`cid-${ids[index-1]}`}}}:{}),
 ...(index===2?{facets:[{$type:"app.bsky.richtext.facet",index:{byteStart:2,byteEnd:18},features:[{$type:"app.bsky.richtext.facet#link",uri:"https://example.com/reference"}]}]}:{})},
 ...(index===0?{embed:{$type:"app.bsky.embed.video#view",playlist:"https://media.example/thread.m3u8",thumbnail:"https://media.example/poster.jpg",aspectRatio:{width:640,height:480}}}:{}),
 ...(index===1?{embed:{$type:"app.bsky.embed.images#view",images:[1,2].map(n=>({fullsize:`https://media.example/image${n}.jpg`,alt:`Test image ${n}`,aspectRatio:{width:640,height:480}}))}}:{})}));
const node=(index:number):unknown=>({$type:"app.bsky.feed.defs#threadViewPost",post:posts[index],...(index<3?{replies:[node(index+1)]}:{replies:[]})});
const ledger={entry:process.argv[1],requests:[]as string[]};
globalThis.fetch=Object.assign(async(input:RequestInfo|URL)=>{const url=new URL(String(input));ledger.requests.push(url.href);
 if(process.env.ARENA_BSKY_LEDGER)writeFileSync(process.env.ARENA_BSKY_LEDGER,JSON.stringify(ledger));
 if(url.origin!=="https://public.api.bsky.app"||!url.pathname.endsWith("app.bsky.feed.getPostThread"))throw Error("Unexpected fixture request");
 return Response.json({thread:node(0)});
},{preconnect:globalThis.fetch.preconnect});
