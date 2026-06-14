/**
 * Per-mode active-model context-window cap.
 *
 * Locked modes advertise a context-window budget (see `MMR_REQUEST_POLICIES`
 * and `/mode`). Native Pi keys all compaction, overflow, footer, percent, and
 * `getContextUsage()` behavior off `agent.state.model.contextWindow`, and
 * `pi.setModel(model)` stores the passed object directly. Passing a clone
 * whose `contextWindow` is capped to the mode's advertised window therefore
 * makes Pi compact and display exactly as it natively would at that window —
 * no bespoke compaction shim required — even when the route's native window is
 * larger (e.g. `smart` pins its 1M Opus route to 300k). The GPT/Codex-primary
 * modes (`smartGPT`, `rush`, `deep`) set no `contextWindow`, so this is a pure
 * no-op for them and every GPT/Codex route runs at Pi's own registered window.
 *
 * The cap is derived from each mode's own request policy so the window Pi
 * compacts against and the window the mode advertises stay in sync (single
 * source of truth). It is applied at the `setModel` call site (see
 * `mode-controller.ts`) and reasserted defensively if another extension or
 * `/login` transiently re-resolves the active model from the registry.
 */

import { MMR_REQUEST_POLICIES } from "./request-policy.js";

/**
 * Smart-mode active-model context window. Kept as a named export for
 * call sites and tests; derived from the smart policy so it cannot drift.
 */
export const MMR_SMART_CONTEXT_WINDOW = getMmrModeContextWindowCap("smart") ?? 300_000;

/**
 * Resolve the context-window cap for a mode, or `undefined` when the mode does
 * not cap. Modes without a request policy (`free`) and unknown mode keys never
 * cap. The cap value is the mode's advertised `contextWindow` profile.
 */
export function getMmrModeContextWindowCap(modeKey: string): number | undefined {
  const policies = MMR_REQUEST_POLICIES as Record<string, { contextWindow?: number } | undefined>;
  const cap = policies[modeKey]?.contextWindow;
  return typeof cap === "number" && Number.isFinite(cap) ? cap : undefined;
}

/**
 * Clone-and-cap a model's `contextWindow` for a given mode. No-op unless the
 * mode declares a cap (`smart` and `large`; `free` and the GPT/Codex-primary
 * modes do not) and the model's window exceeds that cap. Caps DOWN only, so a
 * custom provider with a smaller window stays authoritative.
 *
 * Returns the input reference unchanged when no cap applies, so callers can
 * use identity comparison (`result !== model`) to detect whether a cap was
 * applied. A shallow clone preserves provider/id and every other field;
 * Pi's auth (`hasConfiguredAuth`/`isUsingOAuth`), `modelsAreEqual`
 * (model cycling), and compaction's `sameModel` check all compare
 * provider+id and never `contextWindow`, so the clone is safe.
 */
export function withMmrModeContextCap<T extends { contextWindow?: number }>(
  modeKey: string,
  model: T,
): T {
  const cap = getMmrModeContextWindowCap(modeKey);
  if (cap === undefined) return model;
  const current = model.contextWindow;
  if (typeof current !== "number" || !Number.isFinite(current)) return model;
  if (current <= cap) return model;
  return { ...model, contextWindow: cap };
}
