# Capture storage

Capture stores drafts, source records and save receipts in a shared SQLite database. Prepared media and transfer files occupy additional space. Use a current storage report to measure both before considering removal.

## Storage report

In Settings, choose **Export storage report**, then **Create report**. After collection, use **Save report to Files** to export JSON. An app-local `storage-report` URL also opens the report screen. Opening Capture from that screen can resume existing saves.

The collector reads file metadata and record references within time, size and count limits. It hashes paths and record IDs for comparison, keeping authored text and credentials out of the export. Large media files are measured through metadata. The report identifies incomplete scans and changes during collection.

Opening the report pauses new automatic foreground checks until you confirm **Open Capture**. The session retains this hold across collection, cancellation, Files export and app activation. Work queued before report entry uses an invalidated admission ticket. Existing save passes may continue through the queue, and iOS and the Share extension may continue transfers. Background transfer dependencies are outside this report, so it cannot determine which files are safe to remove. Runtime checks for cold launch, URL delivery and return to Capture remain pending.

## Temporary media

During preparation, Capture downloads working files into `temporary-media-v1`. A file lock protects active app and Share operations, including open media previews. On failure, cancellation or preview dismissal, Capture removes the working files for that operation. Before queueing a save, it moves the prepared upload body into `renders`.

At normal session startup and before new preparation, Capture removes marked inactive workspaces after an hour. It also removes the oldest inactive working copies when their total exceeds 10 MB. Active locks, unfamiliar entries and legacy render directories remain protected. These limits apply to inactive working copies; an active render may use more space within its download and output limits.

Before preparing media, Capture checks available space on the device volume and reserves 1 MiB for metadata. Moving prepared output within that volume reuses its allocated space. Existing per-source and final upload limits also apply. History records and existing saves remain available when a new preparation fails for lack of space.

## Existing data

A crash between output promotion and journal commit can leave a render file without an observed record reference. That observation alone does not establish whether a draft, restorable item, background transfer or another process still uses it.

Before removing existing data, compare a complete current inventory with every retained record kind and active transfer. Preserve pending, canceled and uncertain saves, restorable drafts, recordings, source media and evidence. Review an exact file/size/hash list and measured reclaimable bytes before approving removal. The current report provides only part of that investigation.

## Development inspection

`CAPTURE_STORAGE_AUDIT_ONLY=1` opens an internal read-only inspection mode in builds containing that mode. `CAPTURE_STORAGE_AUDIT_BUILD` forces it at compilation. It bypasses normal capture-session initialization and writes UUID-named JSON reports under `Documents/CaptureStorageAudit`.

Verify the build before using either mode: older binaries can ignore the environment flag and start ordinary recovery. Debug simulator fixtures use `CAPTURE_STORAGE_AUDIT_FIXTURE=1` with synthetic data. Their results establish fixture behavior, with physical-device checks required separately.
