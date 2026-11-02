import { expect, test } from "bun:test";
import { composePlan } from "../packages/core/compose.ts";
import { blockPlanSchema, type ResolvedPost } from "../packages/core/types.ts";
import { checkVideoInputBudget } from "../src/render.ts";
import { captureRenderRecipe, videoBitrate } from "../packages/core/render-recipe.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { requireRetainedCompositionPolicy } from "../packages/core/composition-capabilities.ts";
const post = (duration: number): ResolvedPost => ({ provider: "tiktok", id: "707", canonicalUrl: "https://www.tiktok.com/@author/video/707", author: { handle: "author" }, text: "Original video", media: [{ ref:"1.1",kind:"video",url:"https://media.example/video.mp4",posterUrl:"https://media.example/frame.jpg",durationSeconds:duration,width:720,height:1280,alt:"" }] });
test("25 minutes is an inclusive default boundary, with explicit reversible Video and Frame choices", () => {
 for (const duration of [600,707,1499,1500]) expect(composePlan([post(duration)]).block.kind).toBe("video");
 const source=post(1501), automatic=composePlan([source]);
 expect(automatic.block.kind).toBe("link"); expect(automatic.block.frameMedia?.map(x=>x.ref)).toEqual(["1.1"]);
 const moving=blockPlanSchema.parse(composePlan([source],{videoMotion:["1.1"]}));
 expect(moving.block.kind).toBe("video");expect(moving.block.frameMedia).toBeUndefined();
 expect(moving.policy.videoMotion).toEqual(["1.1"]);expect(moving.sources).toEqual([source]);
 const frame=composePlan([source],{videoMotion:[],videoFrames:["1.1"]});expect(frame.block.kind).toBe("link");
 expect(composePlan(frame.sources,{...frame.policy,videoFrames:[],videoMotion:["1.1"]}).block.kind).toBe("video");
 expect(composePlan([post(707)],{videoFrames:["1.1"]}).block.kind).toBe("link");
 expect(composePlan([post(707)],{videoFrameThresholdSeconds:60,videoMotion:["1.1"]}).block.kind).toBe("video");
 expect(()=>composePlan([source],{videoMotion:["1.1"],videoFrames:["1.1"]})).toThrow("either Video or Frame");
 expect(()=>composePlan([source],{videoMotion:["2.1"]})).toThrow("moving video");
});
test("duration does not act as an input ban; byte and encoding budgets remain independent", () => {
 expect(()=>checkVideoInputBudget("1.1",707,20*1024*1024)).not.toThrow();
 expect(()=>checkVideoInputBudget("1.1",3600,749*1024*1024)).not.toThrow();
 expect(()=>checkVideoInputBudget("1.1",60,751*1024*1024)).toThrow("750 MiB");
 expect(()=>checkVideoInputBudget("1.1",707,undefined)).toThrow("measurable size");
 expect(videoBitrate(707)).toBeGreaterThan(0);expect(videoBitrate(1501)).toBeGreaterThan(0);
 expect(()=>videoBitrate(10000)).toThrow("250 MiB output budget");
 const p=composePlan([post(1501)],{videoMotion:["1.1"]});
 const recipe=captureRenderRecipe(p,{"1.1":{width:720,height:1280,duration:1501.2,fps:30,audio:true}})!;
 expect(recipe.kind).toBe("video");expect(recipe.duration).toBe(1501.2);expect(recipe.audio).toEqual(["1.1"]);
});
test("new choices and long moving-video plans require a matching receiver and retained intent", () => {
 const policy={videoMotion:["1.1"],videoFrameThresholdSeconds:1500};
 const plan=composePlan([post(1600)],policy);
 expect(requiredPlanCapabilities(plan)).toContain("video-representation-v2");
 requireRetainedCompositionPolicy({policy},plan);
 expect(()=>requireRetainedCompositionPolicy({policy},composePlan([post(1600)],{videoFrameThresholdSeconds:1500}))).toThrow("video representation");
});
test("a retained or intermediary plan cannot label an explicit Video choice as a frame",()=>{
 const frame=composePlan([post(1600)],{videoFrames:["1.1"]});
 expect(()=>blockPlanSchema.parse({...frame,policy:{...frame.policy,videoFrames:[],videoMotion:["1.1"]}})).toThrow("cannot be represented as a frame");
});
test("moving-video preference survives a deliberately hidden quote without forcing its media into the block",async()=>{
 const{assignMediaRefs}=await import("../packages/core/providers/provider.ts");
 const root=assignMediaRefs({provider:"x",id:"1",canonicalUrl:"https://x.com/root/status/1",author:{handle:"root"},text:"Root",media:[],quote:post(1600)},0);
 const active=blockPlanSchema.parse(composePlan([root],{videoMotion:["1.1"],quoteDepth:1}));expect(active.block.kind).toBe("video");
 const hidden=blockPlanSchema.parse(composePlan([root],{videoMotion:["1.1"],quoteDepth:0}));expect(hidden.block.kind).toBe("text");expect(hidden.policy.videoMotion).toEqual(["1.1"]);
});
