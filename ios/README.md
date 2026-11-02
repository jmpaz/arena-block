# Capture for iOS

Capture provides a SwiftUI editor and Share extension for Are.na. The app and extension use the same SQLite draft/history store. During source resolution, JavaScriptCore runs the shared TypeScript core. Native ImageIO/Core Graphics and AVFoundation code handles media rendering.

## Build and development

Use macOS, a compatible Xcode SDK, XcodeGen and Bun:

```sh
bun install --frozen-lockfile
bun run build:ios-core
bun run icons:generate
cd ios
swift test
xcodegen generate
open ArenaCapture.xcodeproj
```

Configure signing and callback settings locally before a device build. Generated Xcode projects and `Local.xcconfig` are ignored by Git. Keep credentials in private configuration. A simulator build exercises fixtures through an isolated store with fictional account/channel responses.

## Capture and save

Paste or share the selected URLs, inspect the writing and media, then choose the destination channels. The app supports up to twenty source posts and keeps explicit multi-post order. New supported single-post captures enable thread import; turning it off persists that choice. Existing drafts retain their captured policy.

The Add to row opens channel selection. Save records the draft, chosen destinations and operation UUID before starting source/network work. Picker Done returns to the editor. Reset to default restores the configured default channel. Manual deselection can leave no selected destination. Clear empties the selection when no default is configured. Always-mode routing includes the configured default.

After remote creation, the delivery coordinator records the block ID and checks placements. The UI reports confirmed destinations from a complete server scan. A lost response keeps the attempt for reconciliation. History retains pending, failed and completed operations. Add placements uses a known block and checks the requested additions.

The app saves a SoundCloud track as an MP3 attachment, fetched from an arena-block media service with SoundCloud MP3 support; Settings holds the service's HTTPS address and access token, and the Share extension reads the same address and the token from the keychain. On save, the app reads the track's details from SoundCloud, asks the service for the MP3, checks the file, then uploads it to Are.na.

Text-only media saves the track URL alone. A playlist block lists its tracks in order, with the playlist artwork.

Use New for another capture. Delete, Clear Drafts, Undo and Deleted Drafts recovery operate on unsubmitted drafts. During a queued save, the editor keeps the submitted values fixed. Clipboard import is opt-in and respects the system paste permission.

## Background work

The app retains accepted work locally before the Share host closes. On supported iOS versions, the continued-processing coordinator requests execution for the retained save and updates the system progress display. After cancellation or expiry, it persists the stopped state so later recovery can inspect the attempt.

iOS controls scheduling. A force-quit, offline period or revoked account can defer completion until the app opens again. Verify switching apps, locking, reconnection and restart on a signed device before distribution.

## UI development

Read [the architecture](Design/architecture.md) and [interaction flow](Design/interaction.md) before changing the editor or picker. `CaptureView`, `ChannelPicker` and `CaptureSession` provide the main UI and state transitions. The browser design study provides a visual reference; the native source and fixture tests determine current behavior.

Run simulator tests through the generated `CaptureUITests` target. The background transport probe uses `CAPTURE_BACKGROUND_URL` to contact a controlled fixture server. Without that setting, the probe is skipped.

## Reddit links and saved records

The app takes public post and comment URLs, pasted or shared from Safari, and reads them through the shared HTTP provider and stops on HTTP 401, 403 or 429. See [source access](../docs/reddit-source-access.md).

Drafts and saves still open Reddit records from earlier versions, and the app writes a replacement snapshot before showing it, keeping the selected draft and its input across reloads. Validation checks the data in a record, though it can't verify when someone collected the record, or whether the post is still up.

## Existing Mac device signing

For Josh’s existing development install, use the established signing helper at `/Users/josh/Documents/Codex/2026-10-01/task-4/arena-block-signing-session-20261008/ios/scripts/with-signing-keychain.py`. The [release runbook](/Users/josh/Documents/Codex/2026-10-01/task-4/handoff/bluesky-capture-feedback-20261010/fresh-capture-signing-runbook.md) records the full app settings and device commands. It is an earlier frozen release recipe: select the intended current source and a new build number, and check the phone and profiles afresh.

Run `python3 <helper> --login-keychain --expected-identity 3D5DF1D8BFC71250EE7068D18721C1A5247BE339 -- xcodebuild build ...` with the existing Release device settings from that runbook. The helper checks the identity, temporarily puts the login Keychain first, tests a scratch signature and restores the original search order. It does not read a password file or change key access permissions. Check the restored order afterward, especially after an interrupted process. On October 28, 2026, this route successfully built Capture and Share noninteractively after direct `codesign --keychain` stalled. The Nix Home Manager signing module described in older notes was prepared but was not activated. Do not assume the historical CX-Speech password file unlocks its old keychain.

If the existing development profiles have expired, the normal device `xcodebuild build` may renew them with `-allowProvisioningUpdates` using the existing team and identity. Inspect both resulting profile identifiers, device authorization and expiry; do not create a new signing identity. Verify the app and Share signatures, runtime groups, callback, server settings and embedded core before installing over the existing bundle. Never uninstall the app as an update. Confirm the device’s installed version afterward and report launch separately; iOS may require the phone to be unlocked.
