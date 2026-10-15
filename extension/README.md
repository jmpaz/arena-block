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

After a returned block ID, the worker checks the block and placements. Earlier saves retains interrupted attempts for status checks. A POST without a returned block ID remains uncertain until the account is inspected.

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

## Retained Reddit records

Ordinary Reddit URLs use the shared direct HTTP provider. A denied read does not offer a browser-session reader or manual capture workaround. The former **Read Reddit tab** action and bot-facing gallery origin have been removed. Safari Share passes the URL to native Capture without a Reddit page read. See [source access](../docs/reddit-source-access.md) for the current receiving limit.

Previously saved records remain readable through **Import saved record** and **Export saved record**, retaining observation time, source evidence and authored edits through draft reloads. This compatibility is for existing records, not a replacement for unavailable normal URL acquisition. Imported observations are declarations; validation and plan hashes do not authenticate Reddit, community visibility or capture time.

The helper returns at most 1 MiB per native-message response, following [Chrome's transport limit](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). A record below the 2 MiB import limit may produce a larger plan. The helper reports this limit explicitly; the retained browser draft and export remain available, and the CLI or native app can open the record. The helper bounds incoming messages at 4 MiB. These transport limits are separate from record validation and receiver compatibility.
