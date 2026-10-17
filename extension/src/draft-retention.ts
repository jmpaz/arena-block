import { parseSource } from "../../packages/core/url.ts";

function sourceIdentity(value: string): string {
  try { return parseSource(value).canonicalUrl; } catch { return value.trim(); }
}
export function containsDraftSource(primary: string | undefined, source: string): boolean {
  return Boolean(primary?.split(/\r?\n/).some(value => sourceIdentity(value) === sourceIdentity(source)));
}
export function shouldReplaceAutomaticDraft(saved: { primary?: string; manualContentEdit?: boolean; redditCaptures?: unknown[]; substackCaptures?: unknown[] },
                                           source: string | null, unconfirmed: boolean): boolean {
  return Boolean(source && !containsDraftSource(saved.primary, source) && !saved.manualContentEdit
    && !saved.redditCaptures?.length && !saved.substackCaptures?.length && !unconfirmed);
}
