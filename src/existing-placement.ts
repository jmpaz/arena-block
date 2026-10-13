import type { ArenaClient } from "./arena.ts";
import type { ArenaBlockStore, ExistingPlacement } from "./store.ts";

/** Append an existing Are.na block without changing its source or deleting a connection. */
export class ExistingBlockPlacer {
  private active = new Map<string, AbortController>();
  constructor(private readonly client: ArenaClient, private readonly store: ArenaBlockStore) {}

  status(id: string, accountId: number): ExistingPlacement {
    const value = this.store.existingPlacement(id);
    if (!value || value.accountId !== accountId) throw new Error("Placement not found for this account");
    return { ...value, active: this.active.has(id) };
  }

  async preview(blockId: number, signal?: AbortSignal) {
    const block = await this.client.block(blockId, signal);
    if (block.id !== blockId) throw new Error("Are.na returned another block");
    return { blockId, blockUrl: `https://www.are.na/block/${blockId}`,
      title: typeof block.title === "string" ? block.title : `Block ${blockId}`,
      type: typeof block.type === "string" ? block.type : "Block",
      state: typeof block.state === "string" ? block.state : "unknown" };
  }

  async place(input: { id: string; accountId: number; blockId: number; destinations: number[] }): Promise<ExistingPlacement> {
    const record = this.store.reserveExistingPlacement(input);
    if (record.phase === "saved") return this.status(input.id, input.accountId);
    if (record.cancelRequested) return this.status(input.id, input.accountId);
    if (this.active.has(input.id)) return this.status(input.id, input.accountId);
    const controller = new AbortController();
    this.active.set(input.id, controller);
    this.store.updateExistingPlacement(input.id, value => ({ ...value, phase: "running", active: true, error: undefined }));
    try {
      for (const destination of input.destinations) {
        let current = this.status(input.id, input.accountId);
        if (current.cancelRequested || controller.signal.aborted) break;
        try {
          const channel = await this.client.channel(destination, controller.signal);
          controller.signal.throwIfAborted();
          if (channel.id !== destination || (channel.can as { add_to?: unknown } | undefined)?.add_to !== true)
            throw new Error(`Channel ${destination} does not confirm add permission`);
          const membership = await this.client.completeBlockConnections(input.blockId, controller.signal);
          controller.signal.throwIfAborted();
          if (membership.has(destination)) {
            this.confirm(input.id, destination);
            continue;
          }
          if (current.confirmed.includes(destination)) {
            this.store.updateExistingPlacement(input.id, value => ({ ...value,
              confirmed: value.confirmed.filter(target => target !== destination),
              attempted: [...new Set([...value.attempted, destination])],
              error: "A previously confirmed placement is now absent; later placements were not sent" }));
            break;
          }
          // A previous POST with a lost or delayed result must never be blindly repeated.
          controller.signal.throwIfAborted();
          if (!this.store.reserveExistingPlacementAttempt(input.id, destination)) {
            this.store.updateExistingPlacement(input.id, value => ({ ...value, error: "An earlier or previously attempted placement remains unconfirmed; later placements were not sent" }));
            break;
          }
          try { await this.client.connect(input.blockId, [String(destination)], controller.signal); }
          catch (error) {
            this.store.updateExistingPlacement(input.id, value => ({ ...value, error: error instanceof Error ? error.message : String(error) }));
          }
          // A POST response alone is not membership proof. Later retries only reconcile.
          for (let check = 0; check < 3; check++) {
            if (controller.signal.aborted) break;
            try {
              if ((await this.client.completeBlockConnections(input.blockId, controller.signal)).has(destination)) {
                this.confirm(input.id, destination); break;
              }
            } catch (error) {
              this.store.updateExistingPlacement(input.id, value => ({ ...value, error: error instanceof Error ? error.message : String(error) }));
              break;
            }
            if (check < 2) await new Promise(resolve => setTimeout(resolve, 800));
          }
          if (!this.status(input.id, input.accountId).confirmed.includes(destination)) break;
        } catch (error) {
          this.store.updateExistingPlacement(input.id, value => ({ ...value, error: error instanceof Error ? error.message : String(error) }));
          break;
        }
      }
    } finally {
      this.active.delete(input.id);
      this.store.updateExistingPlacement(input.id, value => {
        const unknown = value.attempted.some(id => !value.confirmed.includes(id));
        const phase = value.confirmed.length === value.destinations.length ? "saved"
          : unknown ? "unknown" : value.cancelRequested ? "cancelled" : value.confirmed.length ? "partial" : "prepared";
        return { ...value, active: false, phase };
      });
    }
    return this.status(input.id, input.accountId);
  }

  cancel(id: string, accountId: number): ExistingPlacement {
    this.status(id, accountId);
    this.store.updateExistingPlacement(id, value => ({ ...value, cancelRequested: true }));
    this.active.get(id)?.abort();
    return this.status(id, accountId);
  }

  retry(id: string, accountId: number): Promise<ExistingPlacement> {
    const prior = this.status(id, accountId);
    if (prior.active) throw new Error("Wait for this placement to settle before retrying");
    if (prior.cancelRequested) this.store.updateExistingPlacement(id, value => ({ ...value, cancelRequested: false }));
    return this.place({ id, accountId, blockId: prior.blockId, destinations: prior.destinations });
  }

  private confirm(id: string, destination: number): void {
    this.store.updateExistingPlacement(id, value => ({ ...value, confirmed: [...new Set([...value.confirmed, destination])], error: undefined }));
    this.store.rememberBlockConnectionAttempts(this.store.existingPlacement(id)!.blockId, [destination], `existing:${id}`);
  }
}
