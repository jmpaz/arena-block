# Routing and saved input

Configure `defaultChannel.channel` with a channel slug or numeric ID. With `mode: fallback`, the CLI adds the default when the caller supplies no explicit destination. With `mode: always`, it includes the default alongside the explicit selection. The native app stores the setting separately for each account.

Before creating a block, the publisher resolves slug/numeric aliases, removes duplicates and checks the twenty-destination limit. It checks current account permissions for each requested channel. Submitted jobs retain their selected destinations during retries.

When local retention is enabled, the CLI writes the normalized input and result to an owned local directory. The daemon records immutable save input in its SQLite journal. An unresolved create response remains associated with its save UUID for later inspection.

Optional connection metadata uses a configured private default destination. The publisher checks that destination and authenticated account before writing the configured summary or complete snapshot. Other destinations receive the selected block placement. Existing connection metadata identifies the original save; later verified events may update the latest-event fields. Read the saved events from the local journal when reviewing repeated saves.

A repeated UUID must use the original input. If a later attempt supplies changed content, the client requires a new UUID. During recovery, the daemon checks the block and channel scan before creating or updating another remote result.

The legacy `remoteInbox` option is accepted when reading older configuration. New configuration uses `defaultChannel`. The example files contain channel placeholders and environment variable references. Supply account-specific settings through private configuration.
