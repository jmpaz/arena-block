import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const channelRecordSchema = z.object({
  id: z.number().int().positive().safe(), title: z.string().max(2048), slug: z.string().max(2048),
  visibility: z.enum(["private", "closed", "public"]),
  owner: z.object({ name: z.string().max(2048), slug: z.string().max(2048) }).strict(),
  count: z.number().int().nonnegative().safe().optional(), canAdd: z.boolean().optional(),
}).strict();
export type ChannelRecord = z.infer<typeof channelRecordSchema>;
const snapshotSchema = z.object({ accountId: z.number().int().positive().safe(), channels: z.array(channelRecordSchema).max(3000),
  updatedAt: z.string(), completeAt: z.string().nullable(),
  scan: z.object({ pages: z.record(z.string(), z.array(channelRecordSchema).max(30)), nextPage: z.number().int().positive().nullable() }).strict().optional(),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;

/** A private, account-scoped cache. A completed prior crawl remains visible while a new crawl is in flight. */
export class ChannelIndex {
  private readonly path: string;
  constructor(private readonly directory: string) { this.path = join(directory, "channel-index.json"); }

  read(accountId: number): Omit<Snapshot, "scan"> {
    let state: Snapshot | undefined;
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 4 * 1024 * 1024) throw new Error("Private channel index has unsafe ownership, permissions or size");
      state = snapshotSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!state || state.accountId !== accountId) return { accountId, channels: [], updatedAt: "", completeAt: null };
    const { scan: _, ...visible } = state;
    if (!visible.channels.length && state.scan) visible.channels = Object.entries(state.scan.pages)
      .sort(([a], [b]) => Number(a) - Number(b)).flatMap(([, channels]) => channels);
    return visible;
  }

  recordPage(accountId: number, page: number, channels: ChannelRecord[], nextPage: number | null): void {
    if (!Number.isSafeInteger(accountId) || accountId < 1 || !Number.isInteger(page) || page < 1 || page > 100) throw new Error("Invalid channel index page");
    const checked = z.array(channelRecordSchema).max(30).parse(channels);
    const current = this.loadFor(accountId);
    const scan = page === 1 || !current.scan ? { pages: {} as Record<string, ChannelRecord[]>, nextPage } : current.scan;
    scan.pages[String(page)] = checked;
    scan.nextPage = nextPage;
    const now = new Date().toISOString();
    const complete = nextPage === null && Array.from({ length: page }, (_, index) => index + 1).every(number => String(number) in scan.pages);
    const next: Snapshot = complete ? { accountId, channels: Array.from({ length: page }, (_, index) => scan.pages[String(index + 1)]!).flat(), updatedAt: now, completeAt: now }
      : { ...current, accountId, updatedAt: now, scan };
    if (next.channels.length > 3000) throw new Error("Channel index exceeds 3000 entries");
    snapshotSchema.parse(next);
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.mode & 0o077) throw new Error("Channel index requires a private state directory");
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { encoding: "utf8", flag: "wx", mode: 0o600 });
      const fd = openSync(temporary, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }

  private loadFor(accountId: number): Snapshot {
    const visible = this.read(accountId);
    if (!existsSync(this.path)) return visible;
    const parsed = snapshotSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    return parsed.accountId === accountId ? parsed : visible;
  }
}
