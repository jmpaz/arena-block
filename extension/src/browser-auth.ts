import type { BrowserCredentialProvider } from "./browser-save.ts";

type Storage = { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> };
type Identity = { getRedirectURL(): string; launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string | undefined> };
const tokenKey = "arena-block-oauth-v1";

function randomUrlSafe(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Public-client PKCE. Tokens live only in this user's browser profile. */
export class BrowserOAuth implements BrowserCredentialProvider {
  constructor(readonly clientId: string, private readonly identity: Identity, private readonly storage: Storage,
    private readonly fetcher: typeof fetch = ((input, init) => globalThis.fetch(input, init)) as typeof fetch) {}

  async token(): Promise<string> {
    const entry = (await this.storage.get(tokenKey))[tokenKey] as { accessToken?: string; expiresAt?: number } | undefined;
    if (!entry?.accessToken || (entry.expiresAt && Date.now() >= entry.expiresAt)) {
      throw new Error("Connect your Are.na account to save from this browser.");
    }
    return entry.accessToken;
  }

  async signIn(): Promise<void> {
    if (!this.clientId) throw new Error("Browser sign-in needs a registered Are.na application.");
    const verifier = randomUrlSafe(48);
    const state = randomUrlSafe(24);
    const redirect = this.identity.getRedirectURL();
    const url = new URL("https://www.are.na/oauth/authorize");
    for (const [key, value] of Object.entries({ client_id: this.clientId, redirect_uri: redirect,
      response_type: "code", scope: "write", state, code_challenge: await challenge(verifier), code_challenge_method: "S256" })) {
      url.searchParams.set(key, value);
    }
    const returned = await this.identity.launchWebAuthFlow({ url: url.href, interactive: true });
    if (!returned || new URL(returned).origin !== new URL(redirect).origin || !returned.startsWith(redirect)) {
      throw new Error("Are.na sign-in did not return to this extension.");
    }
    const params = new URL(returned).searchParams;
    if (params.get("state") !== state || !params.get("code")) throw new Error("Are.na sign-in response could not be verified.");
    const response = await this.fetcher("https://api.are.na/v3/oauth/token", {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: this.clientId,
        redirect_uri: redirect, code: params.get("code")!, code_verifier: verifier }),
    });
    if (!response.ok) throw new Error(`Are.na sign-in returned ${response.status}`);
    const result = await response.json() as { access_token?: unknown; expires_in?: unknown; scope?: unknown };
    if (typeof result.access_token !== "string" || !result.access_token) throw new Error("Are.na sign-in returned no access token.");
    if (typeof result.scope === "string" && !result.scope.split(/\s+/).includes("write")) throw new Error("Are.na did not grant write access.");
    const lifetime = typeof result.expires_in === "number" && result.expires_in > 0 ? result.expires_in : undefined;
    await this.storage.set({ [tokenKey]: { accessToken: result.access_token,
      ...(lifetime ? { expiresAt: Date.now() + Math.max(0, lifetime - 60) * 1000 } : {}) } });
  }

  async signOut(): Promise<void> { await this.storage.remove(tokenKey); }
}
