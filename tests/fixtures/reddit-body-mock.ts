import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { composePlan } from "../../src/compose.ts";
import { publicationFields } from "../../src/capture.ts";
import { SocialResolver } from "../../src/providers/index.ts";
import { RedditProvider } from "../../src/providers/reddit.ts";
import { captureRenderRecipe } from "../../packages/core/render-recipe.ts";
import fixture from "./reddit-body-images.json";

// Fixture-only resolution. No API writes, uploads, or network reads.
const directory = resolve(process.argv[2] ?? "/tmp/arena-reddit-body-evidence");
await mkdir(directory, { recursive: true });
const reddit = new RedditProvider(async () => Response.json([{ data: { children: [{ data: fixture.post }] } }]));
const posts = await new SocialResolver({ reddit }).resolve([`https://www.reddit.com${fixture.post.permalink}`]);
const plans = { automatic: composePlan(posts), all: composePlan(posts, { media: "all" }),
  bodyOnly: composePlan(posts, { media: "selected", selectedMedia: ["1.2"] }),
  bodyFirst: composePlan(posts, { media: "all", mediaOrder: ["1.2", "1.1"] }) };
const cases = Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, { plan, fields: publicationFields(plan), recipe: captureRenderRecipe(plan) }]));
await Bun.write(join(directory, "mock.json"), JSON.stringify({ provenance: fixture.provenance, cases }, null, 2) + "\n");
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const sections = Object.entries(plans).map(([name, plan]) => {
  const recipe = captureRenderRecipe(plan)!;
  const media = new Map(plan.sources.flatMap(post => post.media).map(item => [item.ref, item]));
  return `<section><h2>${name}</h2><p>Selected: ${escape(plan.block.selectedMedia.join(", "))}</p><div class="mosaic" style="aspect-ratio:${recipe.width}/${recipe.height}">${recipe.tiles.map(tile => {
    const asset = media.get(tile.ref)!;
    return `<img alt="${escape(`${tile.ref} ${asset.id}`)}" src="${escape(asset.url)}" style="left:${100 * tile.rect.x / recipe.width}%;top:${100 * tile.rect.y / recipe.height}%;width:${100 * tile.rect.width / recipe.width}%;height:${100 * tile.rect.height / recipe.height}%">`;
  }).join("")}</div></section>`;
}).join("");
await Bun.write(join(directory, "mock.html"), `<!doctype html><meta charset="utf-8"><title>Private Reddit body-image fixture</title><style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:16px}section{margin:32px 0}.mosaic{position:relative;background:#ddd}.mosaic img{position:absolute;object-fit:contain}pre{white-space:pre-wrap}</style><h1>Private Reddit fixture preview</h1><p>Local mock; images reference their original public Reddit URLs. No block was published.</p>${sections}<h2>Unchanged authored body</h2><pre>${escape(fixture.post.selftext)}</pre>`);
console.log(directory);
