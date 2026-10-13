import { join } from "node:path";
import { composePlan } from '../../src/compose.ts';
import { publicationFields } from '../../src/capture.ts';
const directory = process.argv[2];
if (!directory) throw new Error('Provide an output directory');
const result = await Bun.build({entrypoints:[join(import.meta.dir, 'core-compatibility-entry.ts')],outdir:directory,target:'browser',format:'iife',plugins:[{name:'native-hash',setup(build){
 build.onResolve({filter:/^node:crypto$/},args=>({path:args.path,namespace:'native-hash'}));
 build.onLoad({filter:/.*/,namespace:'native-hash'},()=>({contents:`export function createHash(algorithm) { if (algorithm !== 'sha256') throw new Error('unsupported'); let value=''; return {update(text){value+=text;return this},digest(format){if(format!=='hex')throw new Error('unsupported');return globalThis.nativeSHA256(value)}} }`,loader:'js'}));
}}]});
if(!result.success) throw new Error(result.logs.join('\n'));
const base={provider:'x',id:'100',canonicalUrl:'https://x.com/root/status/100',author:{handle:'root',name:'Root'},text:'First paragraph.\n\n日本語 — café 👋',media:[]};
const image={ref:'1.1',kind:'image',url:'https://example.test/image.jpg',alt:'Image'};
const cases=[{posts:[base]},{posts:[{...base,quote:{...base,id:'99',author:{handle:'quoted'},text:'Quoted words.'}}]},{posts:[{...base,media:[image,{...image,ref:'1.2'}]}],policy:{media:'all'}},{posts:[{...base,media:[{...image,kind:'video',duration:4}]}]},{posts:[base,{...base,id:'101',text:'Reply.'}]}];
const expected=cases.map(input=>{const plan=composePlan(input.posts as any,input.policy as any);return {plan,fields:publicationFields(plan)}});
await Bun.write(join(directory, 'cases.json'),JSON.stringify(cases));
await Bun.write(join(directory, 'expected.json'),JSON.stringify(expected));
console.log('Bundled current composition + publication fields with native SHA256 bridge; 5 expected cases');
