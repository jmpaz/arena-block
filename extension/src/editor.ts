import { normalizeSubstackCapture, substackCapturesSchema, substackSourceKey, type SubstackCapture } from "../../packages/core/substack-record.ts";
import { readActiveSubstackTab } from "./substack-tab.ts";
import { containsDraftSource, shouldReplaceAutomaticDraft } from "./draft-retention.ts";
import { resolveWithNative } from "./native-reddit.ts";
import { normalizeRedditCapture, redditLiveReadUnavailable, redditCapturesSchema, redditSourceKey, REDDIT_CAPTURE_MAX_BYTES, type RedditBrowserCapture } from "../../packages/core/reddit-record.ts";
import { blockPlanSchema, type BlockPlan, type CompositionPolicy } from "../../packages/core/types.ts";
import { requiredOrigins, resolveCapture, revisePlan } from "./core.ts";
import { BrowserOAuth } from "./browser-auth.ts";
import { BrowserSaver, browserCanPublish, routeBrowserDestinations, type BrowserSaveIntent } from "./browser-save.ts";
import { ResolutionGuard } from "./resolution-guard.ts";
import { ChannelPickerModel, channelPage, channelValue, type ChannelRow, type ChannelScope } from "./channel-picker.ts";
import type { CaptureJob } from "./capture-job.ts";

type BrowserAPI = {
  permissions: { request(value: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    contains(value: { origins?: string[]; permissions?: string[] }): Promise<boolean> };
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> };
    onChanged: { addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void } };
  runtime: { sendNativeMessage(host: string, message: unknown): Promise<unknown>; sendMessage(message: unknown): Promise<unknown>; getURL(path: string): string };
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number; url?: string }>> };
  scripting?: { executeScript(value: { target: { tabId: number }; world: "MAIN" | "ISOLATED"; func: (...args: any[]) => any; args: string[] }): Promise<Array<{ result?: unknown }>> };
  identity: { getRedirectURL(): string; launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string | undefined> };
};
const browser = ((globalThis as any).browser ?? (globalThis as any).chrome) as BrowserAPI;
const key = "arena-block-editor-draft-v1";
const earlierKey = "arena-block-earlier-saves-v1";
const channelCacheKey = "arena-block-channel-index-v1";
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const primary = $<HTMLTextAreaElement>("primary");
const extras = $<HTMLTextAreaElement>("extras");
const mediaPolicy = $<HTMLSelectElement>("media-policy");
const threadPolicy = $<HTMLSelectElement>("thread-policy");
const quotePolicy = $<HTMLSelectElement>("quote-policy");
const quoteDepth = $<HTMLSelectElement>("quote-depth");
const quoteDates = $<HTMLSelectElement>("quote-dates");
const separatorPolicy = $<HTMLSelectElement>("separator-policy");
const title = $<HTMLInputElement>("title");
const writing = $<HTMLTextAreaElement>("writing");
const description = $<HTMLTextAreaElement>("description");
const status = $<HTMLParagraphElement>("status");
const resolveButton = $<HTMLButtonElement>("resolve");
const channel = $<HTMLInputElement>("channel");
const defaultChannel = $<HTMLInputElement>("default-channel");
const defaultMode = $<HTMLSelectElement>("default-mode");
const saveButton = $<HTMLButtonElement>("save");
const saveStatus = $<HTMLParagraphElement>("save-status");
const checkSave = $<HTMLButtonElement>("check-save");
const picker = new ChannelPickerModel();
let channelTicket = 0;
let channelLoading = false;
let channelAccessGranted = false;
let channelError = "";
let ownedNextPage: number | null = 1;
let channelSearchTimer: ReturnType<typeof setTimeout> | undefined;
let channelSearchPending = false;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let captureScrollTop = 0;
type Pending = { saveId: string; planHash?: string; inputSignature?: string; jobMethod?: "browser" | "native";
  destinations: string[]; phase: string; method?: "browser" | "native" | "job" };
type EarlierSave = { saveId: string; source: string; title: string; phase: string;
  method: "browser" | "native" | "job"; destinations: string[] };
let plan: BlockPlan | undefined;
let redditCaptures: RedditBrowserCapture[] = [];
let substackCaptures: SubstackCapture[] = [];
let pending: Pending | undefined;
let earlierSaves: EarlierSave[] = [];
let saveInFlight = false;
let resolveInFlight = false;
let pageSource: string | undefined;
let manualContentEdit = false;
let manualFields: { title?: boolean; writing?: boolean; description?: boolean } = {};
let resolvedInput: string | undefined;
const resolutionGuard = new ResolutionGuard();
let statusVersion = 0;
let statusPoll: ReturnType<typeof setInterval> | undefined;
let checkingStatus = false;
let oauth: BrowserOAuth | undefined;
const browserIntentKey = (id: string) => `arena-block-browser-save-${id}`;
const captureJobKey = (id: string) => `arena-block-capture-job-${id}`;
const saver = () => new BrowserSaver(oauth!, {
  async get(id) { return (await browser.storage.local.get(browserIntentKey(id)))[browserIntentKey(id)] as BrowserSaveIntent | undefined; },
  async put(intent) { await browser.storage.local.set({ [browserIntentKey(intent.saveId)]: intent }); },
});
async function browserStatus(saveId: string): Promise<BrowserSaveIntent> {
  const reply = await browser.runtime.sendMessage({ kind: "arena-block-browser-status", saveId }) as
    { ok?: boolean; value?: BrowserSaveIntent; error?: string };
  if (!reply?.ok || !reply.value) throw new Error(reply?.error ?? "Save status unavailable.");
  return reply.value;
}

function lines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
function currentDestinations(): string[] {
  return routeBrowserDestinations([...picker.selected.values()].map(item => item.value), defaultChannel.value.trim()
    ? { channel: defaultChannel.value.trim(), mode: defaultMode.value === "always" ? "always" : "fallback" } : undefined);
}
function message(value: string, error = false): void { status.textContent = value; status.classList.toggle("error", error); }
function draft() {
  return { primary: primary.value, extras: extras.value, redditCaptures, substackCaptures, media: mediaPolicy.value,
    thread: threadPolicy.value, quote: quotePolicy.value, depth: quoteDepth.value,
    dates: quoteDates.value, separator: separatorPolicy.value,
    channel: channel.value, selectedChannels: [...picker.selected.values()],
    defaultChannel: defaultChannel.value, defaultMode: defaultMode.value, plan, pending, resolvedInput,
    manualContentEdit, manualFields };
}
function editedFields(): { title?: string; markdown?: string; description?: string } | undefined {
  if (!manualContentEdit) return undefined;
  return { ...(manualFields.title ? { title: title.value } : {}),
    ...(manualFields.writing ? { markdown: writing.value } : {}),
    ...(manualFields.description ? { description: description.value } : {}) };
}
function inputSignature(): string {
  return JSON.stringify([primary.value, extras.value, mediaPolicy.value, threadPolicy.value,
    quotePolicy.value, quoteDepth.value, quoteDates.value, separatorPolicy.value, redditCaptures, substackCaptures]);
}
function destinationsFrozen(): boolean { return Boolean(pending || saveInFlight); }
function syncDestinationLock(): void {
  const frozen = destinationsFrozen();
  for (const id of ["choose-channel", "clear-channels", "add-channel", "default-channel", "default-mode",
    "primary", "extras", "media-policy", "thread-policy", "quote-policy", "quote-depth", "quote-dates",
    "separator-policy", "read-substack", "import-reddit", "reddit-file", "title", "writing", "description", "resolve-local", "add-current",
    "single-media-toggle", "audio-choice"])
    $(id).toggleAttribute("disabled", frozen);
  resolveButton.disabled = frozen || resolveInFlight;
  $<HTMLButtonElement>("preview-source").disabled = frozen || resolveInFlight;
  if (frozen) $("preview-source").hidden = true;
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    "#selected-channels button, #picker-selected-channels button, .channel-choice, .channel-menu, .channel-options button, #typed-channel-choice"))
    control.disabled = frozen || control.dataset.unavailable === "true";
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    "#media-section input, #media-section button")) control.disabled = frozen;
}
async function resolveAuthorizedSource(source: string): Promise<void> {
  try {
    const origins = requiredOrigins([source]);
    if (origins.length && !await browser.permissions.contains({ origins })) return;
    if (primary.value === source && !plan && !pending) await resolve();
  } catch { /* The visible Preview action reports unsupported sources. */ }
}
function refreshSaveButton(): void {
  let destinations: string[] = [];
  let destinationError = "";
  try { destinations = currentDestinations(); }
  catch (error) {
    if (picker.selected.size || defaultChannel.value.trim())
      destinationError = error instanceof Error ? error.message : "Check channels.";
  }
  const sameRoute = JSON.stringify(pending?.destinations) === JSON.stringify(destinations);
  const signature = inputSignature();
  const sameSaved = pending?.phase === "saved" && sameRoute && (pending.method === "job"
    ? pending.inputSignature === signature : pending.planHash === plan?.hash);
  const continuingJob = pending?.method === "job" && pending.inputSignature === signature && sameRoute
    && ["needs_auth", "needs_helper", "failed", "rejected"].includes(pending.phase);
  const blockedJob = pending?.method === "job" && !continuingJob;
  const blockedEarlierSave = pending?.method !== "job" && pending
    && (["running", "creating", "unknown", "partial", "created"].includes(pending.phase)
      || Boolean(plan && resolvedInput !== signature));
  saveButton.disabled = saveInFlight || !destinations.length || !lines(primary.value).length || Boolean(sameSaved)
    || Boolean(blockedJob || blockedEarlierSave);
  if (pending?.method === "job") {
    if (pending.phase === "needs_auth") saveButton.textContent = "Connect Are.na";
    else if (pending.phase === "needs_helper") saveButton.textContent = "Use local helper";
    else if (pending.phase === "failed") saveButton.textContent = "Try again";
    else if (pending.phase === "rejected") saveButton.textContent = "Try save again";
    else if (["queued", "resolving", "prepared"].includes(pending.phase)) saveButton.textContent = "Saving…";
  }
  if (!pending || pending.phase === "saved") saveButton.textContent = destinations.length
    ? `Save to ${destinations.length} ${destinations.length === 1 ? "channel" : "channels"}` : "Choose a channel";
  if (!pending) {
    if (destinationError) {
      saveButton.textContent = "Check channels";
      saveStatus.textContent = destinationError;
      saveStatus.classList.add("error");
      saveStatus.dataset.destinationError = "true";
    } else if (saveStatus.dataset.destinationError) {
      saveStatus.textContent = "";
      saveStatus.classList.remove("error");
      delete saveStatus.dataset.destinationError;
    }
  }
  syncDestinationLock();
}
function intakeChanged(): void {
  resolutionGuard.changed();
  if (previewTimer) clearTimeout(previewTimer);
  retain();
  renderCapturePreview();
  if (plan && resolvedInput !== inputSignature()) {
    message("");
    resolveButton.textContent = "Update preview";
  } else if (plan) {
    message("");
  }
  const refs = lines(primary.value);
  if (refs.length === 1 && !lines(extras.value).length) {
    try {
      if (!requiredOrigins(refs).length) previewTimer = setTimeout(() => { void resolve(); }, 250);
    } catch { /* A partial URL can become valid as the user types. */ }
  }
  refreshSaveButton();
}
function retain(): void {
  // Popups may disappear immediately after a click outside. Dispatch each draft
  // change to extension storage before that happens.
  void browser.storage.local.set({ [key]: draft() });
}

function editPlan(event: Event): void {
  if (!plan) return;
  manualContentEdit = true;
  if (event.target === title) manualFields.title = true;
  else if (event.target === writing) manualFields.writing = true;
  else if (event.target === description) manualFields.description = true;
  resolutionGuard.changed();
  plan = revisePlan(plan, { title: title.value, markdown: writing.value, description: description.value });
  renderCapturePreview();
  refreshSaveButton();
  retain();
}

function renderMedia(): void {
  const section = $("media-section");
  const list = $<HTMLOListElement>("media-list");
  list.replaceChildren();
  const assets = plan?.sources.flatMap(source => source.media) ?? [];
  section.hidden = assets.length === 0;
  const singleImage = assets.length === 1 && assets[0]!.kind === "image" ? assets[0] : undefined;
  const singleSelected = Boolean(singleImage && plan?.block.selectedMedia.includes(singleImage.ref));
  const singleToggle = $<HTMLButtonElement>("single-media-toggle");
  singleToggle.hidden = !singleImage;
  if (singleImage) {
    singleToggle.textContent = singleSelected ? "Included" : "Excluded";
    singleToggle.setAttribute("aria-pressed", String(singleSelected));
    singleToggle.onclick = () => changeMedia(singleImage.ref, !singleSelected);
  }
  $("media-count").hidden = Boolean(singleImage);
  $("media-count").textContent = `${plan?.block.selectedMedia.length ?? 0} selected`;
  list.hidden = Boolean(singleImage);
  const selectedOrder = plan?.policy.mediaOrder ?? plan?.block.selectedMedia ?? [];
  const ordered = [...assets].sort((a, b) => {
    const aIndex = selectedOrder.indexOf(a.ref), bIndex = selectedOrder.indexOf(b.ref);
    return (aIndex < 0 ? selectedOrder.length + assets.indexOf(a) : aIndex)
      - (bIndex < 0 ? selectedOrder.length + assets.indexOf(b) : bIndex);
  });
  const hero = $("media-hero");
  hero.replaceChildren();
  const featured = singleImage ?? ordered.find(asset => plan?.block.selectedMedia.includes(asset.ref)
    && (asset.kind === "image" || Boolean(asset.posterUrl)));
  hero.hidden = !featured;
  hero.classList.toggle("is-excluded", Boolean(singleImage && !singleSelected));
  if (featured) {
    const image = document.createElement("img");
    image.src = featured.kind === "image" ? featured.url : featured.posterUrl!;
    image.alt = featured.kind === "image" ? "Selected image" : "Selected video poster";
    image.referrerPolicy = "no-referrer";
    hero.append(image);
  }
  for (const asset of ordered) {
    const row = document.createElement("li");
    row.className = "media-item";
    const thumb = document.createElement("div");
    thumb.className = "media-thumb";
    if (asset.kind === "image" || asset.posterUrl) {
      const img = document.createElement("img");
      img.className = "media-thumb";
      img.alt = "";
      img.src = asset.kind === "image" ? asset.url : asset.posterUrl!;
      img.referrerPolicy = "no-referrer";
      thumb.append(img);
    } else thumb.textContent = asset.kind === "audio" ? "♫" : "▶";
    const meta = document.createElement("div");
    meta.className = "media-meta";
    const name = document.createElement("strong");
    name.textContent = `${asset.kind[0]!.toUpperCase()}${asset.kind.slice(1)} · ${asset.ref}`;
    const link = document.createElement("a");
    link.href = asset.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = asset.url;
    meta.append(name, link);
    const controls = document.createElement("div");
    controls.className = "media-controls";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.setAttribute("aria-label", `Include media ${asset.ref}`);
    check.checked = plan?.block.selectedMedia.includes(asset.ref) ?? false;
    check.addEventListener("change", () => changeMedia(asset.ref, check.checked));
    controls.append(check);
    if (asset.kind === "video" && asset.posterUrl) {
      const frame = document.createElement("input");
      frame.type = "checkbox";
      frame.setAttribute("aria-label", `Use poster frame from video ${asset.ref}`);
      frame.title = "Use poster frame";
      frame.checked = plan?.policy.videoFrames?.includes(asset.ref) ?? false;
      frame.disabled = !check.checked;
      frame.addEventListener("change", () => {
        if (!plan) return;
        resolutionGuard.changed();
        const refs = new Set(plan.policy.videoFrames ?? []);
        if (frame.checked) refs.add(asset.ref); else refs.delete(asset.ref);
        plan = revisePlan(plan, { policy: { videoFrames: [...refs] }, title: title.value,
          markdown: writing.value, description: description.value });
        renderPlanKeepingMediaFocus();
      });
      controls.append(frame);
    }
    for (const [label, delta] of [["↑", -1], ["↓", 1]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", `Move media ${asset.ref} ${delta < 0 ? "up" : "down"}`);
      button.disabled = !check.checked;
      button.addEventListener("click", () => moveMedia(asset.ref, delta));
      controls.append(button);
    }
    row.append(thumb, meta, controls);
    list.append(row);
  }
  const audio = assets.filter(asset => asset.kind === "audio" && plan?.block.selectedMedia.includes(asset.ref));
  const audioChoice = $<HTMLSelectElement>("audio-choice");
  audioChoice.replaceChildren();
  audioChoice.hidden = $("audio-label").hidden = audio.length < 2;
  if (audio.length >= 2) {
    for (const [value, label] of [["auto", "Auto"], ["mix", "Mix"], ...audio.map(asset => [asset.ref, `Only ${asset.ref}`])]) {
      const option = document.createElement("option");
      option.value = value!;
      option.textContent = label!;
      audioChoice.append(option);
    }
    audioChoice.value = plan?.policy.audio ?? "auto";
  }
}

function changeMedia(ref: string, selected: boolean): void {
  if (!plan) return;
  resolutionGuard.changed();
  const refs = new Set(plan.block.selectedMedia);
  if (selected) refs.add(ref); else refs.delete(ref);
  const previousOrder = plan.policy.mediaOrder ?? plan.block.selectedMedia;
  const mediaOrder = previousOrder.filter(value => refs.has(value));
  for (const value of refs) if (!mediaOrder.includes(value)) mediaOrder.push(value);
  const policy: Partial<CompositionPolicy> = { media: "selected", selectedMedia: [...refs],
    mediaOrder, videoFrames: (plan.policy.videoFrames ?? []).filter(value => refs.has(value)) };
  plan = revisePlan(plan, { policy, title: title.value, markdown: writing.value, description: description.value });
  renderPlanKeepingMediaFocus();
}

function moveMedia(ref: string, delta: number): void {
  if (!plan) return;
  const order = plan.policy.mediaOrder ?? plan.block.selectedMedia;
  const next = [...order];
  const index = next.indexOf(ref);
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  resolutionGuard.changed();
  [next[index], next[target]] = [next[target]!, next[index]!];
  plan = revisePlan(plan, { policy: { mediaOrder: next }, title: title.value, markdown: writing.value, description: description.value });
  renderPlanKeepingMediaFocus();
}

function renderPlanKeepingMediaFocus(): void {
  const active = document.activeElement as HTMLElement | null;
  const label = active?.closest("#media-section") ? active.getAttribute("aria-label") : null;
  const viewport = document.querySelector<HTMLElement>(".viewport")!;
  const scrollTop = viewport.scrollTop;
  renderPlan(false);
  if (label) {
    const controls = [...document.querySelectorAll<HTMLElement>("#media-section [aria-label]")];
    let target = controls.find(item => item.getAttribute("aria-label") === label && !(item as HTMLButtonElement).disabled);
    if (!target && label.startsWith("Move media ")) {
      const opposite = label.endsWith(" down") ? label.replace(/ down$/, " up") : label.replace(/ up$/, " down");
      target = controls.find(item => item.getAttribute("aria-label") === opposite && !(item as HTMLButtonElement).disabled);
    }
    target?.focus({ preventScroll: true });
    viewport.scrollTop = scrollTop;
  }
}

function renderPlan(refreshFields = true): void {
  if (!plan) return;
  $("composition").hidden = false;
  $("composition-empty").hidden = true;
  $("composition-fields").hidden = false;
  if (refreshFields) {
    title.value = plan.block.title;
    writing.value = plan.block.markdown;
    description.value = plan.block.description ?? "";
  }
  $<HTMLDetailsElement>("writing-details").open = plan.block.kind !== "url" || Boolean(writing.value.trim());
  resolveButton.textContent = "Refresh preview";
  resolveButton.classList.remove("primary");
  resolveButton.classList.add("quiet");
  $("source-count").textContent = `${plan.sources.length} source${plan.sources.length === 1 ? "" : "s"}`;
  $("block-kind").textContent = `${plan.block.kind[0]!.toUpperCase()}${plan.block.kind.slice(1)} block`;
  const sourceLink = $<HTMLAnchorElement>("source-link");
  sourceLink.href = plan.block.canonicalSource;
  sourceLink.textContent = plan.block.canonicalSource;
  renderMedia();
  renderCapturePreview();
  renderPickerPreview();
  refreshSaveButton();
  retain();
}

function renderCapturePreview(): void {
  const ref = lines(primary.value)[0];
  const current = Boolean(ref && plan && resolvedInput === inputSignature());
  let host = ref ?? "";
  if (ref) {
    try { host = new URL(ref).hostname || new URL(ref).protocol.replace(":", ""); }
    catch { /* Keep the source as typed. */ }
  }
  const count = current ? plan!.sources.length : 0;
  $("capture-preview-meta").textContent = ref
    ? `${host}${count > 1 ? ` · ${count} posts` : ""}` : "Source";
  $("capture-preview-title").textContent = current ? plan!.block.title : ref ? host : "Add a source";
  $("capture-preview-excerpt").textContent = current
    ? (manualFields.writing ? writing.value.trim() : plan!.sources[0]?.text.trim()) || ref!
    : ref ?? "Paste a link to begin";
  let needsProviderPreview = false;
  try { needsProviderPreview = Boolean(ref && requiredOrigins([ref]).length); }
  catch { /* Incomplete sources remain in Edit sources. */ }
  $("preview-source").hidden = !needsProviderPreview || current || destinationsFrozen();
  const image = $<HTMLImageElement>("capture-preview-image");
  const selected = current ? plan!.sources.flatMap(source => source.media).find(asset =>
    plan!.block.selectedMedia.includes(asset.ref) && (asset.kind === "image" || asset.posterUrl)) : undefined;
  image.hidden = !selected;
  if (selected) image.src = selected.kind === "image" ? selected.url : selected.posterUrl!;
  else image.removeAttribute("src");
}

function renderPickerPreview(): void {
  const preview = $("picker-preview");
  const ref = lines(primary.value)[0];
  preview.hidden = !ref;
  if (!ref) return;
  let source = ref;
  try { source = new URL(ref).hostname; } catch { /* Keep the source as typed. */ }
  const current = Boolean(plan && resolvedInput === inputSignature());
  $("picker-preview-title").textContent = current && plan?.block.title ? plan.block.title : source;
  $("picker-preview-source").textContent = current ? source : ref;
  const image = $<HTMLImageElement>("picker-preview-image");
  const selected = current ? plan!.sources.flatMap(item => item.media).find(item =>
    plan!.block.selectedMedia.includes(item.ref) && (item.kind === "image" || item.posterUrl)) : undefined;
  image.hidden = !selected;
  if (selected) image.src = selected.kind === "image" ? selected.url : selected.posterUrl!;
  else image.removeAttribute("src");
}

type NativeReply = { id?: string; ok: boolean; value?: any; error?: string };
async function native(action: string, fields: Record<string, unknown> = {}, askPermission = true): Promise<any> {
  if (askPermission && !await browser.permissions.request({ permissions: ["nativeMessaging"] } as any)) {
    throw new Error("Access to the local helper was not granted.");
  }
  const id = crypto.randomUUID();
  const result = await browser.runtime.sendNativeMessage("net.fjpaz.arena_block", { id, action, ...fields }) as NativeReply;
  if (!result || result.id !== id || !result.ok) throw new Error(result?.error ?? "The local helper is unavailable.");
  return result.value;
}

function showSave(phase: string, error = false): void {
  const labels: Record<string, string> = {
    queued: "Saving…", resolving: "Saving…", prepared: "Saving…",
    running: "Saving…", saved: "Saved to Are.na.",
    creating: "Saving…", created: "Saving…", rejected: "Are.na couldn't save this. Check your account access.",
    partial: "Saved, but some channels are still pending.", unknown: "Save not confirmed yet.",
    cancelled: "Save stopped. Check status before starting another.", not_saved: "Not saved. Try again.",
    needs_auth: "Connect Are.na to finish saving.", needs_helper: "Use the local helper to finish saving.",
    failed: "Could not prepare this block.",
  };
  saveStatus.textContent = labels[phase] ?? phase;
  saveStatus.classList.toggle("error", error);
  checkSave.hidden = !pending || !["creating", "created", "unknown", "partial", "cancelled"].includes(phase);
  if (["creating", "created"].includes(phase) && !statusPoll)
    statusPoll = setInterval(() => { if (!checkingStatus) void checkStatus(false); }, 2500);
  else if (!["creating", "created"].includes(phase) && statusPoll) {
    clearInterval(statusPoll);
    statusPoll = undefined;
  }
  saveButton.textContent = pending?.method === "browser" && phase === "rejected" ? "Try save again"
    : pending?.method === "browser" ? "Save block"
    : pending && ["prepared", "not_saved", "unknown", "partial", "cancelled"].includes(phase)
      ? "Retry save" : "Save block";
  refreshSaveButton();
  retain();
}

function renderEarlierSaves(): void {
  const details = $<HTMLDetailsElement>("earlier-saves");
  const list = $("earlier-save-list");
  list.replaceChildren();
  details.hidden = earlierSaves.length === 0;
  $("earlier-count").textContent = String(earlierSaves.length);
  for (const entry of earlierSaves) {
    const row = document.createElement("div");
    row.className = "earlier-save";
    const copy = document.createElement("div");
    copy.className = "earlier-save-copy";
    const title = document.createElement("strong");
    title.textContent = entry.title || entry.source;
    const phase = document.createElement("span");
    phase.textContent = entry.phase === "saved" ? "Saved to Are.na" : entry.phase === "unknown"
      ? "Unconfirmed · check Are.na" : entry.phase === "partial" ? "Some channels are pending"
        : "Check save status";
    copy.append(title, phase);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet";
    button.textContent = "Check";
    button.setAttribute("aria-label", `Check earlier save for ${entry.title || entry.source}`);
    button.addEventListener("click", () => { void checkEarlierSave(entry.saveId, button, phase); });
    row.append(copy, button);
    list.append(row);
  }
}

async function checkEarlierSave(saveId: string, button: HTMLButtonElement, phase: HTMLElement): Promise<void> {
  const entry = earlierSaves.find(item => item.saveId === saveId);
  if (!entry) return;
  button.disabled = true;
  try {
    let result: { phase?: string; saveId?: string };
    if (entry.method === "job") {
      const reply = await browser.runtime.sendMessage({ kind: "arena-block-job-status", saveId }) as
        { ok?: boolean; value?: CaptureJob; error?: string };
      if (!reply?.ok || !reply.value) throw new Error(reply?.error ?? "Save status unavailable.");
      result = reply.value;
    } else result = entry.method === "browser" ? await browserStatus(saveId)
      : await native("status", { saveId });
    if (result.saveId && result.saveId !== saveId) throw new Error("Save identity changed.");
    if (typeof result.phase !== "string") throw new Error("Save status unavailable.");
    entry.phase = result.phase;
    await browser.storage.local.set({ [earlierKey]: earlierSaves });
    renderEarlierSaves();
  } catch (error) {
    phase.textContent = error instanceof Error ? error.message : "Could not check this save.";
    button.disabled = false;
  }
}

function acceptStatus(value: any): void {
  if (!pending || value?.saveId !== pending.saveId || typeof value.phase !== "string") {
    throw new Error("The helper returned a different save identity.");
  }
  pending.phase = value.phase;
  if (pending.method === "job" && ["browser", "native"].includes(value.method)) pending.jobMethod = value.method;
  if (pending.method === "job" && value.plan && pending.inputSignature === inputSignature()) {
    plan = blockPlanSchema.parse(value.plan);
    resolvedInput = pending.inputSignature;
    pending.planHash = plan.hash;
    renderPlan();
  }
  statusVersion++;
  showSave(value.phase);
}

async function checkStatus(askPermission = true): Promise<void> {
  if (!pending || checkingStatus) return;
  checkingStatus = true;
  const saveId = pending.saveId;
  const version = statusVersion;
  try {
    let result: any;
    if (pending.method === "job") {
      const reply = await browser.runtime.sendMessage({ kind: "arena-block-job-status", saveId }) as
        { ok?: boolean; value?: CaptureJob; error?: string };
      if (!reply?.ok || !reply.value) throw new Error(reply?.error ?? "Save status unavailable.");
      result = reply.value;
      let resume = ["queued", "resolving", "prepared"].includes(result.phase);
      if (result.phase === "needs_auth" && oauth) {
        try { await oauth.token(); resume = true; } catch { /* Sign-in is still needed. */ }
      }
      if (result.phase === "needs_helper" && await browser.permissions.contains({ permissions: ["nativeMessaging"] }))
        resume = true;
      if (resume) {
        const resumed = await browser.runtime.sendMessage({ kind: "arena-block-job-run", saveId }) as
          { ok?: boolean; value?: CaptureJob; error?: string };
        if (!resumed?.ok || !resumed.value) throw new Error(resumed?.error ?? "Save status unavailable.");
        result = resumed.value;
      }
    } else result = pending.method === "browser" ? await browserStatus(saveId)
      : await native("status", { saveId }, askPermission);
    if (version === statusVersion && pending?.saveId === saveId) acceptStatus(result);
  }
  catch (error) {
    saveStatus.textContent = `${error instanceof Error ? error.message : "Could not check the save."} You can check again.`;
    saveStatus.classList.add("error");
    checkSave.hidden = false;
    if (statusPoll) { clearInterval(statusPoll); statusPoll = undefined; }
  } finally { checkingStatus = false; }
}

async function save(): Promise<void> {
  if (saveInFlight) return;
  let destinations: string[];
  try { destinations = currentDestinations(); } catch (error) {
    saveStatus.textContent = error instanceof Error ? error.message : "Choose a channel.";
    saveStatus.classList.add("error");
    return;
  }
  resolutionGuard.changed();
  if (previewTimer) clearTimeout(previewTimer);
  if (!plan || resolvedInput !== inputSignature() || pending?.method === "job") {
    await saveSourceIntent(destinations);
    return;
  }
  const routeMatch = JSON.stringify(pending?.destinations) === JSON.stringify(destinations);
  if (pending?.phase === "saved" && (pending.planHash !== plan.hash || !routeMatch)) pending = undefined;
  if (pending) {
    if (pending.planHash !== plan.hash || !routeMatch) {
      saveStatus.textContent = "Check the earlier save before changing this block or its channels.";
      saveStatus.classList.add("error");
      return;
    }
    if (pending.phase === "saved") return;
  }
  saveButton.disabled = true;
  const method = pending?.method ?? (oauth && browserCanPublish(plan) ? "browser" : "native");
  saveStatus.textContent = "Saving…";
  saveStatus.classList.remove("error");
  saveInFlight = true;
  syncDestinationLock();
  try {
    if (method === "browser") {
      if (!await browser.permissions.request({ origins: ["https://api.are.na/*"] }))
        throw new Error("Are.na access was not granted.");
      try { await oauth!.token(); } catch { await oauth!.signIn(); }
    } else if (!await browser.permissions.request({ permissions: ["nativeMessaging"] })) {
      throw new Error("Local helper access was not granted.");
    }
    if (!pending) {
      const saveId = crypto.randomUUID();
      if (method === "browser") await saver().prepare(saveId, plan, destinations);
      // Persist the ID and immutable intent before any request can reach the daemon.
      pending = { saveId, planHash: plan.hash, destinations, phase: "prepared", method };
      syncDestinationLock();
      await browser.storage.local.set({ [key]: draft() });
    }
    if (method === "browser") {
      await saver().prepare(pending.saveId, plan, destinations);
      const result = ["prepared", "rejected"].includes(pending.phase)
        ? await (async () => {
          const reply = await browser.runtime.sendMessage({ kind: "arena-block-create", saveId: pending!.saveId }) as
            { ok?: boolean; value?: BrowserSaveIntent; error?: string };
          if (!reply?.ok || !reply.value) throw new Error(reply?.error ?? "Save status unavailable.");
          return reply.value;
        })() : await browserStatus(pending.saveId);
      acceptStatus(result);
    } else if (pending.phase === "prepared") {
      acceptStatus(await native("save", { saveId: pending.saveId, plan, destinations }));
    } else acceptStatus(await native("retry", { saveId: pending.saveId }));
  } catch (error) {
    saveStatus.textContent = `${error instanceof Error ? error.message : "Save status unavailable."}${pending ? " Check status before retrying." : ""}`;
    saveStatus.classList.add("error");
    checkSave.hidden = !pending;
  } finally { saveInFlight = false; refreshSaveButton(); }
}

async function saveSourceIntent(destinations: string[]): Promise<void> {
  if (saveInFlight) return;
  const refs = lines(primary.value), extraRefs = lines(extras.value);
  if (!refs.length || refs.length + extraRefs.length > 20) { message("Add 1–20 links.", true); return; }
  const signature = inputSignature();
  const routeMatch = JSON.stringify(pending?.destinations) === JSON.stringify(destinations);
  if (pending && (pending.method !== "job" || pending.inputSignature !== signature || !routeMatch)) {
    saveStatus.textContent = "Check the earlier save before changing this block or its channels.";
    return;
  }
  if (pending?.phase === "saved" || ["creating", "created", "unknown", "partial"].includes(pending?.phase ?? "")) return;
  saveButton.disabled = true;
  saveInFlight = true;
  syncDestinationLock();
  try {
    if (pending?.phase === "needs_auth") await oauth!.signIn();
    else if (pending?.phase === "rejected" && pending.jobMethod === "browser") await oauth!.signIn();
    else if (pending?.phase === "needs_helper") {
      if (!await browser.permissions.request({ permissions: ["nativeMessaging"] }))
        throw new Error("Local helper access was not granted.");
    }
    if (!pending) {
      const origins = requiredOrigins([...refs, ...extraRefs], redditCaptures, substackCaptures);
      if (oauth) origins.push("https://api.are.na/*");
      if (origins.length && !await browser.permissions.request({ origins: [...new Set(origins)] }))
        throw new Error("Source access was not granted.");
      if (!oauth && !await browser.permissions.request({ permissions: ["nativeMessaging"] }))
        throw new Error("Local helper access was not granted.");
      const saveId = crypto.randomUUID();
      const edits = editedFields();
      const job: CaptureJob = { saveId, input: { primary: refs, extras: extraRefs, policy: chosenPolicy(), redditCaptures, substackCaptures },
        ...(edits ? { edits } : {}), destinations, phase: "queued" };
      pending = { saveId, inputSignature: signature, destinations, phase: "queued", method: "job" };
      syncDestinationLock();
      resolutionGuard.changed();
      if (previewTimer) clearTimeout(previewTimer);
      await browser.storage.local.set({ [captureJobKey(saveId)]: job, [key]: draft() });
    }
    pending.phase = "resolving";
    showSave("resolving");
    const reply = await browser.runtime.sendMessage({ kind: "arena-block-job-run", saveId: pending.saveId }) as
      { ok?: boolean; value?: CaptureJob; error?: string };
    if (!reply?.ok || !reply.value) throw new Error(reply?.error ?? "Save status unavailable.");
    acceptStatus(reply.value);
  } catch (error) {
    saveStatus.textContent = error instanceof Error ? error.message : "Save status unavailable.";
    saveStatus.classList.add("error");
    checkSave.hidden = !pending;
  } finally { saveInFlight = false; refreshSaveButton(); }
}

function renderSelectedChannels(): void {
  const boxes = [$("selected-channels"), $("picker-selected-channels")];
  for (const box of boxes) {
    box.replaceChildren();
    for (const choice of picker.selected.values()) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = `${choice.title} ×`;
      chip.setAttribute("aria-label", `Remove ${choice.title}`);
      chip.addEventListener("click", () => {
        if (destinationsFrozen()) return;
        const focused = document.activeElement === chip;
        const index = [...box.querySelectorAll("button")].indexOf(chip);
        picker.remove(choice.value); renderSelectedChannels(); updateChannelSelections(); retain();
        if (focused) {
          const remaining = [...box.querySelectorAll<HTMLButtonElement>("button")];
          (remaining[Math.min(index, remaining.length - 1)] ??
            (box.id === "picker-selected-channels" ? channel : $<HTMLButtonElement>("choose-channel")))
            .focus({ preventScroll: true });
        }
      });
      box.append(chip);
    }
  }
  let count = picker.selected.size;
  const fallback = defaultChannel.value.trim();
  if (fallback) {
    try {
      const included = currentDestinations().includes(channelValue(fallback));
      if (included && ![...picker.selected.values()].some(item => item.value === fallback)) {
        const note = document.createElement("span");
        note.className = "empty-selection";
        note.textContent = `Default: ${fallback}`;
        for (const box of boxes) box.append(note.cloneNode(true));
        count++;
      }
    } catch { /* Show invalid defaults only when saving. */ }
  }
  for (const box of boxes) if (!box.childNodes.length) {
    const empty = document.createElement("span");
    empty.className = "empty-selection";
    empty.textContent = "None";
    box.append(empty);
  }
  $<HTMLButtonElement>("clear-channels").hidden = picker.selected.size === 0;
  $("selected-count").textContent = `${count} / 20`;
  refreshSaveButton();
}

let renderedScope: ChannelScope | undefined;
let renderedQuery = "";
function updateChannelSelections(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".channel-choice")) {
    const id = Number(button.dataset.channelId);
    const row = (picker.scope === "my" ? picker.owned : picker.network).get(id);
    if (!row) continue;
    const selected = [...picker.selected.values()].some(item => item.id === row.id || item.value === row.slug);
    button.setAttribute("aria-pressed", String(selected));
    const check = button.querySelector(".channel-check");
    if (check) check.textContent = selected ? "✓" : "";
    button.setAttribute("aria-label", `${row.title}, ${row.owner.name}, ${row.visibility}, ${selected ? "selected" : "not selected"}${row.canAdd === false ? ", unavailable" : ""}`);
  }
}
function renderChannelRows(): void {
  const list = $("channel-list");
  if (renderedScope !== picker.scope || renderedQuery !== picker.query) {
    list.replaceChildren();
    renderedScope = picker.scope;
    renderedQuery = picker.query;
  }
  const rows = picker.rows();
  const visibleIds = new Set(rows.map(row => row.id));
  for (const item of list.querySelectorAll<HTMLElement>(".channel-row-item"))
    if (!visibleIds.has(Number(item.dataset.rowId))) item.remove();
  list.querySelector("#empty-channel-list")?.remove();
  list.querySelector("#typed-channel-choice")?.remove();
  for (const row of rows) {
    let item = list.querySelector<HTMLElement>(`[data-row-id="${row.id}"]`);
    if (!item) {
      item = document.createElement("div");
      item.className = "channel-row-item";
      item.dataset.rowId = String(row.id);
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "channel-choice";
      choice.dataset.channelId = String(row.id);
      const check = document.createElement("span"); check.className = "channel-check"; check.setAttribute("aria-hidden", "true");
      const name = document.createElement("span"); name.className = "channel-text";
      const count = document.createElement("span"); count.className = "channel-count";
      name.append(document.createElement("strong"), count);
      const owner = document.createElement("span"); owner.className = "channel-owner";
      choice.append(check, name, owner);
      choice.addEventListener("click", () => {
        const current = (picker.scope === "my" ? picker.owned : picker.network).get(row.id);
        if (!current) return;
        if (destinationsFrozen()) return;
        try { picker.choose(current); renderSelectedChannels(); updateChannelSelections(); retain(); }
        catch (error) { $("channel-progress").textContent = error instanceof Error ? error.message : "Could not select channel."; }
      });
      const menu = document.createElement("button");
      menu.type = "button"; menu.className = "channel-menu"; menu.textContent = "⋯";
      menu.setAttribute("aria-label", `Options for ${row.title}`);
      const popover = document.createElement("div"); popover.className = "channel-options"; popover.hidden = true;
      const setDefault = document.createElement("button"); setDefault.type = "button";
      setDefault.addEventListener("click", () => {
        if (destinationsFrozen() || setDefault.dataset.unavailable === "true") return;
        defaultChannel.value = defaultChannel.value === String(row.id) ? "" : String(row.id);
        popover.hidden = true;
        renderSelectedChannels();
        retain();
      });
      popover.append(setDefault);
      menu.addEventListener("click", () => {
        if (destinationsFrozen()) return;
        for (const other of document.querySelectorAll<HTMLElement>(".channel-options")) other.hidden = true;
        setDefault.textContent = defaultChannel.value === String(row.id) ? "Remove default" : "Set as default";
        setDefault.dataset.unavailable = String(row.canAdd === false && defaultChannel.value !== String(row.id));
        syncDestinationLock();
        popover.hidden = false;
      });
      item.append(choice, menu, popover);
      list.append(item);
    }
    const choice = item.querySelector<HTMLButtonElement>(".channel-choice")!;
    choice.dataset.unavailable = String(row.canAdd === false && ![...picker.selected.values()].some(value => value.id === row.id));
    item.dataset.visibility = row.visibility;
    item.querySelector(".channel-text strong")!.textContent = row.title;
    item.querySelector(".channel-owner")!.textContent = row.owner.name;
    item.querySelector(".channel-count")!.textContent = row.count == null ? "" : row.count.toLocaleString();
    item.querySelector(".channel-menu")!.setAttribute("aria-label", `Options for ${row.title}`);
  }
  if (!rows.length && !channelLoading && !channelSearchPending && !channelError
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(picker.query)) {
    const typed = document.createElement("button");
    typed.id = "typed-channel-choice";
    typed.type = "button";
    typed.className = "typed-channel-choice";
    typed.textContent = `Use “${picker.query}”`;
    typed.addEventListener("click", () => $<HTMLButtonElement>("add-channel").click());
    list.append(typed);
  } else if (!rows.length && !channelError) {
    const empty = document.createElement("p"); empty.id = "empty-channel-list"; empty.className = "channel-empty";
    empty.textContent = channelLoading || channelSearchPending ? "Loading…" : "No channels";
    list.append(empty);
  }
  updateChannelSelections();
  syncDestinationLock();
  const more = $<HTMLButtonElement>("more-channels");
  more.hidden = channelLoading || channelSearchPending || !channelError
    && (!channelAccessGranted || !picker.query || !picker.nextPage);
  more.textContent = channelError ? "Retry" : "Search more";
  if (!channelLoading && !channelSearchPending) $("channel-progress").textContent = channelError;
  document.querySelector<HTMLElement>(".channel-list-footer")!.hidden = !channelError && !channelLoading
    && !channelSearchPending && more.hidden;
}

async function restoreChannelIndex(accountId: number): Promise<void> {
  const saved = (await browser.storage.local.get(channelCacheKey))[channelCacheKey] as
    { accountId?: number; channels?: ChannelRow[] } | undefined;
  if (saved?.accountId !== accountId || !Array.isArray(saved.channels)) return;
  for (const row of saved.channels) if (Number.isSafeInteger(row.id)) picker.owned.set(row.id, row);
  renderChannelRows();
}

async function loadChannelPage(): Promise<void> {
  if (!channelAccessGranted || channelLoading || channelSearchPending || !picker.nextPage) return;
  const page = picker.nextPage, scope = picker.scope, query = picker.query;
  const ticket = ++channelTicket;
  channelLoading = true;
  channelError = "";
  $("channel-progress").textContent = "Loading…";
  renderChannelRows();
  try {
    let response: unknown;
    if (oauth) {
      const token = await oauth.token();
      const headers = { accept: "application/json", authorization: `Bearer ${token}` };
      if (!picker.accountId) {
        const me = await fetch("https://api.are.na/v3/me", { headers, credentials: "omit" });
        if (!me.ok) throw new Error("Connect Are.na to browse channels.");
        const account = await me.json() as { data?: { id?: number }; id?: number };
        const id = account.data?.id ?? account.id;
        if (!Number.isSafeInteger(id)) throw new Error("Could not identify your Are.na account.");
        picker.accountId = id;
        await restoreChannelIndex(id!);
      }
      const path = scope === "my"
        ? `/users/${picker.accountId}/contents?type=Channel&sort=updated_at_desc&per=30&page=${page}`
        : `/search?query=${encodeURIComponent(query || "*")}&type=Channel&scope=${scope}&per=30&page=${page}`;
      const result = await fetch(`https://api.are.na/v3${path}`, { headers, credentials: "omit" });
      if (!result.ok) throw new Error("Could not load channels.");
      response = await result.json();
    } else response = scope === "my" ? await native("channels", { page }, false)
      : await native("channelSearch", { query, scope, page }, false);
    if (ticket !== channelTicket || scope !== picker.scope || query !== picker.query) return;
    const parsed = channelPage(response, page);
    if (!oauth && parsed.accountId && !picker.accountId) await restoreChannelIndex(parsed.accountId);
    picker.replaceRows(parsed.rows, page, parsed.nextPage, parsed.accountId);
    renderSelectedChannels();
    if (scope === "my") {
      ownedNextPage = parsed.nextPage;
      if (picker.accountId) void browser.storage.local.set({ [channelCacheKey]: {
        accountId: picker.accountId, channels: [...picker.owned.values()] } });
    }
  } catch (error) {
    if (ticket === channelTicket) channelError = error instanceof Error ? error.message : "Could not load channels.";
  } finally {
    if (ticket === channelTicket) {
      channelLoading = false;
      renderChannelRows();
      const list = $("channel-list");
      if (!channelError && picker.nextPage && !picker.query && list.scrollHeight <= list.clientHeight + 1)
        void loadChannelPage();
    }
  }
}

function changeChannelScope(scope: ChannelScope): void {
  if (channelSearchTimer) clearTimeout(channelSearchTimer);
  channelSearchPending = false;
  channelTicket++;
  channelLoading = false;
  channelError = "";
  picker.scope = scope;
  picker.nextPage = scope === "my" ? ownedNextPage : 1;
  picker.query = channel.value.trim();
  if (scope !== "my") picker.network.clear();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-channel-scope]"))
    button.setAttribute("aria-pressed", String(button.dataset.channelScope === scope));
  renderChannelRows();
  if (channelAccessGranted && (scope !== "my" || !picker.owned.size)) void loadChannelPage();
}

async function openChannels(force = false): Promise<void> {
  const panel = $("channel-results");
  if (!panel.hidden && !force) { panel.hidden = true; return; }
  panel.hidden = false;
  picker.query = channel.value.trim();
  renderChannelRows();
  try {
    const allowed = oauth ? await browser.permissions.request({ origins: ["https://api.are.na/*"] })
      : await browser.permissions.request({ permissions: ["nativeMessaging"] });
    if (!allowed) throw new Error("Channel access was not granted.");
    channelAccessGranted = true;
    if (oauth) {
      const headers = { accept: "application/json", authorization: `Bearer ${await oauth.token()}` };
      const me = await fetch("https://api.are.na/v3/me", { headers, credentials: "omit" });
      if (!me.ok) throw new Error("Connect Are.na to browse channels.");
      const identity = await me.json() as { data?: { id?: number }; id?: number };
      const id = identity.data?.id ?? identity.id;
      if (!Number.isSafeInteger(id)) throw new Error("Could not identify your Are.na account.");
      if (picker.accountId && picker.accountId !== id) {
        picker.owned.clear(); picker.network.clear();
        if (!destinationsFrozen()) picker.selected.clear();
        ownedNextPage = 1;
        renderSelectedChannels();
      }
      picker.accountId = id;
      if (!picker.owned.size) await restoreChannelIndex(id!);
    }
    picker.nextPage = 1;
    if (picker.scope === "my") ownedNextPage = 1;
    else picker.network.clear();
    renderChannelRows();
    await loadChannelPage();
  } catch (error) {
    channelError = error instanceof Error ? error.message : "Could not browse channels.";
    $("channel-progress").textContent = channelError;
    if (channelError.includes("Connect your Are.na account")) $("connect-arena").hidden = false;
    renderChannelRows();
  }
}

function chosenPolicy(): Partial<CompositionPolicy> {
  return {
    media: mediaPolicy.value as CompositionPolicy["media"],
    threadExpansion: threadPolicy.value as NonNullable<CompositionPolicy["threadExpansion"]>,
    quote: quotePolicy.value as CompositionPolicy["quote"],
    quoteDepth: quoteDepth.value === "full" ? "full" : Number(quoteDepth.value),
    quoteDates: quoteDates.value as NonNullable<CompositionPolicy["quoteDates"]>,
    separator: separatorPolicy.value as CompositionPolicy["separator"],
  };
}

async function resolveLocal(): Promise<void> {
  const refs = lines(primary.value), extraRefs = lines(extras.value);
  if (!refs.length || refs.length + extraRefs.length > 20) { message("Add 1–20 links.", true); return; }
  message("Resolving with local helper…");
  const ticket = resolutionGuard.begin(), signature = inputSignature();
  try {
    const resolved = await resolveWithNative({ refs, extraRefs, policy: chosenPolicy(), refresh: false, redditCaptures, substackCaptures }, native);
    if (!resolutionGuard.current(ticket) || signature !== inputSignature()) return;
    plan = editedFields() ? revisePlan(resolved, editedFields()!) : resolved;
    resolvedInput = signature;
    renderPlan();
    $("resolve-local").hidden = true;
    message("");
  } catch (error) {
    if (resolutionGuard.current(ticket)) message(error instanceof Error ? error.message : "The local helper is unavailable.", true);
  }
}

async function resolve(): Promise<void> {
  if (resolveInFlight || destinationsFrozen()) return;
  const refs = lines(primary.value);
  const extraRefs = lines(extras.value);
  if (!refs.length || refs.length + extraRefs.length > 20) { message("Add 1–20 links.", true); return; }
  resolveInFlight = true;
  syncDestinationLock();
  try { if (requiredOrigins([...refs, ...extraRefs], redditCaptures, substackCaptures).length) message("Resolving sources…"); }
  catch { /* The resolver reports an invalid link below. */ }
  const ticket = resolutionGuard.begin();
  try {
    // A user-invoked preview of the matching active Note can use already granted activeTab/scripting.
    for (const ref of [...refs, ...extraRefs]) {
      try {
        const id = substackSourceKey(ref);
        if (substackCaptures.some(c => substackSourceKey(c.sourceUrl) === id)) continue;
        const captured = await readActiveSubstackTab(browser, ref);
        if (!resolutionGuard.current(ticket) || ![...lines(primary.value), ...lines(extras.value)].includes(ref)) return;
        substackCaptures = substackCapturesSchema.parse([...substackCaptures, captured]);
        showRedditObservation();
        await browser.storage.local.set({ [key]: draft() });
      } catch { /* Ordinary credentialless public acquisition remains available; never request a browser grant. */ }
    }
    const signature = inputSignature();
    const origins = requiredOrigins([...refs, ...extraRefs], redditCaptures, substackCaptures);
    if (origins.length) {
      let allowed: boolean;
      try { allowed = await browser.permissions.contains({ origins })
        || await browser.permissions.request({ origins }); }
      catch (error) {
        if (!await browser.permissions.contains({ origins })) throw error;
        allowed = true;
      }
      if (!allowed) throw new Error("Access to the source sites was not granted.");
    }
    const resolved = await resolveCapture({ primary: refs, extras: extraRefs, policy: chosenPolicy(), redditCaptures, substackCaptures });
    if (!resolutionGuard.current(ticket) || signature !== inputSignature()) return;
    plan = editedFields() ? revisePlan(resolved, editedFields()!) : resolved;
    resolvedInput = signature;
    renderPlan();
    $("resolve-local").hidden = true;
    message("");
  } catch (error) {
    if (!resolutionGuard.current(ticket)) return;
    $("resolve-local").hidden = redditLiveReadUnavailable(error);
    message(error instanceof Error ? error.message : "Could not resolve this source.", true);
  }
  finally {
    resolveInFlight = false;
    syncDestinationLock();
  }
}

function showRedditObservation() {
  const captures = [...redditCaptures, ...substackCaptures];
  $("export-reddit").hidden = captures.length === 0;
  const choice = $<HTMLSelectElement>("reddit-export-choice"), selected = choice.value;
  choice.hidden = captures.length < 2;
  choice.replaceChildren(...captures.map(capture => {
    const option = document.createElement("option"); option.value = capture.schema === "arena-block/substack-browser-capture" ? `substack:${substackSourceKey(capture.sourceUrl)}` : redditSourceKey(capture.sourceUrl);
    option.textContent = capture.schema === "arena-block/substack-browser-capture" ? `Substack Note by @${capture.note.author.handle}` : capture.comment ? `Comment ${capture.comment.id}` : capture.post.title;
    return option;
  }));
  if ([...choice.options].some(option => option.value === selected)) choice.value = selected;
  $("reddit-observation").hidden = captures.length === 0;
  $("reddit-observation").textContent = captures.map(capture => `Browser snapshot observed ${capture.observedAt}`).join("; ");
}
async function acceptRedditCapture(value: unknown) {
  if (destinationsFrozen() || resolveInFlight) throw new Error("Finish the current capture operation before importing a browser record");
  const capture = normalizeRedditCapture(value);
  const refs = [...lines(primary.value), ...lines(extras.value)];
  const matches = refs.some(ref => { try { return redditSourceKey(ref) === redditSourceKey(capture.sourceUrl); } catch { return false; } });
  if (refs.length && !matches) throw new Error("This record belongs to another source. Start a new capture and clear its source links before importing it.");
  if (!refs.length) primary.value = capture.sourceUrl;
  redditCaptures = redditCapturesSchema.parse([...redditCaptures.filter(item => redditSourceKey(item.sourceUrl) !== redditSourceKey(capture.sourceUrl)), capture]);
  showRedditObservation();
  intakeChanged();
  await browser.storage.local.set({ [key]: draft() });
  await resolve();
}
async function acceptSubstackCapture(value: unknown) {
  if (destinationsFrozen() || resolveInFlight) throw new Error("Finish the current capture operation before importing a browser record");
  const capture = normalizeSubstackCapture(value);
  const refs = [...lines(primary.value), ...lines(extras.value)];
  const matches = refs.some(ref => { try { return substackSourceKey(ref) === substackSourceKey(capture.sourceUrl); } catch { return false; } });
  if (refs.length && !matches) throw new Error("This record belongs to another source. Start a new capture before importing it.");
  if (!refs.length) primary.value = capture.sourceUrl;
  substackCaptures = substackCapturesSchema.parse([...substackCaptures.filter(c => substackSourceKey(c.sourceUrl) !== substackSourceKey(capture.sourceUrl)), capture]);
  showRedditObservation(); intakeChanged();
  await browser.storage.local.set({ [key]: draft() });
  await resolve();
}
$("read-substack").addEventListener("click", () => {
  if (destinationsFrozen() || resolveInFlight) return;
  const signature = inputSignature();
  void readActiveSubstackTab(browser).then(capture => {
    if (signature !== inputSignature()) throw new Error("The draft changed while reading Substack. Read the tab again.");
    return acceptSubstackCapture(capture);
  }).catch(error => message(error instanceof Error ? error.message : String(error), true));
});
$("import-reddit").addEventListener("click", () => $<HTMLInputElement>("reddit-file").click());
$("reddit-file").addEventListener("change", () => { void (async () => {
  const input = $<HTMLInputElement>("reddit-file"), file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    if (file.size > REDDIT_CAPTURE_MAX_BYTES) throw new Error("Reddit capture file exceeds 2 MiB");
    const value = JSON.parse(await file.text());
    if (value.schema === "arena-block/substack-browser-capture") await acceptSubstackCapture(value);
    else await acceptRedditCapture(value);
  } catch (error) { message(error instanceof Error ? error.message : String(error), true); }
})(); });
$("export-reddit").addEventListener("click", () => {
  const choice = $<HTMLSelectElement>("reddit-export-choice").value;
  const capture = [...redditCaptures, ...substackCaptures].find(item => item.schema === "arena-block/substack-browser-capture"
    ? `substack:${substackSourceKey(item.sourceUrl)}` === choice : redditSourceKey(item.sourceUrl) === choice) ?? redditCaptures[0] ?? substackCaptures[0];
  if (capture) {
    const href = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = href; link.download = capture.schema === "arena-block/substack-browser-capture" ? `${substackSourceKey(capture.sourceUrl)}.arena-substack.json` : `${capture.comment?.id ?? capture.post.id}.arena-reddit.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
});

for (const field of [primary, extras, mediaPolicy, threadPolicy, quotePolicy, quoteDepth, quoteDates, separatorPolicy]) field.addEventListener("input", () => {
  if (field === primary || field === extras) {
    const keys = new Set([...lines(primary.value), ...lines(extras.value)].flatMap(ref => { try { return [redditSourceKey(ref)]; } catch { return []; } }));
    redditCaptures = redditCaptures.filter(capture => keys.has(redditSourceKey(capture.sourceUrl)));
    const substackKeys = new Set([...lines(primary.value), ...lines(extras.value)].flatMap(ref => { try { return [substackSourceKey(ref)]; } catch { return []; } }));
    substackCaptures = substackCaptures.filter(c => substackKeys.has(substackSourceKey(c.sourceUrl)));
    showRedditObservation();
  }
  intakeChanged();
});
for (const field of [title, writing, description]) field.addEventListener("input", editPlan);
channel.addEventListener("input", () => {
  picker.query = channel.value.trim();
  if ($("channel-results").hidden) return;
  if (picker.scope === "my") {
    renderChannelRows();
    if (channelAccessGranted && picker.query && !picker.rows().length && ownedNextPage) {
      picker.nextPage = ownedNextPage;
      void loadChannelPage();
    }
  }
  else {
    if (channelSearchTimer) clearTimeout(channelSearchTimer);
    channelTicket++;
    channelLoading = false;
    channelSearchPending = true;
    channelError = "";
    picker.network.clear();
    picker.nextPage = 1;
    renderChannelRows();
    channelSearchTimer = setTimeout(() => {
      channelSearchPending = false;
      renderChannelRows();
      void loadChannelPage();
    }, 350);
  }
});
channel.addEventListener("keydown", event => {
  if (event.key === "ArrowDown") {
    const first = document.querySelector<HTMLButtonElement>("#channel-list .channel-choice:not(:disabled)");
    if (first) { event.preventDefault(); first.focus(); }
  }
  if (event.key === "Enter" && channel.value.trim()) {
    event.preventDefault();
    if (channelLoading || channelSearchPending) return;
    const first = document.querySelector<HTMLButtonElement>("#channel-list .channel-choice:not(:disabled)");
    if (first) first.click();
    else document.querySelector<HTMLButtonElement>("#typed-channel-choice")?.click();
  }
});
for (const field of [defaultChannel, defaultMode]) field.addEventListener("input", () => { renderSelectedChannels(); retain(); });
$<HTMLSelectElement>("audio-choice").addEventListener("change", event => {
  if (!plan) return;
  resolutionGuard.changed();
  plan = revisePlan(plan, { policy: { audio: (event.target as HTMLSelectElement).value },
    title: title.value, markdown: writing.value, description: description.value });
  renderPlan(false);
});
resolveButton.addEventListener("click", () => { void resolve(); });
$<HTMLButtonElement>("preview-source").addEventListener("click", () => { void resolve(); });
function showChannels(open: boolean): void {
  const viewport = document.querySelector<HTMLElement>(".viewport")!;
  if (open) captureScrollTop = viewport.scrollTop;
  if (open) renderPickerPreview();
  $("capture-view").hidden = open;
  $("channel-view").hidden = !open;
  $<HTMLButtonElement>("back-to-capture").hidden = !open;
  $<HTMLButtonElement>("new-capture").hidden = open;
  document.body.classList.toggle("channel-open", open);
  if (open) {
    viewport.scrollTop = 0;
    channel.focus({ preventScroll: true });
    if ($("channel-results").hidden) void openChannels();
  }
  else {
    $<HTMLButtonElement>("choose-channel").focus({ preventScroll: true });
    viewport.scrollTop = captureScrollTop;
  }
}
$<HTMLButtonElement>("choose-channel").addEventListener("click", () => showChannels(true));
$<HTMLButtonElement>("back-to-capture").addEventListener("click", () => showChannels(false));
$<HTMLButtonElement>("new-capture").addEventListener("click", () => { void startNewCapture(); });
async function startNewCapture(): Promise<void> {
  if (saveInFlight || pending && ["queued", "resolving", "running", "creating"].includes(pending.phase)) {
    saveStatus.textContent = "Check this save before starting another.";
    checkSave.hidden = false;
    return;
  }
  if (pending && ["prepared", "unknown", "partial", "created", "cancelled"].includes(pending.phase)) {
    const entry: EarlierSave = { saveId: pending.saveId, source: lines(primary.value)[0] ?? "Source",
      title: plan?.block.title ?? "Earlier capture", phase: pending.phase,
      method: pending.method ?? "native", destinations: pending.destinations };
    const nextEarlier = earlierSaves.some(item => item.saveId === entry.saveId)
      ? earlierSaves : [entry, ...earlierSaves];
    try { await browser.storage.local.set({ [earlierKey]: nextEarlier }); }
    catch {
      saveStatus.textContent = "Could not retain the earlier save. Check its status before starting another.";
      return;
    }
    earlierSaves = nextEarlier;
    renderEarlierSaves();
    $<HTMLDetailsElement>("earlier-saves").open = true;
  }
  resolutionGuard.changed();
  plan = pending = undefined;
  redditCaptures = [];
  substackCaptures = [];
  showRedditObservation();
  resolvedInput = undefined;
  manualContentEdit = false;
  manualFields = {};
  if (previewTimer) clearTimeout(previewTimer);
  primary.value = pageSource ?? "";
  extras.value = "";
  for (const select of [mediaPolicy, threadPolicy, quotePolicy, quoteDates, separatorPolicy]) select.value = "auto";
  quotePolicy.value = "block";
  quoteDepth.value = "2";
  title.value = writing.value = description.value = "";
  picker.selected.clear();
  channel.value = "";
  picker.query = "";
  $("composition-empty").hidden = false;
  $("composition-fields").hidden = true;
  $("composition").hidden = true;
  $<HTMLDetailsElement>("composition").open = false;
  $("source-count").textContent = "";
  $("status").textContent = "";
  saveStatus.textContent = "";
  checkSave.hidden = true;
  resolveButton.textContent = "Preview";
  $<HTMLDetailsElement>("source-details").open = !pageSource;
  renderCapturePreview();
  renderSelectedChannels();
  retain();
  document.querySelector<HTMLElement>(".viewport")!.scrollTop = 0;
  if (pageSource) void resolveAuthorizedSource(pageSource);
  if (!pageSource) primary.focus({ preventScroll: true });
}
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("channel-view").hidden) {
    event.preventDefault();
    showChannels(false);
  }
});
$("resolve-local").addEventListener("click", () => { void resolveLocal(); });
saveButton.addEventListener("click", () => { void save(); });
checkSave.addEventListener("click", () => { void checkStatus(); });
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || pending?.method !== "job") return;
  const job = changes[captureJobKey(pending.saveId)]?.newValue as CaptureJob | undefined;
  if (job?.saveId === pending.saveId) acceptStatus(job);
});
$("load-channels").addEventListener("click", () => { void openChannels(); });
$("add-channel").addEventListener("click", () => {
  if (destinationsFrozen()) return;
  try {
    picker.add(channel.value);
    channel.value = "";
    picker.query = "";
    renderSelectedChannels();
    if (!$('channel-results').hidden) renderChannelRows();
    retain();
  } catch (error) { $("channel-progress").textContent = error instanceof Error ? error.message : "Enter a channel slug or ID."; }
});
$<HTMLButtonElement>("clear-channels").addEventListener("click", () => {
  if (destinationsFrozen()) return;
  for (const choice of [...picker.selected.values()]) picker.remove(choice.value);
  renderSelectedChannels();
  updateChannelSelections();
  retain();
});
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-channel-scope]"))
  button.addEventListener("click", () => changeChannelScope(button.dataset.channelScope as ChannelScope));
$("more-channels").addEventListener("click", () => {
  if (!channelError) void loadChannelPage();
  else if (channelAccessGranted && picker.nextPage) void loadChannelPage();
  else void openChannels(true);
});
$("channel-list").addEventListener("scroll", () => {
  const list = $("channel-list");
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 65) void loadChannelPage();
});
$("connect-arena").addEventListener("click", () => {
  if (!oauth) return;
  void (async () => {
    try {
      saveStatus.textContent = "Connecting to Are.na…";
      await oauth!.signIn();
      $("connect-arena").hidden = true;
      saveStatus.textContent = "";
      saveStatus.classList.remove("error");
      picker.nextPage = 1;
      if (channelAccessGranted) void loadChannelPage();
    } catch (error) {
      saveStatus.textContent = error instanceof Error ? error.message : "Could not connect to Are.na.";
      saveStatus.classList.add("error");
    }
  })();
});

void (async () => {
  try {
    const response = await fetch(browser.runtime.getURL("oauth-client.json"));
    const config = await response.json() as { clientId?: string };
    if (config.clientId) {
      oauth = new BrowserOAuth(config.clientId, browser.identity, browser.storage.local);
      try { await oauth.token(); $("connect-arena").hidden = true; }
      catch { $("connect-arena").hidden = false; }
    }
    let source = new URL(location.href).searchParams.get("source");
    if (!source) {
      try { source = (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.url ?? null; }
      catch { /* Browser-owned pages may not expose a source URL. */ }
    }
    if (source && !/^https?:\/\//.test(source)) source = null;
    pageSource = source ?? undefined;
    const earlier = (await browser.storage.local.get(earlierKey))[earlierKey];
    if (Array.isArray(earlier)) earlierSaves = earlier.filter((item): item is EarlierSave =>
      item && typeof item === "object" && typeof item.saveId === "string"
      && typeof item.source === "string" && typeof item.title === "string"
      && typeof item.phase === "string" && ["browser", "native", "job"].includes(item.method)
      && Array.isArray(item.destinations));
    renderEarlierSaves();
    const saved = (await browser.storage.local.get(key))[key] as ReturnType<typeof draft> | undefined;
    if (saved) {
      defaultChannel.value = saved.defaultChannel ?? "";
      defaultMode.value = saved.defaultMode ?? "fallback";
      const unconfirmed = saved.pending && !["saved", "rejected", "not_saved"].includes(saved.pending.phase);
      const replaceAuto = shouldReplaceAutomaticDraft(saved, source, Boolean(unconfirmed));
      if (replaceAuto) {
        primary.value = source!;
        retain();
      } else {
        manualContentEdit = Boolean(saved.manualContentEdit);
        manualFields = saved.manualFields ?? (manualContentEdit
          ? { title: true, writing: true, description: true } : {});
        primary.value = saved.primary ?? "";
        redditCaptures = redditCapturesSchema.parse(saved.redditCaptures ?? []);
        substackCaptures = substackCapturesSchema.parse(saved.substackCaptures ?? []);
        showRedditObservation();
        extras.value = saved.extras ?? "";
        mediaPolicy.value = saved.media ?? "auto";
        threadPolicy.value = saved.thread ?? "auto";
        quotePolicy.value = saved.quote ?? "block";
        quoteDepth.value = saved.depth ?? "2";
        quoteDates.value = saved.dates ?? "auto";
        separatorPolicy.value = saved.separator ?? "auto";
        picker.restore(saved.selectedChannels);
        if (!saved.selectedChannels && saved.channel) {
          try { picker.add(saved.channel); } catch { /* Ignore an invalid old typed destination. */ }
        }
        channel.value = saved.selectedChannels ? saved.channel ?? "" : "";
        pending = saved.pending;
        resolvedInput = saved.resolvedInput;
        if (saved.plan) { plan = blockPlanSchema.parse(saved.plan); renderPlan(); }
        if (pending) { showSave(pending.phase); void checkStatus(false); }
        if (plan && resolvedInput !== inputSignature()) intakeChanged();
      }
    }
    renderSelectedChannels();
    renderCapturePreview();
    $<HTMLDetailsElement>("source-details").open = !primary.value.trim();
    if (!source || containsDraftSource(primary.value, source)) {
      if (source) void resolveAuthorizedSource(source);
      return;
    }
    if (!primary.value.trim()) {
      primary.value = source;
      renderCapturePreview();
      $<HTMLDetailsElement>("source-details").open = false;
      retain();
      void resolveAuthorizedSource(source);
      return;
    }
    const button = $<HTMLButtonElement>("add-current");
    button.hidden = false;
    button.addEventListener("click", () => {
      primary.value = `${primary.value.trimEnd()}\n${source}`;
      button.hidden = true;
      intakeChanged();
    });
  } catch { message("Could not restore the previous draft.", true); }
})();
