import {expect,test}from"bun:test";
import{join}from"node:path";
function run(duration:number,args:string[]=[]){const p=Bun.spawnSync([Bun.which("bun")!,"--preload",join(import.meta.dir,"fixtures/video-choice-cli.ts"),"src/cli.ts",...args.slice(0,args.indexOf("plan")<0?0:args.indexOf("plan")),"plan","https://www.tiktok.com/@author/video/7703354368283708703",...args.slice(args.indexOf("plan")<0?0:args.indexOf("plan")+1),"--json"],{cwd:join(import.meta.dir,".."),env:{...process.env,ARENA_TEST_DURATION:String(duration),ARENA_BLOCK_ACCESS_TOKEN:""},stdout:"pipe",stderr:"pipe"});return{code:p.exitCode,out:p.stdout.toString(),error:p.stderr.toString()};}
test("CLI default boundary and explicit Video/Frame work in either option position",()=>{
 for(const duration of[707,1500]){const r=run(duration);expect(r.code).toBe(0);const p=JSON.parse(r.out);expect(p.block.kind).toBe("video");expect(p.policy.videoFrameThresholdSeconds).toBe(1500);}
 const frame=run(1501);expect(frame.code).toBe(0);expect(JSON.parse(frame.out).block.kind).toBe("link");
 for(const args of[["--video","1.1"],["--video","1.1","plan"]]){const r=run(1501,args);expect(r.code).toBe(0);expect(JSON.parse(r.out).block.kind).toBe("video");expect(JSON.parse(r.out).policy.videoMotion).toEqual(["1.1"]);}
 expect(JSON.parse(run(707,["--frame","1.1"]).out).block.kind).toBe("link");
 expect(run(707,["--frame","1.1","--video","1.1"]).code).not.toBe(0);
});
