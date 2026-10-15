#!/usr/bin/env bun
import { planMedia } from "../packages/core/media-tree.ts";
import { selectedPostMediaPolicy } from "./cli-media.ts";
import { diagnoseSaveDestinations } from "./save-diagnostics.ts";
import { snapshotDefaultChannel } from "./provenance-schema.ts";
import { copyFile, open } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Command, Option } from "commander";
import { configureCliHelp } from "./cli-help.ts";
import { ArenaBlockClient, PublicationError } from "./client.ts";
import { composePlan, planHash } from "./compose.ts";
import { SocialResolver } from "./providers/index.ts";
import { SubstackProvider } from "../packages/core/providers/substack.ts";
import { bindSubstackCaptures, normalizeSubstackCapture, SUBSTACK_CAPTURE_MAX_BYTES } from "../packages/core/substack-record.ts";
import { RedditProvider } from "../packages/core/providers/reddit.ts";
import { bindRedditCaptures, normalizeRedditCapture, REDDIT_CAPTURE_MAX_BYTES } from "../packages/core/reddit-record.ts";
import type { MosaicMode } from "./mosaic-preview.ts";
import { buildInfo } from "./version.ts";
import type { ThreadDescription } from "./thread-capture.ts";
import { arenaDestination, normalizeArenaDestinations } from "./url.ts";
import type { BlockPlan, CompositionPolicy, PublicationReceipt } from "./types.ts";
import { blockPlanSchema, compositionPolicySchema } from "./types.ts";
import { publicationWithProgress } from "./publication-progress.ts";
import { loadUserConfig } from "./config.ts";
import { initiatorSchema, prepareSaveIntent, writeSaveIntent, writeSaveResult, saveSnapshotSchema } from "./save-intent.ts";
import { formatHumanReceipt, receiptOutputMode } from "./receipt-format.ts";
import { formatArenaBlockMetadata } from "./metadata.ts";
import { collectRatio, formatRatioReport, overlapRules, type OverlapRule, type RatioSource } from "./visibility-ratio.ts";

type Options = {
  media?: string;
  mediaOrder?: string;
  frame?: string;
  videoFrameThreshold?: string;
  quoteDepth?: string;
  quoteDates?: CompositionPolicy["quoteDates"];
  quoteAuthorLink?: CompositionPolicy["quoteAuthorLink"];
  audio?: string;
  quote?: CompositionPolicy["quote"];
  separator?: CompositionPolicy["separator"];
  threadExpansion?: boolean;
  to?: string[];
  json?: boolean;
  output?: string;
  plan?: string;
  force?: boolean;
  extra?: string[];
  substackCapture?: string[];
  redditCapture?: string[];
  layout?: string;
  outputDir?: string;
  canvas?: string;
  minScale?: string;
  config?: string;
  dryRun?: boolean;
  initiator?: string;
  agent?: string;
  profile?: string;
  publish?: boolean;
  human?: boolean;
  verbose?: boolean;
};

function splitInputs(values: string[], destinations: string[] = []): { refs: string[]; destinations: string[] } {
  const refs: string[] = [];
  const targets = normalizeArenaDestinations(destinations);
  for (const value of values) {
    const destination = arenaDestination(value);
    if (destination) targets.push(destination);
    else refs.push(value);
  }
  return { refs, destinations: normalizeArenaDestinations(targets) };
}

function audioSource(value: string, postCount: number): string {
  if (!/^\d+$/.test(value)) return value;
  if (postCount !== 1) throw new Error("A bare audio index requires one post; use a post.media ref for multiple posts");
  return `1.${value}`;
}

function policy(options: Options, postCount: number): Partial<CompositionPolicy> {
  const media = options.media ?? "auto";
  const indexes = /^\d+(?:[+,]\d+)*$/.test(media);
  if (indexes && postCount !== 1) throw new Error("Bare media indexes require one post; use post.media refs for multiple posts");
  const selectedMedia = indexes ? media.split(/[+,]/).map(value => `1.${value}`)
    : /^\d+\.\d+/.test(media) ? media.split(",").map(value => value.trim()) : [];
  return {
    media: selectedMedia.length ? "selected" : media as CompositionPolicy["media"],
    selectedMedia,
    ...(options.frame ? { videoFrames: options.frame.split(",").map(value => value.trim()) } : {}),
    ...(options.videoFrameThreshold ? { videoFrameThresholdSeconds: Number(options.videoFrameThreshold) } : {}),
    ...(options.mediaOrder !== undefined ? { mediaOrder: options.mediaOrder.split(",").map(value => value.trim()) } : {}),
    quote: options.quote ?? "block",
    ...(options.quoteDepth !== undefined ? { quoteDepth: options.quoteDepth === "full" ? "full" : Number(options.quoteDepth) } : {}),
    ...(options.quoteDates !== undefined ? { quoteDates: options.quoteDates } : {}),
    ...(options.quoteAuthorLink !== undefined ? { quoteAuthorLink: options.quoteAuthorLink } : {}),
    separator: options.separator ?? "auto",
    threadExpansion: options.threadExpansion ? "on" : "off",
    ...(options.audio ? { audio: audioSource(options.audio, postCount) } : {}),
  };
}

function displayPlan(plan: BlockPlan): string {
  const contributions = plan.sources.map((source, index) => {
    const role = source.selection?.role ?? (plan.policy.mediaOnlyPosts?.includes(index + 1) ? "extra" : "primary");
    const origin = source.selection?.origin === "expanded" ? " · expanded" : "";
    const chosen = plan.block.selectedMedia.filter(ref => ref.startsWith(`${index + 1}.`)).length;
    return `  ${index + 1}. ${role}${origin} · @${source.author.handle.replace(/^@/, "")} · ${chosen}/${planMedia(plan).filter(asset => asset.ref.startsWith(`${index + 1}.`)).length} media · ${source.canonicalUrl}`;
  });
  return [
    `${plan.block.title} · ${plan.block.kind} · ${plan.hash.slice(0, 12)}`,
    `Source: ${plan.block.canonicalSource}`,
    `Sources (${plan.sources.length}):`, ...contributions,
    `Media: ${plan.block.selectedMedia.join(", ") || "none"}`,
    "",
    plan.block.markdown,
    ...(plan.block.description ? ["", "Description:", plan.block.description] : []),
  ].join("\n");
}

async function readLocalPlan(path: string): Promise<BlockPlan> {
  const file = Bun.file(path);
  if (file.size > 2 * 1024 * 1024) throw new Error("Local plan exceeds 2 MiB");
  return blockPlanSchema.parse(await file.json());
}

async function captureInputs(values: string[], options: Options) {
  const captures = [];
  for (const path of options.redditCapture ?? []) {
    const file = Bun.file(path);
    if (file.size > REDDIT_CAPTURE_MAX_BYTES) throw new Error("Reddit capture file exceeds 2 MiB");
    captures.push(normalizeRedditCapture(await file.json()));
  }
  const substack = [];
  for (const path of options.substackCapture ?? []) {
    const file = Bun.file(path);
    if (file.size > SUBSTACK_CAPTURE_MAX_BYTES) throw new Error("Substack capture file exceeds 2 MiB");
    substack.push(normalizeSubstackCapture(await file.json()));
  }
  const inputs = splitInputs(values, options.to);
  if (!inputs.refs.length) inputs.refs = [...captures, ...substack].map(capture => capture.sourceUrl);
  const normalized = bindRedditCaptures([...inputs.refs, ...(options.extra ?? [])], captures);
  return { inputs, resolver: new SocialResolver({ reddit: new RedditProvider(undefined, normalized), substack: new SubstackProvider(bindSubstackCaptures([...inputs.refs, ...(options.extra ?? [])], substack)) }) };
}

async function localPlan(values: string[], options: Options): Promise<{ plan: BlockPlan; destinations: string[] }> {
  const { inputs, resolver } = await captureInputs(values, options);
  if (!inputs.refs.length) throw new Error("At least one source post or non-text Are.na block URL is required");
  const extras = options.extra ?? [];
  const refs = [...inputs.refs, ...extras];
  if (refs.length > 20) throw new Error("At most 20 source posts are supported");
  const composition = policy(options, refs.length);
  const resolved = await resolver.resolveComposition(inputs.refs, extras, composition);
  const plan = composePlan(resolved.posts, selectedPostMediaPolicy(resolved.posts, resolved.policy));
  return { plan, destinations: inputs.destinations };
}

function client(): ArenaBlockClient {
  const endpoint = process.env.ARENA_BLOCK_ENDPOINT ?? "http://127.0.0.1:8790";
  const token = process.env.ARENA_BLOCK_ACCESS_TOKEN;
  if (!token) throw new Error("ARENA_BLOCK_ACCESS_TOKEN is required for daemon commands");
  return new ArenaBlockClient(endpoint, token);
}

function addCompositionOptions(command: Command, extras = true): Command {
  if (extras) command.option("--extra <url>", "add supplementary media from a post or Are.na block; repeatable", (value, values: string[]) => [...values, value], []);
  return command
    .option("--substack-capture <path>", "read a retained Substack source record; repeatable", (value, values: string[]) => [...values, value], [])
    .option("--reddit-capture <path>", "read a retained Reddit source record; repeatable", (value, values: string[]) => [...values, value], [])
    .option("--media <mode>", "auto, none, all, images, video, audio, indexes (1+4) or refs (1.1,1.4); all/types exclude quote-only media", "auto")
    .option("--frame <refs>", "use source poster frames for video refs, such as 1.1,2.1")
    .option("--video-frame-threshold <seconds>", "use source posters above this duration; 1-600 seconds, default 600")
    .addOption(new Option("-t, --thread-expansion", "include available x.com, Bluesky, Delvetown or Substack chains, or Forum Magnum replies").default(false, "off"))
    .addOption(new Option("--no-thread-expansion").hideHelp())
    .option("--media-order <refs>", "set the complete tile order with refs, such as 2.1,1.2,1.1")
    .option("--audio <mode>", "choose a video soundtrack: auto, mix, index (2), or ref (1.2)")
    .option("--quote <mode>", "block, sequence, or omit", "block")
    .option("--quote-depth <depth>", "include 0-8 quote levels, or full (up to 8); default 2")
    .option("--quote-dates <mode>", "auto (earlier source dates), source (literal timestamps), or none")
    .addOption(new Option("--quote-author-link <mode>", "source links to the quoted post; plain uses an unlinked name. Omit to keep the platform style").choices(["source", "plain"]))
    .option("--separator <mode>", "auto, always, or never", "auto")
    .option("--to <channel>", "Are.na channel slug or URL", (value, values: string[]) => [...values, value], []);
}

function addReceiptOptions(command: Command): Command {
  return command
    .option("--json", "print the complete JSON receipt")
    .option("--human", "print a text receipt, including when piped")
    .option("--verbose", "include save IDs and the plan hash in the text receipt");
}

type ChannelDisplay = { channelNames?: Record<string, string>; channelIds?: Record<string, number>; channelSlugs?: Record<string, string> };
async function channelDisplay(daemon: ArenaBlockClient, receipt: PublicationReceipt): Promise<ChannelDisplay> {
  const refs = [...new Set([...receipt.destinations, ...(receipt.pendingDestinations ?? [])])];
  if (!refs.length) return {};
  try {
    const labels = await daemon.channelLabels(refs, AbortSignal.timeout(1800));
    return {
      channelNames: Object.fromEntries(labels.map(value => [value.ref, value.title])),
      channelIds: Object.fromEntries(labels.map(value => [value.ref, value.id])),
      channelSlugs: Object.fromEntries(labels.map(value => [value.ref, value.slug])),
    };
  } catch { return {}; } // Display metadata must never change a saved outcome.
}

async function printReceipt(receipt: PublicationReceipt, options: Options, context: { saveId?: string; provenanceDirectory?: string; defaultChannel?: string } = {}, daemon?: ArenaBlockClient): Promise<void> {
  const mode = receiptOutputMode(options, Boolean(process.stdout.isTTY));
  console.log(mode === "json" ? JSON.stringify(receipt, null, 2)
    : formatHumanReceipt(receipt, { ...context, verbose: options.verbose, ...(daemon ? await channelDisplay(daemon, receipt) : {}) }));
}

const cliBuild = buildInfo();
let activeReceiptOptions: Options | undefined;
let activeSaveId: string | undefined;
let activeProvenanceDirectory: string | undefined;
const program = addCompositionOptions(new Command("arena-block"))
  .description("Capture social posts as editable Are.na blocks")
  .version(`${cliBuild.version} (${cliBuild.sourceId})`)
  .argument("[refs...]", "supported social posts, comments, Bluesky at:// URIs, or non-text Are.na blocks")
  .option("--json", "print stable JSON")
  .option("--config <path>", "read a private configuration file")
  .action(async (refs: string[], options: Options) => {
    if (!refs.length && !options.extra?.length && !options.redditCapture?.length && !options.substackCapture?.length) {
      console.log(program.helpInformation());
      return;
    }
    const { plan } = await localPlan(refs, options);
    console.log(options.json ? JSON.stringify(plan, null, 2) : displayPlan(plan));
  });

program.enablePositionalOptions();
// Composition flags may precede a subcommand. Preserve an explicit parent
// choice unless the subcommand supplies its own choice.
program.hook("preAction", (root, command) => {
  if (command === root) return;
  for (const key of ["threadExpansion", "quoteAuthorLink"] as const) {
    const source = command.getOptionValueSource(key);
    if (root.getOptionValueSource(key) === "cli" && (source === undefined || source === "default")
      && command.options.some(option => option.attributeName() === key)) {
      command.setOptionValueWithSource(key, root.opts()[key], "cli");
    }
  }
});

program.command("version").description("Report the CLI build")
  .option("--daemon", "include the configured daemon")
  .action(async (options: { daemon?: boolean }) => {
    console.log(JSON.stringify({ client: buildInfo(), ...(options.daemon ? { daemon: await client().version() } : {}) }, null, 2));
  });

addCompositionOptions(program.command("resolve").description("Read normalized source posts").argument("[refs...]").option("--json", "print JSON"), false)
  .action(async (refs: string[], options: Options) => {
    const { inputs, resolver } = await captureInputs(refs, options);
    if (!inputs.refs.length) throw new Error("At least one source URL or browser-capture file is required");
    const posts = await resolver.resolve(inputs.refs, undefined, compositionPolicySchema.parse(policy(options, inputs.refs.length)));
    console.log(JSON.stringify(posts, null, options.json ? 2 : 0));
  });

addCompositionOptions(program.command("plan").description("Create a block plan for review").argument("[refs...]").option("--json", "print stable JSON"))
  .action(async (refs: string[], options: Options) => {
    const { plan } = await localPlan(refs, options);
    console.log(options.json ? JSON.stringify(plan, null, 2) : displayPlan(plan));
  });

addCompositionOptions(program.command("render").description("Render a local media preview").argument("[refs...]")
  .option("-o, --output <path>", "write rendered media to this file")
  .option("--plan <path>", "render a saved local plan")
  .option("--layout <mode>", "reading (pages) or wallpaper (overview)")
  .option("--output-dir <path>", "write layout pages and their coverage report here")
  .option("--canvas <width>x<height>", "canvas size; defaults: reading 4096x4096, wallpaper 1440x2560")
  .option("--min-scale <number>", "minimum image scale for reading pages; default 1"))
  .action(async (refs: string[], options: Options) => {
    if (options.plan && (refs.length || options.extra?.length || options.redditCapture?.length || options.substackCapture?.length)) throw new Error("--plan cannot accompany source URLs, --extra, --reddit-capture, or --substack-capture");
    if (options.layout && !["reading", "wallpaper"].includes(options.layout)) throw new Error("--layout must be reading or wallpaper");
    if (options.layout ? (!options.outputDir || options.output) : (!options.output || options.outputDir || options.canvas || options.minScale)) {
      throw new Error("Normal rendering requires -o; --layout requires --output-dir and writes local preview pages");
    }
    if (options.layout === "wallpaper" && options.minScale) throw new Error("--min-scale applies to reading pages; wallpaper is an overview without a text-legibility guarantee");
    const match = options.canvas ? /^(\d+)x(\d+)$/.exec(options.canvas) : undefined;
    if (options.canvas && !match) throw new Error("--canvas must use WIDTHxHEIGHT");
    const { plan } = options.plan ? { plan: await readLocalPlan(options.plan) } : await localPlan(refs, options);
    if (options.layout) {
      const { renderMosaicPreview } = await import("./mosaic-preview.ts");
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("Preview cancelled"));
      process.once("SIGINT", cancel);
      try {
        const manifest = await renderMosaicPreview(plan, options.outputDir!, { mode: options.layout as MosaicMode, signal: controller.signal,
          ...(match ? { canvas: { width: Number(match[1]), height: Number(match[2]) } } : {}),
          ...(options.minScale ? { minScale: Number(options.minScale) } : {}) });
        console.log(JSON.stringify(manifest, null, 2));
      } finally { process.removeListener("SIGINT", cancel); }
      return;
    }
    if (plan.block.kind === "text") {
      await Bun.write(options.output!, plan.block.markdown);
      return;
    }
    const { renderPlan } = await import("./render.ts");
    const directory = process.env.ARENA_BLOCK_CACHE_DIR ?? `${process.env.HOME}/.cache/arena-block`;
    const media = await renderPlan(plan, join(directory, "rendered"));
    if (!media) throw new Error("Plan rendered no media");
    await copyFile(media.path, options.output!);
    console.error(`${media.mimeType} ${media.size} bytes`);
  });

addCompositionOptions(addReceiptOptions(program.command("publish").description("Save a block through the daemon").argument("[refs...]").option("--plan <path>", "save an existing local plan").option("--force", "allow a new publication of an already saved plan"))
  .option("--config <path>", "read a private configuration file").option("--dry-run", "print the proposed save and destinations locally")
  .option("--profile <name>", "use this configured account profile")
  .option("--initiator <kind>", "declare the initiator: human, agent, automation, or unknown", "unknown")
  .option("--agent <label>", "record an agent or workflow label"))
  .action(async (refs: string[], options: Options) => {
    activeReceiptOptions = options;
    const display = receiptOutputMode(options, Boolean(process.stdout.isTTY));
    if (options.plan && (refs.length || options.extra?.length || options.redditCapture?.length || options.substackCapture?.length)) throw new Error("--plan cannot accompany source URLs, --extra, --reddit-capture, or --substack-capture");
    const planned = options.plan
      ? { plan: await readLocalPlan(options.plan), destinations: options.to ?? [] }
      : await localPlan(refs, options);
    const config = await loadUserConfig(options.config ?? program.opts().config);
    const legacyDefaults = (process.env.ARENA_BLOCK_DEFAULT_CHANNELS ?? "").split(",").filter(Boolean);
    const intent = prepareSaveIntent(planned.plan, config, { origin: "cli", initiator: initiatorSchema.parse({ kind: options.initiator, identityBasis: options.initiator === "unknown" ? "unknown" : "declared", ...(options.agent ? { label: options.agent } : {}) }),
      destinations: planned.destinations, legacyDefaults, operation: "publish", force: options.force, credentialProfile: options.profile,
      inputSourceRefs: options.plan ? undefined : [...splitInputs(refs).refs, ...(options.extra ?? [])],
      inputDestinationArgs: [...(options.to ?? []), ...refs.filter(ref => arenaDestination(ref))],
      sourceRevision: cliBuild.revision ?? undefined, sourceId: cliBuild.sourceId });
    const destinations = intent.snapshot.routing.destinations;
    if (options.dryRun) { console.log(JSON.stringify(intent, null, 2)); return; }
    const remoteSave = config.provenance.remoteSnapshot !== "none" && snapshotDefaultChannel(intent.snapshot)?.included
      ? { snapshot: intent.snapshot, snapshotSha256: intent.snapshotSha256, mode: config.provenance.remoteSnapshot } : undefined;
    const daemon = client();
    await daemon.assertSaveProfile(config, "cli", options.profile);
    const operationId = intent.snapshot.saveId;
    activeSaveId = operationId;
    const provenanceDirectory = config.provenance.local ? await writeSaveIntent(intent,
      process.env.ARENA_BLOCK_PROVENANCE_DIR ?? join(process.env.ARENA_BLOCK_STATE_DIR ?? join(process.env.HOME!, ".local/share/arena-block"), "provenance")) : undefined;
    activeProvenanceDirectory = provenanceDirectory;
    let published = false;
    try {
      let receipt;
      try {
        receipt = await publicationWithProgress(daemon, planned.plan, destinations,
          signal => daemon.publishIntent(planned.plan, intent, remoteSave?.mode, signal), undefined, operationId, true, display === "human" ? "stdout" : "none");
      } catch (error) {
        if (provenanceDirectory) {
          try {
            await writeSaveResult(provenanceDirectory, { ...(error instanceof PublicationError && error.receipt ? { receipt: error.receipt } : {}),
              ...(error instanceof PublicationError && error.attempt ? { attempt: error.attempt } : {}), error: error instanceof Error ? error.message : String(error) });
          } catch { console.error("Could not record the local result. Check the retained save with save-status."); }
        }
        throw error;
      }
      if (provenanceDirectory) {
        try { await writeSaveResult(provenanceDirectory, { receipt }); }
        catch { console.error(`Block saved: ${receipt.blockUrl}\nPrivate result could not be recorded. Inspect retained state: arena-block inspect ${receipt.id}`); }
      }
      await printReceipt(receipt, options, { saveId: operationId, provenanceDirectory, defaultChannel: snapshotDefaultChannel(intent.snapshot)?.channel }, daemon);
      published = true;
    } catch (error) {
      if (display !== "human" && !(error instanceof PublicationError && error.saveStatus)) console.error(`Save UUID: ${operationId}\nStatus: arena-block save-status ${operationId}\nRecovery: arena-block retry-save ${operationId}`);
      throw error;
    } finally { if (!published && provenanceDirectory && display !== "human") console.error(`Private save snapshot: ${provenanceDirectory}`); }
  });

program.command("replan-save").description("Create a revised local plan from an unsaved capture")
  .argument("<id>", "original save UUID")
  .requiredOption("-o, --output <path>", "write to a new private plan file")
  .action(async (id: string, options: { output: string }) => {
    const daemon = client();
    const before = await daemon.saveStatus(id);
    const safelyUncreated = (status: typeof before) => status.phase === "not_saved" && !status.active && !status.receipt && !status.attempt;
    if (!safelyUncreated(before)) throw new Error("Replanning requires an inactive save with no block or creation attempt. Inspect the original save before recovery.");
    const retained = await daemon.retainedIntent(id);
    if (retained.snapshot.origin !== "cli") throw new Error("Use the original capture adapter to recover this save.");
    if (!retained.snapshot.fidelity.originalPlanPreserved) throw new Error("The retained source plan was redacted. Replan from the original local sources instead.");
    const original = retained.snapshot.plan;
    const { hash: originalHash, ...originalBody } = original;
    if (planHash(originalBody) !== originalHash) throw new Error("The retained plan checksum does not match. Use the original local plan for recovery.");
    const composed = composePlan(original.sources, original.policy);
    const selection = (block: BlockPlan["block"]) => ({ kind: block.kind, selectedMedia: block.selectedMedia, frameMedia: block.frameMedia ?? [] });
    if (!isDeepStrictEqual(selection(composed.block), selection(original.block))) throw new Error("Replanning would change the selected media. Review the original capture before recovery.");
    // Only the new plan's geometry changes. Preserve any approved title or writing
    // that differs from the provider's original text, as well as all provenance.
    const body = structuredClone(originalBody);
    body.block.layout = composed.block.layout;
    const plan = { ...body, hash: planHash(body) };
    if (plan.hash === original.hash) throw new Error("The retained composition is unchanged. Review its media selection before creating another save.");
    if (!safelyUncreated(await daemon.saveStatus(id))) throw new Error("The original save changed during replanning. Inspect its status before recovery.");
    const file = await open(options.output, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(plan, null, 2) + "\n"); } finally { await file.close(); }
    console.log(JSON.stringify({ originalSaveId: id, originalPlanHash: original.hash, planHash: plan.hash, output: options.output,
      destinations: retained.snapshot.routing.destinations, published: false }, null, 2));
    console.error("Review the new plan, then publish it separately with --plan and the destinations above. This creates a new save UUID; the original save is unchanged.");
  });

program.command("save-intent").description("Write a private local save snapshot")
  .requiredOption("--plan <path>", "read an existing source plan")
  .requiredOption("--output-dir <path>", "write a new private snapshot bundle here")
  .option("--config <path>", "read a private configuration file")
  .option("--profile <name>", "use this configured account profile")
  .option("--to <channel>", "active destination (repeatable)", (value, values: string[]) => [...values, value], [])
  .option("--initiator <kind>", "human, agent, automation, or unknown", "unknown")
  .option("--agent <label>", "record an agent or workflow label")
  .action(async (options: Options & { plan: string; outputDir: string }) => {
    const config = await loadUserConfig(options.config ?? program.opts().config);
    const intent = prepareSaveIntent(await readLocalPlan(options.plan), config, {
      origin: "cli", initiator: initiatorSchema.parse({ kind: options.initiator, identityBasis: options.initiator === "unknown" ? "unknown" : "declared", ...(options.agent ? { label: options.agent } : {}) }), destinations: options.to,
      legacyDefaults: (process.env.ARENA_BLOCK_DEFAULT_CHANNELS ?? "").split(",").filter(Boolean),
      inputDestinationArgs: options.to, sourceRevision: cliBuild.revision ?? undefined, sourceId: cliBuild.sourceId, operation: "publish", credentialProfile: options.profile });
    const directory = await writeSaveIntent(intent, options.outputDir);
    console.log(JSON.stringify({ directory, snapshotSha256: intent.snapshotSha256, routing: intent.snapshot.routing, remoteWriteImplemented: true, remoteQualification: intent.remoteQualification }, null, 2));
  });

program.command("mcp").description("Run the private MCP server over stdio")
  .option("--config <path>", "read a private configuration file")
  .option("--profile <name>", "use this configured account profile")
  .option("--publish", "enable save, status and cancel through the configured daemon")
  .action(async (options: Options) => {
    const config = await loadUserConfig(options.config ?? program.opts().config);
    const daemon = options.publish ? client() : undefined;
    if (daemon) await daemon.assertSaveProfile(config, "mcp-local", options.profile);
    const { runMcpStdio } = await import("./mcp.ts");
    await runMcpStdio(config, { ...(daemon ? { backend: daemon.mcpBackend() } : {}),
      metadataReader: { blockMetadata: (blockUrl, signal) => client().blockMetadata(blockUrl, signal) }, credentialProfile: options.profile });
  });

program.command("save-status").description("Read a retained save by UUID").argument("<save-id>")
  .action(async (id: string) => {
    const daemon = client(), status = await daemon.saveStatus(id);
    const diagnosis = await diagnoseSaveDestinations(daemon, status);
    console.log(JSON.stringify({ ...status, ...(diagnosis ? { diagnosis } : {}) }, null, 2));
  });
program.command("cancel-save").description("Stop active work and retain completed saves").argument("<save-id>")
  .action(async (id: string) => console.log(JSON.stringify(await client().cancelSave(id), null, 2)));
addReceiptOptions(program.command("retry-save").description("Retry a retained save with its original UUID and plan").argument("<save-id>"))
  .action(async (id: string, options: Options) => {
    activeReceiptOptions = options; activeSaveId = id;
    const display = receiptOutputMode(options, Boolean(process.stdout.isTTY));
    const daemon = client(), intent = await daemon.retainedIntent(id);
    const receipt = await publicationWithProgress(daemon, intent.snapshot.plan, intent.snapshot.routing.destinations, signal => daemon.retrySave(id, signal), undefined, id, true, display === "human" ? "stdout" : "none");
    await printReceipt(receipt, options, { saveId: id, defaultChannel: snapshotDefaultChannel(intent.snapshot)?.channel }, daemon);
  });
addReceiptOptions(program.command("replay-save").description("Retry a private save bundle with its original UUID").argument("<bundle-directory>"))
  .option("--config <path>", "read a private configuration file").option("--profile <name>", "use this configured account profile").option("--plan <path>", "supply the original plan if the saved copy was redacted")
  .action(async (directory: string, options: Options) => {
    activeReceiptOptions = options; activeProvenanceDirectory = directory;
    const display = receiptOutputMode(options, Boolean(process.stdout.isTTY));
    const snapshotFile = Bun.file(join(directory, "snapshot.json")), envelopeFile = Bun.file(join(directory, "intent.json"));
    if (snapshotFile.size > 2 * 1024 * 1024 || envelopeFile.size > 2 * 1024 * 1024) throw new Error("Save bundle exceeds its byte bound");
    const snapshot = saveSnapshotSchema.parse(await snapshotFile.json()), envelope = await envelopeFile.json();
    activeSaveId = snapshot.saveId;
    if (snapshot.origin !== "cli") throw new Error("Recover this save through its original MCP client.");
    if (!snapshot.fidelity.originalPlanPreserved && !options.plan) throw new Error("Supply the original --plan to preserve its source fidelity");
    const config = await loadUserConfig(options.config ?? program.opts().config), daemon = client();
    await daemon.assertSaveProfile(config, "cli", options.profile);
    const mode = envelope.remoteMetadata && snapshotDefaultChannel(snapshot)?.included ? envelope.remoteMetadata.ab_snapshot_complete === true ? "full" : "summary" : undefined;
    const originalPlan = options.plan ? await readLocalPlan(options.plan) : snapshot.plan;
    const intent = { snapshot, snapshotSha256: envelope.snapshotSha256, remoteWriteImplemented: true as const, remoteQualification: "existing_account_full_snapshot_fixtures" as const };
    const receipt = await publicationWithProgress(daemon, originalPlan, snapshot.routing.destinations, signal => daemon.publishIntent(originalPlan, intent, mode, signal), undefined, snapshot.saveId, true, display === "human" ? "stdout" : "none");
    await printReceipt(receipt, options, { saveId: snapshot.saveId, provenanceDirectory: directory, defaultChannel: snapshotDefaultChannel(snapshot)?.channel }, daemon);
  });

program.command("thread").description("Write a local x.com or Bluesky conversation draft")
  .argument("<ref>", "direct x.com or Bluesky post URL")
  .requiredOption("--output-dir <path>", "write source records, Markdown and HTML to a new directory")
  .option("--manifest <path>", "read a JSON array of exact x.com post URLs")
  .option("--scope <mode>", "chain (post and ancestors) or tree (Bluesky replies)", "chain")
  .option("--author <handle>", "prioritize this Bluesky author in tree mode; repeatable", (value, values: string[]) => [...values, value], [])
  .option("--select <id>", "include this captured post ID in the draft; repeatable", (value, values: string[]) => [...values, value], [])
  .option("--media <mode>", "none, images, or all; capture.json retains source references", "all")
  .option("--max-posts <number>", "maximum captured posts", "100")
  .option("--max-requests <number>", "maximum public source requests", "20")
  .option("--depth <number>", "requested reply and quote depth", "6")
  .option("--parent-height <number>", "requested ancestor height", "80")
  .option("--descriptions <path>", "read reviewed media descriptions and evidence from JSON")
  .action(async (ref: string, options: {outputDir: string; manifest?: string; scope: string; author: string[]; select: string[]; media: string; maxPosts: string; maxRequests: string; depth: string; parentHeight: string; descriptions?: string}) => {
    if (!["chain", "tree"].includes(options.scope)) throw new Error("--scope must be chain or tree");
    if (!["none", "images", "all"].includes(options.media)) throw new Error("--media must be none, images, or all");
    const xManifest: unknown = options.manifest ? await Bun.file(options.manifest).json() : undefined;
    if (xManifest !== undefined && (!Array.isArray(xManifest) || xManifest.some(value => typeof value !== "string"))) throw new Error("--manifest must contain a JSON array of exact x.com post URLs");
    const descriptions: unknown = options.descriptions ? await Bun.file(options.descriptions).json() : undefined;
    if (descriptions !== undefined && (!descriptions || typeof descriptions !== "object" || Array.isArray(descriptions) || Object.values(descriptions).some((value: any) => !value || typeof value.text !== "string" || !["pixels", "source-alt"].includes(value.basis) || value.evidence !== undefined && typeof value.evidence !== "string" || value.basis === "pixels" && !value.evidence))) throw new Error("Invalid reviewed description mapping");
    const [{ captureThread }, { writeThreadDraft }] = await Promise.all([import("./thread-capture.ts"), import("./thread-draft.ts")]);
    const controller = new AbortController(); const cancel = () => controller.abort(new Error("Draft capture cancelled"));
    process.once("SIGINT", cancel);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
      const capture = await captureThread(ref, {blueskyScope: options.scope as "chain" | "tree", selectedAuthors: options.author,
        maxPosts: Number(options.maxPosts), maxRequests: Number(options.maxRequests), depth: Number(options.depth), parentHeight: Number(options.parentHeight),
        xManifest: xManifest as string[] | undefined, descriptions: descriptions as Record<string, ThreadDescription> | undefined, signal});
      const result = await writeThreadDraft(capture, options.outputDir, {scope: options.scope as "chain" | "tree", media: options.media as "none" | "images" | "all", selectedIds: options.select}, signal);
      console.log(JSON.stringify({directory: result.directory, coverage: capture.coverage, selectedPostIds: result.manifest.selection.selectedIds}, null, 2));
    } finally { process.removeListener("SIGINT", cancel); }
  });

program.command("status").description("Read a publication receipt").argument("<id>").action(async (id: string) => {
  console.log(JSON.stringify(await client().receipt(id), null, 2));
});

program.command("metadata").description("Read block and channel metadata")
  .argument("<block-url>", "Are.na block URL")
  .option("--json", "print exact structured JSON")
  .action(async (blockUrl: string, options: Options) => {
    const result = await client().blockMetadata(blockUrl);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatArenaBlockMetadata(result));
  });

program.command("ratio").description("Report private, closed and public channels and blocks without writes")
  .option("--overlap <rule>", `how a block in several channels counts: ${overlapRules.join(", ")}`, "public")
  .option("--cached", "list channels from the daemon's saved channel index")
  .option("--json", "print exact structured JSON")
  .action(async (options: { overlap: string; cached?: boolean; json?: boolean }) => {
    if (!(overlapRules as readonly string[]).includes(options.overlap)) throw new Error(`--overlap must be one of ${overlapRules.join(", ")}`);
    const daemon = client();
    const index = options.cached ? await daemon.channelIndex() : undefined;
    if (index && !index.completeAt) throw new Error("The daemon's channel index is incomplete; run without --cached to read the account again");
    const source: RatioSource = {
      channels: index ? async () => ({ accountId: index.accountId, channels: index.channels, nextPage: null }) : (page, signal) => daemon.channels(page, signal),
      channelBlocks: (id, page, signal) => daemon.channelBlocks(id, page, signal),
    };
    const progress = process.stderr.isTTY ? (done: number, total: number) => process.stderr.write(`\rReading channels ${done}/${total}`) : undefined;
    const report = await collectRatio(source, { overlap: options.overlap as OverlapRule, progress, listing: index ? `cached ${index.completeAt}` : "live" });
    if (progress) process.stderr.write("\r\x1b[K");
    console.log(options.json ? JSON.stringify(report, null, 2) : formatRatioReport(report));
  });

program.command("inspect").description("Read a save receipt and its source plan")
  .argument("<receipt>").option("--json", "print receipt and plan JSON")
  .action(async (id: string, options: Options) => {
    const daemon = client();
    const receipt = await daemon.receipt(id);
    const plan = await daemon.storedPlan(receipt.planHash);
    console.log(options.json ? JSON.stringify({ receipt, plan }, null, 2) : [
      formatHumanReceipt(receipt, await channelDisplay(daemon, receipt)),
      "", displayPlan(plan),
      "", `After checking placements: arena-block resume ${receipt.id}`,
    ].join("\n"));
  });

addReceiptOptions(program.command("resume").description("Resume a save from its retained plan"))
  .argument("<receipt>")
  .option("--to <channel>", "additional destination (repeatable)", (value, values: string[]) => [...values, value], [])
  .action(async (id: string, options: Options) => {
    activeReceiptOptions = options;
    const display = receiptOutputMode(options, Boolean(process.stdout.isTTY));
    const daemon = client();
    const receipt = await daemon.receipt(id);
    const plan = await daemon.storedPlan(receipt.planHash);
    const destinations = normalizeArenaDestinations([...receipt.destinations, ...(receipt.pendingDestinations ?? []), ...(options.to ?? [])]);
    await printReceipt(await publicationWithProgress(daemon, plan, destinations,
      signal => daemon.resume(id, destinations, signal), id, undefined, false, display === "human" ? "stdout" : "none"), options, {}, daemon);
  });

program.command("attempt").description("Inspect a creation attempt with an uncertain remote outcome")
  .argument("<id>").action(async (id: string) => { console.log(JSON.stringify(await client().attempt(id), null, 2)); });

program.command("picker").description("Open the local channel picker")
  .action(async () => { const { startPicker } = await import("./picker-cli.ts"); await startPicker(); });

program.command("serve").description("Run the HTTP service").action(async () => {
  const { serve } = await import("./service.ts");
  serve();
});

function saveRecovery(error: PublicationError): string | undefined {
  const status = error.saveStatus;
  if (!status || error.destinationUnavailable || status.failure?.code === "retained_recovery") return undefined;
  if (status.failure?.retryable === false) {
    if (status.phase === "not_saved" && !status.active && !status.receipt && !status.attempt
      && status.failure.code === "media_budget" && status.failure.message.startsWith("Mosaic selection is too dense"))
      return `Replan without publishing: arena-block replan-save ${status.saveId} --output <new-plan.json>`;
    return undefined;
  }
  return `Recovery after inspection: arena-block retry-save ${status.saveId}`;
}

function publicationIssue(error: PublicationError): string {
  if (saveRecovery(error)?.startsWith("Replan without publishing:")) {
    // Older daemons suggest image-only local previews for mixed-media failures.
    // Preserve the measured dimensions while showing the supported recovery.
    const detail = /^Mosaic selection is too dense for a legible \d+x\d+ composition\./.exec(error.saveStatus!.failure!.message)?.[0];
    if (detail) return `${detail} Replan from the retained sources before publishing. The original save keeps its layout.`;
  }
  return error.message;
}

function threadExpansionArguments(args: string[]): string[] {
  const normalized: string[] = [];
  const warnings = new Set<string>();
  const commands = new Set(program.commands.flatMap(command => [command.name(), ...command.aliases()]));
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { normalized.push(...args.slice(index)); break; }
    if (arg !== "--thread-expansion" && arg !== "-t" && !arg.startsWith("--thread-expansion=")) {
      normalized.push(arg); continue;
    }
    const attached = arg.startsWith("--thread-expansion=");
    const next = args[index + 1];
    const legacy = attached ? arg.slice("--thread-expansion=".length)
      : arg === "--thread-expansion" && next !== undefined && ["on", "off", "auto"].includes(next) ? next : undefined;
    if (legacy !== undefined) {
      if (legacy === "auto") throw new Error("CLI thread expansion has no auto mode. Omit the flag to keep expansion off, or use -t / --thread-expansion to enable it.");
      if (legacy !== "on" && legacy !== "off") throw new Error("--thread-expansion takes no value. Omit it for off, or use -t / --thread-expansion for on.");
      if (!attached) index++;
      normalized.push(legacy === "on" ? "--thread-expansion" : "--no-thread-expansion");
      warnings.add(legacy === "on"
        ? "Warning: --thread-expansion on is deprecated; use -t or --thread-expansion without a value."
        : "Warning: --thread-expansion off is deprecated; omit the flag to keep expansion off.");
      continue;
    }
    // A URL can immediately follow the boolean flag. Reject old mode-like
    // words here so they never become source references or trigger acquisition.
    if (next && !next.startsWith("-") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(next) && !commands.has(next)) {
      throw new Error(`${arg} takes no value. Omit it for off, or use -t / --thread-expansion for on; CLI auto mode is not supported.`);
    }
    normalized.push(arg);
  }
  for (const warning of warnings) console.error(warning);
  return normalized;
}

configureCliHelp(program);

Promise.resolve().then(() => program.parseAsync(threadExpansionArguments(process.argv.slice(2)), { from: "user" })).catch(async (error) => {
  if (error instanceof PublicationError && error.saveStatus && !error.userInterrupted) {
    const diagnosis = await diagnoseSaveDestinations(client(), error.saveStatus);
    if (diagnosis) { error.message = diagnosis.message; error.destinationUnavailable = true; }
  }
  if (error instanceof PublicationError && error.userInterrupted) {
    console.error(error.message);
    const receipt = error.receipt ?? error.saveStatus?.receipt;
    if (receipt) console.error(`Block retained: ${receipt.blockUrl}\nInspect: arena-block inspect ${receipt.id}`);
    if (error.attempt && !receipt) console.error(`Creation outcome: arena-block attempt ${error.attempt.id}`);
    if (activeSaveId ?? error.saveStatus?.saveId) console.error(`Status: arena-block save-status ${activeSaveId ?? error.saveStatus?.saveId}`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof PublicationError && activeReceiptOptions && receiptOutputMode(activeReceiptOptions, Boolean(process.stdout.isTTY)) === "human") {
    const receipt = error.receipt ?? error.saveStatus?.receipt;
    if (receipt) {
      let display: ChannelDisplay = {};
      try { display = await channelDisplay(client(), receipt); } catch { /* Keep the retained receipt visible offline. */ }
      console.error(formatHumanReceipt(receipt, { forceAttention: true, ...display,
        ...(activeReceiptOptions.verbose ? { verbose: true, saveId: activeSaveId ?? error.saveStatus?.saveId, provenanceDirectory: activeProvenanceDirectory } : {}) }));
      if (!receipt.error) console.error(`Issue: ${error.message}`);
      console.error(`Inspect: arena-block inspect ${receipt.id}`);
    } else if (error.saveStatus) {
      console.error(`Save needs attention\n${publicationIssue(error)}\nStatus: arena-block save-status ${error.saveStatus.saveId}`);
    } else if (error.attempt) {
      console.error(`Creation outcome needs inspection\n${error.message}\nAttempt: arena-block attempt ${error.attempt.id}`);
    } else {
      console.error(`Save needs attention\n${error.message}${activeSaveId ? `\nStatus: arena-block save-status ${activeSaveId}` : ""}`);
    }
    const recovery = saveRecovery(error);
    if (recovery && (activeReceiptOptions.verbose || error.saveStatus?.failure?.retryable === false)) console.error(recovery);
    process.exitCode = 1;
    return;
  }
  console.error(error instanceof PublicationError ? publicationIssue(error) : error instanceof Error ? error.message : String(error));
  if (error instanceof PublicationError) {
    if (error.receipt) console.error(`Block retained: ${error.receipt.blockUrl}\nInspect: arena-block inspect ${error.receipt.id}${error.saveStatus ? "" : `\nResume: arena-block resume ${error.receipt.id}`}`);
    if (error.saveStatus) console.error(`Save UUID: ${error.saveStatus.saveId}\nStatus: arena-block save-status ${error.saveStatus.saveId}${saveRecovery(error) ? `\n${saveRecovery(error)}` : ""}`);
    if (error.attempt) console.error(`${error.attempt.status === "rejected" ? "Creation rejected; correct access before retrying. Audit" : "Creation outcome needs inspection"}: arena-block attempt ${error.attempt.id}\nPlan: ${error.attempt.planHash}`);
  }
  if (!(error instanceof PublicationError) && activeReceiptOptions && receiptOutputMode(activeReceiptOptions, Boolean(process.stdout.isTTY)) === "human" && activeSaveId) {
    console.error(`Status: arena-block save-status ${activeSaveId}`);
    if (activeReceiptOptions.verbose) console.error(`Recovery after inspection: arena-block retry-save ${activeSaveId}${activeProvenanceDirectory ? `\nPrivate save snapshot: ${activeProvenanceDirectory}` : ""}`);
  }
  process.exitCode = 1;
});
