export const channelVisibilities = ["private", "closed", "public"] as const;
export type ChannelVisibility = typeof channelVisibilities[number];
export const blockVisibilities = ["private", "public", "orphan"] as const;
export type BlockVisibility = typeof blockVisibilities[number];
export const blockTypes = ["Text", "Image", "Link", "Attachment", "Embed"] as const;
export type BlockType = typeof blockTypes[number];
export type BlockSort = "created_at_asc" | "created_at_desc";

export type ChannelTally = Record<ChannelVisibility, number> & { total: number };
export type BlockTally = Record<BlockVisibility, number> & { other: number; total: number };
export type ChannelRow = { id: number; visibility: string; owner: { slug: string }; count?: number };
export type BlockRow = { id: number; visibility: string };
export type BlockPage = { blocks: BlockRow[]; total: number; nextPage: number | null };
export type RatioSource = {
  channels(page: number, signal?: AbortSignal): Promise<{ accountId: number; channels: ChannelRow[]; nextPage: number | null }>;
  blocks(type: BlockType | "Block", sort: BlockSort, page: number, signal?: AbortSignal): Promise<BlockPage>;
};

export type TypeCoverage = { reported: number; read: number };
export type RatioReport = {
  accountId: number;
  generatedAt: string;
  listing: string;
  channels: ChannelTally;
  channelRatios: { privatePerVisible: number | null; privateShare: number | null };
  owners: Record<string, ChannelTally>;
  blocks: BlockTally;
  blockRatios: { privatePerPublic: number | null; privateShare: number | null };
  coverage: { reported: number; read: number; complete: boolean; types: Record<BlockType, TypeCoverage> };
};

function emptyChannelTally(): ChannelTally { return { private: 0, closed: 0, public: 0, total: 0 }; }

export function normalizeVisibility(value: string): ChannelVisibility {
  return value === "private" ? "private" : value === "closed" ? "closed" : "public";
}

function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
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
  signal?: AbortSignal;
  now?: () => Date;
  retryDelays?: number[];
  progress?: (read: number, reported: number) => void;
  listing?: string;
};

/**
 * Reads one block type oldest first. Are.na serves this listing through search, which can refuse pages deep into a
 * large result, so a listing that stops short is read again newest first and the two halves are joined by block ID.
 */
async function readBlockType(source: RatioSource, type: BlockType, retry: <T>(operation: () => Promise<T>) => Promise<T>,
  found: Map<number, string>, onPage: () => void, signal?: AbortSignal): Promise<TypeCoverage> {
  let reported = 0, read = 0;
  const pass = async (sort: BlockSort): Promise<boolean> => {
    for (let page = 1; ;) {
      let response: BlockPage;
      try { response = await retry(() => source.blocks(type, sort, page, signal)); }
      catch (error) { if (page === 1) throw error; return false; }
      reported = response.total;
      for (const block of response.blocks) if (!found.has(block.id)) { found.set(block.id, block.visibility); read++; }
      onPage();
      if (read >= reported) return true;
      if (!response.blocks.length || response.nextPage === null) return false;
      if (response.nextPage <= page) throw new Error(`${type} block listing did not advance`);
      page = response.nextPage;
    }
  };
  if (!await pass("created_at_asc")) await pass("created_at_desc");
  return { reported, read };
}

/** Counts channels by channel visibility and the account's blocks by block visibility. Only GET routes are called. */
export async function collectRatio(source: RatioSource, options: CollectOptions = {}): Promise<RatioReport> {
  const { signal } = options;
  const withRetry = retrying(options.retryDelays ?? defaultRetryDelays, signal);
  const { accountId, channels } = await listChannels(source, withRetry, signal);
  const channelTally = emptyChannelTally();
  const owners: Record<string, ChannelTally> = {};
  for (const channel of channels) {
    const visibility = normalizeVisibility(channel.visibility);
    channelTally[visibility]++; channelTally.total++;
    const owner = owners[channel.owner.slug] ??= emptyChannelTally();
    owner[visibility]++; owner.total++;
  }

  const reported = (await withRetry(() => source.blocks("Block", "created_at_asc", 1, signal))).total;
  const found = new Map<number, string>();
  const onPage = () => options.progress?.(found.size, reported);
  const types = {} as Record<BlockType, TypeCoverage>;
  for (const type of blockTypes) types[type] = await readBlockType(source, type, withRetry, found, onPage, signal);

  const blocks: BlockTally = { private: 0, public: 0, orphan: 0, other: 0, total: 0 };
  for (const visibility of found.values()) {
    blocks[(blockVisibilities as readonly string[]).includes(visibility) ? visibility as BlockVisibility : "other"]++;
    blocks.total++;
  }
  const typesComplete = blockTypes.every(type => types[type].read >= types[type].reported);
  return {
    accountId, generatedAt: (options.now?.() ?? new Date()).toISOString(), listing: options.listing ?? "live",
    channels: channelTally,
    channelRatios: { privatePerVisible: divide(channelTally.private, channelTally.closed + channelTally.public), privateShare: divide(channelTally.private, channelTally.total) },
    owners,
    blocks,
    blockRatios: { privatePerPublic: divide(blocks.private, blocks.public), privateShare: divide(blocks.private, blocks.total) },
    coverage: { reported, read: blocks.total, complete: typesComplete && blocks.total >= reported, types },
  };
}

const count = (value: number) => value.toLocaleString("en-US");
const percent = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const ratio = (value: number | null) => value === null ? "n/a" : value.toFixed(2);

function table(heading: string, rows: Array<[string, number]>, total: number): string[] {
  return [
    `${heading.padEnd(10)}${"count".padStart(10)}${"share".padStart(8)}`,
    ...rows.map(([label, value]) => `${label.padEnd(10)}${count(value).padStart(10)}${(total ? percent(value / total) : "n/a").padStart(8)}`),
    `${"total".padEnd(10)}${count(total).padStart(10)}`,
  ];
}

export function formatRatioReport(report: RatioReport): string {
  const blockRows: Array<[string, number]> = blockVisibilities.map(value => [value, report.blocks[value]]);
  if (report.blocks.other) blockRows.push(["other", report.blocks.other]);
  const lines = [
    `Account ${report.accountId}, ${report.generatedAt}, channel list ${report.listing}`,
    "",
    ...table("channels", channelVisibilities.map(value => [value, report.channels[value]]), report.channels.total),
    "",
    ...table("blocks", blockRows, report.blocks.total),
    "",
    `Channels: ${ratio(report.channelRatios.privatePerVisible)} private per closed or public, ${percent(report.channelRatios.privateShare)} private.`,
    `Blocks: ${ratio(report.blockRatios.privatePerPublic)} private per public, ${percent(report.blockRatios.privateShare)} private.`,
  ];
  const { coverage } = report;
  if (coverage.complete) lines.push(`Read all ${count(coverage.reported)} blocks Are.na reports for this account.`);
  else {
    const short = blockTypes.filter(type => coverage.types[type].read < coverage.types[type].reported)
      .map(type => `${type} ${count(coverage.types[type].read)} of ${count(coverage.types[type].reported)}`);
    lines.push(`Read ${count(coverage.read)} of the ${count(coverage.reported)} blocks Are.na reports${short.length ? `; listings stopped short for ${short.join(", ")}` : ""}.`);
  }
  return lines.join("\n");
}
