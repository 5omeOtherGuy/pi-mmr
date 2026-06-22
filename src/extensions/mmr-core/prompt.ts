import { assembleActiveSurface } from "./prompt-assembly.js";
import type { MmrModeState } from "./types.js";

export const MMR_PROMPT_LAYER_START = "<!-- mmr-core:start -->";
export const MMR_PROMPT_LAYER_END = "<!-- mmr-core:end -->";

export interface MmrPromptLayerContext {
  state: MmrModeState;
  /** Pi's current chained system prompt for this turn. Read-only input. */
  baseSystemPrompt: string;
}

/**
 * Build the full system prompt for the current MMR mode.
 *
 * This function is a thin wrapper around
 * `assembleActiveSurface()`. The wrapper preserves the existing
 * `before_agent_start` wiring (which passes only `state` + base prompt and
 * expects a string), while the new ordered-block surface is available via
 * `assembleActiveSurface()` for tests, the debug renderer, and future
 * registry-driven consumers.
 *
 * Splice behavior is unchanged with one exception: the Pi-authored
 * `Guidelines:` block now passes through byte-identically. Earlier versions
 * filtered out two unconditional bullets ("Be concise...", "Show file
 * paths..."); the policy is to never edit Pi-authored blocks.
 *
 * Returns Pi's prompt unchanged when:
 *   - the mode is `open` or `free`;
 *   - the Pi-auto head cannot be located (`--system-prompt` / `SYSTEM.md`
 *     custom prompt, or unexpected layout);
 *   - the auto sections are out of the expected order
 *     (`identity < tools < guidelines < pi docs`).
 */
export function buildMmrPromptLayer(context: MmrPromptLayerContext): string {
  return assembleActiveSurface({
    state: context.state,
    baseSystemPrompt: context.baseSystemPrompt,
    activeToolManifest: [],
  }).systemPrompt;
}
