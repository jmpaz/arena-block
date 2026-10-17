# Capture UI and data flow

## Source composition

`CaptureSession` reads the draft and selected composition options, then asks `CaptureRuntime` to resolve or compose the sources. JavaScriptCore executes `packages/core/native-entry.ts`. The shared composer returns source records, writing, media selection and a plan hash.

Keep the source text and protocol records when formatting the block. A UI edit changes the draft input; the composer calculates a new plan from that input. Regenerate `capture-core.js` after changing the shared TypeScript implementation.

## Editor and picker

`CaptureView` renders the source field, preview, media choices and Add to row. `ChannelPicker` renders search, channel rows and selected destinations. `CaptureSession` applies each action to the draft and persists the updated values through `CaptureStore`.

A manual channel toggle updates the explicit selection. Reset to default calls `resetDestinations()` when a default is configured. With no default, Clear calls `clearDestinations()`. After Save, source, writing and media stay frozen. Placement edits keep the same capture UUID and apply a picker delta against the latest durable selection. Already sent or confirmed channels remain protected; unsent choices can be removed. An open picker is persisted separately and never overwrites a running job.

## Delivery and recovery

Save stores the accepted operation before asynchronous resolution or media work. `CaptureDelivery` acquires the approved source/media, creates the remote block and records the returned ID. It checks the block and requested destinations before displaying completion.

When a create response is lost, the coordinator records uncertainty and checks the retained attempt before another creation request. During placement scans, it keeps the last complete confirmed set until another complete scan returns. History displays active saves first, followed by drafts and saved or canceled captures. Source-preparation failures stay with drafts. Placement changes and completed delivery receipts retain their own audit identities while the capture remains one visible item. Later additive cycles request only new channels, so they do not recreate a historical connection removed in Are.na. Continued-processing claims are fenced by receipt cycle as well as capture UUID.

Cancellation persists its terminal intent before canceling execution. It removes the executable delivery record and retains a separate tombstone for an outstanding response. Existing block and placement effects remain visible; late responses cannot schedule another mutation. Optional cancellation metadata preserves decoding by older binaries while the separate tombstone prevents their automatic recovery from reopening that capture.

History rows and counts use lightweight projections checked against each SQLite record revision. The app loads full source records, plans and block bodies when a capture is opened. Account scope and row revisions also detect writes from the Share extension without retaining full capture payloads in the list cache.

The app and Share extension read the same account-scoped SQLite data. Signing configuration supplies the app-group and keychain settings. These identifiers determine access to shared storage and credentials; keep them consistent across both targets and app updates.

## Runtime boundaries

The native network adapter uses an ephemeral URLSession with private authentication handled on the device. The TypeScript runtime returns source/plan data to Swift. Swift handles Are.na delivery and native media rendering.

The iOS continued-processing coordinator requests execution for a persisted save on supported systems. It reports observed progress and records stopped work on expiry. The durable queue supports inspection and recovery after the foreground or Share host closes.

Debug simulator fixtures create fictional drafts and account/channel data in an isolated store. They support editing, picker, media and restart tests. Use device checks for background scheduling, Share extension lifecycle and network interruption.
