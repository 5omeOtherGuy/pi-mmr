import type { MmrAsyncTaskPushOutcome } from "./async-task-internal.js";
import type { MmrAsyncTaskCompletionPushState } from "./async-task-registry.js";

/**
 * Pure projection of the async-task delivery/push state. This module is a leaf:
 * it has no runtime imports. The `import type` reference back to
 * `./async-task-registry.js` is erased by the compiler, so it does not create a
 * runtime import cycle.
 *
 * Internal-only target shape shared by task and group records for delivery
 * bookkeeping. Both the eligibility helpers and the claim path operate on this
 * structural subset so task and group delivery stay in lockstep.
 */
export interface DeliveryTarget {
  deliveryOptIn: boolean;
  finalObservedAtMs?: number;
  terminalAnnouncedAtMs?: number;
  pushOutcome?: MmrAsyncTaskPushOutcome;
}

/**
 * Eligibility state for surfacing a terminal item to the model. Timestamp-only;
 * it does not inspect idle-wake transport outcomes.
 */
export function terminalDeliveryOf(target: {
  finalObservedAtMs?: number;
  terminalAnnouncedAtMs?: number;
}): "pending" | "announced" | "observed" {
  if (target.finalObservedAtMs !== undefined) return "observed";
  if (target.terminalAnnouncedAtMs !== undefined) return "announced";
  return "pending";
}

/**
 * Project the single public delivery field from internal delivery state.
 * `completionPush` is no longer a mutable source of truth on records; it is
 * computed here for snapshots and board entries.
 */
export function projectCompletionPush(target: DeliveryTarget): MmrAsyncTaskCompletionPushState {
  if (!target.deliveryOptIn) return "disabled";
  if (target.finalObservedAtMs !== undefined) return "observed";
  if (target.pushOutcome === "failed") return "failed";
  if (target.pushOutcome === "sending") return "sending";
  if (target.terminalAnnouncedAtMs !== undefined) return "announced";
  if (target.pushOutcome === "suppressed") return "suppressed";
  return "pending";
}
