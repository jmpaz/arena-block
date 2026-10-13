import { expect, test } from "bun:test";
import { ChannelPickerModel, channelPage, matchesChannel, type ChannelRow } from "../extension/src/channel-picker.ts";
import { routeBrowserDestinations } from "../extension/src/browser-save.ts";

const row = (id: number, title = `Channel ${id}`): ChannelRow => ({ id, title, slug: `channel-${id}`,
  visibility: id % 2 ? "private" : "public", owner: { name: "Example", slug: "josh" }, count: id });

test("channel pages preserve metadata, ownership, permissions and next page", () => {
  const page = channelPage({ accountId: 7, channels: [{ id: 2, title: "Reading", slug: "reading",
    visibility: "closed", owner: { name: "Example", slug: "josh" }, count: 42, canAdd: false }], nextPage: 3 }, 2);
  expect(page).toEqual({ accountId: 7, rows: [{ id: 2, title: "Reading", slug: "reading",
    visibility: "closed", owner: { name: "Example", slug: "josh" }, count: 42, canAdd: false }], nextPage: 3 });
  expect(channelPage({ data: [row(1)], meta: { has_more_pages: true } }, 1).nextPage).toBe(2);
});

test("selection survives metadata refresh and remains ordered across pages and search", () => {
  const picker = new ChannelPickerModel();
  picker.replaceRows([row(1, "Motion Index"), row(2, "Paintings")], 1, 2, 7);
  picker.choose(row(2, "Paintings"));
  picker.replaceRows([row(2, "Paintings Updated"), row(3, "Music")], 2, null, 7);
  expect([...picker.owned.keys()]).toEqual([1, 2, 3]);
  expect([...picker.selected.values()].map(value => value.title)).toEqual(["Paintings Updated"]);
  picker.query = "mtion";
  expect(picker.rows().map(value => value.id)).toEqual([1]);
  picker.scope = "all";
  picker.replaceRows([row(10)], 1, null, 7);
  expect([...picker.selected.values()].map(value => value.value)).toEqual(["2"]);
  picker.scope = "my";
  expect(picker.rows().map(value => value.id)).toEqual([1]);
});

test("unavailable channels cannot be added, and twenty selections keep their route", () => {
  const picker = new ChannelPickerModel();
  expect(() => picker.choose({ ...row(1), canAdd: false })).toThrow();
  for (let id = 1; id <= 20; id++) picker.choose(row(id));
  expect(() => picker.choose(row(21))).toThrow("Choose at most 20 channels");
  expect(routeBrowserDestinations([...picker.selected.values()].map(value => value.value))).toHaveLength(20);
  picker.choose(row(2));
  picker.add("my-default");
  expect(routeBrowserDestinations([...picker.selected.values()].map(value => value.value),
    { channel: "my-default", mode: "always" })).toHaveLength(20);
  expect(matchesChannel(row(1, "Motion Index"), "josh motion")).toBe(true);
});
