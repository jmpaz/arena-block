# Capture UI and data flow

## Source composition

`CaptureSession` reads the draft and selected composition options, then asks `CaptureRuntime` to resolve or compose the sources. JavaScriptCore executes `packages/core/native-entry.ts`. The shared composer returns source records, writing, media selection and a plan hash.

Keep the source text and protocol records when formatting the block. A UI edit changes the draft input; the composer calculates a new plan from that input. Regenerate `capture-core.js` after changing the shared TypeScript implementation.

## Editor and picker

`CaptureView` renders the source field, preview, media choices and Add to row. `ChannelPicker` renders search, channel rows and selected destinations. `CaptureSession` applies each action to the draft and persists the updated values through `CaptureStore`.

A manual channel toggle updates the explicit selection. Reset to default calls `resetDestinations()` when a default is configured. With no default, Clear calls `clearDestinations()`. After Save, the source, text and media stay fixed. Editing placements keeps the capture's UUID and applies the picker's changes to the latest stored selection. Channels already sent or confirmed stay selected, and unsent choices can be removed. The session stores an open picker apart from running jobs.

## Delivery and recovery

Save stores the accepted operation before asynchronous resolution or media work. `CaptureDelivery` acquires the approved source/media, creates the remote block and records the returned ID. It checks the block and requested destinations before displaying completion.

When a create response is lost, the coordinator records uncertainty and checks the retained attempt before another creation request. During placement scans, it keeps the last complete confirmed set until another complete scan returns. History lists active saves first, then drafts, then saved and canceled captures. A capture whose source preparation failed stays with the drafts. Placement changes and delivery receipts each keep their own audit ID, and History still shows the capture as a single item. Each later round of additions requests only the new channels, so a connection removed in Are.na stays removed. Background processing claims are scoped to both the receipt cycle and the capture UUID.

To cancel, the coordinator first stores the intent to cancel, then stops execution. It removes the delivery record and keeps a separate tombstone for any response still outstanding. Blocks and placements already made stay visible. A late response can update what the app shows, without scheduling further changes. Older app versions can still decode the optional cancel metadata, and the tombstone keeps their recovery from reopening the capture.

History rows and counts come from lightweight summaries, checked against each SQLite record's revision. The app loads full source records, plans and block bodies when a capture opens. Account scope and row revisions catch writes from the Share extension, so the list cache holds summaries alone.

The app and Share extension read the same account-scoped SQLite data. Signing configuration supplies the app-group and keychain settings. These identifiers determine access to shared storage and credentials; keep them consistent across both targets and app updates.

## Runtime boundaries

The native network adapter uses an ephemeral URLSession with private authentication handled on the device. The TypeScript runtime returns source/plan data to Swift. Swift handles Are.na delivery and native media rendering.

The iOS continued-processing coordinator requests execution for a persisted save on supported systems. It reports observed progress and records stopped work on expiry. The durable queue supports inspection and recovery after the foreground or Share host closes.

Debug simulator fixtures create fictional drafts and account/channel data in an isolated store. They support editing, picker, media and restart tests. Use device checks for background scheduling, Share extension lifecycle and network interruption.
