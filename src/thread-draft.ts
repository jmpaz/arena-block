import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { renderThreadMarkdown, renderThreadHtml, threadCoverageReport, type ThreadCapture } from "./thread-capture.ts";

export type ThreadDraftSelection = {
  scope: "chain" | "tree";
  media: "none" | "images" | "all";
  selectedIds?: string[];
};

/** A fresh owned bundle keeps original capture evidence separate from curator selections. */
export async function writeThreadDraft(capture: ThreadCapture, directory: string, selection: ThreadDraftSelection, signal?: AbortSignal) {
  if (!["chain", "tree"].includes(selection.scope) || !["none", "images", "all"].includes(selection.media)) throw new Error("Invalid draft selection");
  const ids = selection.selectedIds?.length ? new Set(selection.selectedIds) : new Set(capture.posts.map(post => post.id));
  for (const id of ids) if (!capture.posts.some(post => post.id === id)) throw new Error(`Selected post ${id} was not captured`);

  // Quotes provide context for a selected post; preserve their entire reachable chain.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of capture.edges) {
      if (edge.kind === "quote" && ids.has(edge.from) && !ids.has(edge.to)) {
        ids.add(edge.to);
        changed = true;
      }
    }
  }
  const view: ThreadCapture = {
    ...capture,
    posts: capture.posts.filter(post => ids.has(post.id)).map(post => ({
      ...post,
      media: post.media.filter(media => selection.media === "all" || selection.media === "images" && media.kind === "image"),
    })),
    edges: capture.edges.filter(edge => edge.kind === "quote" ? ids.has(edge.from) && ids.has(edge.to) : ids.has(edge.from) || ids.has(edge.to)),
    coverage: {
      ...capture.coverage,
      limits: [...capture.coverage.limits, `Draft curator selection: ${ids.size} post IDs, ${selection.media} media. The complete acquired snapshot and original media references remain in capture.json.`],
    },
  };
  const selectedMedia = view.posts.flatMap(post => post.media.map(media => ({ postId: post.id, url: media.url, kind: media.kind })));
  const manifest = {
    version: 1,
    source: capture.sourceUrl,
    capturedAt: capture.capturedAt,
    selection: { ...selection, selectedIds: [...ids], selectedMedia },
    omittedPostIds: capture.posts.filter(post => !ids.has(post.id)).map(post => post.id),
    omittedMedia: capture.posts.flatMap(post => post.media
      .filter(media => !selectedMedia.some(selected => selected.postId === post.id && selected.url === media.url))
      .map(media => ({ postId: post.id, url: media.url, kind: media.kind }))),
    coverage: capture.coverage,
  };
  const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const run = `thread-${digest.slice(0, 12)}-${crypto.randomUUID()}`;
  const staging = join(directory, `.${run}`);
  signal?.throwIfAborted();
  await mkdir(staging, { recursive: true });
  try {
    const files = {
      "capture.json": JSON.stringify(capture, null, 2),
      "manifest.json": JSON.stringify(manifest, null, 2),
      "thread.md": renderThreadMarkdown(view),
      "thread.html": renderThreadHtml(view),
      "coverage.txt": threadCoverageReport(capture),
    };
    for (const [name, data] of Object.entries(files)) {
      signal?.throwIfAborted();
      await Bun.write(join(staging, name), data);
    }
    signal?.throwIfAborted();
    await rename(staging, join(directory, run));
    return { directory: join(directory, run), manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
