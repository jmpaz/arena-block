import { describe, expect, test } from "bun:test";
import { composePlan } from "../src/compose.ts";
import { publicationFields } from "../src/capture.ts";
import { blockPlanSchema, type LayoutNode, type ResolvedPost } from "../src/types.ts";
import { arenaDestination, normalizeArenaDestinations, parseSource } from "../src/url.ts";

function post(overrides: Partial<ResolvedPost> = {}): ResolvedPost {
  return {
    provider: "x",
    id: "100",
    canonicalUrl: "https://x.com/root/status/100",
    author: { handle: "root", name: "Root" },
    text: "First paragraph.\n\nSecond paragraph.",
    media: [],
    ...overrides,
  };
}

describe("composition", () => {
  test("preserves paragraph breaks in text blocks", () => {
    const plan = composePlan([post()]);
    expect(plan.block.kind).toBe("text");
    expect(plan.block.title).toBe("Post by @root");
    expect(plan.block.markdown).toBe("First paragraph.\n\nSecond paragraph.");
  });

  test("puts the quote author inline at the top of the blockquote", () => {
    const plan = composePlan([post({
      text: "Root response.",
      quote: post({
        id: "99",
        canonicalUrl: "https://x.com/quoted/status/99",
        author: { handle: "quoted" },
        text: "Quoted thought.\n\nAnother paragraph.",
      }),
    })]);
    expect(plan.block.markdown).toBe(
      "> `@quoted`\n> Quoted thought.\n>\n> Another paragraph.\n\nRoot response.",
    );
  });

  test("keeps an independently authored same-author quote tag without repeating the root tag", () => {
    const plan = composePlan([post({
      text: "Root response.",
      quote: post({ id: "99", text: "Quoted thought." }),
    })]);
    expect(plan.block.markdown).toBe("> `@root`\n> Quoted thought.\n\nRoot response.");
  });

  test("same-author nested quotes retain their levels and only older quote dates", () => {
    const plan = composePlan([
      post({ postedAt: "Wed Oct 07 19:35:15 +0000 2026", text: "Newest result.", quote: post({
        postedAt: "Wed Oct 07 19:34:00 +0000 2026", text: "Earlier result.", quote: post({
          postedAt: "Wed Oct 07 19:33:00 +0000 2026", text: "Original result.",
        }),
      }) }),
      post({ id: "101", canonicalUrl: "https://x.com/root/status/101", postedAt: "Wed Oct 07 19:35:16 +0000 2026", text: "Proof notes: https://example.test/proof" }),
    ]);
    expect(plan.block.kind).toBe("text");
    expect(plan.block.markdown).toBe("> > `@root`\n> > Original result.\n>\n> `@root`\n> Earlier result.\n\nNewest result.\n\n---\n\nProof notes: https://example.test/proof");
    expect(publicationFields(plan).content).toBe(plan.block.markdown);
    expect(plan.sources.map(source => source.canonicalUrl)).toEqual(["https://x.com/root/status/100", "https://x.com/root/status/101"]);

    const older = composePlan([post({ postedAt: "Wed Oct 07 19:35:15 +0000 2026", text: "Today.", quote: post({
      postedAt: "Tue Oct 06 18:00:00 +0000 2026", text: "Yesterday.",
    }) })]);
    expect(older.block.markdown).toBe("> `@root` (Oct 6, 2026)\n> Yesterday.\n\nToday.");
  });

  test("Andrew's Anthropic root quote stays first while his plain self-reply keeps its text", () => {
    const root = post({ id: "2108244808494154089", canonicalUrl: "https://x.com/AndrewCurran_/status/2108244808494154089",
      author: { handle: "AndrewCurran_" }, text: "Effective November 12th, 2026, abusive behavior towards Claude will be a violation of Anthropic's Usage Policy.",
      quote: post({ id: "2108241513159528705", author: { handle: "haydenfield" }, text: "Exclusive: Anthropic is updating its usage policy." }) });
    const reply = post({ id: "2108245805169844232", author: { handle: "AndrewCurran_" },
      replyTo: { id: root.id, authorHandle: "AndrewCurran_" }, text: "@repligate @anthrupad Anthropic did it first." });
    const plan = composePlan([root, reply]);
    expect(plan.block.title).toBe("Post by @AndrewCurran_");
    expect(plan.block.markdown).toBe("> `@haydenfield`\n> Exclusive: Anthropic is updating its usage policy.\n\nEffective November 12th, 2026, abusive behavior towards Claude will be a violation of Anthropic's Usage Policy.\n\n---\n\n@repligate @anthrupad Anthropic did it first.");
  });

  test("Andrew's verified self-replies introduce Jasmine and Tomek before their quotes", () => {
    const root = post({ id: "2108271344286892133", author: { handle: "AndrewCurran_" },
      text: "The three OpenAI employees have posted an open letter.",
      quote: post({ id: "2108262814003687745", author: { handle: "balesni" }, text: "We wrote this letter to leadership." }) });
    const jasmine = post({ id: "2108277692819017822", author: { handle: "AndrewCurran_" },
      replyTo: { id: root.id, authorHandle: "AndrewCurran_" }, text: "Jasmine Wang:",
      quote: post({ id: "2108263312291180680", author: { handle: "j_asminewang" }, text: "OpenAI fired me last week.",
        quote: post({ id: "2108262814003687745", author: { handle: "balesni" }, text: "We wrote this letter to leadership." }) }) });
    const tomek = post({ id: "2108277964911878220", author: { handle: "AndrewCurran_" },
      replyTo: { id: jasmine.id, authorHandle: "AndrewCurran_" }, text: "Tomek Korbak:",
      quote: post({ id: "2108266859397283953", author: { handle: "tomekkorbak" }, text: "I raised safety concerns." }) });
    const plan = composePlan([root, jasmine, tomek]);
    const markdown = plan.block.markdown;
    expect(markdown).toStartWith("> `@balesni`\n> We wrote this letter to leadership.\n\nThe three OpenAI employees have posted an open letter.");
    expect(markdown).toContain("Jasmine Wang:\n\n> > `@balesni`\n> > We wrote this letter to leadership.\n>\n> `@j_asminewang`\n> OpenAI fired me last week.");
    expect(markdown).toContain("Tomek Korbak:\n\n> `@tomekkorbak`\n> I raised safety concerns.");
    expect(markdown).not.toContain("`@AndrewCurran_`");
    expect(plan.sources.map(source => source.replyTo?.id)).toEqual([undefined, root.id, jasmine.id]);
  });

  test("quote order changes only for an adjacent verified same-author x.com reply", () => {
    const root = post({ id: "100", text: "Root." });
    const quote = post({ id: "900", author: { handle: "quoted" }, text: "Cited text." });
    const sameReply = post({ id: "101", replyTo: { id: root.id, authorHandle: "root" }, text: "Introduction:", quote });
    expect(composePlan([root, sameReply]).block.markdown).toContain("Introduction:\n\n> `@quoted`\n> Cited text.");
    expect(composePlan([root, sameReply], { quote: "sequence" }).block.markdown).toContain("Introduction:\n\n`@quoted`\nCited text.");
    expect(composePlan([root, sameReply], { quote: "omit" }).block.markdown).not.toContain("Cited text.");
    const otherReply = { ...sameReply, author: { handle: "other" }, canonicalUrl: "https://x.com/other/status/101" };
    expect(composePlan([root, otherReply]).block.markdown).toContain("`@other`\n> `@quoted`\n> Cited text.\n\nIntroduction:");
    const wrongParent = { ...sameReply, replyTo: { id: "unobserved", authorHandle: "root" } };
    expect(composePlan([root, wrongParent]).block.markdown).toContain("> `@quoted`\n> Cited text.\n\nIntroduction:");
    expect(composePlan([sameReply]).block.markdown).toStartWith("> `@quoted`");
  });

  test("renders a quote as labelled sequence on request", () => {
    const plan = composePlan([post({
      text: "Root response.",
      quote: post({ author: { handle: "quoted" }, text: "Quoted thought." }),
    })], { quote: "sequence" });
    expect(plan.block.markdown).toBe(
      "`@quoted`\nQuoted thought.\n\nRoot response.",
    );
  });

  test("labels quoted authors and changed speaker turns without repeating the root speaker", () => {
    const sources = [
      post({ author: { handle: "TomDavidsonX" }, text: "I think we're in the Paul world.",
        quote: post({ id: "99", author: { handle: "allTheYud" }, text: "Slow takeoff thought." }) }),
      post({ id: "101", canonicalUrl: "https://x.com/TomDavidsonX/status/101",
        author: { handle: "TomDavidsonX" }, text: "A follow-up." }),
      post({ id: "102", canonicalUrl: "https://x.com/kartographien/status/102",
        author: { handle: "kartographien" }, text: "Too early to tell.",
        quote: post({ id: "98", author: { handle: "kartographien" }, text: "A prior thought." }) }),
      post({ id: "103", canonicalUrl: "https://x.com/kartographien/status/103",
        author: { handle: "kartographien" }, text: "A second follow-up." }),
    ];
    const markdown = composePlan(sources).block.markdown;
    expect(markdown).toBe(
      "> `@allTheYud`\n> Slow takeoff thought.\n\nI think we're in the Paul world.\n\n---\n\nA follow-up.\n\n---\n\n`@kartographien`\n> `@kartographien`\n> A prior thought.\n\nToo early to tell.\n\n---\n\nA second follow-up.",
    );
  });

  test("defaults multiple primary posts to their ordered text and media", () => {
    const media = [{ ref: "1.1", kind: "image" as const, url: "https://example.test/1.jpg", alt: "" }];
    const plan = composePlan([
      post({ text: "One", media }),
      post({ id: "101", canonicalUrl: "https://x.com/root/status/101", text: "Two", media: [{ ...media[0]!, ref: "2.1" }] }),
    ]);
    expect(plan.block.kind).toBe("link");
    expect(plan.block.selectedMedia).toEqual(["1.1", "2.1"]);
    expect(plan.block.markdown).toBe("One\n\n*[image]*\n\n---\n\nTwo\n\n*[image]*");
    expect(plan.sources.map(source => source.canonicalUrl)).toEqual(["https://x.com/root/status/100", "https://x.com/root/status/101"]);
  });

  test("same-author thread keeps authored text and only dates an older quote", () => {
    const image = { ref: "1.1", kind: "image" as const, url: "https://example.test/cover.jpg", alt: "" };
    const sources = [
      post({ postedAt: "Wed Oct 07 17:08:04 +0000 2026", text: "Opening thought.", media: [image] }),
      post({ id: "101", canonicalUrl: "https://x.com/root/status/101", postedAt: "Wed Oct 07 17:08:05 +0000 2026",
        text: "Literal cited source: https://x.com/OpenAI/status/123", quote: post({
          author: { handle: "OpenAI" }, postedAt: "Tue Oct 06 17:00:00 +0000 2026", text: "Older quoted thought.",
        }) }),
      post({ id: "102", canonicalUrl: "https://x.com/root/status/102", postedAt: "Wed Oct 07 17:08:06 +0000 2026",
        text: "Closing thought.", quote: post({ author: { handle: "today" }, postedAt: "Wed Oct 07 09:00:00 +0000 2026", text: "Today quoted thought." }) }),
    ];
    const plan = composePlan(sources);
    const published = String(publicationFields(plan).description);
    expect(plan.block.kind).toBe("link");
    expect(published).toBe(plan.block.markdown);
    expect(published).toContain("`@OpenAI` (Oct 6, 2026)");
    expect(published).toContain("`@today`\n> Today quoted thought.");
    expect(published).toContain("Literal cited source: https://x.com/OpenAI/status/123");
    expect(published).not.toContain("`@root`");
    expect(published).not.toContain("[source](");
    expect(published.match(/\n\n---\n\n/g)).toHaveLength(2);
    expect(published).not.toContain("17:08:");
    expect(plan.sources.map(source => source.canonicalUrl)).toEqual(sources.map(source => source.canonicalUrl));
    expect(plan.sources[1]?.postedAt).toBe("Wed Oct 07 17:08:05 +0000 2026");
  });

  test("speaker labels begin turns and return to the first author", () => {
    const plan = composePlan([
      post({ text: "First voice." }),
      post({ id: "101", author: { handle: "other" }, text: "Second voice." }),
      post({ id: "102", author: { handle: "other" }, text: "Same second voice." }),
      post({ id: "103", text: "First voice returns." }),
    ]);
    expect(plan.block.markdown).toBe("First voice.\n\n---\n\n`@other`\nSecond voice.\n\n---\n\nSame second voice.\n\n---\n\n`@root`\nFirst voice returns.");
  });

  test("depicts a post's attachments on one marker line", () => {
    const marker = (...kinds: ("image" | "video")[]) => composePlan([post({
      text: "Caption",
      media: kinds.map((kind, index) => ({ ref: `1.${index + 1}`, kind, url: `https://example.test/${index}`, alt: "" })),
    })], { media: "none" }).block.markdown;
    expect(marker("image")).toBe("Caption\n\n*[image]*");
    expect(marker("image", "image", "image")).toBe("Caption\n\n*[images]*");
    expect(marker("video", "video")).toBe("Caption\n\n*[videos]*");
    expect(marker("image", "video", "image", "image")).toBe("Caption\n\n*[image, video, image, image]*");
  });

  test("labels other authors without inserting source links or changing reply mentions", () => {
    const plan = composePlan([
      post({ author: { handle: "TheStalwart" }, text: "A question?\n\nSome context." }),
      post({
        id: "101",
        canonicalUrl: "https://x.com/_max_bo_/status/101",
        author: { handle: "_max_bo_" },
        text: "@TheStalwart First answer.",
      }),
      post({
        id: "102",
        canonicalUrl: "https://x.com/_max_bo_/status/102",
        author: { handle: "_max_bo_" },
        text: "@TheStalwart Second answer.",
      }),
    ]);
    expect(plan.block.markdown).toBe(
      "A question?\n\nSome context.\n\n---\n\n`@_max_bo_`\n@TheStalwart First answer.\n\n---\n\n@TheStalwart Second answer.",
    );
  });

  test("the separator preference remains explicit for multiple sources", () => {
    const sources = [post({ text: "First" }), post({ id: "101", canonicalUrl: "https://x.com/root/status/101", text: "Second" })];
    expect(composePlan(sources).block.markdown).toContain("\n\n---\n\n");
    expect(composePlan(sources, { separator: "always" }).block.markdown).toContain("\n\n---\n\n");
    expect(composePlan(sources, { separator: "never" }).block.markdown).not.toContain("\n\n---\n\n");
  });

  test("distinguishes authored Markdown rules from post boundaries", () => {
    const sources = [post({ text: "Opening\n---\nFollow-up\n  * * *" }),
      post({ id: "101", canonicalUrl: "https://x.com/root/status/101", text: "Next post" })];
    const plan = composePlan(sources);
    expect(plan.block.markdown).toBe("Opening\n\\---\nFollow-up\n  \\* * *\n\n---\n\nNext post");
    expect(plan.sources[0]?.text).toBe("Opening\n---\nFollow-up\n  * * *");
  });

  test("a rotating signed poster never changes save identity", () => {
    const source = post({ media: [{ ref: "1.1", kind: "video", url: "https://cdn.example/video.mp4",
      posterUrl: "https://cdn.example/frame.jpg?signature=first", alt: "" }] });
    const first = composePlan([source]);
    const later = composePlan([{ ...source, media: [{ ...source.media[0]!, posterUrl: "https://cdn.example/frame.jpg?signature=second" }] }]);
    expect(first.hash).toBe(later.hash);
    expect(first.sources[0]?.media[0]?.posterUrl).not.toBe(later.sources[0]?.media[0]?.posterUrl);
  });

  test("retains leading external mentions and separates structured posts", () => {
    const plan = composePlan([
      post({ text: "First paragraph.\n\nSecond paragraph." }),
      post({
        id: "101",
        canonicalUrl: "https://x.com/root/status/101",
        text: "@someone_else A separate structured reply.",
      }),
    ]);
    expect(plan.block.markdown).toBe(
      "First paragraph.\n\nSecond paragraph.\n\n---\n\n@someone_else A separate structured reply.",
    );
  });

  test("retains a leading mention run and distinct provider source", () => {
    const plan = composePlan([
      post({ text: "Root" }),
      post({
        id: "101",
        provider: "bluesky",
        canonicalUrl: "https://bsky.app/profile/replier.test/post/101",
        author: { handle: "replier.test" },
        text: "@outside.test @another-person A reply about @someone_else.",
      }),
    ]);
    expect(plan.block.markdown).toBe(
      "Root\n\n---\n\n`@replier.test`\n@outside.test @another-person A reply about @someone_else.",
    );
  });

  test("omits only a repeated reply-address run in an adjacent same-author x.com thread", () => {
    const root = post({ id: "100", text: "Thanks @alice and @bob. Inline @charlie stays." });
    const reply = post({ id: "101", canonicalUrl: "https://x.com/root/status/101", replyTo: { id: "100", authorHandle: "root" },
      replyAddressPrefix: "@alice @bob ", text: "@alice @bob The next step mentions @charlie in prose." });
    const next = post({ id: "102", canonicalUrl: "https://x.com/root/status/102", replyTo: { id: "101", authorHandle: "root" },
      replyAddressPrefix: "@alice @bob ", text: "@alice @bob Finally, @charlie reviews it." });
    const plan = composePlan([root, reply, next]);
    expect(plan.block.markdown).toBe("Thanks @alice and @bob. Inline @charlie stays.\n\n---\n\nThe next step mentions @charlie in prose.\n\n---\n\nFinally, @charlie reviews it.");
    expect(plan.sources[1]?.text).toBe(reply.text);
    expect(plan.sources[2]?.text).toBe(next.text);
  });

  test("keeps leading mentions for quote tweets, mixed speakers and uncertain reply addresses", () => {
    const root = post({ id: "100", text: "Thanks @alice and @bob." });
    const quoted = post({ id: "101", canonicalUrl: "https://x.com/root/status/101", replyTo: { id: "100" },
      replyAddressPrefix: "@alice @bob ", text: "@alice @bob A quote tweet.", quote: post({ id: "200", author: { handle: "quoted" }, text: "@alice @bob Quoted words." }) });
    const mixed = post({ id: "102", canonicalUrl: "https://x.com/other/status/102", author: { handle: "other" },
      replyTo: { id: "101" }, text: "@alice @bob Different speaker." });
    const deliberate = post({ id: "103", canonicalUrl: "https://x.com/other/status/103", author: { handle: "other" },
      replyTo: { id: "102" }, text: "@newperson A direct address." });
    const plan = composePlan([root, quoted, mixed, deliberate]);
    expect(plan.block.markdown).toContain("@alice @bob A quote tweet.");
    expect(plan.block.markdown).toContain("@alice @bob Quoted words.");
    expect(plan.block.markdown).toContain("@alice @bob Different speaker.");
    expect(plan.block.markdown).toContain("@newperson A direct address.");
  });

  test("builds a grouped cross-post mosaic with explicit media selection", () => {
    const first = post({
      text: "One\n\nMore",
      media: [1, 2, 3, 4].map((index) => ({ ref: `1.${index}`, kind: "image", url: `https://example.test/${index}.jpg`, width: 800, height: 600, alt: "" })),
    });
    const second = post({
      id: "101",
      canonicalUrl: "https://x.com/root/status/101",
      text: "Two",
      media: [1, 2, 3].map((index) => ({ ref: `2.${index}`, kind: "image", url: `https://example.test/b${index}.jpg`, width: 600, height: 800, alt: "" })),
    });
    const plan = composePlan([first, second], { media: "all" });
    expect(plan.block.kind).toBe("link");
    expect(plan.block.selectedMedia).toEqual(["1.1", "1.2", "1.3", "1.4", "2.1", "2.2", "2.3"]);
    expect(plan.block.layout).toMatchObject({ kind: "split", axis: "vertical" });
    expect(plan.block.markdown).toBe("One\n\nMore\n\n*[images]*\n\n---\n\nTwo\n\n*[images]*");
  });

  test("keeps three portrait images from one post in one row", () => {
    const media = [1, 2, 3].map((index) => ({
      ref: `1.${index}`,
      kind: "image" as const,
      url: `https://example.test/${index}.jpg`,
      width: 900,
      height: 1200,
      alt: "",
    }));
    const plan = composePlan([post({ media })], { media: "all" });
    expect(plan.block.layout).toEqual({
      kind: "split",
      axis: "horizontal",
      children: media.map((item) => ({ kind: "media", ref: item.ref })),
    });
  });

  test("never selects quoted media", () => {
    const plan = composePlan([post({
      quote: post({ media: [{ ref: "quote.1", kind: "video", url: "https://example.test/quote.mp4", alt: "" }] }),
    })]);
    expect(blockPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.block.kind).toBe("text");
    expect(plan.block.markdown).toContain("*[video]*");
  });

  test("composites mixed root media into one video mosaic", () => {
    const plan = composePlan([post({ media: [
      { ref: "1.1", kind: "image", url: "https://example.test/a.jpg", width: 800, height: 600, alt: "" },
      { ref: "1.2", kind: "video", url: "https://example.test/a.mp4", width: 1280, height: 720, alt: "" },
    ] })], { media: "all" });
    expect(blockPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.block.kind).toBe("video");
    expect(plan.block.selectedMedia).toEqual(["1.1", "1.2"]);
    expect(plan.block.layout).toEqual({
      kind: "split",
      axis: "vertical",
      children: [{ kind: "media", ref: "1.2" }, { kind: "media", ref: "1.1" }],
    });
  });

  test("stacks a post's images beside its video", () => {
    const plan = composePlan([post({ media: [
      { ref: "1.1", kind: "video", url: "https://example.test/a.mp4", width: 2846, height: 2160, alt: "" },
      { ref: "1.2", kind: "image", url: "https://example.test/a.jpg", width: 2048, height: 1536, alt: "" },
      { ref: "1.3", kind: "image", url: "https://example.test/b.jpg", width: 2048, height: 1536, alt: "" },
    ] })], { media: "all" });
    expect(plan.block.layout).toEqual({
      kind: "split",
      axis: "horizontal",
      children: [
        { kind: "media", ref: "1.1" },
        { kind: "split", axis: "vertical", children: [{ kind: "media", ref: "1.2" }, { kind: "media", ref: "1.3" }] },
      ],
    });
  });

  test("selects only videos or only images on request", () => {
    const media = [
      { ref: "1.1", kind: "video" as const, url: "https://example.test/a.mp4", width: 1280, height: 720, alt: "" },
      { ref: "1.2", kind: "image" as const, url: "https://example.test/a.jpg", width: 800, height: 600, alt: "" },
      { ref: "1.3", kind: "video" as const, url: "https://example.test/b.mp4", width: 1280, height: 720, alt: "" },
    ];
    const videos = composePlan([post({ media })], { media: "video" });
    expect(videos.block.kind).toBe("video");
    expect(videos.block.selectedMedia).toEqual(["1.1", "1.3"]);
    expect(videos.block.layout).toEqual({
      kind: "split",
      axis: "vertical",
      children: [{ kind: "media", ref: "1.1" }, { kind: "media", ref: "1.3" }],
    });
    const images = composePlan([post({ media })], { media: "images" });
    expect(images.block.kind).toBe("link");
    expect(images.block.selectedMedia).toEqual(["1.2"]);
    expect(images.block.layout).toEqual({ kind: "media", ref: "1.2" });
  });

  test("lets explicit refs mix kinds", () => {
    const plan = composePlan([post({ media: [
      { ref: "1.1", kind: "video", url: "https://example.test/a.mp4", alt: "" },
      { ref: "1.2", kind: "image", url: "https://example.test/a.jpg", alt: "" },
    ] })], { media: "selected", selectedMedia: ["1.1", "1.2"] });
    expect(plan.block.kind).toBe("video");
    expect(plan.block.selectedMedia).toEqual(["1.1", "1.2"]);
  });

  test("composes videos across posts automatically and explicitly", () => {
    const posts = [
      post({ media: [{ ref: "1.1", kind: "video", url: "https://example.test/a.mp4", alt: "" }] }),
      post({
        id: "101",
        canonicalUrl: "https://x.com/root/status/101",
        media: [{ ref: "2.1", kind: "video", url: "https://example.test/b.mp4", alt: "" }],
      }),
    ];
    const videos = composePlan(posts, { media: "video" });
    expect(videos.block.kind).toBe("video");
    expect(videos.block.selectedMedia).toEqual(["1.1", "2.1"]);
    expect(videos.block.layout).toEqual({
      kind: "split",
      axis: "horizontal",
      children: [{ kind: "media", ref: "1.1" }, { kind: "media", ref: "2.1" }],
    });
    expect(composePlan(posts).block.kind).toBe("video");
  });

  test("stacks two wide videos instead of forming a strip", () => {
    const plan = composePlan([post({ media: [
      { ref: "1.1", kind: "video", url: "https://example.test/a.mp4", width: 1920, height: 1080, alt: "" },
      { ref: "1.2", kind: "video", url: "https://example.test/b.mp4", width: 1920, height: 1080, alt: "" },
    ] })], { media: "all" });
    expect(plan.block.layout).toEqual({
      kind: "split",
      axis: "vertical",
      children: [{ kind: "media", ref: "1.1" }, { kind: "media", ref: "1.2" }],
    });
  });

  test("sets a third wide video beneath a row of two", () => {
    const plan = composePlan([post({ media: [1, 2, 3].map((index) => (
      { ref: `1.${index}`, kind: "video" as const, url: `https://example.test/${index}.mp4`, width: 1920, height: 1080, alt: "" }
    )) })], { media: "all" });
    expect(plan.block.layout).toEqual({
      kind: "split",
      axis: "vertical",
      children: [
        { kind: "split", axis: "horizontal", children: [{ kind: "media", ref: "1.1" }, { kind: "media", ref: "1.2" }] },
        { kind: "media", ref: "1.3" },
      ],
    });
  });

  test("arranges equal halves alike so four wide videos form a grid", () => {
    const plan = composePlan([post({ media: [1, 2, 3, 4].map((index) => (
      { ref: `1.${index}`, kind: "video" as const, url: `https://example.test/${index}.mp4`, width: 1920, height: 1080, alt: "" }
    )) })], { media: "all" });
    const layout = plan.block.layout!;
    expect(layout.kind).toBe("split");
    const [first, second] = (layout as Extract<LayoutNode, { kind: "split" }>).children;
    expect(first).toMatchObject({ kind: "split" });
    expect(second).toMatchObject({ kind: "split", axis: (first as Extract<LayoutNode, { kind: "split" }>).axis });
  });

  test("keeps a lone auto video without a layout", () => {
    const plan = composePlan([post({ media: [
      { ref: "1.1", kind: "video", url: "https://example.test/a.mp4", width: 1280, height: 720, alt: "" },
    ] })]);
    expect(plan.block.kind).toBe("video");
    expect("layout" in plan.block).toBe(false);
    expect(plan.hash).toBe("0f3ca73e478cc47d035510dc46c50c9d97037e5e21d0974c5ce188b278170803");
  });

  test("keeps image plans and hashes stable", () => {
    const images = [1, 2].map((index) => ({
      ref: `1.${index}`,
      kind: "image" as const,
      url: `https://example.test/${index}.jpg`,
      width: 800,
      height: 600,
      alt: "",
    }));
    expect(composePlan([post({ media: images })], { media: "all" }).hash)
      .toBe("e3384a7fbbe51f2d6a3f95523e19bf792de625b65c41c7be57aa66c70e2ef49f");
    expect(composePlan([post({ media: [images[0]!] })]).hash)
      .toBe("0057c7d7f384c3b0525f8bcc0c992873de2b6c2fa9b3ee0214c1edf3a830b4d5");
  });

  test("hashes equivalent plans deterministically", () => {
    expect(composePlan([post()]).hash).toBe(composePlan([post()]).hash);
  });
});

describe("URL parsing", () => {
  test("canonicalizes x.com and Bluesky URLs", () => {
    expect(parseSource("https://twitter.com/example/status/123?s=20").canonicalUrl).toBe("https://x.com/example/status/123");
    expect(parseSource("https://bsky.app/profile/example.com/post/abc").canonicalUrl).toBe("https://bsky.app/profile/example.com/post/abc");
  });

  test("extracts Are.na destinations", () => {
    expect(arenaDestination("https://are.na/example-user/block-share-test")).toBe("block-share-test");
    expect(arenaDestination("https://are.na/block/123")).toBeUndefined();
  });

  test("normalizes --to channel URLs and slugs", () => {
    expect(normalizeArenaDestinations([
      "https://www.are.na/example-user/recompilations",
      "recompilations",
    ])).toEqual(["recompilations"]);
  });
});
