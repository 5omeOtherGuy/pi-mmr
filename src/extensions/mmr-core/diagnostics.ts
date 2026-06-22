import type {
  MmrModeState,
  MmrPolicyDiagnostic,
  MmrPromptAssemblyObservation,
  MmrPromptAssemblyResult,
  MmrPromptPassthroughReason,
} from "./types.js";

const SOURCE = "mmr-core";
const FALLBACK_PROVIDER_WARNING =
  "Using only one provider is not recommended because MMR modes are optimized around model-specific strengths and weaknesses.";

/**
 * Structured policy diagnostics for the current MMR mode state.
 *
 * `/mmr-status` and the activation notification's "Warnings:" block both render
 * `message` verbatim, so the two surfaces stay in sync. Worker tools and later
 * extensions can branch on the stable `code` field.
 *
 * Deferred-tool messages (e.g. "oracle: deferred until mmr-subagents ships")
 * are intentionally **not** policy diagnostics: they are informational "what
 * is coming" announcements rather than active warnings, and surface as a
 * separate `Deferred tools:` section in `/mmr-status` and as their own bullets
 * appended after policy warnings in the activation notification.
 *
 * The compact status bar in `status.ts` summarizes mode/model state only and
 * does not re-render diagnostic messages.
 *
 * Native-control modes never emit model/request/prompt diagnostics: native Pi
 * controls are in charge and MMR-specific model/policy state is intentionally absent.
 */
export function getMmrPolicyDiagnostics(state: MmrModeState): MmrPolicyDiagnostic[] {
  if (state.mode === "free") return [];

  const diagnostics: MmrPolicyDiagnostic[] = [];

  if (state.mode === "open") {
    if (state.activeTools.length === 0) {
      diagnostics.push({
        code: "tools.none-active",
        severity: "warning",
        source: SOURCE,
        message: "no active tools resolved",
      });
    }
    if (state.missingTools.length > 0) {
      diagnostics.push({
        code: "tools.missing",
        severity: "warning",
        source: SOURCE,
        message: `missing tools: ${state.missingTools.join(", ")}`,
        data: { tools: [...state.missingTools] },
      });
    }
    if (state.gatedTools.length > 0) {
      diagnostics.push({
        code: "tools.gated",
        severity: "warning",
        source: SOURCE,
        message: `gated tools: ${state.gatedTools.join(", ")}`,
        data: { tools: [...state.gatedTools] },
      });
    }
    if (state.disabledTools.length > 0) {
      diagnostics.push({
        code: "tools.disabled",
        severity: "warning",
        source: SOURCE,
        message: `disabled tools: ${state.disabledTools.join(", ")}`,
        data: { tools: [...state.disabledTools] },
      });
    }
    for (const note of state.availabilityNotes) {
      diagnostics.push({
        code: "availability",
        severity: "warning",
        source: SOURCE,
        message: note,
        data: { note },
      });
    }
    return diagnostics;
  }

  if (!state.modelApplied) {
    diagnostics.push({
      code: "model.not-applied",
      severity: "warning",
      source: SOURCE,
      message: state.modelFound ? "model was found but not applied" : "no usable model found",
      data: { modelFound: state.modelFound, requestedModels: [...state.requestedModels] },
    });
  } else if (state.modelFallbackApplied) {
    const reason = state.modelFallbackReason ?? "fallback route selected";
    diagnostics.push({
      code: "model.fallback-applied",
      severity: "warning",
      source: SOURCE,
      message: `model fallback applied: ${reason} ${FALLBACK_PROVIDER_WARNING}`,
      data: {
        provider: state.provider,
        model: state.model,
        reason: state.modelFallbackReason,
      },
    });
  }

  if (state.activeTools.length === 0) {
    diagnostics.push({
      code: "tools.none-active",
      severity: "warning",
      source: SOURCE,
      message: "no active tools resolved",
    });
  }

  if (state.missingTools.length > 0) {
    diagnostics.push({
      code: "tools.missing",
      severity: "warning",
      source: SOURCE,
      message: `missing tools: ${state.missingTools.join(", ")}`,
      data: { tools: [...state.missingTools] },
    });
  }

  if (state.gatedTools.length > 0) {
    diagnostics.push({
      code: "tools.gated",
      severity: "warning",
      source: SOURCE,
      message: `gated tools: ${state.gatedTools.join(", ")}`,
      data: { tools: [...state.gatedTools] },
    });
  }

  if (state.disabledTools.length > 0) {
    diagnostics.push({
      code: "tools.disabled",
      severity: "warning",
      source: SOURCE,
      message: `disabled tools: ${state.disabledTools.join(", ")}`,
      data: { tools: [...state.disabledTools] },
    });
  }

  if (
    typeof state.effectiveContextWindow === "number"
    && Number.isFinite(state.effectiveContextWindow)
    && state.effectiveContextWindow > 0
    && typeof state.registeredContextWindow === "number"
    && Number.isFinite(state.registeredContextWindow)
    && state.registeredContextWindow > state.effectiveContextWindow
  ) {
    const profile = state.effectiveContextWindow;
    const registered = state.registeredContextWindow;
    const route = state.provider && state.model ? `${state.provider}/${state.model}` : "selected route";
    diagnostics.push({
      code: "context.registered-exceeds-profile",
      severity: "warning",
      source: SOURCE,
      message: `mode profile ${profile} tokens is smaller than registered window ${registered} tokens for ${route}; Pi-native compaction follows the registered window, so the mode profile is a display budget only`,
      data: {
        provider: state.provider || undefined,
        model: state.model || undefined,
        effectiveContextWindow: profile,
        registeredContextWindow: registered,
      },
    });
  }

  const promptAssembly = state.promptAssembly;
  if (promptAssembly?.unexpectedPassthroughReason) {
    diagnostics.push({
      code: "prompt.head-not-applied",
      severity: "warning",
      source: SOURCE,
      message:
        `locked-mode prompt head was not applied (reason: ${promptAssembly.unexpectedPassthroughReason}); `
        + "Pi's prompt was preserved unchanged, so this mode's tool posture and guidance are not in effect this turn",
      data: { reason: promptAssembly.unexpectedPassthroughReason },
    });
  }
  if (promptAssembly?.selectedToolsMissingFromPrompt || promptAssembly?.selectedToolsExtraInPrompt) {
    const missing = promptAssembly.selectedToolsMissingFromPrompt ?? [];
    const extra = promptAssembly.selectedToolsExtraInPrompt ?? [];
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`active but absent from prompt selection: ${missing.join(", ")}`);
    if (extra.length > 0) parts.push(`in prompt selection but not mode-active: ${extra.join(", ")}`);
    diagnostics.push({
      code: "tools.prompt-selection-mismatch",
      severity: "warning",
      source: SOURCE,
      message: `active tools differ from the prompt's tool selection (${parts.join("; ")})`,
      data: { missingFromPrompt: [...missing], extraInPrompt: [...extra] },
    });
  }

  for (const note of state.availabilityNotes) {
    diagnostics.push({
      code: "availability",
      severity: "warning",
      source: SOURCE,
      message: note,
      data: { note },
    });
  }

  return diagnostics;
}

/** Minimal structural view of Pi's `BuildSystemPromptOptions` we consume. */
interface MmrSystemPromptOptionsView {
  selectedTools?: string[];
  customPrompt?: string;
}

/**
 * Passthrough reasons that indicate the Pi-auto head could not be located in
 * the expected shape (anchor drift / section reorder), as opposed to the
 * benign `not-prompted-mode` case.
 */
const DRIFT_PASSTHROUGH_REASONS: ReadonlySet<MmrPromptPassthroughReason> = new Set([
  "identity-anchor-missing",
  "section-anchor-missing",
  "section-order-invalid",
  "section-boundary-missing",
]);

function readSelectedTools(options: MmrSystemPromptOptionsView | undefined): string[] | undefined {
  if (!options || !Array.isArray(options.selectedTools)) return undefined;
  return options.selectedTools.filter((name): name is string => typeof name === "string");
}

function hasCustomPrompt(options: MmrSystemPromptOptionsView | undefined): boolean {
  return typeof options?.customPrompt === "string" && options.customPrompt.length > 0;
}

/**
 * Derive the runtime-only prompt-assembly observation from the most recent
 * `before_agent_start` turn. Pure: callers store the result on
 * `state.promptAssembly` so {@link getMmrPolicyDiagnostics} can surface it.
 *
 * - Drift: a non-benign passthrough is reported only when Pi supplied
 *   structured options and there is no custom system prompt, so a user's
 *   `--system-prompt`/`SYSTEM.md` is never mistaken for anchor drift, and
 *   hosts that omit options stay silent rather than guess.
 * - Reconciliation: compares the mode's resolved active tools against the
 *   tool selection Pi rendered the prompt from (`selectedTools`), as sets.
 *
 * Returns `undefined` for free mode and for clean turns with nothing to report.
 */
export function buildPromptAssemblyObservation(
  state: MmrModeState,
  surface: Pick<MmrPromptAssemblyResult, "passthroughReason">,
  options: MmrSystemPromptOptionsView | undefined,
): MmrPromptAssemblyObservation | undefined {
  if (state.mode === "free" || state.mode === "open") return undefined;
  const observation: MmrPromptAssemblyObservation = {};

  const reason = surface.passthroughReason;
  if (
    reason !== undefined
    && DRIFT_PASSTHROUGH_REASONS.has(reason)
    && options !== undefined
    && !hasCustomPrompt(options)
  ) {
    observation.unexpectedPassthroughReason = reason;
  }

  const selectedTools = readSelectedTools(options);
  if (selectedTools !== undefined) {
    const selectedSet = new Set(selectedTools);
    const activeSet = new Set(state.activeTools);
    const missing = [...activeSet].filter((name) => !selectedSet.has(name)).sort();
    const extra = [...selectedSet].filter((name) => !activeSet.has(name)).sort();
    if (missing.length > 0) observation.selectedToolsMissingFromPrompt = missing;
    if (extra.length > 0) observation.selectedToolsExtraInPrompt = extra;
  }

  return observation.unexpectedPassthroughReason !== undefined
    || observation.selectedToolsMissingFromPrompt !== undefined
    || observation.selectedToolsExtraInPrompt !== undefined
    ? observation
    : undefined;
}
