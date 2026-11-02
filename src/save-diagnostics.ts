import type { ArenaBlockClient } from "./client.ts";
import type { SaveStatus } from "./save-gateway.ts";

export type DestinationDiagnosis = {
  code: "destination_unavailable";
  basis: "read_only_channel_lookup";
  channel: string;
  httpStatus: 401 | 403 | 404;
  message: string;
};

/** Older daemons can retain a failed pre-create save without its error text.
 * Diagnose only that state, using reads. Keep the original journal status intact.
 */
export async function diagnoseSaveDestinations(
  daemon: Pick<ArenaBlockClient, "retainedIntent" | "channelLabels">, status: SaveStatus,
): Promise<DestinationDiagnosis | undefined> {
  if (status.phase !== "not_saved" || status.active || status.receipt || status.attempt
    || status.failure || status.cancelRequested || !status.authentication.authenticatedAccountVerified) return;
  try {
    const signal = AbortSignal.timeout(8_000);
    const intent = await daemon.retainedIntent(status.saveId, signal);
    const refs = intent.snapshot.routing.destinations;
    if (!refs.length) return;
    try { await daemon.channelLabels(refs, signal); }
    catch (error) {
      const match = error instanceof Error && /^Are\.na GET \/channels\/([^\s/]+) returned (401|403|404)$/.exec(error.message);
      if (!match) return;
      const channel = decodeURIComponent(match[1]!);
      if (!refs.includes(channel)) return;
      const httpStatus = Number(match[2]) as DestinationDiagnosis["httpStatus"];
      return { code: "destination_unavailable", basis: "read_only_channel_lookup", channel, httpStatus,
        message: `Destination "${channel}" is unavailable (Are.na HTTP ${httpStatus}). Check the channel URL and account access before retrying.` };
    }
  } catch { /* A failed diagnostic read cannot change the retained outcome. */ }
}
