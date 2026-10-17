# Capture interaction flow

## Draft editing

Start a capture with New, Paste or the Share extension. A single supported source can import its returned author thread. Change that switch to keep the selected post only. Multiple explicit URLs retain their entered order.

Inspect the composed writing and selected media. Expand a post to include/exclude text or remove the post. Media controls retain order, poster and video/frame choices. Existing drafts use their saved video threshold; new captures take the current Settings preference.

## Destinations

Open Add to, search or browse channels, then toggle the required rows. Done closes the picker. Save accepts the routed selection.

With a configured default, Reset to default removes other selections and restores the default. It is available after manually deselecting all channels. Manual deselection itself leaves an empty selection, so Save becomes unavailable. With no default, Clear leaves an empty selection. Always-mode routing keeps the default among actual destinations.

The picker shows the current capture preview and selected channel names. Its checkbox area keeps fixed geometry during a toggle. Cached channel permissions help browsing; Save checks current permissions before remote creation.

## Submitted work

A valid Save stores the approved input and UUID before resolution starts. During that operation, source, block and media edits remain disabled. Once the block has been verified, Add to channels is available while its placements are still connecting. Apply updates the original capture; it does not add another History item. The UI shows observed stages and complete confirmed destination counts.

If a create response is ambiguous, keep the attempt visible and inspect its status. A new save would use a new UUID. History shows active saves first, followed by unsubmitted drafts and saved or canceled captures. Its badge counts active saves.

Swipe an active, paused or interrupted save to cancel it. Cancellation moves the same capture to History and stops further attempts. A block or connection already created remains in Are.na. The canceled detail retains confirmed placements and identifies any request whose remote outcome remains unknown. A late response can update those observations without restarting the save.

Continue names the exact remaining destinations before accepting another attempt. A missing connection that was previously confirmed is not restored automatically. Readback can reconcile an existing block and its present connections without creating another block.

Add to channels uses the stored block ID. An open picker and its baseline survive relaunch. Apply merges its changes with newer choices; Cancel discards them. Sent or confirmed channels stay selected and can be disconnected in Are.na. Unsent choices can be removed locally. Choose up to 20 new channels per amendment; existing placements do not use those slots. Each accepted amendment and completed receipt is retained for audit under the same logical capture. Later cycles do not automatically restore connections removed in Are.na; choosing that channel again authorizes one new attempt. Older placement entries without a parent identity remain separate; the app does not guess which historical captures to merge.

## Testing

Use fictional debug fixtures for editor/picker/media screenshots and persistence tests. Check toggling, Reset from empty selection, no-default Clear, reopening the picker and queued-edit rejection.

On a signed device, test Save while switching apps, locking, interrupting the network and reopening the app. Check the retained block identity and confirmed placements after each transition.
