import { openSync } from "node:fs";
import tty from "node:tty";
import {
  BoxRenderable, RGBA, StyledText, TextRenderable, createCliRenderer, dim, fg, reverse, underline,
  type CliRenderer, type ParsedKey, type TextChunk,
} from "@opentui/core";
import type { ArenaBlockClient } from "../client.ts";
import { arenaDestination } from "../url.ts";
import { PickerModel, visibilityWord, type Block, type Channel, type Mode, type Outcome, type Row } from "./model.ts";

export type Emit = "id" | "slug" | "url" | "json";

export type PickerOptions = {
  client: ArenaBlockClient;
  block?: Block;
  recents?: number[];
  height?: number;
  mode?: Mode;
  emit?: Emit;
  copy?: boolean;
  me?: string;
  previewWidth?: number;
};

export type PickerResult = { accepted: boolean; outcome?: Outcome; emitted: string };

const ink = {
  private: fg(RGBA.fromIndex(1)),
  public: fg(RGBA.fromIndex(2)),
  closed: fg(RGBA.defaultForeground()),
  plain: fg(RGBA.defaultForeground()),
};
type Piece = string | TextChunk;
const SCOPE_WORDS = { mine: "my are.na", network: "my network", all: "all" } as const;
const SCOPE_LINE = Object.values(SCOPE_WORDS).join("  ");
const SELECTED = "♦";
const CONNECTED = "♢";
const NEST = "›";
const VISIBILITY_WIDTH = 7;
const SELECTED_LABEL = "selected";

function scopeAt(x: number): keyof typeof SCOPE_WORDS | undefined {
  let start = 0;
  for (const [scope, word] of Object.entries(SCOPE_WORDS) as Array<[keyof typeof SCOPE_WORDS, string]>) {
    if (x >= start && x < start + word.length) return scope;
    start += word.length + 2;
  }
  return undefined;
}

const width = (text: string) => Bun.stringWidth(text);
const padEnd = (text: string, to: number) => text + " ".repeat(Math.max(0, to - width(text)));
const padStart = (text: string, to: number) => " ".repeat(Math.max(0, to - width(text))) + text;

function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (width(out + ch) + 1 > max) break;
    out += ch;
  }
  return `${out}…`;
}

function line(pieces: Piece[]): StyledText {
  return new StyledText(pieces.map(p => (typeof p === "string" ? ink.plain(p) : p)));
}

function titlePieces(title: string, spans: Array<[number, number]>, paint: (s: string) => TextChunk): Piece[] {
  if (!spans.length) return [paint(title)];
  const marks = new Array(title.length).fill(false);
  for (const [a, b] of spans) for (let i = a; i < Math.min(b, title.length); i++) marks[i] = true;
  const pieces: Piece[] = [];
  let run = "", on = marks[0];
  for (let i = 0; i < title.length; i++) {
    if (marks[i] !== on) { pieces.push(on ? underline(paint(run)) : paint(run)); run = ""; on = marks[i]; }
    run += title[i];
  }
  pieces.push(on ? underline(paint(run)) : paint(run));
  return pieces;
}

function channelUrl(channel: Channel): string {
  return `https://www.are.na/${channel.owner.slug}/${channel.slug}`;
}

export function emitText(outcome: Outcome, emit: Emit): string {
  if (emit === "json") return `${JSON.stringify(outcome, null, 2)}\n`;
  return outcome.destinations.map(c => (emit === "slug" ? c.slug : emit === "url" ? channelUrl(c) : c.pending ? `new:${c.title}` : String(c.id)))
    .map(s => `${s}\n`).join("");
}

/** Copies through the desktop clipboard tool when one is present, else asks the terminal with OSC 52. */
function copyText(text: string, output: tty.WriteStream): string {
  const tool = process.env.WAYLAND_DISPLAY && Bun.which("wl-copy") ? ["wl-copy"] : Bun.which("pbcopy") ? ["pbcopy"] : undefined;
  if (tool && Bun.spawnSync(tool, { stdin: Buffer.from(text) }).exitCode === 0) return tool[0]!;
  output.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  return "OSC 52";
}

/** Widths of the right-hand columns, measured over the rows on screen so every visible row lines up. */
type Columns = { owner: number; count: number; nest: number };

/**
 * Draws the model into a fixed stack of one-line text renderables, plus an optional preview column.
 * From the top: the block, the query field, the list, a blank line, the selected channels, and the key rule.
 */
export class PickerView {
  readonly lines: TextRenderable[];
  readonly preview?: TextRenderable;
  readonly listStart = 2;

  constructor(readonly renderer: CliRenderer, readonly model: PickerModel, readonly height: number, readonly opts: { me?: string; previewWidth: number }) {
    const frame = new BoxRenderable(renderer, { id: "frame", flexDirection: "row", width: "100%", height });
    const column = new BoxRenderable(renderer, { id: "column", flexDirection: "column", flexGrow: 1, height });
    frame.add(column);
    this.lines = Array.from({ length: height }, (_, i) => {
      const text = new TextRenderable(renderer, { id: `line-${i}`, content: "", height: 1, width: "100%", selectable: false,
        fg: RGBA.defaultForeground(), bg: RGBA.defaultBackground() });
      column.add(text);
      return text;
    });
    if (opts.previewWidth > 0) {
      this.preview = new TextRenderable(renderer, { id: "preview", content: "", width: opts.previewWidth, height, selectable: false,
        fg: RGBA.defaultForeground(), bg: RGBA.defaultBackground() });
      frame.add(this.preview);
    }
    renderer.root.add(frame);
  }

  get columnWidth(): number {
    return this.renderer.width - (this.preview ? this.opts.previewWidth : 0);
  }

  get trayLine(): number {
    return this.height - 2;
  }

  draw(): void {
    const m = this.model;
    const w = this.columnWidth;
    this.lines[0]!.content = this.blockLine(w);
    this.lines[1]!.content = this.field(w);
    const thumb = m.rows.length > m.listRows ? this.thumb() : undefined;
    const inList = thumb && !this.preview ? thumb : undefined;
    const rowWidth = inList ? w - 2 : w;
    const columns = this.columns();
    for (let i = 0; i < m.listRows; i++) {
      const row = this.row(m.top + i, rowWidth, columns);
      if (inList) row.chunks.push(ink.plain(" "), i >= inList[0] && i < inList[1] ? ink.plain("┃") : dim("│"));
      this.lines[this.listStart + i]!.content = row;
    }
    this.lines[this.trayLine - 1]!.content = line([]);
    this.lines[this.trayLine]!.content = this.tray(w);
    this.lines[this.height - 1]!.content = this.rule(w);
    if (this.preview) this.preview.content = this.previewText(thumb);
    this.renderer.setCursorPosition(Math.min(w - 1, width(this.prompt())) + 1, this.lines[1]!.y + 1, true);
  }

  private thumb(): [number, number] {
    const m = this.model;
    const size = Math.max(1, Math.round((m.listRows * m.listRows) / m.rows.length));
    const start = Math.round((m.top / Math.max(1, m.rows.length - m.listRows)) * (m.listRows - size));
    return [start, start + size];
  }

  private blockLine(w: number) {
    const block = this.model.block;
    if (!block) return line([dim("choose channels")]);
    const right = block.connectedTo.length ? `in ${block.connectedTo.length} channel${block.connectedTo.length === 1 ? "" : "s"}` : "";
    const facts = `   ${block.source}   ${block.kind.toLowerCase()}`;
    const room = w - width(right) - 2;
    const title = truncate(`${SELECTED} ${block.title}`, room);
    const rest = truncate(facts, room - width(title));
    return line([title, dim(rest), " ".repeat(Math.max(0, w - width(title) - width(rest) - width(right))), dim(right)]);
  }

  private prompt(): string {
    const m = this.model;
    const trail = m.path.map(c => truncate(c.title, 14)).join(" › ");
    return `${trail ? `${trail} ` : ""}› ${m.query}`;
  }

  private field(w: number) {
    const m = this.model;
    const scopes: Piece[] = [];
    for (const scope of ["mine", "network", "all"] as const) {
      if (scopes.length) scopes.push(dim("  "));
      scopes.push(scope === m.scope ? underline(ink.plain(SCOPE_WORDS[scope])) : dim(SCOPE_WORDS[scope]));
    }
    const tag = m.mode === "jump" ? "jump  " : "";
    const prompt = this.prompt();
    return line([prompt, " ".repeat(Math.max(1, w - width(prompt) - width(tag) - SCOPE_LINE.length)), dim(tag), ...scopes]);
  }

  private countText(c: Channel): string {
    return c.pending ? "new" : c.count === undefined ? "" : String(c.count);
  }

  private nestText(c: Channel): string {
    const kids = this.model.childrenOf(c).length;
    return kids ? `${NEST} ${kids}` : "";
  }

  private columns(): Columns {
    const m = this.model;
    const visible = m.rows.slice(m.top, m.top + m.listRows).flatMap(r => (r.kind === "channel" ? [r.channel] : []));
    const others = visible.filter(c => !m.isMine(c));
    return {
      owner: Math.min(16, Math.max(0, ...others.map(c => width(c.owner.name)))),
      count: Math.max(1, ...visible.map(c => width(this.countText(c)))),
      nest: Math.max(0, ...visible.map(c => width(this.nestText(c)))),
    };
  }

  private gutter(row: Extract<Row, { kind: "channel" }>): Piece {
    const m = this.model;
    if (m.isSelected(row.channel)) return ink[m.visibilityOf(row.channel)](`${SELECTED} `);
    if (m.connectedTo.has(row.channel.id)) return dim(`${CONNECTED} `);
    if (row.slot) return dim(`${row.slot} `);
    return "  ";
  }

  row(index: number, w: number, columns = this.columns()) {
    const m = this.model;
    const row = m.rows[index];
    if (!row || row.kind === "gap") return line([]);
    const here = index === m.cursor;
    const lit = (p: Piece) => (here ? reverse(typeof p === "string" ? ink.plain(p) : p) : p);
    if (row.kind === "label") return line([dim(`${row.text} ${"─".repeat(Math.max(1, w - width(row.text) - 1))}`)]);
    if (row.kind === "pending") {
      if (row.text) return line([dim(`  ${row.text}`)]);
      const bar = "░".repeat(Math.max(4, Math.floor(w * (0.25 + ((index * 37) % 30) / 100))));
      return line([dim(`  ${bar}`)]);
    }
    if (row.kind === "create") {
      const text = truncate(`new ${visibilityWord(row.visibility)} channel "${row.title}"`, w - 2);
      const body = padEnd(text, w - 2);
      return line([dim("+ "), here ? reverse(ink.plain(body)) : ink[row.visibility](body)]);
    }
    const c = row.channel;
    const visibility = m.visibilityOf(c);
    const changed = visibility !== c.visibility;
    const parent = m.query.trim() && !m.room ? m.parentOf(c) : undefined;
    const trail = parent ? `${truncate(parent.title, 16)} ${NEST} ` : "";
    const owner = columns.owner ? padEnd(m.isMine(c) ? "" : truncate(c.owner.name, columns.owner), columns.owner) + "  " : "";
    const count = padStart(this.countText(c), columns.count);
    const nest = columns.nest ? "  " + padEnd(this.nestText(c), columns.nest) : "";
    const state = padEnd(visibilityWord(visibility), VISIBILITY_WIDTH);
    const right = width(owner) + width(count) + width(nest) + 2 + VISIBILITY_WIDTH;
    const room = w - 2 - width(trail) - right - 2;
    const title = truncate(c.title, room);
    const gap = " ".repeat(Math.max(2, w - 2 - width(trail) - width(title) - right));
    const paint = here ? ink.plain : ink[visibility];
    const faint = (row.faint || c.canAdd === false) && !here;
    const titled = titlePieces(title, title.endsWith("…") ? [] : row.spans, paint).map(p => (faint ? dim(p) : p));
    const stateInk = changed ? underline((here ? ink.plain : ink[visibility])(state)) : dim(state);
    const body: Piece[] = [dim(trail), ...titled, gap, dim(owner), dim(count), dim(nest), "  ", stateInk];
    return line([this.gutter(row), ...body.map(lit)]);
  }

  trayChips(w: number): Array<{ channel: Channel; from: number; to: number }> {
    const chips: Array<{ channel: Channel; from: number; to: number }> = [];
    let x = width(SELECTED_LABEL);
    for (const channel of this.model.selected) {
      const label = `${SELECTED} ${truncate(channel.title, 24)}`;
      if (x + 3 + width(label) + 4 > w) break;
      chips.push({ channel, from: x + 3, to: x + 3 + width(label) });
      x += 3 + width(label);
    }
    return chips;
  }

  private tray(w: number) {
    const m = this.model;
    if (m.notice) return line([dim(truncate(m.notice, w))]);
    if (!m.selected.length) return line([]);
    const chips = this.trayChips(w);
    const pieces: Piece[] = [dim(SELECTED_LABEL)];
    for (const chip of chips) {
      const paint = ink[m.visibilityOf(chip.channel)];
      pieces.push("   ", paint(`${SELECTED} `), paint(truncate(chip.channel.title, 24)));
    }
    const more = m.selected.length - chips.length;
    if (more > 0) pieces.push(dim(`   +${more}`));
    return line(pieces);
  }

  private rule(w: number) {
    const m = this.model;
    const selectable = m.rows.filter(r => r.kind === "channel").length;
    const position = m.rows.slice(0, m.cursor + 1).filter(r => r.kind === "channel").length;
    const n = m.selected.length;
    const act: [string, string] = m.block ? ["enter", n ? `save to ${n}` : "save"] : ["enter", "done"];
    const onCreate = m.rows[m.cursor]?.kind === "create";
    const hints: Array<[string, string]> = m.showSelected ? [["shift-tab", "all channels"], act, ["esc", "back"]]
      : [["tab", "select"], ...(onCreate ? [["^v", "visibility"] as [string, string]] : []), act, ["^y", "copy"], ["esc", m.rooms.length ? "back" : "close"]];
    const pieces: Piece[] = [];
    hints.forEach(([key, label], i) => pieces.push(i ? "  " : "", key, dim(` ${label}`)));
    const hintWidth = hints.reduce((sum, [k, l], i) => sum + (i ? 2 : 0) + width(k) + 1 + width(l), 0);
    const left = `── ${position}/${selectable} `;
    const fill = "─".repeat(Math.max(1, w - width(left) - hintWidth - 4));
    return line([dim(left), dim(fill), " ", ...pieces, dim(" ──")]);
  }

  private previewText(thumb?: [number, number]) {
    const pw = this.opts.previewWidth - 2;
    const m = this.model;
    const c = m.previewChannel();
    let at = 0;
    const bar = (pieces: Piece[]) => {
      const list = at++ - this.listStart;
      const lit = thumb && list >= thumb[0] && list < thumb[1];
      return [lit ? ink.plain("┃ ") : dim("│ "), ...pieces];
    };
    const rows: Piece[][] = [];
    if (c) {
      const visibility = m.visibilityOf(c);
      const kids = m.childrenOf(c).length;
      rows.push(bar([ink[visibility](truncate(c.title, pw))]));
      rows.push(bar([dim(visibilityWord(c.visibility))]));
      if (visibility !== c.visibility) rows.push(bar([ink[visibility](`${visibilityWord(visibility)} on save`)]));
      rows.push(bar([dim(c.pending ? "created on save" : `${c.count ?? "?"} block${c.count === 1 ? "" : "s"}`)]));
      if (kids) rows.push(bar([dim(`${kids} channel${kids === 1 ? "" : "s"}`)]));
      rows.push(bar([dim(truncate(c.owner.name, pw))]));
      if (c.updatedAt) rows.push(bar([dim(`updated ${c.updatedAt.slice(0, 10)}`)]));
      rows.push(bar([]));
      if (m.connectedTo.has(c.id)) rows.push(bar([dim(`${CONNECTED} this block is here`)]));
      if (m.isSelected(c)) rows.push(bar([ink[visibility](`${SELECTED} `), "selected"]));
      if (c.canAdd === false) rows.push(bar([dim("you cannot add here")]));
    }
    while (rows.length < this.height) rows.push(bar([]));
    const pieces: Piece[] = [];
    rows.slice(0, this.height).forEach((r, i) => { if (i) pieces.push("\n"); pieces.push(...r); });
    return line(pieces);
  }
}


/** Runs the picker inline below the prompt, drawing on /dev/tty so stdout stays free for the result. */
export async function runPicker(options: PickerOptions): Promise<PickerResult> {
  const index = await options.client.channelIndex();
  const channels = index.channels as Channel[];
  const nesting = await options.client.channelNesting().catch(() => undefined);
  const height = Math.max(10, options.height ?? 18);
  const fd = openSync("/dev/tty", "r+");
  const input = new tty.ReadStream(fd);
  const output = new tty.WriteStream(fd);
  const columns = output.columns || 80;
  const previewWidth = options.previewWidth ?? (columns >= 100 ? 30 : 0);
  const model = new PickerModel(channels, options.recents ?? [], options.block, height - 5, { mode: options.mode, me: options.me, nesting });
  output.write("\x1b[A");
  const renderer = await createCliRenderer({
    stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream,
    remote: false, screenMode: "split-footer", footerHeight: height, useMouse: true, clearOnShutdown: false,
    exitOnCtrlC: false, useKittyKeyboard: {}, targetFps: 60,
  });
  const view = new PickerView(renderer, model, height, { me: options.me, previewWidth });

  let carrying = false;
  let downRow: number | null = null;
  let lastClick: { row: number; at: number } | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const redraw = () => { view.draw(); renderer.requestRender(); };

  const search = () => {
    clearTimeout(searchTimer);
    const query = model.query.trim();
    if (model.scope === "mine" || !query) return;
    const scope = model.scope;
    model.setRemote({ query, scope, state: "loading", channels: [] });
    searchTimer = setTimeout(async () => {
      try {
        const found = await options.client.channelSearch(query, scope === "network" ? "following" : "all");
        if (model.query.trim() === query && model.scope === scope) model.setRemote({ query, scope, state: "done", channels: found.channels as Channel[] });
      } catch (error) {
        const message = /403|Premium/i.test(String(error)) ? "search across Are.na requires Premium" : "search failed";
        model.setRemote({ query, scope, state: "error", channels: [], message });
      }
      redraw();
    }, 250);
  };

  const teleport = (text: string): boolean => {
    const slug = /^https?:\/\//.test(text.trim()) ? arenaDestination(text.trim()) : undefined;
    if (!slug) return false;
    const at = model.rows.findIndex(r => r.kind === "channel" && (r.channel.slug === slug || String(r.channel.id) === slug));
    if (at < 0) { model.notice = `no channel in my channels matches ${slug}`; return true; }
    model.focusRow(at);
    model.notice = "";
    return true;
  };

  const result = await new Promise<PickerResult>(resolve => {
    const leave = (accepted: boolean, copy = false) => {
      clearTimeout(searchTimer);
      const outcome = accepted ? model.commit() : undefined;
      const emitted = outcome && outcome.destinations.length ? emitText(outcome, options.emit ?? "id") : "";
      renderer.destroy();
      output.write(`\x1b[${height}A\r\x1b[J`);
      if (outcome && (outcome.destinations.length || outcome.requests.length)) {
        const names = outcome.destinations.map(c => c.title).join(", ");
        if (names) output.write(`${model.block ? `◆ ${model.block.title}  to ` : "chose "}${names}\n`);
        for (const request of outcome.requests) {
          const body = request.body ? ` ${JSON.stringify(request.body)}` : "";
          output.write(`\x1b[2m  would send ${truncate(`${request.method} ${request.path}${body}`, columns - 14)}\x1b[22m\n`);
          if (request.note) output.write(`\x1b[2m    ${request.note}\x1b[22m\n`);
        }
        if (copy || options.copy) {
          const via = copyText(emitted.trim(), output);
          output.write(`\x1b[2m  copied ${outcome.destinations.length} to the clipboard (${via})\x1b[22m\n`);
        }
      }
      input.destroy();
      resolve({ accepted: Boolean(outcome?.destinations.length), outcome, emitted });
    };

    renderer.keyInput.on("keypress", (key: ParsedKey) => {
      const name = key.name;
      model.notice = "";
      if (key.ctrl && name === "c") return leave(false);
      if (name === "escape") {
        if (model.escape()) return leave(false);
        return redraw();
      }
      if (name === "return") return leave(true);
      if (key.ctrl && name === "y") return leave(true, true);
      if (name === "tab" && key.shift) model.toggleSelectedView();
      else if (name === "tab") model.toggle();
      else if (name === "up" || (key.ctrl && name === "p")) model.move(-1);
      else if (name === "down" || (key.ctrl && name === "n")) model.move(1);
      else if (name === "pageup") model.move(-model.listRows);
      else if (name === "pagedown") model.move(model.listRows);
      else if (key.ctrl && name === "s") { model.cycleScope(); search(); }
      else if (key.ctrl && name === "t") model.toggleMode();
      else if (key.ctrl && name === "v") model.cycleVisibility();
      else if ((name === "right" || (key.ctrl && name === "]")) && !model.query) model.enter();
      else if (name === "left" && !model.query) model.back();
      else if (key.ctrl && name === "u") { model.clearQuery(); search(); }
      else if (key.ctrl && name === "o") { const c = model.previewChannel(); if (c) model.notice = channelUrl(c); }
      else if (key.meta && /^[1-9]$/.test(name)) model.toggleRecent(Number(name));
      else if (name === "backspace") { model.backspace(); search(); }
      else if (!key.ctrl && !key.meta && key.sequence && !key.sequence.startsWith("\x1b") && key.sequence >= " ") {
        model.type(key.sequence);
        if (teleport(model.query)) {
          model.query = "";
          model.rebuild();
        } else search();
      } else return;
      redraw();
    });

    renderer.keyInput.on("paste", event => {
      const text = new TextDecoder().decode(event.bytes);
      if (!teleport(text)) { model.type(text.replace(/\s+/g, " ").trim()); search(); }
      redraw();
    });

    view.lines.forEach((text, lineIndex) => {
      const rowAt = () => model.top + lineIndex - view.listStart;
      const inList = lineIndex >= view.listStart && lineIndex < view.listStart + model.listRows;
      if (lineIndex === 0) {
        text.onMouseDown = () => { if (model.block) carrying = true; };
      }
      if (lineIndex === 1) {
        text.onMouseDown = event => {
          const x = event.x - (view.columnWidth - SCOPE_LINE.length);
          const scope = scopeAt(x);
          if (!scope) return;
          while (model.scope !== scope) model.cycleScope();
          search();
          redraw();
        };
      }
      if (inList) {
        text.onMouseDown = () => { downRow = rowAt(); };
        text.onMouseOver = () => { model.hover = rowAt(); redraw(); };
        text.onMouseUp = event => {
          const at = model.top + event.y - view.lines[0]!.y - view.listStart;
          if (at !== rowAt()) return;
          if (carrying) { carrying = false; model.focusRow(at); model.select(at); }
          else if (downRow === at) {
            const now = performance.now();
            const second = lastClick && lastClick.row === at && now - lastClick.at < 400;
            lastClick = second ? undefined : { row: at, at: now };
            model.focusRow(at);
            const row = model.rows[at];
            if (second && row?.kind === "channel" && model.childrenOf(row.channel).length) { model.toggle(at); model.enter(at); }
            else model.toggle(at);
          }
          downRow = null;
          redraw();
        };
        text.onMouseDrop = text.onMouseUp;
        text.onMouseScroll = event => { model.scroll(event.scroll?.direction === "up" ? -1 : 1); redraw(); };
      } else {
        text.onMouseOver = () => { if (model.hover !== null) { model.hover = null; redraw(); } };
      }
      if (lineIndex === view.trayLine || lineIndex === view.trayLine - 1) {
        const drop = () => {
          if (downRow !== null) model.select(downRow);
          carrying = false;
          downRow = null;
          redraw();
        };
        text.onMouseUp = drop;
        text.onMouseDrop = drop;
        text.onMouseDown = event => {
          const chip = view.trayChips(view.columnWidth).find(c => event.x >= c.from && event.x < c.to);
          if (chip) { model.deselect(chip.channel.id); redraw(); }
        };
      }
    });

    redraw();
    setTimeout(redraw, 20);
  });
  return result;
}
