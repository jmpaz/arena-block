import type { ChannelRecord } from "../channel-index.ts";
import { ChannelRanker, normalize, type Match } from "./rank.ts";

export type Visibility = ChannelRecord["visibility"];
export type Scope = "mine" | "network" | "all";
export type Mode = "filter" | "jump";
export type Channel = ChannelRecord & { pending?: true; updatedAt?: string | null };

export type HeldBlock = { title: string; source: string; kind: string; blockId?: number; url?: string; alreadyIn: number[] };

export type Row =
  | { kind: "label"; text: string }
  | { kind: "channel"; channel: Channel; spans: Array<[number, number]>; slot?: number; faint?: boolean }
  | { kind: "create"; title: string; visibility: Visibility }
  | { kind: "pending"; text: string };

export type Request = { method: "GET" | "POST"; path: string; body?: unknown; note?: string };

export type Outcome = { destinations: Channel[]; requests: Request[]; created: Channel[] };

const VISIBILITY_CYCLE: Visibility[] = ["private", "closed", "public"];
const SCOPES: Scope[] = ["mine", "network", "all"];

/** Picker state for one session. The view reads it; key and mouse handlers call its methods. */
export class PickerModel {
  query = "";
  mode: Mode;
  scope: Scope = "mine";
  showHeld = false;
  cursor = 0;
  top = 0;
  held: Channel[] = [];
  createVisibility: Visibility = "private";
  notice = "";
  hover: number | null = null;
  rows: Row[] = [];
  remote: { query: string; scope: Scope; state: "idle" | "loading" | "done" | "error"; channels: Channel[]; message?: string } =
    { query: "", scope: "mine", state: "idle", channels: [] };

  private channels: Channel[];
  private ranker: ChannelRanker;
  private nextPendingId = -1;
  private readonly me: string;

  constructor(channels: Channel[], readonly recents: number[], readonly block: HeldBlock | undefined, readonly listRows: number,
    options: { mode?: Mode; me?: string } = {}) {
    this.me = options.me ?? "you";
    this.channels = [...channels];
    this.ranker = new ChannelRanker(this.channels);
    this.mode = options.mode ?? "filter";
    this.rebuild();
  }

  get alreadyIn(): Set<number> {
    return new Set(this.block?.alreadyIn ?? []);
  }

  isHeld(channel: Channel): boolean {
    return this.held.some(c => c.id === channel.id);
  }

  private recentChannels(): Channel[] {
    return this.recents.map(id => this.channels.find(c => c.id === id)).filter((c): c is Channel => Boolean(c));
  }

  private arrangement(): Row[] {
    const recent = this.recentChannels();
    const recentIds = new Set(recent.map(c => c.id));
    const rows: Row[] = [];
    if (recent.length) {
      rows.push({ kind: "label", text: "recent" });
      recent.forEach((channel, i) => rows.push({ kind: "channel", channel, spans: [], slot: i < 9 ? i + 1 : undefined }));
    }
    const mine = this.channels.filter(c => !recentIds.has(c.id));
    if (mine.length) {
      rows.push({ kind: "label", text: "mine" });
      for (const channel of mine) rows.push({ kind: "channel", channel, spans: [] });
    }
    return rows;
  }

  private exactTitle(): boolean {
    const wanted = normalize(this.query.trim());
    return this.channels.some(c => normalize(c.title) === wanted);
  }

  rebuild(): void {
    const query = this.query.trim();
    if (this.showHeld) {
      this.rows = this.held.map(channel => ({ kind: "channel", channel, spans: [] }));
    } else if (this.scope !== "mine") {
      this.rows = this.remoteRows();
    } else if (this.mode === "jump" || !query) {
      const rows = this.arrangement();
      if (query) {
        const matches = new Map(this.ranker.rank(query).map(m => [m.channel.id, m]));
        for (const row of rows) if (row.kind === "channel") {
          const match = matches.get(row.channel.id);
          row.spans = match?.spans ?? [];
          row.faint = !match;
        }
      }
      this.rows = rows;
    } else {
      const rows: Row[] = [];
      if (!this.exactTitle()) rows.push({ kind: "create", title: query, visibility: this.createVisibility });
      for (const match of this.ranker.rank(query)) rows.push({ kind: "channel", channel: match.channel, spans: match.spans });
      this.rows = rows;
    }
    this.clampCursor();
  }

  private remoteRows(): Row[] {
    const remote = this.remote;
    if (!this.query.trim()) return [{ kind: "pending", text: `type to search ${this.scope === "all" ? "all of Are.na" : "channels you follow"}` }];
    if (remote.state === "loading" || remote.query !== this.query.trim() || remote.scope !== this.scope)
      return Array.from({ length: Math.min(4, this.listRows) }, () => ({ kind: "pending", text: "" }));
    if (remote.state === "error") return [{ kind: "pending", text: remote.message ?? "search failed" }];
    if (!remote.channels.length) return [{ kind: "pending", text: `no channels match "${this.query.trim()}"` }];
    return remote.channels.map(channel => ({ kind: "channel", channel, spans: [] }));
  }

  private selectable(index: number): boolean {
    const row = this.rows[index];
    return row !== undefined && (row.kind === "channel" || row.kind === "create");
  }

  private clampCursor(): void {
    if (this.mode === "jump" && this.query.trim() && !this.showHeld && this.scope === "mine") {
      const best = this.ranker.rank(this.query.trim())[0];
      const at = best ? this.rows.findIndex(r => r.kind === "channel" && r.channel.id === best.channel.id) : -1;
      if (at >= 0) this.cursor = at;
    }
    if (!this.rows.length) { this.cursor = 0; this.top = 0; return; }
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor));
    if (!this.selectable(this.cursor)) {
      const next = this.rows.findIndex((_, i) => i > this.cursor && this.selectable(i));
      let previous = this.cursor - 1;
      while (previous >= 0 && !this.selectable(previous)) previous--;
      this.cursor = next >= 0 ? next : previous >= 0 ? previous : this.cursor;
    }
    this.scrollTo(this.cursor);
  }

  private scrollTo(index: number): void {
    const before = index > 0 && this.rows[index - 1]?.kind === "label" ? index - 1 : index;
    if (before < this.top) this.top = before;
    if (index >= this.top + this.listRows) this.top = index + 1 - this.listRows;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.rows.length - this.listRows)));
  }

  type(text: string): void {
    this.query += text;
    this.notice = "";
    this.resetCursor();
  }

  backspace(): void {
    this.query = [...this.query].slice(0, -1).join("");
    this.resetCursor();
  }

  /** In filter mode the cursor starts on the best match; the create row is one step above it. */
  private resetCursor(): void {
    this.rebuild();
    if (this.mode === "filter") {
      const first = this.rows.findIndex(r => r.kind === "channel");
      this.cursor = first >= 0 ? first : 0;
      this.scrollTo(this.cursor);
    }
  }

  /** Clears the query first; reports true when there was nothing to clear, so the caller can leave. */
  escape(): boolean {
    if (this.showHeld) { this.showHeld = false; this.rebuild(); return false; }
    if (!this.query) return true;
    this.query = "";
    this.rebuild();
    return false;
  }

  move(delta: number): void {
    let at = this.cursor;
    for (let step = 0; step < Math.abs(delta); step++) {
      let next = at + Math.sign(delta);
      while (next >= 0 && next < this.rows.length && !this.selectable(next)) next += Math.sign(delta);
      if (next < 0 || next >= this.rows.length) break;
      at = next;
    }
    this.cursor = at;
    this.scrollTo(at);
  }

  scroll(delta: number): void {
    this.top = Math.max(0, Math.min(Math.max(0, this.rows.length - this.listRows), this.top + delta));
  }

  focusRow(index: number): void {
    if (this.selectable(index)) { this.cursor = index; this.scrollTo(index); }
  }

  /** Puts the held block down in the row's channel, or picks it back up. */
  toggle(index = this.cursor): void {
    const row = this.rows[index];
    if (!row) return;
    if (row.kind === "create") return this.create(row.title);
    if (row.kind !== "channel") return;
    const channel = row.channel;
    if (this.isHeld(channel)) {
      this.held = this.held.filter(c => c.id !== channel.id);
      this.notice = `picked up from ${channel.title}`;
    } else if (channel.canAdd === false) {
      this.notice = `${channel.title} is closed to additions from this account`;
      return;
    } else if (this.alreadyIn.has(channel.id)) {
      this.notice = `already in ${channel.title}`;
      return;
    } else if (this.held.length >= 20) {
      this.notice = "20 channels at most";
      return;
    } else {
      this.held.push(channel);
      this.notice = "";
    }
    if (this.showHeld) this.rebuild();
  }

  putDown(index: number): void {
    const row = this.rows[index];
    if (row?.kind === "channel" && this.isHeld(row.channel)) return;
    this.toggle(index);
  }

  pickUp(channelId: number): void {
    this.held = this.held.filter(c => c.id !== channelId);
    this.rebuild();
  }

  toggleRecent(slot: number): void {
    const index = this.rows.findIndex(r => r.kind === "channel" && r.slot === slot);
    if (index < 0) return;
    this.focusRow(index);
    this.toggle(index);
  }

  private create(title: string): void {
    const channel: Channel = { id: this.nextPendingId--, title, slug: title, visibility: this.createVisibility,
      owner: { name: this.me, slug: "you" }, count: 0, canAdd: true, pending: true };
    this.channels.unshift(channel);
    this.ranker = new ChannelRanker(this.channels);
    this.held.push(channel);
    this.notice = `new ${channel.visibility} channel, created on connect`;
    this.rebuild();
  }

  cycleCreateVisibility(): void {
    this.createVisibility = VISIBILITY_CYCLE[(VISIBILITY_CYCLE.indexOf(this.createVisibility) + 1) % VISIBILITY_CYCLE.length]!;
    this.rebuild();
  }

  cycleScope(): Scope {
    this.scope = SCOPES[(SCOPES.indexOf(this.scope) + 1) % SCOPES.length]!;
    this.cursor = 0;
    this.rebuild();
    return this.scope;
  }

  toggleMode(): void {
    this.mode = this.mode === "filter" ? "jump" : "filter";
    this.cursor = 0;
    this.rebuild();
  }

  toggleHeldView(): void {
    this.showHeld = !this.showHeld && this.held.length > 0;
    this.cursor = 0;
    this.rebuild();
  }

  setRemote(result: PickerModel["remote"]): void {
    this.remote = result;
    this.rebuild();
  }

  /** The channel the preview pane describes: the hovered row if the pointer is over the list, else the cursor row. */
  previewChannel(): Channel | undefined {
    const row = this.rows[this.hover ?? this.cursor];
    return row?.kind === "channel" ? row.channel : undefined;
  }

  commit(): Outcome {
    if (!this.held.length) {
      const row = this.rows[this.cursor];
      if (row?.kind === "channel" && row.channel.canAdd !== false && !this.alreadyIn.has(row.channel.id)) this.held.push(row.channel);
      if (row?.kind === "create") this.create(row.title);
    }
    const created = this.held.filter(c => c.pending);
    const requests: Request[] = created.map(c => ({ method: "POST", path: "/v3/channels", body: { title: c.title, visibility: c.visibility },
      note: "arena-block's daemon has no channel-creation route yet" }));
    const existing = this.held.filter(c => !c.pending).map(c => c.id);
    if (this.block?.blockId && this.held.length) {
      requests.push({ method: "POST", path: "/v1/existing-placements", body: { blockId: this.block.blockId,
        destinations: [...existing, ...created.map(c => `<new ${c.title}>`)], placementId: "<uuid>" } });
    }
    return { destinations: [...this.held], requests, created };
  }
}
