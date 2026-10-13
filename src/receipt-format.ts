import type { PublicationReceipt } from "./types.ts";

export type ReceiptDisplayOptions = { json?: boolean; human?: boolean; verbose?: boolean };

export function receiptOutputMode(options: ReceiptDisplayOptions, stdoutIsTTY: boolean): "json" | "human" {
  if (options.json && options.human) throw new Error("Choose either --json or --human");
  return options.json || !options.human && !stdoutIsTTY ? "json" : "human";
}

export function formatHumanReceipt(receipt: PublicationReceipt, options: { verbose?: boolean; saveId?: string; provenanceDirectory?: string; channelNames?: Record<string, string>; channelIds?: Record<string, number>; channelSlugs?: Record<string, string>; defaultChannel?: string; forceAttention?: boolean } = {}): string {
  const defaultChannel = options.defaultChannel ?? (receipt.remoteProvenance ? String(receipt.remoteProvenance.inboxChannelId) : undefined);
  const identity = (ref: string): string => {
    const resolved = options.channelIds?.[ref] ?? (/^[1-9]\d*$/.test(ref) ? Number(ref) : undefined);
    return resolved && Number.isSafeInteger(resolved) ? `id:${resolved}` : `ref:${ref}`;
  };
  const unique = (refs: string[]): string[] => {
    const seen = new Set<string>();
    return refs.filter(ref => { const key = identity(ref); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  const requested = unique([...receipt.destinations, ...(receipt.pendingDestinations ?? [])]);
  const title = (ref: string): string => options.channelNames?.[ref] ?? (/^\d+$/.test(ref) ? ref === defaultChannel ? "Default channel" : "Channel name unavailable" : ref);
  const names = new Map<string, Set<string>>();
  for (const ref of requested) {
    const name = title(ref);
    const ids = names.get(name) ?? new Set<string>(); ids.add(identity(ref)); names.set(name, ids);
  }
  const clean = (raw: string): string => Array.from(raw.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim()).slice(0, 80).join("") || "Channel name unavailable";
  const label = (ref: string): string => {
    const name = title(ref);
    if ((names.get(name)?.size ?? 0) < 2) return clean(name);
    const slug = options.channelSlugs?.[ref] ?? ref;
    const sameSlug = requested.filter(other => title(other) === name && (options.channelSlugs?.[other] ?? other) === slug);
    return `${clean(name)} (${clean(slug)}${sameSlug.some(other => identity(other) !== identity(ref)) ? `, ${clean(ref)}` : ""})`;
  };
  const defaultIdentity = defaultChannel && identity(defaultChannel);
  const defaultRef = defaultIdentity && receipt.destinations.find(ref => identity(ref) === defaultIdentity);
  const primary = unique(receipt.destinations.filter(ref => identity(ref) !== defaultIdentity));
  const pending = unique(receipt.pendingDestinations ?? []);
  const complete = !options.forceAttention && receipt.status === "verified" && !receipt.stage && !receipt.error && !pending.length
    && (!receipt.remoteProvenance || receipt.remoteProvenance.state === "verified");
  const ordered = unique([...primary, ...(defaultRef ? [defaultRef] : [])]);
  const lines = [
    complete ? `Saved to ${receipt.blockUrl}` : `Save needs attention: ${receipt.blockUrl}`,
    complete ? "Channels:" : "Requested channels:",
    ...(ordered.length ? ordered.map(ref => `  ${label(ref)}${defaultRef === ref && primary.length ? " (default)" : ""}`) : ["  (none yet)"]),
  ];
  if (pending.length) lines.push("Placement check:", ...pending.map(ref => `  ${label(ref)}`));
  if (receipt.mediaArtifact) lines.push(`Media: ${receipt.mediaArtifact.url}`);
  if (receipt.error) lines.push(`Issue: ${receipt.error}`);
  if (options.verbose) lines.push(
    "",
    `Receipt ID: ${receipt.id}`,
    ...(options.saveId ? [`Save UUID: ${options.saveId}`] : []),
    `Block ID: ${receipt.blockId}`,
    `Connection IDs: ${receipt.connectionIds.join(", ") || "none"}`,
    `Plan hash: ${receipt.planHash}`,
    `Created: ${receipt.createdAt}`,
    ...(options.provenanceDirectory ? [`Private save snapshot: ${options.provenanceDirectory}`] : []),
  );
  return lines.join("\n");
}
