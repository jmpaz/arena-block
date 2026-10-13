# UI development

## Editor source

The browser editor lives in `extension/src/editor.ts`, `editor.html` and `editor.css`. Its save/state modules retain drafts, queued operations and destination choices. Run `bun run extension:dev` to rebuild the extension while editing.

The native editor uses `CaptureView.swift`, `ChannelPicker.swift` and `CaptureSession.swift` in `ios/Sources/CaptureUI`. The [native architecture](../ios/Design/architecture.md) describes persistence and delivery. The [HTML interaction study](../ios/Design/preview.html) provides a visual reference with sample data. Native fixtures exercise SwiftUI behavior.

## Fixtures and state

The checked-in fixtures cover empty drafts, composed blocks, channel selection, media ordering and retained interrupted saves. The picker screenshot fixture supplies fake account responses. Use fictional names and test images when adding fixtures.

The source preview shows the captured writing and media. Destination controls apply to an editable draft. Reset to default restores the configured channel; manual deselection can leave Save unavailable. Queued work retains its submitted input and confirmed placements.

Saving creates a block with neutral text and description values, then applies the submitted fields once processing completes. CLI and browser save records distinguish pending field updates from attempted updates. Their recovery can complete unchanged initial values or verify final fields after a lost response; it stops on changed content and does not repeat an uncertain update. Older receipts without initial values require the final fields to match.

## Shared data and builds

Edit UI source and regenerate its bundles with the commands in [development](development.md). Provider namespaces, original text/records, quote relationships, media order, thread choices and save UUIDs carry capture and delivery meaning. Source and composition changes pass through the shared composer.

Signing identifiers and app groups determine access to native storage and credentials. Browser callback settings and native-host allowlists determine which client can authenticate and contact the local service. Keep these settings consistent with the installation being tested.
