import { normalizeRedditCapture } from "../../packages/core/reddit-record.ts";
import { readRedditPage } from "../../packages/core/reddit-browser-reader.ts";

export type RedditTabAPI = {
  permissions: { request(value: { permissions: string[] }): Promise<boolean> };
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number; url?: string }>> };
  scripting?: { executeScript(value: { target: { tabId: number }; world: "MAIN"; func: typeof readRedditPage; args: string[] }): Promise<Array<{ result?: unknown }>> };
};
export async function readActiveRedditTab(browser: RedditTabAPI) {
  if (!await browser.permissions.request({ permissions: ["scripting"] })) throw new Error("Reddit tab access was not granted. No read was attempted.");
  if (!browser.scripting) throw new Error("This browser cannot read the Reddit tab. Import a browser capture file instead.");
  const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.id === undefined || !tab.url) throw new Error("Choose the Reddit tab before opening Capture");
  const results = await browser.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: readRedditPage, args: [tab.url] });
  if (results.length !== 1) throw new Error("The Reddit tab did not return one capture record");
  return normalizeRedditCapture(results[0]?.result);
}
