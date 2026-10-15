import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubstackProvider } from "../packages/core/providers/substack.ts";
import { assignMediaRefs } from "../packages/core/providers/provider.ts";
import { parseSource } from "../packages/core/url.ts";
import { composePlan } from "../packages/core/compose.ts";
import { blockPlanSchema, type ResolvedPost } from "../packages/core/types.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";
import { buildInfo } from "../src/version.ts";
import { renderPlan } from "../src/render.ts";

const fixture = await Bun.file(new URL("./fixtures/substack-public-podcast.json", import.meta.url)).json();
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function resolve(value = fixture) { return assignMediaRefs(await new SubstackProvider([], (async () => Response.json(value)) as unknown as typeof fetch).resolve(parseSource(value.canonical_url)), 0); }
function wav() { const bytes = Buffer.alloc(44 + 16000); bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8,4); bytes.write("WAVEfmt ",8); bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22); bytes.writeUInt32LE(8000,24); bytes.writeUInt32LE(16000,28); bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34); bytes.write("data",36); bytes.writeUInt32LE(16000,40); return bytes; }
async function audioPlan(duration = 1) { const post = await resolve(); post.media = post.media.filter(m => m.kind === "audio").map(m => ({ ...m, durationSeconds: duration })); post.substackArticle!.nativeMedia = post.substackArticle!.nativeMedia!.filter(m => m.kind === "audio").map(m => ({ ...m, durationSeconds: duration })); return composePlan([post], { media: "audio" }); }
async function directory() { const dir = await mkdtemp(join(tmpdir(),"substack-audio-test-")); dirs.push(dir); return dir; }
function response(body: BodyInit | ReadableStream, headers = {}): typeof fetch { return (async () => new Response(body, { headers })) as unknown as typeof fetch; }
async function stagingEmpty(dir: string) { expect(await readdir(join(dir,".staging"))).toEqual([]); }

test("native public podcast retains stable originals and external linked video distinctions", async () => {
  const post = await resolve(); const [video,audio] = post.media;
  expect(video).toMatchObject({kind:"video", acquisition:"substack-public-original",durationSeconds:1460});
  expect(video!.url).toBe(`https://www.lennysnewsletter.com/api/v1/video/upload/${fixture.video_upload_id}/src?type=mp4&override_publication_id=10845`);
  expect(video!.posterUrl).toEndWith("transcoded-00001.png");
  expect(audio).toMatchObject({kind:"audio", url:fixture.podcast_url, acquisition:"substack-public-original"});
  expect(post.article).toContain("Linked video (not acquired)"); expect(post.article).toContain("https://www.youtube.com/watch?v=pJNM1z9l5mU");
  const automatic = composePlan([post]); expect(automatic.block.selectedMedia).toEqual(["1.1"]); expect(automatic.block.frameMedia?.[0]?.url).toBe(video!.posterUrl);
  const plan = composePlan([post],{media:"audio"}); expect(plan.block.kind).toBe("audio"); expect(plan.block.layout).toBeUndefined(); expect(blockPlanSchema.parse(plan)).toEqual(plan);
  expect(composePlan([post],{media:"selected", selectedMedia:["1.2"]}).block.kind).toBe("audio");
  expect(composePlan([{...post,media:[audio!]}]).block.kind).toBe("audio");
  expect(() => composePlan([post],{media:"all"})).toThrow("alone");
  expect(requiredPlanCapabilities(plan)).toContain("substack-native-media-v1"); expect(buildInfo().planCapabilities).toContain("substack-native-media-v1");
});
test("ordered sources and media extras automatically prefer podcast visuals over alternate audio", async () => {
  const note: ResolvedPost = {provider:"substack",id:"42",canonicalUrl:"https://substack.com/note/c-42",author:{handle:"writer"},text:"Note",media:[]};
  const podcast = assignMediaRefs(await resolve(),1);
  for (const policy of [{media:"auto" as const},{media:"auto" as const,mediaOnlyPosts:[2]}]) { const plan=composePlan([note,podcast],policy); expect(plan.block.selectedMedia).toEqual(["2.1"]); expect(plan.block.frameMedia).toHaveLength(1); }
});
test("paid, preview, mismatched and unverified native uploads cannot be promoted to originals", async () => {
  for (const value of [{...fixture,audience:"only_paid"},{...fixture,videoUpload:{...fixture.videoUpload,is_free_preview:true}},{...fixture,videoUpload:{...fixture.videoUpload,post_id:1}},{...fixture,podcast_url:fixture.podcast_url+"?token=account"},{...fixture,videoUpload:null}]) await expect(resolve(value)).rejects.toThrow();
});
test("CLI original audio derives actual container and preserves bytes and MIME without conversion", async () => {
  const dir=await directory(), bytes=wav(); let seen: RequestInit | undefined;
  const fetcher=(async (_url: unknown, init?: RequestInit) => {seen=init;return new Response(bytes,{headers:{"content-type":"audio/mpeg"}});}) as unknown as typeof fetch;
  const result=await renderPlan(await audioPlan(),dir,{fetcher}); expect(result!.extension).toBe("wav"); expect(result!.mimeType).toBe("audio/wav"); expect(Buffer.from(await Bun.file(result!.path).arrayBuffer())).toEqual(bytes); expect(seen!.credentials).toBe("omit"); await stagingEmpty(dir);
});
test("CLI declared and chunked overflow, invalid payload and truncated audio remove staging", async () => {
  const plan=await audioPlan();
  for (const fetcher of [response(wav(),{"content-length":"100000"}), response(new ReadableStream({start(c){c.enqueue(wav());c.close();}})),response("<html>not audio</html>")]) {
    const dir=await directory(); await expect(renderPlan(plan,dir,{fetcher,maximumAudioBytes:100})).rejects.toThrow(); await stagingEmpty(dir);
  }
  const dir=await directory(); await expect(renderPlan(await audioPlan(1460),dir,{fetcher:response(wav())})).rejects.toThrow("duration"); await stagingEmpty(dir);
});
test("CLI stalled original audio obeys cancellation and cleans staging", async () => {
  const controller=new AbortController(),dir=await directory(); let cancelled=false;
  const fetcher=response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}));
  const pending=renderPlan(await audioPlan(),dir,{fetcher,signal:controller.signal}); setTimeout(()=>controller.abort(new Error("cancel capture")),20);
  await expect(pending).rejects.toThrow("cancel capture"); await stagingEmpty(dir); expect(cancelled).toBe(true);
});
test("short native video follows normal delivery redirect and rejects a shortened original", async () => {
  const dir=await directory(),file=join(dir,"source.mp4");
  const child=Bun.spawn(["ffmpeg","-nostdin","-loglevel","error","-f","lavfi","-i","color=blue:s=128x128:r=10","-t","0.3","-c:v","libx264","-pix_fmt","yuv420p","-y",file],{stdout:"ignore",stderr:"pipe"});
  expect(await child.exited).toBe(0);
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){ const url=new URL(request.url); return url.pathname==="/src" ? Response.redirect(new URL("/original.mp4",url),307) : new Response(Bun.file(file)); }});
  try {
    const post=await resolve(),video=post.media.find(m=>m.kind==="video")!; video.url=`http://127.0.0.1:${server.port}/src`; video.durationSeconds=0.3; delete video.posterUrl; post.media=[video];
    const result=await renderPlan(composePlan([post],{media:"video"}),dir); expect(result!.mimeType).toBe("video/mp4"); expect(result!.size).toBeGreaterThan(0);
    video.durationSeconds=10; await expect(renderPlan(composePlan([post],{media:"video"}),dir)).rejects.toThrow("duration"); await stagingEmpty(dir);
  } finally { await server.stop(true); }
});
