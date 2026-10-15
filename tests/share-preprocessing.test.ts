import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

test.each([
  "https://www.tiktok.com/@kylemakesshortfilms/video/7696537875722013983",
  "https://www.reddit.com/r/neovim/s/jNsGjBVn9A",
  "https://www.reddit.com/r/neovim/comments/1x6nuin/whatsappnvim_handwritten_code_with_zero_ai/",
  "https://www.reddit.com/r/test/comments/abc/title/def/",
])("ordinary Safari preprocessing passes %s without a page read", async source => {
  const script = await Bun.file(new URL("../ios/ShareExtension/RedditPreprocessor.js", import.meta.url)).text();
  let calls = 0;
  const context: any = { location: new URL(source), URL,
    fetch: () => { throw new Error("Ordinary preprocessing must not fetch"); } };
  runInNewContext(script, context);
  context.ExtensionPreprocessingJS.run({ completionFunction(value: unknown) {
    calls++;
    expect(value).toEqual({ sourceUrl: source });
  } });
  expect(calls).toBe(1);
});
