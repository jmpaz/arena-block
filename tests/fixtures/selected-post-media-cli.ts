import { writeFileSync } from "node:fs";
import observed from "./x-quoted-video-2111482639052116051.json";

const image = (id: string) => ({ type: "photo", url: `https://media.example/${id}.jpg`, width: 640, height: 480 });
const video = (id: string) => ({ type: "video", url: `https://media.example/${id}.mp4`, width: 640, height: 480, duration: 5, thumbnail_url: `https://media.example/${id}.jpg` });
const other = { id: "201", author: { id: "other", screen_name: "other" }, text: "Quote-only writing.", media: { all: [video("201")] } };
const second = { id: "102", author: { id: "selected", screen_name: "selected" }, text: "Second selected writing.",
  replying_to: { status: "101", screen_name: "selected" }, media: { all: [image("102")] }, quote: other };
const first = { id: "101", author: { id: "selected", screen_name: "selected" }, text: "First selected writing.",
  media: { all: [image("101"), video("101")] }, quote: second };
const extra = { id: "301", author: { id: "extra", screen_name: "extra" }, text: "Extra writing stays excluded.",
  media: { all: [image("301")] }, quote: other };
const tweets = new Map<string, unknown>([first, second, other, extra].map(post => [post.id, post]));
function retain(post: any): any {
  const tweet = { id: post.id, author: { screen_name: post.author.handle }, text: post.text,
    ...(post.postedAt ? { created_at: post.postedAt } : {}),
    media: { all: post.media.map((asset: any) => ({ type: asset.kind === "image" ? "photo" : asset.kind, url: asset.url,
      width: asset.width, height: asset.height, duration: asset.durationSeconds, thumbnail_url: asset.posterUrl })) },
    ...(post.quote ? { quote: retain(post.quote) } : {}) };
  tweets.set(post.id, tweet);return tweet;
}
observed.sources.forEach(retain);
const ledger = { entry: process.argv[1], requests: [] as string[] };
const save = () => { if (process.env.ARENA_SELECTION_LEDGER) writeFileSync(process.env.ARENA_SELECTION_LEDGER, JSON.stringify(ledger)); };
save();
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const url = new URL(String(input));ledger.requests.push(url.href);save();
  if (url.origin !== "https://api.fxtwitter.com") throw new Error("Unexpected fixture request");
  const id = url.pathname.split("/").at(-1)!, tweet = tweets.get(id);
  if (!tweet) throw new Error("Unknown fixture post");
  if (url.pathname.startsWith("/2/thread/")) {
    if (!["101", "102"].includes(id)) throw new Error("Unknown fixture thread");
    return Response.json({ code: 200, status: tweet, thread: [first, second] });
  }
  return Response.json({ code: 200, tweet });
}, { preconnect: globalThis.fetch.preconnect });
