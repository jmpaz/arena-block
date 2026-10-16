# Arena Block browser extension

Build the temporary extensions with Bun:

```sh
bun install --frozen-lockfile
bun run extension:typecheck
bun run extension:build
bun run extension:dev
```

The build writes Manifest V3 files to `extension/dist/chrome` and `extension/dist/firefox`. The development command rebuilds after editor, background or shared-core changes. Reload the temporary extension after each build.

Both builds generate PNG icons from [the shared SVG](../assets/mark.svg). The black mark sits on a white backing with rounded corners so it stays visible on light and dark toolbars. The manifests use the same static images for both themes.

In Chrome, open `chrome://extensions`, enable Developer mode and load `extension/dist/chrome`. In Firefox, open `about:debugging`, choose This Firefox and load the Firefox manifest as a temporary add-on.

## Editing and saving

The browser action opens the capture popup. It displays the source preview and selected destinations. Edit block provides title, text, description and media controls. Edit sources provides URLs and capture options. New starts another draft.

The channel picker keeps the source preview above search and loads additional owned-channel pages as needed. Selected destinations persist through filtering and reopening. During a queued Save, the background worker retains the approved plan, account, channels and UUID while the editor disables changes.

After a returned block ID, the worker checks the block and placements. Open Earlier saves to check an interrupted attempt. A POST without a returned block ID remains uncertain until the account is inspected.

## Authentication and media

With a configured public `ARENA_BLOCK_OAUTH_CLIENT_ID`, the browser uses PKCE for explicit sign-in and stores the resulting token in extension-local storage. Direct saves support ordinary URLs, text and available source artwork. Rendered media uses the optional native host and matching daemon.

The native host reads its configured daemon credential for each message. It returns source, plan, channel or save-status data to the browser. It requires explicit registration and the exact extension allowlist.

For UI checks, use `extension/scripts/receive_picker_fixture.py` with a temporary build and fake account responses. The source fixtures and tests use fictional authors and channels.

## Nix and Chrome identity

`packages.browser-extension` builds browser files. `homeManagerModules.browser-extension` provides the optional installation/native-host module. Import `lib.chromeDevelopmentIdentity` to use the checked-in public SPKI:

```nix
{ inputs, ... }:
let chromeDev = inputs."arena-block".lib.chromeDevelopmentIdentity;
in {
  imports = [ inputs."arena-block".homeManagerModules.browser-extension ];
  programs.arenaBlockExtension = {
    enable = true;
    chromePublicKey = chromeDev.publicKey;
    nativeHost = { enable = false; chromeId = chromeDev.chromeId; };
  };
}
```

The public key determines the unpacked Chrome ID `fijpffccadekllfkkfelnknanpljbobb`. Native-host registration must use the ID displayed by the installed extension. Firefox uses its declared add-on ID.

The public key is recorded in `nix/chrome-development-identity.nix`. The project contains no private signing key. Native-host registration and runtime credentials are configured by the caller.

### Updating unpacked Chrome files through Home Manager

Home Manager can deploy successive Nix builds to a stable real directory. Set the existing public OAuth client ID when retaining browser sign-in:

```nix
programs.arenaBlockExtension = {
  enable = true;
  chromePublicKey = chromeDev.publicKey;
  oauthClientId = "existing-public-client-id";
  chrome = {
    enable = true;
    extensionId = chromeDev.chromeId;
  };
};
```

For a first installation, close Chrome normally, apply the Home Manager generation, then load `~/.local/share/arena-block-extension/unpacked-chrome` once through Chrome's unpacked-extension interface. Future generations replace the files at that directory. Use Chrome's Reload action after an update. Home Manager defers replacement while that profile's browser is running. After closing Chrome, apply the generation again or run `arena-block-extension-update deploy`. Updating the files does not confirm that Chrome has loaded the new worker.

To retain an existing unpacked registration, set `chrome.directory` to its current absolute real directory and enable `chrome.adoptExisting`. The updater checks Chrome's existing registration, the public key, manifest settings and public OAuth bytes before adopting the directory. A registration inside `/nix/store` needs a one-time move through Chrome's interface because Nix store files are immutable. Set `chrome.prepareForMigration` to prepare the stable directory while retaining that registration, then select the prepared directory once in Chrome. The deployment status reports the pending registration. A directory symlink may resolve to a particular store generation when Chrome registers it; use a real directory for the registration.

Run `arena-block-extension-update status` to compare the selected package, deployed files and registered path. The command reports runtime loading as unverified. Check the running extension separately before treating an update as received. `arena-block-extension-update rollback` restores the previous directory while Chrome is closed. Browser profile storage remains in Chrome's profile.

The package also exposes `browser-extension.withBrowserConfig { chromePublicKey = "..."; oauthClientId = "..."; substackTabReading = true; }` and `extension-manager`. The manager accepts `status`, `deploy` or `rollback`, with `--package`, `--directory`, `--profile` and `--extension-id` arguments. `release.json` records each Nix build's source identity and whether Substack tab reading is included.

Set `programs.arenaBlockExtension.substackTabReading = false` to build without the optional `scripting` declaration. The editor marks Substack tab reading unavailable, keeps its button disabled, and uses ordinary public URL acquisition. It does not request a scripting grant. The default remains `true`; tab reading then uses an existing scripting grant and the user-invoked active tab. For a direct Bun build, set `ARENA_BLOCK_SUBSTACK_TAB_READING=false`. This setting changes the manifest, so choose the variant matching the existing installation before updating; the deployment tool still rejects manifest differences.

### Capture access

Open **Capture access** and choose **Allow capture access** to request the optional APIs and source sites together. The request runs directly from that click. Opening the editor, previewing a source and choosing channels only check existing grants. Declining leaves existing grants in place; the editor reports partial access or an unavailable permission check without retrying the prompt. A completed request is followed by a readback of each grant. Chrome controls which confirmation prompts appear.

The package declares `activeTab`, `storage` and `identity` as required APIs, and `nativeMessaging` and `scripting` as optional APIs. `activeTab` supplies access to the invoked page; scripting can read that page when separately granted. Persistent site access permits reading and modifying pages on those sites, including signed-in content. The current Substack reader only reads the matching active Note. The local helper can prepare blocks, inspect channels and save, retry or cancel saves through the configured receiver. Its registered extension allowlist and receiver credentials remain separate from the browser grant.

Use a finite source declaration on both platforms with:

```nix
programs.arenaBlockExtension = {
  permissionProfile = "named-sources";
  substackTabReading = true;
  mastodonOrigins = [ "https://mastodon.social" ];
};
```

The named profile lists the thirteen source API patterns in [permission-policy.ts](permission-policy.ts). It contains no unrestricted HTTPS pattern. Setup requests a configured Mastodon instance only when it appears in the current capture. An unlisted instance requires a package rebuild or the local helper; Chrome cannot grant an origin absent from the manifest. Substack public URLs and generic link captures do not add site grants. Redirects and media delivery may involve other hosts; this list describes browser source preflight, not universal browser acquisition.

The default `legacy` profile preserves the existing optional HTTPS declaration for compatible updates. Its setup action still requests only named source sites and selected Mastodon instances. For direct builds, use `ARENA_BLOCK_PERMISSION_PROFILE=named-sources` and `ARENA_BLOCK_MASTODON_ORIGINS='["https://mastodon.social"]'`. Nix builds the same permission profile on macOS and Linux and records it in `release.json`; Chrome handles consent. Changing the profile still requires separate manifest review. The updater does not grant permissions or modify Chrome's stored registration.

The updater checks the profile lock and, for the normal Chrome user-data directory, main Chrome processes before replacement. A separate Chrome process conservatively blocks a normal-profile update. Custom user-data directories use their own lock. Process-query errors stop replacement. The final check runs immediately before directory exchange, including recovery after a failed receipt write. These checks cannot prevent a new process starting after the check; keep Chrome closed throughout the update and verify the running extension after reopening it.

Chrome's [external installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) differ by platform. macOS Chrome accepts external update declarations for Chrome Web Store items. Linux also accepts local CRX packages and self-hosted updates. Home Manager's [Chromium module](https://github.com/nix-community/home-manager/blob/master/modules/programs/chromium.nix) follows those restrictions; proprietary Chrome on Linux reads external declarations from system-managed directories. The unpacked workflow above uses the existing development identity. Producing a CRX with that identity would require its private signing key. Browser-store publication and enterprise management require separate setup.

## Retained Reddit records

Ordinary Reddit URLs use the shared HTTP provider. A denied read stops capture. Safari Share supplies the page URL. See [source access](../docs/reddit-source-access.md) for current limits.

Open **Import saved record** to use an existing record, or **Export saved record** to keep a copy. Draft reloads retain its observation time, source fields and authored edits. Validation checks the supplied data; it cannot authenticate its origin or observation time.

The helper returns at most 1 MiB per native-message response, following [Chrome's transport limit](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). A record below the 2 MiB import limit may produce a larger plan. The helper reports this limit explicitly; the retained browser draft and export remain available, and the CLI or native app can open the record. The helper bounds incoming messages at 4 MiB. These transport limits are separate from record validation and receiver compatibility.
