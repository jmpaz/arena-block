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

The browser action opens the capture popup, showing the source preview, the formatted block text and the selected channels. The text preview renders links, emphasis, lists, code and nested quotes from the text prepared for Are.na. Media has its own controls. The preview shows raw HTML as literal text and loads no embedded resources. Edit block holds the title, Markdown text, description and media controls. New starts another draft.

Under **Edit sources**, **Capture options**, **Composition**, the **Quoted authors** setting offers **Link to quoted post** and **Name only**. **Keep current style** leaves it unset, so each site keeps its usual style. The draft remembers the choice. Changing it rebuilds the text from the saved sources and keeps manual edits to the text, title and description. While a save is in progress, the setting stays as approved.

The channel picker keeps the source preview above search and loads additional owned-channel pages as needed. Selected destinations persist through filtering and reopening. During a queued Save, the background worker retains the approved plan, account, channels and UUID while the editor disables changes.

After a returned block ID, the worker checks the block and placements. Open Earlier saves to check an interrupted attempt. A POST without a returned block ID remains uncertain until the account is inspected.

## Authentication and media

With a configured public `ARENA_BLOCK_OAUTH_CLIENT_ID`, the browser uses PKCE for explicit sign-in and stores the resulting token in extension-local storage. Direct saves support ordinary URLs, text and available source artwork. Rendered media uses the optional native host and matching daemon.

The native host reads its configured daemon credential for each message. It returns source, plan, channel or save-status data to the browser. It requires explicit registration and the exact extension allowlist.

For UI checks, use `extension/scripts/receive_picker_fixture.py` with a temporary build and fake account responses. The source fixtures and tests use fictional authors and channels.

`extension/scripts/receive_text_preview_chrome.py` checks the built editor using saved public Note plans and stand-in browser APIs, with HTTP and HTTPS blocked. It runs in an empty temporary profile, installs nothing and saves nothing. It takes the build directory, a JSON array of `{id, plan}` cases and an output directory for screenshots and the report.

`bun extension/scripts/prepare_text_preview_cases.ts /tmp/arena-text-cases.json` prepares the cases offline from the saved public responses for Notes c-347044458 and c-348712218. The check covers how the editor shows text. Media playback and other Substack attachment types need their own checks.

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

Home Manager can deploy each new Nix build into the same real directory. To keep browser sign-in working, set the existing public OAuth client ID:

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

A first install takes a single load of `~/.local/share/arena-block-extension/unpacked-chrome` from Chrome's unpacked extension page, after applying the Home Manager generation with Chrome closed. Later generations replace the files in that directory, and Chrome's Reload button picks them up. While the profile's browser is running, Home Manager defers the replacement. Applying the generation again, or running `arena-block-extension-update deploy`, finishes it once Chrome has closed. Replacing the files leaves Chrome on the old worker until it reloads.

`chrome.directory`, set to the absolute real path of an existing unpacked registration, together with `chrome.adoptExisting`, keeps that registration. Before adopting the directory, the updater checks Chrome's registration, the public key, the manifest settings and the OAuth client ID. A registration inside `/nix/store` needs a single move through Chrome, since store files are read-only. `chrome.prepareForMigration` fills the stable directory while keeping the old registration, and the deployment status shows the registration as pending until Chrome points at the new directory. Chrome may resolve a symlinked directory to a single store generation when registering it, so the registration needs a real directory.

`arena-block-extension-update status` compares the selected package, the deployed files and the registered path. It can't see whether Chrome loaded the update. `arena-block-extension-update rollback` restores the previous directory while Chrome is closed. Browser profile data stays in Chrome's profile.

The package also exposes `browser-extension.withBrowserConfig { chromePublicKey = "..."; oauthClientId = "..."; substackTabReading = true; }` and `extension-manager`. The manager takes `status`, `deploy` or `rollback`, with `--package`, `--directory`, `--profile` and `--extension-id`. Each Nix build's `release.json` records its source revision and whether it includes Substack tab reading.

`programs.arenaBlockExtension.substackTabReading = false` builds without the optional `scripting` permission. The editor then shows Substack tab reading as unavailable, disables its button and fetches Substack URLs the usual way, without asking for scripting access. The default is `true`. Tab reading then uses an existing scripting grant and the tab the extension opened on. Direct Bun builds read `ARENA_BLOCK_SUBSTACK_TAB_READING=false`. The setting changes the manifest, and the deployment tool rejects an update whose manifest differs from the existing install.

### Capture access

**Allow capture access**, under **Capture access**, requests the optional APIs and source sites in one prompt, straight from that click. Opening the editor, previewing a source and choosing channels only check existing grants. A declined prompt leaves existing grants in place. The editor reports partial access, or a failed permission check, and leaves the prompt for the next click. After a request, it reads back each grant. Chrome decides which prompts to show.

The package requires `activeTab`, `storage` and `identity`, and lists `nativeMessaging` and `scripting` as optional. `activeTab` gives access to the page the extension opened on, and `scripting` can read that page once granted. Persistent site access lets the extension read and change pages on those sites, including signed-in content. The Substack reader reads only the active Note. Through the configured receiver, the local helper can prepare blocks, list channels, and save, retry or cancel saves. Its extension allowlist and receiver credentials are separate from Chrome's grants.

A fixed list of sources limits access on both platforms:

```nix
programs.arenaBlockExtension = {
  permissionProfile = "named-sources";
  substackTabReading = true;
  mastodonOrigins = [ "https://mastodon.social" ];
};
```

The named profile lists the twelve source API patterns in [permission-policy.ts](permission-policy.ts), with no catch-all HTTPS pattern. Setup asks for a Mastodon instance only when the current capture uses it. An instance missing from the list needs a rebuild or the local helper, because Chrome can grant only origins listed in the manifest. Substack URLs and plain link captures add no site grants. The list covers the first request to each source. Redirects and media downloads can reach other hosts, so check those separately.

The default `legacy` profile keeps the existing optional HTTPS permission so updates stay compatible. Its setup still asks only for the named sources and the Mastodon instances in use. Direct builds read `ARENA_BLOCK_PERMISSION_PROFILE=named-sources` and `ARENA_BLOCK_MASTODON_ORIGINS='["https://mastodon.social"]'`. Nix builds the same profile on macOS and Linux and records it in `release.json`. Chrome handles consent. A changed profile changes the manifest too. The updater leaves permissions and Chrome's stored registration untouched.

Before replacing files, the updater checks the profile lock and, for the default Chrome data directory, the main Chrome processes. Any other Chrome process blocks an update to the default profile. A custom data directory uses its own lock. If the process check fails, the updater stops. The last check runs just before swapping directories, including during recovery from a failed receipt write. Chrome could still start after that check, so the update relies on Chrome staying closed throughout.

Chrome's [external installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) vary by platform. On macOS, Chrome accepts external update entries only for Chrome Web Store items. On Linux it also accepts local CRX files and self-hosted updates. Home Manager's [Chromium module](https://github.com/nix-community/home-manager/blob/master/modules/programs/chromium.nix) follows those rules, and Chrome on Linux reads external entries from system-managed directories. The unpacked setup above uses the existing development identity. A CRX with that identity would need its private signing key. Store publication and enterprise policy installs take separate setup.

## Saved Reddit records

Ordinary Reddit URLs go through the shared HTTP provider, and capture stops if Reddit refuses the read. See [source access](../docs/reddit-source-access.md).

**Import saved record** opens an existing record, and **Export saved record** writes a copy. Reloading a draft keeps its fetch time, source fields and manual edits. Validation checks the data in a record. It can't verify where or when the record came from.

The helper sends native messages of up to 1 MiB, [Chrome's transport limit](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). A record under the 2 MiB import limit can still produce a larger plan. The helper then reports the limit. The draft and export stay available, and the CLI and iOS app can open the record. Incoming messages to the helper can be up to 4 MiB. These transport limits sit apart from record validation and receiver support.
