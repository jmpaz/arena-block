import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { ArenaBlockClient } from "../src/client.ts";
import { readSnapshot, startSnapshotDaemon, type SnapshotDaemon } from "../src/tui/snapshot-daemon.ts";
import { PickerModel, type Channel } from "../src/tui/model.ts";
import { emitText, PickerView } from "../src/tui/picker.ts";
import { ChannelRanker } from "../src/tui/rank.ts";

const snapshot = readSnapshot(join(import.meta.dir, "fixtures/tui/channels.json"));
const block = snapshot.block;
const channels = snapshot.channels as Channel[];
const model = (mode: "filter" | "jump" = "filter") => new PickerModel(channels, snapshot.recents, block, 10, { mode, me: "Ana Ruiz" });
const daemons: SnapshotDaemon[] = [];
afterEach(() => daemons.splice(0).forEach(d => d.stop()));

describe("ranking", () => {
  test("every query word must match, and exact words outrank prefixes", () => {
    const titles = new ChannelRanker(channels).rank("gardens room").map(m => m.channel.title);
    expect(titles[0]).toBe("Gardens room");
    expect(titles.every(t => /garden/i.test(t) && /room/i.test(t))).toBe(true);
  });

  test("an in-order subsequence has to start where the word starts", () => {
    const head = new ChannelRanker([...channels, { ...channels[5]!, id: 1, title: "padding", slug: "padding" }]).rank("pdng");
    expect(head.map(m => m.channel.title)).toContain("padding");
    expect(new ChannelRanker([{ ...channels[5]!, id: 1, title: "padding", slug: "padding" }]).rank("ading")).toHaveLength(0);
  });

  test("one typo is forgiven in a word of four letters or more", () => {
    expect(new ChannelRanker(channels).rank("gardnes").map(m => m.channel.title).some(t => /gardens/i.test(t))).toBe(true);
  });
});

describe("model", () => {
  test("an empty query shows recents first, numbered, then the rest without repeats", () => {
    const m = model();
    expect(m.rows.slice(0, 2)).toEqual([{ kind: "gap" }, { kind: "label", text: "recent channels" }]);
    const recent = m.rows.slice(2, 5).map(r => r.kind === "channel" ? [r.channel.id, r.slot] : null);
    expect(recent).toEqual([[9010, 1], [9020, 2], [9030, 3]]);
    const ids = m.rows.flatMap(r => r.kind === "channel" ? [r.channel.id] : []);
    expect(new Set(ids).size).toBe(ids.length);
    m.rows.forEach((row, i) => { if (row.kind === "label") expect(m.rows[i - 1]).toEqual({ kind: "gap" }); });
  });

  test("typing offers a create row above the matches, and the cursor starts on the first match", () => {
    const m = model();
    m.type("garden");
    expect(m.rows[1]).toMatchObject({ kind: "create", title: "garden", visibility: "private" });
    expect(m.rows[m.cursor]?.kind).toBe("channel");
    m.cycleCreateVisibility();
    expect(m.rows[1]).toMatchObject({ kind: "create", visibility: "closed" });
  });

  test("tab selects a channel and deselects it; channels with the block already refuse", () => {
    const m = model();
    m.toggleRecent(1);
    expect(m.selected.map(c => c.id)).toEqual([9010]);
    m.toggleRecent(1);
    expect(m.selected).toHaveLength(0);
    const at = m.rows.findIndex(r => r.kind === "channel" && r.channel.id === 9011);
    m.toggle(at);
    expect(m.selected).toHaveLength(0);
    expect(m.notice).toBe("this block is in Screens programs");
  });

  test("clearing the query keeps the cursor on the channel it was on", () => {
    const m = model();
    m.type("gardens room");
    const row = m.rows[m.cursor];
    m.clearQuery();
    const after = m.rows[m.cursor];
    expect(after?.kind === "channel" && row?.kind === "channel" && after.channel.id === row.channel.id).toBe(true);
  });

  test("jump mode keeps the arrangement and moves the cursor to the best match", () => {
    const m = model("jump");
    const before = m.rows.map(r => r.kind === "channel" ? r.channel.id : r.kind);
    m.type("terminal reading");
    expect(m.rows.map(r => r.kind === "channel" ? r.channel.id : r.kind)).toEqual(before);
    const row = m.rows[m.cursor];
    expect(row?.kind === "channel" && row.channel.title).toBe("Terminal reading");
  });

  test("commit describes the requests a real save would send, and sends none", () => {
    const m = model();
    m.toggleRecent(2);
    m.type("brand new");
    m.toggle(1);
    const outcome = m.commit();
    expect(outcome.requests.map(r => `${r.method} ${r.path}`)).toEqual(["POST /v3/channels", "POST /v1/existing-placements"]);
    expect(emitText(outcome, "id")).toBe("9020\nnew:brand new\n");
  });
});

describe("snapshot daemon", () => {
  test("serves the read routes and refuses every write", async () => {
    const daemon = startSnapshotDaemon(snapshot);
    daemons.push(daemon);
    const client = new ArenaBlockClient(daemon.endpoint, daemon.token);
    expect((await client.channelIndex()).channels).toHaveLength(150);
    expect((await client.channelSearch("gardens room", "all")).channels[0]?.title).toBe("Gardens room");
    await expect(client.existingPlacement({ id: crypto.randomUUID(), blockId: 42, destinations: [9010] })).rejects.toThrow();
    expect(daemon.refused).toEqual(["POST /v1/existing-placements"]);
  });
});

describe("view", () => {
  test("rows set counts and visibility in columns, and show owners other than the account", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 14 });
    const m = new PickerModel(channels, snapshot.recents, block, 14 - 5, { me: "Ana Ruiz" });
    const view = new PickerView(renderer, m, 14, { me: "Ana Ruiz", previewWidth: 0 });
    m.type("gardens room");
    view.draw();
    await renderOnce();
    const lines = captureCharFrame().split("\n");
    expect(lines[1]).toStartWith("› gardens room");
    const row = lines.find(l => l.includes("Gardens room"))!;
    expect(row).toMatch(/Gardens room +\d+ +(private|closed|open) *$/);
    expect(row).not.toContain("Ana Ruiz");
    const rows = lines.slice(view.listStart, view.listStart + m.listRows).filter(l => /(private|closed|open) *$/.test(l));
    expect(new Set(rows.map(l => l.search(/(private|closed|open) *$/))).size).toBe(1);
    expect(lines[view.trayLine - 1]!.trim()).toBe("");
    expect(lines[13]).toContain("enter save");
    renderer.destroy();
  });
});

describe("nesting and visibility", () => {
  const nested = () => new PickerModel(channels, snapshot.recents, block, 10, {
    me: "Ana Ruiz", nesting: { parents: { "9012": [9013, 9014], "9013": [9015] }, channels: [] },
  });

  test("right steps into a channel's nested channels and left returns to the same row", () => {
    const m = nested();
    const at = m.rows.findIndex(r => r.kind === "channel" && r.channel.id === 9012);
    m.focusRow(at);
    expect(m.enter()).toBe(true);
    expect(m.rows.flatMap(r => r.kind === "channel" ? [r.channel.id] : [])).toEqual([9013, 9014]);
    m.enter();
    expect(m.path.map(c => c.id)).toEqual([9012, 9013]);
    m.back();
    m.back();
    expect(m.rooms).toHaveLength(0);
    expect(m.cursor).toBe(at);
  });

  test("escape clears the query, then climbs out, then reports there is nothing left", () => {
    const m = nested();
    m.focusRow(m.rows.findIndex(r => r.kind === "channel" && r.channel.id === 9012));
    m.enter();
    m.type("x");
    expect(m.escape()).toBe(false);
    expect(m.escape()).toBe(false);
    expect(m.rooms).toHaveLength(0);
    expect(m.escape()).toBe(true);
  });

  test("a visibility change on an own channel is proposed, shown, and sent only as a stubbed request", () => {
    const m = nested();
    const at = m.rows.findIndex(r => r.kind === "channel" && r.channel.owner.name === "Ana Ruiz" && r.channel.visibility === "private");
    m.cycleVisibility(at);
    const row = m.rows[at]!;
    expect(row.kind === "channel" && m.visibilityOf(row.channel)).toBe("closed");
    expect(m.commit().requests[0]).toMatchObject({ method: "PUT", body: { visibility: "closed" } });
  });
});
