import type { ChannelRecord } from "../channel-index.ts";
import { ChannelRanker, normalize, type Match } from "./rank.ts";

export type Visibility = ChannelRecord["visibility"];
export type Scope = "mine" | "network" | "all";
export type Mode = "filter" | "jump";
export type Channel = ChannelRecord & { pending?: true; updatedAt?: string | null };

export type Block = { title: string; source: string; kind: string; blockId?: number; url?: string; connectedTo: number[] };

export type Row =
  | { kind: "label"; text: string; aside?: string }
  | { kind: "channel"; channel: Channel; spans: Array<[number, number]>; slot?: number; faint?: boolean }
  | { kind: "create"; title: string; visibility: Visibility }
  | { kind: "pending"; text: string };

export type Request = { method: "GET" | "POST" | "PUT"; path: string; body?: unknown; note?: string };

export type Nesting = { parents: Record<string, number[]>; channels: Channel[] };

export type Outcome = { destinations: Channel[]; requests: Request[]; created: Channel[] };

const VISIBILITY_CYCLE: Visibility[] = ["private", "closed", "public"];
const SCOPES: Scope[] = ["mine", "network", "all"];

/** Are.na and the iOS app call a public channel open. */
export function visibilityWord(visibility: Visibility): string {
  return visibility === "public" ? "open" : visibility;
}

/** Picker state for one session. The view reads it; key and mouse handlers call its methods. */
export class PickerModel {
  query = "";
  mode: Mode;
  scope: Scope = "mine";
  showSelected = false;
  cursor = 0;
  top = 0;
  selected: Channel[] = [];
  createVisibility: Visibility = "private";
  notice = "";
  hover: number | null = null;
  rows: Row[] = [];
  remote: { query: string; scope: Scope; state: "idle" | "loading" | "done" | "error"; channels: Channel[]; message?: string } =
    { query: "", scope: "mine", state: "idle", channels: [] };

  rooms: Array<{ id: number; cursor: number; top: number }> = [];
  readonly proposedVisibility = new Map<number, Visibility>();

  private channels: Channel[];
  private readonly known = new Map<number, Channel>();
  private readonly children = new Map<number, number[]>();
  private readonly parents = new Map<number, number[]>();
  private ranker: ChannelRanker;
  private nextPendingId = -1;
  private readonly me: string;

  constructor(channels: Channel[], readonly recents: number[], readonly block: Block | undefined, readonly listRows: number,
    options: { mode?: Mode; me?: string; nesting?: Nesting } = {}) {
    this.me = options.me ?? "you";
    this.channels = [...channels];
    for (const c of [...channels, ...(options.nesting?.channels ?? [])]) this.known.set(c.id, c);
    for (const [parent, kids] of Object.entries(options.nesting?.parents ?? {})) {
      const present = kids.filter(id => this.known.has(id));
      this.children.set(Number(parent), present);
      for (const kid of present) this.parents.set(kid, [...(this.parents.get(kid) ?? []), Number(parent)]);
    }
    this.ranker = new ChannelRanker([...this.known.values()]);
    this.mode = options.mode ?? "filter";
    this.rebuild();
  }

  get connectedTo(): Set<number> {
    return new Set(this.block?.connectedTo ?? []);
  }

  childrenOf(channel: Channel): Channel[] {
    return (this.children.get(channel.id) ?? []).map(id => this.known.get(id)!);
  }

  parentOf(channel: Channel): Channel | undefined {
    const id = this.parents.get(channel.id)?.[0];
    return id === undefined ? undefined : this.known.get(id);
  }

  get room(): Channel | undefined {
    const top = this.rooms.at(-1);
    return top ? this.known.get(top.id) : undefined;
  }

  get path(): Channel[] {
    return this.rooms.map(r => this.known.get(r.id)!);
  }

  isMine(channel: Channel): boolean {
    return channel.owner.name === this.me || Boolean(channel.pending);
  }

  visibilityOf(channel: Channel): Visibility {
    return this.proposedVisibility.get(channel.id) ?? channel.visibility;
  }

  isSelected(channel: Channel): boolean {
    return this.selected.some(c => c.id === channel.id);
  }

  private recentChannels(): Channel[] {
    return this.recents.map(id => this.channels.find(c => c.id === id)).filter((c): c is Channel => Boolean(c));
  }

  private arrangement(): Row[] {
    const recent = this.recentChannels();
    const recentIds = new Set(recent.map(c => c.id));
    const rows: Row[] = [];
    if (recent.length) {
      rows.push({ kind: "label", text: "recent channels" });
      recent.forEach((channel, i) => rows.push({ kind: "channel", channel, spans: [], slot: i < 9 ? i + 1 : undefined }));
    }
    const mine = this.channels.filter(c => !recentIds.has(c.id));
    if (mine.length) {
      const tally = (["private", "closed", "public"] as const).map(v => `${this.channels.filter(c => c.visibility === v).length} ${visibilityWord(v)}`).join(" · ");
      rows.push({ kind: "label", text: "my channels", aside: tally });
      for (const channel of mine) rows.push({ kind: "channel", channel, spans: [] });
    }
    return rows;
  }

  private roomRows(room: Channel): Row[] {
    const kids = this.childrenOf(room);
    const mineCount = kids.filter(c => this.isMine(c)).length;
    return [{ kind: "label", text: this.path.map(c => c.title).join(" › "), aside: `${kids.length} channels inside${mineCount < kids.length ? `, ${kids.length - mineCount} not yours` : ""}` },
      ...kids.map(channel => ({ kind: "channel" as const, channel, spans: [] }))];
  }

  /** Steps into the cursor row's nested channels, remembering where the step was taken from. */
  enter(index = this.cursor): boolean {
    const row = this.rows[index];
    if (row?.kind !== "channel" || !this.childrenOf(row.channel).length) {
      if (row?.kind === "channel") this.notice = `no channels inside ${row.channel.title}`;
      return false;
    }
    this.rooms.push({ id: row.channel.id, cursor: index, top: this.top });
    this.query = "";
    this.notice = "";
    this.cursor = 1;
    this.top = 0;
    this.rebuild();
    return true;
  }

  /** Returns to the place the last step into a channel was taken from. */
  back(): boolean {
    const last = this.rooms.pop();
    if (!last) return false;
    this.query = "";
    this.rebuild();
    this.cursor = last.cursor;
    this.top = last.top;
    this.clampCursor();
    return true;
  }

  /** Proposes the next visibility for a channel of the account's own; the change is sent only on save. */
  cycleVisibility(index = this.cursor): void {
    const row = this.rows[index];
    if (row?.kind === "create") return this.cycleCreateVisibility();
    if (row?.kind !== "channel") return;
    const c = row.channel;
    if (!this.isMine(c) || c.pending) { this.notice = c.pending ? "set a new channel's visibility on its row" : `only ${c.owner.name} can change ${c.title}`; return; }
    const next = VISIBILITY_CYCLE[(VISIBILITY_CYCLE.indexOf(this.visibilityOf(c)) + 1) % VISIBILITY_CYCLE.length]!;
    if (next === c.visibility) this.proposedVisibility.delete(c.id);
    else this.proposedVisibility.set(c.id, next);
    this.notice = next === c.visibility ? "" : `${visibilityWord(next)} on save`;
  }

  private exactTitle(): boolean {
    const wanted = normalize(this.query.trim());
    return this.channels.some(c => normalize(c.title) === wanted);
  }

  rebuild(): void {
    const query = this.query.trim();
    if (this.showSelected) {
      this.rows = this.selected.map(channel => ({ kind: "channel", channel, spans: [] }));
    } else if (this.scope !== "mine") {
      this.rows = this.remoteRows();
    } else if (this.mode === "jump" || !query) {
      const rows = this.room ? this.roomRows(this.room) : this.arrangement();
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
    if (!this.query.trim()) return [{ kind: "pending", text: `type to search ${this.scope === "all" ? "all of Are.na" : "my network"}` }];
    if (remote.state === "loading" || remote.query !== this.query.trim() || remote.scope !== this.scope)
      return Array.from({ length: Math.min(4, this.listRows) }, () => ({ kind: "pending", text: "" }));
    if (remote.state === "error") return [{ kind: "pending", text: remote.message ?? "search failed" }];
    if (!remote.channels.length) return [{ kind: "pending", text: "no channels match" }];
    return remote.channels.map(channel => ({ kind: "channel", channel, spans: [] }));
  }

  private selectable(index: number): boolean {
    const row = this.rows[index];
    return row !== undefined && (row.kind === "channel" || row.kind === "create");
  }

  private clampCursor(): void {
    if (this.mode === "jump" && this.query.trim() && !this.showSelected && this.scope === "mine") {
      const best = this.ranker.rank(this.query.trim())[0];
      const at = best ? this.rows.findIndex(r => r.kind === "channel" && r.channel.id === best.channel.id) : -1;
      if (at >= 0) {
        this.cursor = at;
        this.top = Math.max(0, Math.min(at - Math.floor(this.listRows / 2), this.rows.length - this.listRows));
      }
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
    const before = this.rows[this.cursor];
    this.rebuild();
    if (!this.query.trim() && before?.kind === "channel") return this.keepPlace(before.channel.id);
    if (this.mode === "filter") {
      const first = this.rows.findIndex(r => r.kind === "channel");
      this.cursor = first >= 0 ? first : 0;
      this.scrollTo(this.cursor);
    }
  }

  /** Clears the query, then steps back out of nested channels; reports true when nothing is left to undo. */
  escape(): boolean {
    if (this.showSelected) { this.showSelected = false; this.rebuild(); return false; }
    if (!this.query) return !this.back();
    this.clearQuery();
    return false;
  }

  clearQuery(): void {
    const before = this.rows[this.cursor];
    this.query = "";
    this.rebuild();
    if (before?.kind === "channel") this.keepPlace(before.channel.id);
  }

  /** After the query empties, the cursor stays on the channel it was on, now seen in the full arrangement. */
  private keepPlace(channelId: number): void {
    const at = this.rows.findIndex(r => r.kind === "channel" && r.channel.id === channelId);
    if (at < 0) return;
    this.cursor = at;
    this.top = Math.max(0, Math.min(at - Math.floor(this.listRows / 2), this.rows.length - this.listRows));
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

  /** Selects the row's channel as a destination for the block, or deselects it. */
  toggle(index = this.cursor): void {
    const row = this.rows[index];
    if (!row) return;
    if (row.kind === "create") return this.create(row.title);
    if (row.kind !== "channel") return;
    const channel = row.channel;
    if (this.isSelected(channel)) {
      this.selected = this.selected.filter(c => c.id !== channel.id);
      this.notice = "";
    } else if (channel.canAdd === false) {
      this.notice = `you cannot add to ${channel.title}`;
      return;
    } else if (this.connectedTo.has(channel.id)) {
      this.notice = `this block is in ${channel.title}`;
      return;
    } else if (this.selected.length >= 20) {
      this.notice = "choose at most 20 channels";
      return;
    } else {
      this.selected.push(channel);
      this.notice = "";
    }
    if (this.showSelected) this.rebuild();
  }

  select(index: number): void {
    const row = this.rows[index];
    if (row?.kind === "channel" && this.isSelected(row.channel)) return;
    this.toggle(index);
  }

  deselect(channelId: number): void {
    this.selected = this.selected.filter(c => c.id !== channelId);
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
    this.known.set(channel.id, channel);
    this.ranker = new ChannelRanker([...this.known.values()]);
    this.selected.push(channel);
    this.notice = "";
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

  toggleSelectedView(): void {
    this.showSelected = !this.showSelected && this.selected.length > 0;
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
    if (!this.selected.length) {
      const row = this.rows[this.cursor];
      if (row?.kind === "channel" && row.channel.canAdd !== false && !this.connectedTo.has(row.channel.id)) this.selected.push(row.channel);
      if (row?.kind === "create") this.create(row.title);
    }
    const created = this.selected.filter(c => c.pending);
    const changes: Request[] = [...this.proposedVisibility].map(([id, visibility]) => ({ method: "PUT", path: `/v3/channels/${id}`,
      body: { visibility }, note: "arena-block's daemon has no channel-update route yet" }));
    const requests: Request[] = created.map(c => ({ method: "POST", path: "/v3/channels", body: { title: c.title, visibility: c.visibility },
      note: "arena-block's daemon has no channel-creation route yet" }));
    const existing = this.selected.filter(c => !c.pending).map(c => c.id);
    if (this.block?.blockId && this.selected.length) {
      requests.push({ method: "POST", path: "/v1/existing-placements", body: { blockId: this.block.blockId,
        destinations: [...existing, ...created.map(c => `<new ${c.title}>`)], placementId: "<uuid>" } });
    }
    return { destinations: [...this.selected], requests: [...changes, ...requests], created };
  }
}
