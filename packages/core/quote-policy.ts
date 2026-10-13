import { DEFAULT_QUOTE_DEPTH, MAX_QUOTE_DEPTH, type CompositionPolicy, type ResolvedPost } from "./types.ts";

export function renderedQuoteDepth(policy: Pick<CompositionPolicy, "quote" | "quoteDepth">): number {
  return policy.quote === "omit" ? 0 : policy.quoteDepth === "full" ? MAX_QUOTE_DEPTH : policy.quoteDepth ?? DEFAULT_QUOTE_DEPTH;
}

type SourceDay = { day: string; basis: string };
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function validDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function offset(value: string): string { return value === "Z" ? "+0000" : value.replace(":", ""); }

/** Calendar day as supplied by the source, with its explicit offset; never uses a device timezone or capture time. */
export function sourceCalendarDay(value: string | undefined): SourceDay | undefined {
  if (!value) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:?\d{2}))?$/.exec(value);
  if (iso) {
    if (!validDay(Number(iso[1]), Number(iso[2]), Number(iso[3])) || iso[4] && !Number.isFinite(Date.parse(value))) return undefined;
    return { day: `${iso[1]}-${iso[2]}-${iso[3]}`, basis: iso[4] ? offset(iso[4]) : "source-date-only" };
  }
  const twitter = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) \d{2}:\d{2}:\d{2} ([+-]\d{4}) (\d{4})$/.exec(value);
  if (!twitter || !Number.isFinite(Date.parse(value))) return undefined;
  const month = months.indexOf(twitter[1]!) + 1, day = Number(twitter[2]), year = Number(twitter[4]);
  if (!validDay(year, month, day)) return undefined;
  return { day: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, basis: offset(twitter[3]!) };
}

export function quoteDateLabel(root: ResolvedPost, quote: ResolvedPost, mode: CompositionPolicy["quoteDates"]): { label?: string; uncertainty?: "same_day" | "missing_or_incomparable_source_days" } {
  if (mode === "none") return {};
  if (mode === "source") return quote.postedAt ? { label: quote.postedAt } : { uncertainty: "missing_or_incomparable_source_days" };
  const rootDay = sourceCalendarDay(root.postedAt), quoteDay = sourceCalendarDay(quote.postedAt);
  if (!rootDay || !quoteDay || rootDay.basis !== quoteDay.basis) return { uncertainty: "missing_or_incomparable_source_days" };
  if (quoteDay.day === rootDay.day) return { uncertainty: "same_day" };
  if (quoteDay.day > rootDay.day) return {};
  const [year, month, day] = quoteDay.day.split("-").map(Number);
  return { label: `${months[month! - 1]} ${day}, ${year}` };
}

export function availableQuoteNodes(root: ResolvedPost): ResolvedPost[] {
  const nodes: ResolvedPost[] = [], visited = new Set<ResolvedPost>([root]);
  let post = root.quote;
  while (post && nodes.length < MAX_QUOTE_DEPTH && !visited.has(post)) {
    visited.add(post); nodes.push(post); post = post.quote;
  }
  return nodes;
}
