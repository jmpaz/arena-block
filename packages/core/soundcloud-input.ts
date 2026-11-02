import { planHash } from "./compose.ts";
import { isSoundCloudAudio } from "./soundcloud.ts";
import { parseSource, soundCloudShareURL } from "./url.ts";
import type { BlockPlan, CompositionPolicy } from "./types.ts";

/** Fresh audio intent must survive helpers which can return an older URL fallback. */
export function requireSoundCloudAudioResult(input: { refs: string[]; extraRefs?: string[]; policy?: Partial<CompositionPolicy> }, plan: BlockPlan): void {
  if (!["all", "audio"].includes(input.policy?.media ?? "auto")) return;
  let track: string | undefined, share = false;
  for (const ref of [...input.refs, ...(input.extraRefs ?? [])]) {
    if (soundCloudShareURL(ref)) { share = true; continue; }
    try {
      const parsed = parseSource(ref);
      if (parsed.provider === "soundcloud" && parsed.kind === "track") track = parsed.canonicalUrl;
    } catch { /* Other provider validation belongs to the source resolver. */ }
  }
  if (!track && !share) return;
  const incomplete = () => new Error("The helper did not retain the requested SoundCloud audio. Update the helper and receiver; no save was submitted.");
  const source = plan.sources[0], metadata = source?.soundcloud;
  const { hash, ...content } = plan;
  if (input.refs.length !== 1 || input.extraRefs?.length || plan.sources.length !== 1 || source?.provider !== "soundcloud"
    || !metadata || planHash(content) !== hash || plan.block.canonicalSource !== source.canonicalUrl
    || track && source.canonicalUrl !== track) throw incomplete();
  try {
    const identity = parseSource(source.canonicalUrl);
    if (identity.provider !== "soundcloud" || identity.kind !== metadata.kind) throw incomplete();
  } catch { throw incomplete(); }
  if (!track && metadata.kind === "playlist") return;
  const selected = source.media.filter(asset => plan.block.selectedMedia.includes(asset.ref));
  if (metadata.kind !== "track" || plan.block.kind !== "audio" || plan.block.selectedMedia.length !== 1 || selected.length !== 1
    || !isSoundCloudAudio(selected[0]!) || selected[0]!.url !== source.canonicalUrl
    || selected[0]!.acquisition === "soundcloud-original-download" && !metadata.originalDownloadAvailable) throw incomplete();
}
