import { captureAccessScope, type PermissionManifest, type PermissionRequest } from "../permission-policy.ts";

export type PermissionAPI = {
  contains(request: PermissionRequest): Promise<boolean>;
  request(request: PermissionRequest): Promise<boolean>;
};
export type AccessState = {
  phase: "checking" | "requesting" | "enabled" | "partial" | "missing" | "declined" | "unknown";
  scope: ReturnType<typeof captureAccessScope>;
  granted: string[]; missing: string[]; unknown: string[];
  requestError?: boolean;
};

// Construction and refresh only read permissions. requestFromClick must be called
// directly by a click handler: dispatch the browser request before any await.
export class CaptureAccess {
  state?: AccessState;
  private ticket = 0;
  private inFlight = false;
  constructor(private api: PermissionAPI, private manifest: PermissionManifest,
    private selectedMastodonOrigins: () => string[], private render: (state: AccessState) => void) {}

  async refresh(outcome?: "declined" | "error"): Promise<void> {
    if (this.inFlight) return;
    const ticket = ++this.ticket;
    const scope = captureAccessScope(this.manifest, this.selectedMastodonOrigins());
    const state: AccessState = { phase: "checking", scope, granted: [], missing: [], unknown: [],
      ...(outcome === "error" ? { requestError: true } : {}) };
    this.render(state);
    const checks = [
      ...(scope.request.permissions ?? []).map(name => ({ label: name, query: { permissions: [name] } })),
      ...(scope.request.origins ?? []).map(name => ({ label: name, query: { origins: [name] } })),
    ];
    const results = await Promise.allSettled(checks.map(check => this.api.contains(check.query)));
    if (ticket !== this.ticket) return;
    results.forEach((result, index) => {
      state[result.status === "rejected" ? "unknown" : result.value ? "granted" : "missing"].push(checks[index]!.label);
    });
    state.phase = state.unknown.length ? "unknown" : state.missing.length
      ? state.granted.length ? "partial" : outcome === "declined" ? "declined" : outcome === "error" ? "unknown" : "missing"
      : "enabled";
    this.state = state;
    this.render(state);
  }

  requestFromClick(): Promise<void> {
    if (this.inFlight) return Promise.resolve();
    const scope = captureAccessScope(this.manifest, this.selectedMastodonOrigins());
    if (this.state?.phase === "enabled" && JSON.stringify(this.state.scope) === JSON.stringify(scope))
      return this.refresh();
    this.inFlight = true;
    ++this.ticket; // Discard a read started before this explicit request.
    this.render({ phase: "requesting", scope, granted: [], missing: [], unknown: [] });
    let request: Promise<boolean>;
    try { request = this.api.request(scope.request); }
    catch { request = Promise.reject(new Error("Permission request unavailable")); }
    return Promise.resolve(request).then(granted => granted ? undefined : "declined" as const,
      () => "error" as const).then(outcome => {
      this.inFlight = false;
      return this.refresh(outcome);
    });
  }
}

export function renderCaptureAccess(state: AccessState, button: HTMLButtonElement, status: HTMLElement,
  scope: HTMLElement, unavailable: HTMLElement): void {
  const messages: Record<AccessState["phase"], string> = {
    checking: "Checking access…", requesting: "Waiting for the browser…",
    enabled: "Capture access is enabled.", partial: "Some capture access is enabled. Review the remaining access when you need it.",
    missing: "Allow access to enable source reading and the local helper.",
    declined: "Access was not granted. You can review it here later.",
    unknown: "Could not verify capture access. Review it here when the browser is available.",
  };
  status.textContent = messages[state.phase] + (state.requestError && state.phase !== "unknown" ? " The browser could not complete the request." : "");
  button.disabled = ["checking", "requesting", "enabled"].includes(state.phase);
  button.textContent = state.phase === "enabled" ? "Access enabled" : state.phase === "missing" ? "Allow capture access" : "Review capture access";
  scope.textContent = (state.scope.request.origins ?? []).join("\n");
  unavailable.hidden = !state.scope.unavailableOrigins.length;
  unavailable.textContent = state.scope.unavailableOrigins.length
    ? `This package does not include: ${state.scope.unavailableOrigins.join(", ")}. Use the local helper or add the instance to the package configuration.` : "";
}
