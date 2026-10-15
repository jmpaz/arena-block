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

Use New for another capture. Delete, Clear Drafts, Undo and Deleted Drafts recovery operate on unsubmitted drafts. During a queued save, the editor keeps the submitted values fixed. Clipboard import is opt-in and respects the system paste permission.

## Background work

The app retains accepted work locally before the Share host closes. On supported iOS versions, the continued-processing coordinator requests execution for the retained save and updates the system progress display. After cancellation or expiry, it persists the stopped state so later recovery can inspect the attempt.

iOS controls scheduling. A force-quit, offline period or revoked account can defer completion until the app opens again. Verify switching apps, locking, reconnection and restart on a signed device before distribution.

## UI development

Read [the architecture](Design/architecture.md) and [interaction flow](Design/interaction.md) before changing the editor or picker. `CaptureView`, `ChannelPicker` and `CaptureSession` provide the main UI and state transitions. The browser design study provides a visual reference; the native source and fixture tests determine current behavior.

Run simulator tests through the generated `CaptureUITests` target. The background transport probe uses `CAPTURE_BACKGROUND_URL` to contact a controlled fixture server. Without that setting, the probe is skipped.

## Reddit browser intake

Share a public post or selected comment from Safari to Capture. Safari runs `RedditPreprocessor.js` in the shared page, returning the sanitized record through the Share result. The shared TypeScript importer validates the record before the app changes a draft. The reader uses Safari's existing session without exporting session data. A refusal stops this action.

Start with Paste or share the page to Capture. Safari passes the page content automatically when it is available. Sharing a supported record file exported on another device remains available through the Share extension. Capture retains the record with the draft, queued intake and frozen submission. A URL share alone uses the ordinary anonymous provider path; it cannot reuse a browser session. The plan keeps its observation timestamp and public records. File intake and Safari preprocessing need no additional persistent browser permission. Physical Safari share-sheet acceptance remains a separate release check.

Imported Reddit records declare their observation time and public visibility; validation and plan hashes do not authenticate those claims. Capture commits a matching draft's replacement snapshot before showing it, and selects queued snapshots in the same transaction that saves the new draft and consumes that intake. Reimporting a record changes the source cache identity while authored presentation edits retain the current snapshot.
