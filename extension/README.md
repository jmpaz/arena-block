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

## Reddit browser records

Open a public Reddit post or selected comment, invoke the extension, choose **Read Reddit tab**. The optional scripting request runs the reader in that tab, using the existing page session. Refusal or challenge HTML stops the read. No cookies, authorization headers, saved/vote state or reports enter the exported record.

Use **Export browser capture** to move the sanitized JSON to `arena-block --reddit-capture <path>` or native Capture's **Import browser capture**. Importing a record for another source requires a new capture with empty source links. The editor retains observation time, source records and authored edits through draft reloads; the immutable plan carries the same record into publication.

Imported observations are declarations. Validation and plan hashes do not authenticate Reddit, community visibility or capture time. The file can be edited; use a record from a source you trust. Attachment acquisition accepts matching Reddit image origins and native Reddit video paths.

The helper returns at most 1 MiB per native-message response, following [Chrome's transport limit](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). A record below the 2 MiB import limit may produce a larger plan. The helper reports this limit explicitly; the retained browser draft and export remain available, and the CLI or native app can open the record. The helper bounds incoming messages at 4 MiB. These transport limits are separate from record validation and receiver compatibility.
