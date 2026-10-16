export const CAPTURE_ORIGINS = [
  "https://api.are.na/*",
  "https://api.fxtwitter.com/*",
  "https://public.api.bsky.app/*",
  "https://api.delve.town/*",
  "https://www.reddit.com/*",
  "https://arctic-shift.photon-reddit.com/*",
  "https://www.lesswrong.com/*",
  "https://www.alignmentforum.org/*",
  "https://forum.effectivealtruism.org/*",
  "https://api.atmosphere.tools/*",
  "https://hacker-news.firebaseio.com/*",
  "https://lobste.rs/*",
  "https://soundcloud.com/*",
] as const;

export type PermissionProfile = "legacy" | "named-sources";
export type PermissionManifest = {
  permissions?: string[]; optional_permissions?: string[];
  host_permissions?: string[]; optional_host_permissions?: string[];
};
export type PermissionRequest = { permissions?: string[]; origins?: string[] };

export function mastodonPattern(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.origin !== origin || !/^[a-z0-9.-]+$/.test(url.hostname) ||
      !url.hostname.includes(".") || url.hostname.includes("*") || url.hostname.endsWith("."))
    throw new Error("Mastodon origins must be exact HTTPS origins without paths, ports or wildcards.");
  return `${url.origin}/*`;
}

export function permissionManifest(profile: string, tabReading: boolean, mastodonOrigins: string[]) {
  if (profile !== "legacy" && profile !== "named-sources")
    throw new Error("Permission profile must be legacy or named-sources.");
  const mastodon = [...new Set(mastodonOrigins.map(mastodonPattern))].sort();
  return {
    permissions: ["activeTab", "storage", "identity"],
    optional_permissions: ["nativeMessaging", ...(tabReading ? ["scripting"] : [])],
    optional_host_permissions: profile === "legacy" ? ["https://*/*"] : [...CAPTURE_ORIGINS, ...mastodon],
  };
}

export function captureAccessScope(manifest: PermissionManifest, selectedMastodonOrigins: string[] = []) {
  const declared = [...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])];
  const invalid: string[] = [];
  const selected = selectedMastodonOrigins.flatMap(origin => {
    try { return [mastodonPattern(origin)]; }
    catch { invalid.push(`${origin}/*`); return []; }
  });
  const requested = [...new Set([...CAPTURE_ORIGINS, ...selected])];
  const supported = (origin: string) => declared.includes(origin) || declared.includes("https://*/*");
  return {
    request: {
      permissions: ["nativeMessaging", "scripting"].filter(name => manifest.optional_permissions?.includes(name)),
      origins: requested.filter(supported),
    } satisfies PermissionRequest,
    unavailableOrigins: [...requested.filter(origin => !supported(origin)), ...invalid],
  };
}
