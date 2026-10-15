import { readSubstackPage } from "../../packages/core/substack-page.ts";
import { normalizeSubstackCapture, substackSourceKey } from "../../packages/core/substack-record.ts";

export type SubstackTabAPI = {
  permissions: { contains(value: { permissions: string[] }): Promise<boolean> };
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number; url?: string }>> };
  scripting?: { executeScript(value: { target: { tabId: number }; world: "ISOLATED"; func: typeof readSubstackPage; args: string[] }): Promise<Array<{ result?: unknown }>> };
};
/** Only an already granted scripting API and the user-invoked activeTab are used. Never requests permission. */
export async function readActiveSubstackTab(browser: SubstackTabAPI, expectedUrl?: string) {
  if (!await browser.permissions.contains({ permissions: ["scripting"] }) || !browser.scripting) throw new Error("Substack tab reading needs the existing scripting permission. No permission was requested; use the public URL resolver or import a capture.");
  const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.id === undefined || !tab.url) throw new Error("Choose the Substack Note tab before opening Capture");
  const key = substackSourceKey(tab.url);
  if (expectedUrl && substackSourceKey(expectedUrl) !== key) throw new Error("The active Substack Note does not match this draft");
  const results = await browser.scripting.executeScript({ target: { tabId: tab.id }, world: "ISOLATED", func: readSubstackPage, args: [tab.url] });
  if (results.length !== 1) throw new Error("Substack returned an ambiguous browser capture");
  const capture = normalizeSubstackCapture(results[0]?.result);
  if (substackSourceKey(capture.sourceUrl) !== key) throw new Error("Substack browser capture identity changed");
  return capture;
}
