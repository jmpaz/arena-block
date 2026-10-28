# Capture interaction flow

## Draft editing

Start a capture with New, Paste or the Share extension. A single supported source can import its returned author thread. Change that switch to keep the selected post only. Multiple explicit URLs retain their entered order.

Inspect the composed writing and selected media. Expand a post to include/exclude text or remove the post. Media controls retain order, poster and video/frame choices. Existing drafts use their saved video threshold; new captures take the current Settings preference.

## Destinations

Open Add to, search or browse channels, then toggle the required rows. Done closes the picker. Save accepts the routed selection.

With a configured default, Reset to default removes other selections and restores the default. It is available after manually deselecting all channels. Manual deselection itself leaves an empty selection, so Save becomes unavailable. With no default, Clear leaves an empty selection. Always-mode routing keeps the default among actual destinations.

The picker shows the current capture preview and selected channel names. Its checkbox area keeps fixed geometry during a toggle. Cached channel permissions help browsing; Save checks current permissions before remote creation.

## Submitted work

A valid Save stores the approved input and UUID before resolution starts, and source, block and media edits stay disabled while it runs; the UI shows observed stages and confirmed destination counts. Once the block is verified, Add to channels becomes available, even while placements are still connecting, and Apply updates the same capture in History.

An ambiguous create response leaves the attempt visible for a status check, since a new save would get a new UUID. History lists active saves first, then unsubmitted drafts, then saved and canceled captures; its badge counts active saves.

A swipe cancels an active, paused or interrupted save, moving the capture to History; blocks and connections already created stay in Are.na. The canceled capture shows its confirmed placements, along with any request still waiting on an outcome, and a late response can update those details without restarting the save.

Continue lists the remaining destinations before starting another attempt. If a connection confirmed earlier has gone missing, it stays missing until that channel is chosen again. Reading the block back can match an existing block and its connections, so a retry reuses them.

Add to channels uses the stored block ID, and an open picker and its starting state survive a relaunch. Apply merges the picker's changes with newer ones, and Cancel discards them.

Channels already sent or confirmed stay selected, with disconnection left to Are.na; unsent choices can be removed in the app. Each change can add up to 20 new channels, with existing placements counted separately.

The app keeps each accepted change and completed receipt under the same capture. A connection removed in Are.na stays removed until that channel is chosen again, and older placement entries without a parent ID stay separate, since the app has no record of their capture.

## Testing

Use fictional debug fixtures for editor/picker/media screenshots and persistence tests. Check toggling, Reset from empty selection, no-default Clear, reopening the picker and queued-edit rejection.

On a signed device, test Save while switching apps, locking, interrupting the network and reopening the app. Check the retained block identity and confirmed placements after each transition.
