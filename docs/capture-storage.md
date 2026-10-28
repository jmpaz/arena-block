# Capture storage

The iOS app keeps drafts, source records and save receipts in a SQLite database shared with the Share extension. Prepared media and files waiting to upload take up further space. The storage report measures both.

## Storage report

The report lives under **Export storage report** in Settings. **Create report** collects it, and **Save report to Files** exports it as JSON. The app-local `storage-report` URL opens the same screen.

The app reads file metadata and record references within limits on time, size and count, measuring large media files from their metadata. It hashes paths and record IDs so reports stay comparable, and leaves authored text and credentials out of the export; the report flags scans that stopped early and files that changed during collection.

While the report screen is open, the app holds off on new automatic checks in the foreground until **Open Capture** is chosen; the hold lasts through collection, cancellation, export to Files and app switching. Saves already in progress may keep running, and iOS and the Share extension may keep transferring files. Background transfers fall outside the report, so it can't establish which files are safe to delete.

## Temporary media

While preparing media, the app downloads working files into `temporary-media-v1`, with a file lock on each folder in use by the app, the Share extension or an open media preview. When preparation fails, gets canceled or its preview closes, the app deletes that operation's files; before queueing a save, it moves the finished upload into `renders`.

When a session starts, and before each new preparation, the app deletes inactive working folders older than an hour, then the oldest remaining ones while they add up to more than 10 MB. Locked folders, unrecognized entries and older render folders stay. A render in progress can use more space, up to its own download and output limits.

Before preparing media, the app checks free space on the device and sets aside 1 MiB for metadata, alongside the usual per-source and upload size limits. When a preparation fails for lack of space, history and existing saves stay as they were.

## Existing data

If the app crashes after moving a render into place and before recording it, the file stays on disk with no record pointing to it. That alone doesn't show whether a draft, a restorable item, a background transfer or another process still needs the file.

Safe deletion of existing data depends on a full inventory of files, compared against every kind of retained record and every active transfer; pending, canceled and uncertain saves, restorable drafts, recordings, source media and evidence all stay. Approval rests on an exact list of files, sizes and hashes, with the space each deletion would free, and the storage report covers part of that work.

## Development inspection

Builds with an inspection mode open it when `CAPTURE_STORAGE_AUDIT_ONLY=1` is set. `CAPTURE_STORAGE_AUDIT_BUILD` turns it on at compile time. The mode skips normal session startup, reads the store without writing to it and saves JSON reports named by UUID under `Documents/CaptureStorageAudit`.

An older binary ignores the environment variable and runs normal recovery, so the build matters before using either setting. Debug simulator fixtures set `CAPTURE_STORAGE_AUDIT_FIXTURE=1` and use synthetic data, and their results cover the fixtures alone. Physical devices need separate checks.
