# Capture interaction flow

## Draft editing

Start a capture with New, Paste or the Share extension. A single supported source can import its returned author thread. Change that switch to keep the selected post only. Multiple explicit URLs retain their entered order.

Inspect the composed writing and selected media. Expand a post to include/exclude text or remove the post. Media controls retain order, poster and video/frame choices. Existing drafts use their saved video threshold; new captures take the current Settings preference.

## Destinations

Open Add to, search or browse channels, then toggle the required rows. Done closes the picker. Save accepts the routed selection.

With a configured default, Reset to default removes other selections and restores the default. It is available after manually deselecting all channels. Manual deselection itself leaves an empty selection, so Save becomes unavailable. With no default, Clear leaves an empty selection. Always-mode routing keeps the default among actual destinations.

The picker shows the current capture preview and selected channel names. Its checkbox area keeps fixed geometry during a toggle. Cached channel permissions help browsing; Save checks current permissions before remote creation.

## Submitted work

A valid Save stores the approved input and UUID before resolution starts. During that operation, source, block, media and destination edits remain disabled. The UI shows observed stages and complete confirmed destination counts.

If a create response is ambiguous, keep the attempt visible and inspect its status. A new save would use a new UUID. History preserves the retained operation for checking and recovery.

Add placements uses the stored block ID. The confirmation action creates a separate retained operation for the chosen additions. Cancelling the picker returns to the current capture.

## Testing

Use fictional debug fixtures for editor/picker/media screenshots and persistence tests. Check toggling, Reset from empty selection, no-default Clear, reopening the picker and queued-edit rejection.

On a signed device, test Save while switching apps, locking, interrupting the network and reopening the app. Check the retained block identity and confirmed placements after each transition.
