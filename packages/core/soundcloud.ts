import type { CompositionPolicy, MediaAsset, ResolvedPost, SoundCloudMetadata } from "./types.ts";

export function isSoundCloudAudio(asset: MediaAsset): boolean {
  return asset.kind === "audio" && ["soundcloud-original-download", "soundcloud-mp3"].includes(asset.acquisition ?? "");
}

export function assertSoundCloudAudioIntent(post: ResolvedPost, policy: Pick<CompositionPolicy, "media">): void {
  if (post.provider !== "soundcloud" || post.soundcloud?.kind !== "track" || !["all", "audio"].includes(policy.media)) return;
  if (post.media.some(isSoundCloudAudio)) return;
  throw new Error("No supported full SoundCloud audio is available to this client. Choose a source link or prepare a new audio plan. No audio block was created.");
}

function duration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}
function markdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

export function soundCloudTrackText(metadata: Extract<SoundCloudMetadata, { kind: "track" }>, description: string): string {
  const lines = [metadata.artists.length ? `Artist${metadata.artists.length === 1 ? "" : "s"}: ${metadata.artists.join(", ")}` : "",
    metadata.durationSeconds === undefined ? "" : `Duration: ${duration(metadata.durationSeconds)}`,
    description];
  return lines.filter(Boolean).join("\n\n");
}

export function soundCloudPlaylistText(metadata: Extract<SoundCloudMetadata, { kind: "playlist" }>, description: string, includeArtwork = true): string {
  const tracks = metadata.tracks.map((track, index) => {
    const credits = track.artists.length ? ` — ${track.artists.join(", ")}` : "";
    const trackDuration = duration(track.durationSeconds);
    const suffix = trackDuration ? ` (${trackDuration})` : "";
    return `${index + 1}. [${markdownLabel(track.title)}${markdownLabel(credits)}](${track.url})${suffix}`;
  }).join("\n");
  // Are.na Text content preserves image Markdown literally in content_html.
  // Keep artwork reachable without implying an inline image will render.
  const artwork = includeArtwork && metadata.artworkUrl ? `[Playlist artwork](${metadata.artworkUrl})` : "";
  return [artwork, description, tracks].filter(line => line.length > 0).join("\n\n");
}
