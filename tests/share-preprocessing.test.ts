import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

test("ordinary Safari page preprocessing supplies the exact TikTok URL without a separate URL attachment", async () => {
  const source = "https://www.tiktok.com/@kylemakesshortfilms/video/7696537875722013983";
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
