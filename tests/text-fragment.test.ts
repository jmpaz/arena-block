import { expect, test } from "bun:test";
import { parseTextFragment, matchTextFragments } from "../packages/core/text-fragment.ts";
const url = (selector: string) => `https://example.com/p#section:~:text=${selector}`;

test("fragment parsing retains the selection URL and ordinary anchor separately", () => {
  const value = url("before-,First%2C%20part,last%2Dword,-after");
  expect(parseTextFragment(value)).toEqual({ url: value, documentURL: "https://example.com/p#section", directives: [{ prefix: "before", start: "First, part", end: "last-word", suffix: "after" }] });
  expect(parseTextFragment(url("a+b%26c%3Dd"))?.directives[0]?.start).toBe("a+b&c=d");
  expect(parseTextFragment("https://example.com/#:~:unknown=x&text=%E6%97%A5%E6%9C%AC%E8%AA%9E&text=caf%C3%A9")?.directives.map(d => d.start)).toEqual(["日本語", "café"]);
  expect(parseTextFragment("https://gwern.net/design#features")).toBeUndefined();
  expect(parseTextFragment("https://example.com/#:~:unknown=x")).toBeUndefined();
});

test.each(["", "-,hello", "hello,-", "hello-world", "a,b,c", "a,b,c,d,e", "a%FF", "a%2", "a,,b", "pre-fix-,a", "a,-suf-fix"])("invalid selector %s fails explicitly", selector => {
  expect(() => parseTextFragment(url(selector))).toThrow();
});

test("matching returns complete inclusive text rather than concatenated start/end markers", () => {
  const text = "Intro. When you delude yourself, a long middle stays exact; get accidentally ratatouilled. Next.";
  const fragment = parseTextFragment(url("When%20you%20delude,get%20accidentally%20ratatouilled."))!;
  const match = matchTextFragments(text, fragment.directives)[0]!;
  expect(match.text).toBe("When you delude yourself, a long middle stays exact; get accidentally ratatouilled.");
  expect(text.slice(match.start, match.end)).toBe(match.text);
  expect(() => matchTextFragments(text, parseTextFragment(url("When%20you%20delude,get%20accidentally%20ratatouilled)."))!.directives)).toThrow("could not be matched");
});

test("context disambiguates repeated phrases, and unavailable or ambiguous ranges fail", () => {
  const text = "One: same words. Two: same words. End.";
  expect(() => matchTextFragments(text, [{ start: "same words" }])).toThrow("ambiguous");
  expect(matchTextFragments(text, [{ prefix: "Two:", start: "same words", suffix: ". End." }])[0]?.text).toBe("same words");
  expect(() => matchTextFragments("insideword", [{ start: "side" }])).toThrow("could not be matched");
  expect(() => matchTextFragments("start end and end", [{ start: "start", end: "end" }])).toThrow("ambiguous");
  expect(() => matchTextFragments("one two three", [{ start: "one", end: "three" }, { start: "two" }])).toThrow("Overlapping");
});

test("case/diacritic and whitespace comparison preserves the original matched characters", () => {
  const text = "Before CAFÉ\n\tand cafe\u0301 👋 end. After";
  const match = matchTextFragments(text, [{ start: "cafe and", end: "end." }])[0]!;
  expect(match.text).toBe("CAFÉ\n\tand cafe\u0301 👋 end.");
  expect(matchTextFragments("cafe\u0301", [{ start: "café" }])[0]?.text).toBe("cafe\u0301");
});

test("Unicode word segmentation handles CJK and keeps astral characters intact", () => {
  expect(matchTextFragments("私は日本語を話します。", [{ start: "日本語" }])[0]?.text).toBe("日本語");
  expect(matchTextFragments("Hello 👋 world", [{ start: "👋" }])[0]?.text).toBe("👋");
});
