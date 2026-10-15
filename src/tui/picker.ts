import { openSync } from "node:fs";
import tty from "node:tty";
import {
  BoxRenderable, RGBA, StyledText, TextRenderable, createCliRenderer, dim, fg, reverse, underline,
  type CliRenderer, type ParsedKey, type TextChunk,
} from "@opentui/core";
import type { ArenaBlockClient } from "../client.ts";
import { arenaDestination } from "../url.ts";
import { PickerModel, type Channel, type HeldBlock, type Mode, type Outcome, type Row } from "./model.ts";

export type Emit = "id" | "slug" | "url" | "json";

export type PickerOptions = {
  client: ArenaBlockClient;
  block?: HeldBlock;
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
const width = (text: string) => Bun.stringWidth(text);

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

/** Draws the model into a fixed stack of one-line text renderables, plus an optional preview column. */
export class PickerView {
  readonly lines: TextRenderable[];
  readonly preview?: TextRenderable;
  readonly listStart = 2;

  constructor(readonly renderer: CliRenderer, readonly model: PickerModel, readonly height: number, readonly opts: { me?: string; previewWidth: number }) {
    const frame = new BoxRenderable(renderer, { id: "frame", flexDirection: "row", width: "100%", height });
    const column = new BoxRenderable(renderer, { id: "column", flexDirection: "column", flexGrow: 1, height });
    frame.add(column);
    this.lines = Array.from({ length: height }, (_, i) => {
      const text = new TextRenderable(renderer, { id: `line-${i}`, content: "", height: 1, width: "100%",
        fg: RGBA.defaultForeground(), bg: RGBA.defaultBackground() });
      column.add(text);
      return text;
    });
    if (opts.previewWidth > 0) {
      this.preview = new TextRenderable(renderer, { id: "preview", content: "", width: opts.previewWidth, height,
        fg: RGBA.defaultForeground(), bg: RGBA.defaultBackground() });
      frame.add(this.preview);
    }
    renderer.root.add(frame);
  }

  get columnWidth(): number {
    return this.renderer.width - (this.preview ? this.opts.previewWidth : 0);
  }

  draw(): void {
    const m = this.model;
    const w = this.columnWidth;
    this.lines[0]!.content = this.hand(w);
    this.lines[1]!.content = this.field(w);
    for (let i = 0; i < m.listRows; i++) this.lines[this.listStart + i]!.content = this.row(m.top + i, w);
    this.lines[this.height - 2]!.content = this.tray(w);
    this.lines[this.height - 1]!.content = this.rule(w);
    if (this.preview) this.preview.content = this.previewText();
    const fieldText = `› ${m.query}`;
    this.renderer.setCursorPosition(Math.min(w - 1, width(fieldText)), 1, true);
  }

  private hand(w: number) {
    const block = this.model.block;
    if (!block) return line([dim("pick channels")]);
    const right = block.alreadyIn.length ? `already in ${block.alreadyIn.length}` : "";
    const left = `◆ ${block.title}`;
    const source = `  ${block.source} · ${block.kind.toLowerCase()}`;
    const room = w - width(right) - 1;
    const title = truncate(left, room);
    const rest = truncate(source, room - width(title));
    return line([title, dim(rest), " ".repeat(Math.max(0, w - width(title) - width(rest) - width(right))), dim(right)]);
  }

  private field(w: number) {
    const m = this.model;
    const scopes: Piece[] = [];
    for (const scope of ["mine", "network", "all"] as const) {
      if (scopes.length) scopes.push(dim(" "));
      scopes.push(scope === m.scope ? underline(ink.plain(scope)) : dim(scope));
    }
    const tag = m.mode === "jump" ? "jump  " : "";
    const right = width(tag) + "mine network all".length;
    const prompt = `› ${m.query}`;
    return line([prompt, " ".repeat(Math.max(1, w - width(prompt) - right)), dim(tag), ...scopes]);
  }

  private gutter(row: Extract<Row, { kind: "channel" }>): Piece {
    const m = this.model;
    const paint = ink[row.channel.visibility];
    if (m.isHeld(row.channel)) return paint("■ ");
    if (m.alreadyIn.has(row.channel.id)) return dim("◇ ");
    if (row.slot) return dim(`${row.slot} `);
    return "  ";
  }

  row(index: number, w: number) {
    const m = this.model;
    const row = m.rows[index];
    if (!row) return line([]);
    const here = index === m.cursor;
    const lit = (p: Piece) => (here ? reverse(typeof p === "string" ? ink.plain(p) : p) : p);
    if (row.kind === "label") return line([dim(`${row.text} ${"─".repeat(Math.max(0, w - width(row.text) - 1))}`)]);
    if (row.kind === "pending") {
      if (row.text) return line([dim(`  ${row.text}`)]);
      const bar = "░".repeat(Math.max(4, Math.floor(w * (0.25 + ((index * 37) % 30) / 100))));
      return line([dim(`  ${bar}`)]);
    }
    if (row.kind === "create") {
      const paint = ink[row.visibility];
      const text = truncate(`+ new ${row.visibility} channel "${row.title}"`, w - 18);
      const hint = "^v visibility";
      const gap = " ".repeat(Math.max(1, w - 2 - width(text) - width(hint)));
      return line(["  ", here ? reverse(ink.plain(text)) : paint(text), lit(gap), dim(hint)]);
    }
    const c = row.channel;
    const showOwner = c.owner.name !== this.opts.me;
    const owner = showOwner ? truncate(c.owner.name, Math.min(18, Math.floor(w / 4))) : "";
    const count = c.pending ? " new" : c.count === undefined ? "" : ` ${c.count}`;
    const room = w - 2 - width(count) - (owner ? width(owner) + 2 : 1);
    const title = truncate(c.title, room);
    const gap = " ".repeat(Math.max(1, w - 2 - width(title) - width(count) - width(owner)));
    const paint = here ? ink.plain : ink[c.visibility];
    const titled = titlePieces(title, title.endsWith("…") ? [] : row.spans, paint);
    const faint = row.faint && !here;
    const body: Piece[] = [...titled.map(p => (faint ? dim(p) : p)), dim(count), gap, dim(owner)];
    return line([this.gutter(row), ...body.map(lit)]);
  }

  trayChips(w: number): Array<{ channel: Channel; from: number; to: number }> {
    const chips: Array<{ channel: Channel; from: number; to: number }> = [];
    let x = 2;
    for (const channel of this.model.held) {
      const label = truncate(channel.title, 24);
      if (x + width(label) + 6 > w) break;
      chips.push({ channel, from: x, to: x + width(label) });
      x += width(label) + 3;
    }
    return chips;
  }

  private tray(w: number) {
    const m = this.model;
    if (m.notice) return line([dim(`  ${truncate(m.notice, w - 2)}`)]);
    if (!m.held.length) {
      const hint = m.block ? "tab puts it down here · click a row · drag ◆ onto a channel" : "tab picks · click a row";
      return line([dim(`  ${truncate(hint, w - 2)}`)]);
    }
    const chips = this.trayChips(w);
    const pieces: Piece[] = [ink.plain("→ ")];
    chips.forEach((chip, i) => {
      if (i) pieces.push(dim(" · "));
      pieces.push(ink[chip.channel.visibility](truncate(chip.channel.title, 24)));
    });
    const more = m.held.length - chips.length;
    if (more > 0) pieces.push(dim(` +${more}`));
    return line(pieces);
  }

  private rule(w: number) {
    const m = this.model;
    const selectable = m.rows.filter(r => r.kind === "channel").length;
    const position = m.rows.slice(0, m.cursor + 1).filter(r => r.kind === "channel").length;
    const n = m.held.length;
    const act = m.block ? (n ? `⏎ connect ${n}` : "⏎ connect") : "⏎ done";
    const hints = m.showHeld ? `⇧⇥ all  ${act}  esc back` : `⇥ ${m.block ? "put down" : "pick"}  ${act}  ^y copy  esc leave`;
    const left = `── ${position}/${selectable} `;
    const fill = "─".repeat(Math.max(1, w - width(left) - width(hints) - 4));
    return line([dim(left), dim(fill), dim(" "), dim(hints), dim(" ──")]);
  }

  private previewText() {
    const pw = this.opts.previewWidth - 2;
    const c = this.model.previewChannel();
    const bar = (pieces: Piece[]) => [dim("│ "), ...pieces];
    const rows: Piece[][] = [];
    if (c) {
      const paint = ink[c.visibility];
      rows.push(bar([paint(truncate(c.title, pw))]));
      rows.push(bar([dim(truncate(`${c.visibility} · ${c.pending ? "created on connect" : `${c.count ?? "?"} blocks`}`, pw))]));
      rows.push(bar([dim(truncate(c.owner.name, pw))]));
      if (c.updatedAt) rows.push(bar([dim(`updated ${c.updatedAt.slice(0, 10)}`)]));
      rows.push(bar([]));
      if (this.model.alreadyIn.has(c.id)) rows.push(bar([dim("◇ already holds this block")]));
      if (this.model.isHeld(c)) rows.push(bar([ink[c.visibility]("■ "), "put down here"]));
      if (c.canAdd === false) rows.push(bar([dim("closed to you")]));
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
  const height = Math.max(8, options.height ?? 14);
  const fd = openSync("/dev/tty", "r+");
  const input = new tty.ReadStream(fd);
  const output = new tty.WriteStream(fd);
  const columns = output.columns || 80;
  const previewWidth = options.previewWidth ?? (columns >= 100 ? 30 : 0);
  const model = new PickerModel(channels, options.recents ?? [], options.block, height - 4, { mode: options.mode, me: options.me });
  output.write("\x1b[A");
  const renderer = await createCliRenderer({
    stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream,
    remote: false, screenMode: "split-footer", footerHeight: height, useMouse: true, clearOnShutdown: false,
    exitOnCtrlC: false, useKittyKeyboard: null, targetFps: 60,
  });
  const view = new PickerView(renderer, model, height, { me: options.me, previewWidth });

  let carrying = false;
  let downRow: number | null = null;
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
        const message = /403|Premium/i.test(String(error)) ? "searching beyond your channels needs Are.na Premium" : "search failed";
        model.setRemote({ query, scope, state: "error", channels: [], message });
      }
      redraw();
    }, 250);
  };

  const teleport = (text: string): boolean => {
    const slug = /^https?:\/\//.test(text.trim()) ? arenaDestination(text.trim()) : undefined;
    if (!slug) return false;
    const at = model.rows.findIndex(r => r.kind === "channel" && (r.channel.slug === slug || String(r.channel.id) === slug));
    if (at < 0) { model.notice = `${slug} is not among your channels`; return true; }
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
      if (outcome && outcome.destinations.length) {
        const names = outcome.destinations.map(c => c.title).join(", ");
        output.write(`${model.block ? `◆ ${model.block.title} → ` : "→ "}${names}\n`);
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
      if ((key.ctrl && name === "c") || (name === "escape" && model.escape())) return leave(false);
      if (name === "return") return leave(true);
      if (key.ctrl && name === "y") return leave(true, true);
      if (name === "tab" && key.shift) model.toggleHeldView();
      else if (name === "tab") model.toggle();
      else if (name === "up" || (key.ctrl && name === "p")) model.move(-1);
      else if (name === "down" || (key.ctrl && name === "n")) model.move(1);
      else if (name === "pageup") model.move(-model.listRows);
      else if (name === "pagedown") model.move(model.listRows);
      else if (key.ctrl && name === "s") { model.cycleScope(); search(); }
      else if (key.ctrl && name === "t") model.toggleMode();
      else if (key.ctrl && name === "v") model.cycleCreateVisibility();
      else if (key.ctrl && name === "u") { model.query = ""; model.rebuild(); search(); }
      else if (key.ctrl && name === "o") { const c = model.previewChannel(); if (c) model.notice = `would open ${channelUrl(c)}`; }
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
        text.onMouseDown = () => { if (model.block) { carrying = true; model.notice = "carrying ◆, release over a channel"; redraw(); } };
      }
      if (lineIndex === 1) {
        text.onMouseDown = event => {
          const right = view.columnWidth - "mine network all".length;
          const x = event.x - right;
          const scope = x >= 0 && x < 4 ? "mine" : x >= 5 && x < 12 ? "network" : x >= 13 ? "all" : undefined;
          if (!scope) return;
          while (model.scope !== scope) model.cycleScope();
          search();
          redraw();
        };
      }
      if (inList) {
        text.onMouseDown = () => { downRow = rowAt(); };
        text.onMouseOver = () => { model.hover = rowAt(); redraw(); };
        text.onMouseUp = () => {
          const at = rowAt();
          if (carrying) { carrying = false; model.notice = ""; model.focusRow(at); model.putDown(at); }
          else if (downRow === at) { model.focusRow(at); model.toggle(at); }
          downRow = null;
          redraw();
        };
        text.onMouseDrop = text.onMouseUp;
        text.onMouseScroll = event => { model.scroll(event.scroll?.direction === "up" ? -1 : 1); redraw(); };
      } else {
        text.onMouseOver = () => { if (model.hover !== null) { model.hover = null; redraw(); } };
      }
      if (lineIndex === height - 2) {
        const drop = () => {
          if (downRow !== null) model.putDown(downRow);
          else if (carrying) model.notice = "release over a channel row";
          carrying = false;
          downRow = null;
          redraw();
        };
        text.onMouseUp = drop;
        text.onMouseDrop = drop;
        text.onMouseDown = event => {
          const chip = view.trayChips(view.columnWidth).find(c => event.x >= c.from && event.x < c.to);
          if (chip) { model.pickUp(chip.channel.id); model.notice = `picked up from ${chip.channel.title}`; redraw(); }
        };
      }
    });

    redraw();
  });
  return result;
}
