import type { ChannelRecord } from "../channel-index.ts";

type Field = { text: string; parts: string[] };
type Entry = { channel: ChannelRecord; fields: Field[] };

export type Match = { channel: ChannelRecord; score: number; spans: Array<[number, number]> };

export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function words(text: string): string[] {
  return normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function subsequence(needle: string, haystack: string): boolean {
  if (needle[0] !== haystack[0]) return false;
  let at = 0;
  for (const ch of haystack) if (ch === needle[at]) at++;
  return at === needle.length;
}

function typoDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 3;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      current[j + 1] = Math.min(previous[j + 1]! + 1, current[j]! + 1, previous[j]! + (left[i] === right[j] ? 0 : 1));
    }
    if (Math.min(...current) > 2) return 3;
    previous = current;
  }
  return previous[right.length]!;
}

function wordScore(word: string, field: Field): number | undefined {
  if (field.text === word) return 100;
  if (field.parts.includes(word)) return 95;
  if (field.text.startsWith(word)) return 90;
  if (field.parts.some(part => part.startsWith(word))) return 78;
  if (field.text.includes(word)) return 65;
  if (word.length >= 3 && field.parts.some(part => subsequence(word, part))) return 43;
  if (word.length >= 4 && field.parts.some(part => typoDistance(word, part) <= (word.length >= 7 ? 2 : 1))) return 30;
  return undefined;
}

function titleSpans(title: string, query: string[]): Array<[number, number]> {
  const lower = normalize(title);
  const spans: Array<[number, number]> = [];
  for (const word of query) {
    const at = lower.indexOf(word);
    if (at >= 0) spans.push([at, at + word.length]);
  }
  return spans;
}

/** Ranks channels as the iOS picker does: every query word has to match the title, slug or owner. */
export class ChannelRanker {
  private readonly entries: Entry[];

  constructor(channels: ChannelRecord[]) {
    this.entries = channels.map(channel => ({
      channel,
      fields: [channel.title, channel.slug, channel.owner.name].map(text => ({ text: normalize(text), parts: words(text) })),
    }));
  }

  rank(query: string): Match[] {
    const wanted = words(query);
    if (!wanted.length) return this.entries.map(({ channel }) => ({ channel, score: 0, spans: [] }));
    const scored: Array<Match & { offset: number }> = [];
    this.entries.forEach(({ channel, fields }, offset) => {
      let total = 0;
      for (const word of wanted) {
        let best = -Infinity;
        fields.forEach((field, index) => {
          const score = wordScore(word, field);
          if (score !== undefined) best = Math.max(best, score - index * 8);
        });
        if (best === -Infinity) return;
        total += best;
      }
      scored.push({ channel, score: total, spans: titleSpans(channel.title, wanted), offset });
    });
    return scored.sort((a, b) => b.score - a.score || a.offset - b.offset).map(({ offset: _, ...match }) => match);
  }
}
