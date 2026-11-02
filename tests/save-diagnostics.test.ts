import { expect, test } from "bun:test";
import { diagnoseSaveDestinations } from "../src/save-diagnostics.ts";
import { composePlan } from "../src/compose.ts";
import { prepareSaveIntent } from "../src/save-intent.ts";
import { userConfigSchema } from "../src/config.ts";
import type { SaveStatus } from "../src/save-gateway.ts";
const plan=composePlan([{provider:"x",id:"1",canonicalUrl:"https://x.com/example/status/1",author:{handle:"example"},text:"Test post",media:[]}]);
const intent=prepareSaveIntent(plan,userConfigSchema.parse({provenance:{local:false,remoteSnapshot:"none"}}),{origin:"cli",initiator:{kind:"human"},operation:"publish",destinations:["missing-channel"]});
const status:SaveStatus={operationId:intent.snapshot.saveId,saveId:intent.snapshot.saveId,phase:"not_saved",active:false,cancelRequested:false,authentication:{accountId:47,credentialProfile:"shared",authenticatedAccountVerified:true}};
test.each([401,403,404])("old pre-create failures receive a read-only channel diagnosis for HTTP %s",async httpStatus=>{
 const calls:unknown[]=[],before=JSON.stringify({status,intent});
 const daemon={retainedIntent:async(id:string)=>{calls.push(["intent",id]);return intent;},channelLabels:async(refs:string[])=>{calls.push(["labels",refs]);throw Error(`Are.na GET /channels/missing-channel returned ${httpStatus}`);}};
 expect(await diagnoseSaveDestinations(daemon,status)).toMatchObject({code:"destination_unavailable",basis:"read_only_channel_lookup",channel:"missing-channel",httpStatus});
 expect(calls).toEqual([["intent",status.saveId],["labels",["missing-channel"]]]);expect(JSON.stringify({status,intent})).toBe(before);
});
test("partial, ambiguous, active, cancelled and already explained outcomes never trigger diagnostic reads",async()=>{
 let reads=0;
 const daemon={retainedIntent:async()=>{reads++;throw Error("Unexpected read");},channelLabels:async()=>{reads++;throw Error("Unexpected read");}};
 for(const change of [{phase:"saved"},{phase:"partial"},{phase:"unknown"},{active:true},{cancelRequested:true},{authentication:{credentialProfile:"shared",authenticatedAccountVerified:false}},{failure:{code:"authorization",message:"Known failure"}},{attempt:{}},{receipt:{}}])
  expect(await diagnoseSaveDestinations(daemon,{...status,...change}as SaveStatus)).toBeUndefined();
 expect(reads).toBe(0);
});
test("failed lookups and unrelated error text do not replace the retained outcome",async()=>{
 for(const message of ["Owner service returned HTTP 503","Are.na GET /channels/another-channel returned 404","Are.na GET /blocks/42 returned 404","Are.na GET /channels/missing-channel returned 500"]){
  const daemon={retainedIntent:async()=>intent,channelLabels:async()=>{throw Error(message);}};
  expect(await diagnoseSaveDestinations(daemon,status)).toBeUndefined();
 }
 const unavailable={retainedIntent:async()=>{throw Error("offline");},channelLabels:async()=>[]};
 expect(await diagnoseSaveDestinations(unavailable,status)).toBeUndefined();
});
