export const visibilities = ["private", "closed", "public"] as const;
export type Visibility = typeof visibilities[number];
export const overlapRules = ["public", "private", "both", "placements"] as const;
export type OverlapRule = typeof overlapRules[number];

export type Tally = Record<Visibility, number> & { total: number };
export type ChannelRow = { id: number; visibility: string; owner: { slug: string }; count?: number };
export type RatioSource = {
  channels(page: number, signal?: AbortSignal): Promise<{ accountId: number; channels: ChannelRow[]; nextPage: number | null }>;
  channelBlocks(channelId: number, page: number, signal?: AbortSignal): Promise<{ blockIds: number[]; channelEntries: number; nextPage: number | null }>;
};

export type Ratios = { privatePerPublic: number | null; privatePerOpen: number | null; privateShare: number | null };
export type RatioReport = {
  accountId: number;
  generatedAt: string;
  overlap: OverlapRule;
  listing: string;
  unit: "unique blocks" | "placements";
  channels: Tally;
  blocks: Tally;
  channelRatios: Ratios;
  blockRatios: Ratios;
  owners: Record<string, Tally>;
  scan?: { channelsRead: number; blockPlacements: number; nestedChannelEntries: number; countMismatches: number };
};

export const overlapDescription: Record<OverlapRule, string> = {
  public: "a block in several channels counts once, as the most open visibility among them (public, then closed, then private)",
  private: "a block in several channels counts once, as the most restricted visibility among them (private, then closed, then public)",
  both: "a block in several channels counts once under every visibility it appears in; the total counts each block once",
  placements: "each channel membership counts, so a block in several channels counts several times; nested channels are included",
};

const bit: Record<Visibility, number> = { private: 1, closed: 2, public: 4 };
const openness: Record<Visibility, number> = { private: 0, closed: 1, public: 2 };

export function emptyTally(): Tally { return { private: 0, closed: 0, public: 0, total: 0 }; }

export function normalizeVisibility(value: string): Visibility {
  return value === "private" ? "private" : value === "closed" ? "closed" : "public";
}

function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function ratios(tally: Tally): Ratios {
  return {
    privatePerPublic: divide(tally.private, tally.public),
    privatePerOpen: divide(tally.private, tally.closed + tally.public),
    privateShare: divide(tally.private, tally.total),
  };
}

/** Count each block once per the overlap rule, from the visibility bits collected for every block ID. */
export function tallyBlocks(masks: Iterable<number>, rule: Exclude<OverlapRule, "placements">): Tally {
  const tally = emptyTally();
  for (const mask of masks) {
    const present = visibilities.filter(value => mask & bit[value]);
    if (!present.length) continue;
    tally.total++;
    if (rule === "both") { for (const value of present) tally[value]++; continue; }
    const sorted = [...present].sort((a, b) => openness[a] - openness[b]);
    tally[rule === "public" ? sorted[sorted.length - 1]! : sorted[0]!]++;
  }
  return tally;
}

async function listChannels(source: RatioSource, retry: <T>(operation: () => Promise<T>) => Promise<T>, signal?: AbortSignal): Promise<{ accountId: number; channels: ChannelRow[] }> {
  const channels: ChannelRow[] = [];
  let accountId = 0, page: number | null = 1;
  const seen = new Set<number>();
  while (page !== null) {
    const current: number = page;
    const response: Awaited<ReturnType<RatioSource["channels"]>> = await retry(() => source.channels(current, signal));
    accountId = response.accountId;
    for (const channel of response.channels) if (!seen.has(channel.id)) { seen.add(channel.id); channels.push(channel); }
    if (response.nextPage !== null && response.nextPage <= current) throw new Error("Channel listing did not advance");
    page = response.nextPage;
  }
  return { accountId, channels };
}

const defaultRetryDelays = [3000, 10_000, 30_000, 60_000, 60_000, 60_000];

/** Retries rate limits and server errors; a limit hit pauses every worker that shares the gate. */
function retrying(delays: number[], signal?: AbortSignal) {
  let resumeAt = 0;
  return async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = resumeAt - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      try { return await operation(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= delays.length || signal?.aborted || !/\b(429|5\d\d)\b|timed? ?out|fetch failed/i.test(message)) throw error;
        resumeAt = Math.max(resumeAt, Date.now() + delays[attempt]!);
      }
    }
  };
}

export type CollectOptions = {
  overlap: OverlapRule;
  concurrency?: number;
  signal?: AbortSignal;
  now?: () => Date;
  retryDelays?: number[];
  progress?: (done: number, total: number) => void;
  listing?: string;
};

/** Read the channel list, then count channels and blocks by visibility. Only GET routes are called. */
export async function collectRatio(source: RatioSource, options: CollectOptions): Promise<RatioReport> {
  const { signal, overlap } = options;
  const withRetry = retrying(options.retryDelays ?? defaultRetryDelays, signal);
  const { accountId, channels } = await listChannels(source, withRetry, signal);
  const channelTally = emptyTally(), blockTally = emptyTally();
  const owners: Record<string, Tally> = {};
  for (const channel of channels) {
    const visibility = normalizeVisibility(channel.visibility);
    channelTally[visibility]++; channelTally.total++;
    const owner = owners[channel.owner.slug] ??= emptyTally();
    owner[visibility]++; owner.total++;
  }
  const report: RatioReport = {
    accountId, generatedAt: (options.now?.() ?? new Date()).toISOString(), overlap, listing: options.listing ?? "live",
    unit: overlap === "placements" ? "placements" : "unique blocks",
    channels: channelTally, blocks: blockTally, channelRatios: ratios(channelTally), blockRatios: ratios(blockTally), owners,
  };
  if (overlap === "placements") {
    for (const channel of channels) {
      const visibility = normalizeVisibility(channel.visibility), count = channel.count ?? 0;
      blockTally[visibility] += count; blockTally.total += count;
    }
    report.blockRatios = ratios(blockTally);
    return report;
  }

  const masks = new Map<number, number>();
  const scanned = channels.filter(channel => channel.count !== 0);
  let blockPlacements = 0, nestedChannelEntries = 0, countMismatches = 0, done = 0, next = 0;
  const scanChannel = async (channel: ChannelRow) => {
    const visibility = normalizeVisibility(channel.visibility);
    let page: number | null = 1, entries = 0;
    while (page !== null) {
      const current: number = page;
      const response = await withRetry(() => source.channelBlocks(channel.id, current, signal));
      for (const id of response.blockIds) masks.set(id, (masks.get(id) ?? 0) | bit[visibility]);
      blockPlacements += response.blockIds.length;
      nestedChannelEntries += response.channelEntries;
      entries += response.blockIds.length + response.channelEntries;
      if (response.nextPage !== null && response.nextPage <= current) throw new Error(`Channel ${channel.id} pages did not advance`);
      page = response.nextPage;
    }
    if (channel.count !== undefined && channel.count !== entries) countMismatches++;
    options.progress?.(++done, scanned.length);
  };
  const worker = async () => { while (next < scanned.length) await scanChannel(scanned[next++]!); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 2, scanned.length || 1)) }, worker));
  const tally = tallyBlocks(masks.values(), overlap);
  Object.assign(blockTally, tally);
  report.blockRatios = ratios(blockTally);
  report.scan = { channelsRead: scanned.length, blockPlacements, nestedChannelEntries, countMismatches };
  return report;
}

function ratioText(value: number | null, suffix = ""): string {
  return value === null ? "n/a" : `${value.toFixed(2)}${suffix}`;
}

function ratioLines(label: string, value: Ratios): string[] {
  return [
    `${label} private per public: ${ratioText(value.privatePerPublic)}`,
    `${label} private per closed or public: ${ratioText(value.privatePerOpen)}`,
    `${label} private share: ${value.privateShare === null ? "n/a" : `${(value.privateShare * 100).toFixed(1)}%`}`,
  ];
}

export function formatRatioReport(report: RatioReport): string {
  const unit = report.unit === "placements" ? "placements" : "blocks";
  const rows = ["private", "closed", "public"] as const;
  const width = (value: number) => String(value).padStart(10);
  const share = (value: number, total: number) => total ? `${(value / total * 100).toFixed(1)}%`.padStart(8) : "     n/a";
  const lines = [
    `Account ${report.accountId}, ${report.generatedAt}, channel list ${report.listing}`,
    `Block rule (${report.overlap}): ${overlapDescription[report.overlap]}.`,
    "",
    `${"".padEnd(10)}${"channels".padStart(10)}${"share".padStart(8)}${unit.padStart(12)}${"share".padStart(8)}`,
    ...rows.map(row => `${row.padEnd(10)}${width(report.channels[row])}${share(report.channels[row], report.channels.total)}${width(report.blocks[row]).padStart(12)}${share(report.blocks[row], report.blocks.total)}`),
    `${"total".padEnd(10)}${width(report.channels.total)}${"".padStart(8)}${width(report.blocks.total).padStart(12)}`,
    "",
    ...ratioLines("channels,", report.channelRatios),
    ...ratioLines(`${unit},`, report.blockRatios),
  ];
  if (report.overlap === "both") lines.push("", "Under this rule the visibility rows can sum to more than the total.");
  if (report.scan) {
    lines.push("", `Scanned ${report.scan.channelsRead} channels: ${report.scan.blockPlacements} block placements, ${report.scan.nestedChannelEntries} nested channel entries, ${report.scan.countMismatches} channels whose listed count differed from the entries read.`);
  } else lines.push("", "Counts come from each channel's listed content count, which includes nested channels. Use another rule to count unique blocks.");
  return lines.join("\n");
}
