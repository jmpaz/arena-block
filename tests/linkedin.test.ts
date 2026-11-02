import { describe, expect, test } from "bun:test";
import { LinkedInProvider, linkedInPostFromPage } from "../packages/core/providers/linkedin.ts";
import { SocialResolver } from "../packages/core/providers/index.ts";
import { captureSource } from "../packages/core/capture.ts";
import { composePlan } from "../packages/core/compose.ts";
import { parseSource } from "../packages/core/url.ts";
import { requiredPlanCapabilities } from "../src/plan-capabilities.ts";

const url = "https://www.linkedin.com/posts/fixture_caption-activity-1234567890123456789-AbCd";
const source = parseSource(url);
if (source.provider !== "linkedin") throw new Error("fixture source");
const record = { "@type": "VideoObject", "@id": url, creator: { name: "Fixture Company", url: "https://uk.linkedin.com/company/fixture" },
  description: "First paragraph.\n\nSecond #example", datePublished: "2022-01-24T16:24:39.137Z", duration: "PT42S",
  contentUrl: "https://dms.licdn.com/video.mp4", thumbnailUrl: "https://media.licdn.com/poster.jpg",
  embedUrl: "https://www.linkedin.com/embed/feed/update/urn:li:activity:1234567890123456789?compact=true" };
const page = (value: unknown) => `<html><script type="application/ld+json">${JSON.stringify(value)}</script></html>`;

describe("LinkedIn public video posts", () => {
  test("normalizes tracking and classifies the URL as a social capture", () => {
    expect(captureSource(`${url}?tracking=abc`)).toEqual({ kind: "social", url });
    expect(parseSource(`${url}?tracking=abc`).id).toBe(source.id);
    expect(captureSource("https://www.linkedin.com/company/fixture")).toEqual({ kind: "url", url: "https://www.linkedin.com/company/fixture" });
    expect(captureSource("https://www.linkedin.com/feed/update/urn:li:activity:123")).toEqual({ kind: "url", url: "https://www.linkedin.com/feed/update/urn:li:activity:123" });
    for (const invalid of ["http://linkedin.com/posts/a-activity-1-b", "https://user:pw@linkedin.com/posts/a-activity-1-b", "https://linkedin.com:4430/posts/a-activity-1-b"]) expect(() => parseSource(invalid)).toThrow();
  });
  test("uses the ordinary composition, media, attribution and capability contracts", async () => {
    const resolver = new SocialResolver({ linkedin: new LinkedInProvider(async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(page(record), { headers: { "content-type": "text/html" } });
    }) });
    const resolved = await resolver.resolveComposition([url]);
    const plan = composePlan(resolved.posts, resolved.policy);
    expect(plan.sources[0]).toMatchObject({ provider: "linkedin", id: source.id, author: { handle: "fixture", name: "Fixture Company" }, text: record.description, postedAt: record.datePublished,
      media: [{ ref: "1.1", kind: "video", url: record.contentUrl, posterUrl: record.thumbnailUrl, durationSeconds: 42 }] });
    expect(plan.block).toMatchObject({ kind: "video", title: "Post by @fixture", markdown: record.description, canonicalSource: url, selectedMedia: ["1.1"] });
    expect(composePlan(resolved.posts, { media: "none" }).block.markdown).toEndWith("*[video]*");
    expect(requiredPlanCapabilities(plan)).toEqual(["video-representation-v2", "linkedin-posts-v1"]);
  });
  test("keeps a leading hashtag literal in Are.na Markdown while retaining source text", () => {
    const post = linkedInPostFromPage(source, page({ ...record, description: "Caption\n\n#Example #Design" }));
    const plan = composePlan([post]);
    expect(plan.sources[0]!.text).toBe("Caption\n\n#Example #Design");
    expect(plan.block.markdown).toBe("Caption\n\n\\#Example #Design");
  });
  test("rejects identity mismatches and incomplete or unsafe data", () => {
    for (const changes of [ { "@id": url.replace(source.id, "888") }, { embedUrl: record.embedUrl.replace(source.id, "888") },
      { creator: null }, { description: null }, { contentUrl: "https://evil.test/video.mp4" }, { thumbnailUrl: "file:///etc/passwd" },
      { datePublished: "yesterday" }, { "@type": "DiscussionForumPosting" } ]) {
      expect(() => linkedInPostFromPage(source, page({ ...record, ...changes }))).toThrow();
    }
    expect(() => linkedInPostFromPage(source, page([record, record]))).toThrow();
    expect(() => linkedInPostFromPage(source, '<script type="application/ld+json">{</script>')).toThrow();
  });
  test("stops on access denial, redirects, and non-HTML responses", async () => {
    for (const code of [302, 401, 403, 429, 503]) {
      const client = new LinkedInProvider(async () => new Response(null, { status: code }));
      await expect(client.resolve(source)).rejects.toThrow(`HTTP ${code}`);
    }
    await expect(new LinkedInProvider(async () => new Response("login", { headers: { "content-type": "text/plain" } })).resolve(source)).rejects.toThrow();
    await expect(new LinkedInProvider(async (_url, init) => { init?.signal?.throwIfAborted(); return new Response(page(record)); }).resolve(source, AbortSignal.abort())).rejects.toThrow();
  });
});
