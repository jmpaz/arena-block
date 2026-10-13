import { ArenaBlockClient, PublicationError } from "./client.ts";
import type { BlockPlan, PublicationReceipt, PublicationState } from "./types.ts";
import type { SaveStatus } from "./save-gateway.ts";

const stages = {
  processing: "Processing on Are.na",
  updating: "Adding title and text",
  verifying: "Checking saved block",
  connecting: "Checking channels",
};

export function formatProgressLine(state: PublicationState, seconds: number): string {
  const receipt = state.receipt;
  const label = state.attempt ? "Checking creation outcome"
    : receipt?.status === "needs_attention" ? "Save needs attention"
    : receipt?.stage ? stages[receipt.stage] : "Preparing save";
  return `${label} · ${seconds}s`;
}

/** Draw only on an interactive stream; machine output remains a JSON receipt. */
export async function publicationWithProgress(
  daemon: ArenaBlockClient,
  plan: BlockPlan,
  destinations: string[],
  operation: (signal: AbortSignal) => Promise<PublicationReceipt>,
  receiptId?: string,
  operationId?: string,
  journaledSave = false,
  progressOutput: "stdout" | "stderr" | "none" = "stderr",
  progressSink?: { isTTY?: boolean; columns?: number; write(text: string): unknown },
): Promise<PublicationReceipt> {
  const stream = progressOutput === "none" ? undefined : progressSink ?? (progressOutput === "stdout" ? process.stdout : process.stderr);
  const controller = new AbortController();
  const started = Date.now();
  let active = true;
  let reading = false;
  let state: PublicationState = {};
  let saveState: SaveStatus | undefined;
  let interrupted = false;
  let cancellation: Promise<SaveStatus | undefined> | undefined;
  const readState = async (): Promise<PublicationState> => {
    if (receiptId) return { receipt: await daemon.receipt(receiptId, AbortSignal.timeout(2000)) };
    if (journaledSave && operationId) { saveState = await daemon.saveStatus(operationId, "cli", AbortSignal.timeout(2000)); return saveState; }
    if (operationId) return daemon.operation(operationId, AbortSignal.timeout(2000));
    const current = await daemon.publicationState(plan.hash, AbortSignal.timeout(2000));
    // Legacy uncorrelated state must not combine a new uncertain create with an older block.
    return current.attempt ? { attempt: current.attempt } : current;
  };
  const cancel = () => {
    if (interrupted) return;
    interrupted = true;
    // Ask the owner to stop future work. An accepted Are.na write is retained.
    // The same UUID also records cancellation if submission has not arrived yet.
    if (journaledSave && operationId) cancellation = daemon.cancelSave(operationId, "cli", AbortSignal.timeout(3000)).catch(() => undefined);
    controller.abort(new DOMException("Capture request cancelled", "AbortError"));
  };
  process.on("SIGINT", cancel);
  const draw = () => {
    if (!active || !stream?.isTTY) return;
    const line = formatProgressLine(state, Math.floor((Date.now() - started) / 1000));
    const columns = stream.columns || 100;
    const glyphs = Array.from(line);
    stream.write(`\r\u001b[2K${glyphs.length < columns ? line : glyphs.slice(0, Math.max(1, columns - 2)).join("") + "…"}`);
  };
  const observe = async () => {
    if (!active || reading) return;
    reading = true;
    try {
      const next = await readState();
      if (active) state = next;
    } catch { /* Older daemons and temporary read failures retain elapsed feedback. */ }
    finally { reading = false; draw(); }
  };
  draw();
  const timer = stream?.isTTY ? setInterval(() => { draw(); void observe(); }, 1000) : undefined;
  try {
    const result = await operation(controller.signal);
    if (!interrupted) return result;
    state = { receipt: result };
  }
  catch (error) {
    if (!interrupted) throw error;
    if (error instanceof PublicationError) {
      if (error.saveStatus) saveState = error.saveStatus;
      state = { ...(error.receipt ? { receipt: error.receipt } : {}), ...(error.attempt ? { attempt: error.attempt } : {}) };
    }
  } finally {
    active = false;
    if (timer) clearInterval(timer);
    if (!interrupted) process.removeListener("SIGINT", cancel);
    if (stream?.isTTY) stream.write("\r\u001b[2K");
  }
  try {
    if (cancellation) {
      const result = await cancellation;
      if (result) { saveState = result; state = result; }
    }
    // Cancellation is a request, not a rollback. Read its durable outcome without
    // reposting, and never present an interrupted command as an ordinary success.
    try { state = await readState(); } catch { /* Preserve the last known receipt or attempt. */ }
    const message = journaledSave
      ? saveState?.phase === "saved" ? "Cancellation arrived after the save completed; committed block retained"
        : saveState?.cancelRequested ? "Cancellation requested; committed work is retained and the owner may still be stopping"
        : "Cancellation could not be confirmed; inspect retained status before another save"
      : "Capture request cancelled; committed work is retained";
    throw new PublicationError(message, state.receipt, state.attempt, saveState, true);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}
