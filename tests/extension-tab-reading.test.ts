import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { configureSubstackTabReading, readActiveSubstackTab, type TabReadingManifest } from "../extension/src/substack-tab.ts";
import { resolveCapture } from "../extension/src/core.ts";

const source = "https://substack.com/@norvidstudies/note/c-360829302";
const html = await Bun.file(new URL("../extension/src/editor.html", import.meta.url)).text();

test("a build without tab reading stays visibly unavailable across locks and never touches tab APIs", async () => {
  const document = createDocument(html);
  const button = document.getElementById("read-substack") as unknown as HTMLButtonElement;
  const notice = document.getElementById("substack-tab-availability") as unknown as HTMLElement;
  const manifest = { permissions: ["activeTab", "storage", "identity"], optional_permissions: ["nativeMessaging"] };
  for (const locked of [false, true, false]) {
    expect(configureSubstackTabReading(manifest, button, notice, locked)).toBe(false);
    expect(button.disabled).toBe(true);
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("Paste a link and choose Preview");
  }
  expect((document.getElementById("resolve") as unknown as HTMLButtonElement).disabled).toBe(false);
  const calls: string[] = [];
  await expect(readActiveSubstackTab({
    runtime: { getManifest: () => manifest },
    permissions: { contains: async () => { calls.push("permission"); return true; } },
    tabs: { query: async () => { calls.push("tab"); return []; } },
    scripting: { executeScript: async () => { calls.push("execute"); return []; } },
  }, source)).rejects.toThrow("unavailable here");
  expect(calls).toEqual([]);
});

test("declared tab reading retains its lock and existing-grant boundary", async () => {
  for (const manifest of [{ optional_permissions: ["scripting"] }, { permissions: ["scripting"] }] satisfies TabReadingManifest[]) {
    const document = createDocument(html);
    const button = document.getElementById("read-substack") as unknown as HTMLButtonElement;
    const notice = document.getElementById("substack-tab-availability") as unknown as HTMLElement;
    for (const locked of [false, true, false]) {
      expect(configureSubstackTabReading(manifest, button, notice, locked)).toBe(true);
      expect(button.disabled).toBe(locked);
      expect(notice.hidden).toBe(true);
    }
    const calls: string[] = [];
    await expect(readActiveSubstackTab({
      runtime: { getManifest: () => manifest },
      permissions: { contains: async () => false },
      tabs: { query: async () => { calls.push("tab"); return []; } },
    }, source)).rejects.toThrow("No permission was requested");
    expect(calls).toEqual([]);
  }
});

test("public Note acquisition retains full writing and quote without any tab record", async () => {
  const outer = await Bun.file(new URL("./fixtures/substack-note-public.html", import.meta.url)).text();
  const quote = await Bun.file(new URL("./fixtures/substack-quote-public.html", import.meta.url)).text();
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("c-360829302")) return new Response(outer, { headers: { "content-type": "text/html" } });
    if (url.includes("c-359890078")) return new Response(quote, { headers: { "content-type": "text/html" } });
    throw new Error(`Unexpected public request: ${url}`);
  }) as typeof fetch;
  const plan = await resolveCapture({ primary: [source], extras: [], policy: { media: "none" } }, undefined, fetcher);
  expect(plan.block.title).toBe("Note by @norvidstudies");
  const capture = plan.sources[0]?.substackCapture;
  expect(capture?.method).toBe("public-html");
  expect(capture?.note.body.html.length).toBe(492);
  expect(capture?.note.quote?.expanded?.body.html.length).toBe(3881);
});
