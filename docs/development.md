# Development

## Source layout

| Location | Development task |
|---|---|
| `packages/core` | Resolve sources, compose writing/media and calculate plans |
| `src` | Run the CLI, HTTP service, Are.na client and save journal |
| `extension/src` | Edit browser drafts, channels, authentication and save state |
| `ios/Sources/CaptureCore` | Persist native drafts/history and represent delivery state |
| `ios/Sources/CaptureRuntime` | Call the TypeScript core through JavaScriptCore |
| `ios/Sources/CaptureUI` | Render native capture and channel selection |
| `nix` and `flake.nix` | Build reusable packages and optional Home Manager modules |
| `tests/fixtures` | Replay source snapshots and fictional account responses |

## Local checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun run extension:typecheck
bun test tests/atproto-facets.test.ts tests/bluesky-op-thread.test.ts tests/delve.test.ts
bun test tests/plan-capabilities.test.ts tests/extension-browser.test.ts
```

The full Bun suite requires loopback socket access and media tools such as FFmpeg. `bun test` runs the suite; `nix flake check` runs the packaged checks.

For native work, regenerate the core with `bun run build:ios-core`, then run `swift test` from `ios`. XcodeGen creates the app project and its `CaptureUITests` target. Use device checks for system background scheduling and Share extension lifecycle alongside the simulator fixtures.

## Icons

Edit [assets/mark.svg](../assets/mark.svg), then run `bun run icons:generate` and `bun run icons:check`. The generator renders SVG geometry directly at each output resolution. The committed outputs include 16, 32, 48, 64 and 128px extension PNGs and the iOS AppIcon asset catalog. Browser builds also regenerate and copy the icons. Use the locked Bun dependencies to reproduce the PNG bytes.

The iOS catalog supplies an opaque 1024px light image, a transparent dark foreground and a grayscale tinted image. Xcode produces smaller sizes; iOS applies its own corner mask and appearance effects. [Apple supports this asset-catalog format](https://developer.apple.com/documentation/xcode/configuring-your-app-icon). [Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer) offers layered control over Liquid Glass and clear appearances. The current catalog uses the system treatment for clear appearances.

[Chrome requires raster manifest icons](https://developer.chrome.com/docs/extensions/reference/manifest/icons). [Firefox supports PNG icons and separate theme images](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/action); these builds use common static PNGs with a white backing.

## Fixture development

Source fixtures include fictional cases and retained public posts. The public Substack examples include response hashes and observation details. Their reply/quote graphs, media geometry and rich-text offsets support regression checks. Retained-plan fixtures use their own immutable hashes. When changing fixture input, calculate a new fixture plan deliberately and keep the expected hash fixed during the test.

AT Protocol records include normalized facets plus retained raw record fields. Test UTF-8 boundaries, protocol namespaces, quote identities and capability rejection before submission. Browser fetch adapters omit credentials when reading public provider data.

Qualification helpers in `tests/fixtures` use a fake account and protected fixture destination. Unit tests supply the fake API.

## Browser development

Build with `bun run extension:build`, then load the temporary manifest. `bun run extension:dev` watches source files. The Chrome identity comes from an explicitly supplied public key. Native-host registration is optional and separate from the build.

The picker screenshot fixture accepts `--browser`, `--extension`, `--screenshot`, `--dark-screenshot` and `--composition-screenshot`. It creates an empty temporary profile and supplies fake Are.na responses. Run it against the current browser files when reviewing layout changes.

## Native source tests

For optional native live-source checks, set `CAPTURE_LIVE_SOURCE_CHECK=1` and provide a JSON path through `CAPTURE_LIVE_SOURCE_FIXTURE`. The JSON contains `chainURI`, `rootText`, `seedText`, `quotedAuthor`, `quoteCardURL`, `cardText`, `cardTarget`, `singleImageURL` and `twoImageURL`. The tests check content, thread, media and picker behavior against those selected sources.

`CAPTURE_LIVE_SUBSTACK_IMAGE_NOTE=1` enables public Note reads in the Swift suite and Substack UI tests. `CAPTURE_LIVE_SUBSTACK_PODCAST_AUDIO=1` enables original podcast-audio staging and its byte/hash check in the Swift suite. Neither check submits a save. UI flags belong in the test runner's environment.

`StorageReportUITests` exercises cold URLs, collection cancellation, Files export and return to a retained capture. Unsigned simulator fixtures use an isolated synthetic store. Verify signed App Group access and OS-driven background callbacks separately on a device.
