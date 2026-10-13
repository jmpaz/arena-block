import { afterEach, describe, expect, test } from "bun:test";
import { composePlan } from "../src/compose.ts";
import { XProvider } from "../src/providers/x.ts";
import { parseSource } from "../src/url.ts";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const article = {
  id: "900",
  title: "RSI vs. Human Enhancement",
  content: { blocks: [{ text: "The opening claim.", type: "unstyled" }], entityMap: [] },
};

function respond(tweet: unknown) {
  globalThis.fetch = Object.assign(async () => Response.json({ tweet }), { preconnect: original.preconnect });
  return new XProvider().resolve(parseSource("https://x.com/vie/status/100"));
}

describe("x.com articles", () => {
  test("keeps the tweet text beside the article body", async () => {
    const post = await respond({
      id: "100", author: { screen_name: "vie" }, article,
      text: "We stand at a great crossroads. https://x.com/i/article/900",
    });
    expect(post.text).toBe("We stand at a great crossroads.");
    expect(post.article).toStartWith("# RSI vs. Human Enhancement");
  });

  test("retains links to other articles", async () => {
    const post = await respond({
      id: "100", author: { screen_name: "vie" }, article,
      text: "Read alongside https://x.com/i/article/901",
    });
    expect(post.text).toBe("Read alongside https://x.com/i/article/901");
  });

  test("describes the block with the tweet and fills it with the article", async () => {
    const plan = composePlan([await respond({
      id: "100", author: { screen_name: "vie" }, article,
      text: "We stand at a great crossroads. https://x.com/i/article/900",
    })]);
    expect(plan.block.kind).toBe("text");
    expect(plan.block.description).toBe("We stand at a great crossroads.");
    expect(plan.block.markdown).toBe("# RSI vs. Human Enhancement\n\nThe opening claim.");
  });

  test("leaves ordinary tweets undescribed", async () => {
    const post = await respond({ id: "100", author: { screen_name: "vie" }, text: "Just a thought." });
    expect(post.article).toBeUndefined();
    expect(post.text).toBe("Just a thought.");
    expect(composePlan([post]).block.description).toBeUndefined();
  });
});

test("reads a thread response's structured self-reply parent without confusing it with the quote", async () => {
  const source = parseSource("https://x.com/AndrewCurran_/status/2108277692819017822");
  const provider = new XProvider("https://api.fxtwitter.com", async () => Response.json({ code: 200, tweet: {
    id: "2108277692819017822", author: { screen_name: "AndrewCurran_" }, text: "Jasmine Wang:",
    replying_to: { screen_name: "AndrewCurran_", status: "2108271344286892133" },
    quote: { id: "2108263312291180680", author: { screen_name: "j_asminewang" }, text: "OpenAI fired me last week." },
  } }));
  const resolved = await provider.resolve(source);
  expect(resolved.replyTo).toEqual({ id: "2108271344286892133", authorHandle: "AndrewCurran_" });
  expect(resolved.quote?.id).toBe("2108263312291180680");
  expect(composePlan([postForReplyParent(), resolved]).block.markdown).toContain("Jasmine Wang:\n\n> `@j_asminewang`");
});

function postForReplyParent() {
  return { provider: "x" as const, id: "2108271344286892133",
    canonicalUrl: "https://x.com/AndrewCurran_/status/2108271344286892133",
    author: { handle: "AndrewCurran_" }, text: "Open letter.", media: [] };
}
