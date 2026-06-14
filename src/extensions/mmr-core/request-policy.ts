import { isRecord } from "./internal/json.js";
import type { MmrModeKey } from "./types.js";

/**
 * Per-mode request-policy module.
 *
 * Pure data + a single shape-detecting transformer used by mmr-core's
 * `before_provider_request` hook. The transformer is the only place that
 * knows the exact numbers (max output, thinking budgets, reasoning effort,
 * effective input cap) for each locked mode. It mutates only a small
 * allowlist of payload fields and never touches `system`, `messages`,
 * `input`, `tools`, headers, model id, base URL, or provider auth.
 *
 * Shape detection is structural, not provider-id-based, so:
 *   - Pi-native `anthropic`,
 *   - subscription-backed Anthropic providers (e.g. `claude-subscription`),
 *   - any future custom provider that emits Anthropic-shaped payloads,
 * all flow through the same Anthropic branch. Non-matching shapes (unknown
 * providers, RPC-bridge wrappers, etc.) are returned untouched.
 */

export type MmrAnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface MmrAnthropicAdaptiveThinking {
  type: "adaptive";
  display?: "summarized" | "raw";
  outputConfigEffort?: MmrAnthropicEffort;
}

export interface MmrAnthropicBudgetThinking {
  type: "enabled";
  budgetTokens: number;
  display?: "summarized" | "raw";
}

export interface MmrAnthropicDisabledThinking {
  type: "disabled";
}

export type MmrAnthropicThinking =
  | MmrAnthropicAdaptiveThinking
  | MmrAnthropicBudgetThinking
  | MmrAnthropicDisabledThinking;

export interface MmrOpenAiResponsesReasoning {
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "concise" | "detailed";
}

export interface MmrRequestPolicy {
  /** Mutations applied to Anthropic-shaped payloads. */
  anthropic?: {
    maxTokens?: number;
    thinking?: MmrAnthropicThinking;
  };
  /** Mutations applied to OpenAI Responses-shaped payloads. */
  openaiResponses?: {
    maxOutputTokens?: number;
    reasoning?: MmrOpenAiResponsesReasoning;
  };
  /** Total context window for this mode/model profile. */
  contextWindow?: number;
  /**
   * Mode max-input profile used for diagnostics and provider-route clamping.
   * Undefined means "use the model's registered context behavior".
   */
  effectiveMaxInputTokens?: number;
}

/**
 * Per-mode policies for each locked MMR mode. Free mode has no policy;
 * mmr-core's hook is a no-op while the mode is `free`.
 *
 * Notes on the shape choices:
 * - SMART uses adaptive thinking with `output_config.effort=high` for its
 *   Opus 4.8 profile. SMART's GPT fallback sets only Responses reasoning
 *   effort (no `max_output_tokens` override), so Opus-specific output caps
 *   do not leak onto GPT payloads.
 * - LARGE uses adaptive thinking with `output_config.effort=medium` for its
 *   Opus 4.6 profile (and `max_tokens=32000`). LARGE's GPT fallback sets
 *   Responses reasoning effort only, matching the generic OpenAI default.
 * - RUSH uses OpenAI Responses with `reasoning.effort=none` and
 *   `max_output_tokens=128000` for the GPT-5.5 profile. Its Haiku fallback
 *   relies on the mode's `thinkingLevel: "off"` rather than an Anthropic
 *   budget-thinking override.
 * - DEEP uses OpenAI Responses with `reasoning.effort=medium` and
 *   `summary=auto`, plus `max_output_tokens=128000`.
 * - Context triples are the mode's total context window / max output / max
 *   input. They are surfaced in `/mode` and `/mmr-status`. This module does
 *   not write any context fields into provider payloads. A mode that sets a
 *   `contextWindow` caps the active model's `contextWindow` to that profile
 *   total at the `setModel` call site (see `context-cap.ts`), so Pi's native
 *   compaction/overflow/footer run at the advertised window even when the
 *   route's native window is larger (e.g. `smart` pins its Opus route to 300k).
 *   The GPT/Codex-primary modes (`smartGPT`, `rush`, `deep`) intentionally set
 *   no `contextWindow`, so every GPT/Codex route runs at Pi's own registered
 *   window (the observed Codex backend limit) with no pi-mmr override. The cap
 *   is cap-down only, so a smaller custom route stays authoritative, and `free`
 *   (no policy) is never capped.
 */
export const MMR_REQUEST_POLICIES: Record<Exclude<MmrModeKey, "free">, MmrRequestPolicy> = {
  smart: {
    anthropic: {
      maxTokens: 32000,
      // Anthropic adaptive effort follows the native Opus route's Pi-level map
      // (Option 1: Pi medium -> Anthropic high). The medium toggle preset pins
      // the same value; the high preset maps Pi high -> Anthropic xhigh.
      thinking: { type: "adaptive", display: "summarized", outputConfigEffort: "high" },
    },
    openaiResponses: {
      reasoning: { effort: "medium", summary: "auto" },
    },
    // smart caps the active Opus route to a 300k window (see context-cap.ts);
    // every locked mode caps to its profile total this way. Keep the display
    // metadata consistent: 300k total - 32k max-output = 268k.
    contextWindow: 300_000,
    effectiveMaxInputTokens: 268_000,
  },
  smartGPT: {
    openaiResponses: {
      maxOutputTokens: 128000,
      reasoning: { effort: "medium", summary: "auto" },
    },
    // No context override: GPT/Codex routes run at Pi's own registered window
    // (the observed Codex backend limit, pi#3641). pi-mmr deliberately does not
    // carry its own number here so it cannot drift from Pi's metadata.
  },
  large: {
    anthropic: {
      maxTokens: 32000,
      thinking: { type: "adaptive", display: "summarized", outputConfigEffort: "medium" },
    },
    openaiResponses: {
      reasoning: { effort: "medium", summary: "auto" },
    },
    contextWindow: 1000000,
    effectiveMaxInputTokens: 968000,
  },
  rush: {
    openaiResponses: {
      maxOutputTokens: 128000,
      reasoning: { effort: "none" },
    },
    // No context override; GPT/Codex routes run at Pi's registered window. See
    // smartGPT above.
  },
  deep: {
    anthropic: {
      thinking: { type: "adaptive", display: "summarized", outputConfigEffort: "medium" },
    },
    openaiResponses: {
      maxOutputTokens: 128000,
      reasoning: { effort: "medium", summary: "auto" },
    },
    // No context override; GPT/Codex routes run at Pi's registered window. The
    // Opus fallback likewise runs at its native window (only `smart` pins Opus).
    // See smartGPT above.
  },
};

/**
 * Thinking levels that participate in the alt+r in-mode toggle. Restricted to the
 * subset that is valid both as an Anthropic adaptive `output_config.effort`
 * (`low|medium|high|xhigh|max`) and as an OpenAI Responses `reasoning.effort`
 * (`none|minimal|low|medium|high|xhigh`), so the level can drive both wire
 * shapes without casts.
 */
export type MmrToggleThinkingLevel = "medium" | "high" | "xhigh";

/**
 * One toggle preset for a toggleable mode. `level` is the Pi/session thinking
 * level and the OpenAI Responses `reasoning.effort`. `anthropicEffort`, when
 * set, overrides the Anthropic adaptive `output_config.effort` so the wire
 * effort matches the native provider's Pi-level->Anthropic-effort mapping
 * (Smart maps Pi `high` -> Anthropic `xhigh`) instead of echoing the Pi level
 * string verbatim. `maxTokens`, when set, overrides the mode's Anthropic
 * `max_tokens` for this level.
 */
export interface MmrModeThinkingOption {
  level: MmrToggleThinkingLevel;
  anthropicEffort?: MmrAnthropicEffort;
  maxTokens?: number;
}

/**
 * Modes whose thinking level can be toggled between exactly two presets.
 * Index 0 is the default preset (also the mode's static `thinkingLevel`).
 *
 * Smart's high preset asks for Anthropic `xhigh` effort (Pi `high` maps to
 * Anthropic `xhigh` on the Opus route) while keeping the Anthropic output
 * budget at the mode default (32k). Both Smart presets therefore send the
 * same 32k admission shape and differ only in adaptive reasoning effort
 * (`high` vs `xhigh`), avoiding the heavier 64k output reservation that
 * reduced admission stability under Opus capacity pressure.
 */
export const MMR_MODE_THINKING_TOGGLES = {
  smart: [{ level: "medium", anthropicEffort: "high" }, { level: "high", anthropicEffort: "xhigh" }],
  smartGPT: [{ level: "medium" }, { level: "xhigh" }],
  deep: [{ level: "medium" }, { level: "xhigh" }],
} as const satisfies Partial<Record<MmrModeKey, readonly [MmrModeThinkingOption, MmrModeThinkingOption]>>;

export type MmrToggleableModeKey = keyof typeof MMR_MODE_THINKING_TOGGLES;

export function isToggleableMmrMode(modeKey: MmrModeKey): modeKey is MmrToggleableModeKey {
  return Object.hasOwn(MMR_MODE_THINKING_TOGGLES, modeKey);
}

export function getMmrModeThinkingOptions(
  modeKey: MmrToggleableModeKey,
): readonly [MmrModeThinkingOption, MmrModeThinkingOption] {
  return MMR_MODE_THINKING_TOGGLES[modeKey];
}

/** Default toggle level for a toggleable mode (the first preset). */
export function getDefaultToggleThinkingLevel(modeKey: MmrToggleableModeKey): MmrToggleThinkingLevel {
  return MMR_MODE_THINKING_TOGGLES[modeKey][0].level;
}

/**
 * Compute the toggle target from the currently applied level. When the current
 * level is the second preset, return the first; otherwise (default level or an
 * unrecognized value) return the second preset. This makes repeated presses
 * alternate cleanly between the two configured levels.
 */
export function getOtherToggleThinkingLevel(
  modeKey: MmrToggleableModeKey,
  current: string | undefined,
): MmrToggleThinkingLevel {
  const [first, second] = MMR_MODE_THINKING_TOGGLES[modeKey];
  return current === second.level ? first.level : second.level;
}

function findThinkingOption(modeKey: MmrToggleableModeKey, level: MmrToggleThinkingLevel): MmrModeThinkingOption | undefined {
  return MMR_MODE_THINKING_TOGGLES[modeKey].find((option) => option.level === level);
}

/**
 * Return a new policy with its reasoning effort (and any per-level
 * `max_tokens` override) adjusted to the given toggle level. Pure: never
 * mutates the input policy or the shared `MMR_REQUEST_POLICIES` data, so
 * toggling one mode cannot corrupt another mode's static defaults.
 */
export function applyMmrThinkingLevelToPolicy(
  modeKey: MmrToggleableModeKey,
  policy: MmrRequestPolicy,
  level: MmrToggleThinkingLevel,
): MmrRequestPolicy {
  const next: MmrRequestPolicy = { ...policy };
  const option = findThinkingOption(modeKey, level);
  // Anthropic adaptive effort follows the provider's Pi-level->effort mapping
  // when a preset pins it (Smart high -> xhigh); otherwise it echoes the Pi
  // level. OpenAI Responses effort always tracks the Pi level below.
  const anthropicEffort: MmrAnthropicEffort = option?.anthropicEffort ?? level;

  if (policy.anthropic) {
    const anthropic = { ...policy.anthropic };
    if (anthropic.thinking?.type === "adaptive") {
      anthropic.thinking = { ...anthropic.thinking, outputConfigEffort: anthropicEffort };
    }
    if (option?.maxTokens !== undefined) {
      anthropic.maxTokens = option.maxTokens;
      // A larger output reservation reduces the usable input window on the
      // shared context budget; keep the displayed max-input profile honest.
      if (typeof policy.contextWindow === "number" && typeof policy.effectiveMaxInputTokens === "number") {
        next.effectiveMaxInputTokens = Math.max(policy.contextWindow - option.maxTokens, 0);
      }
    }
    next.anthropic = anthropic;
  }

  if (policy.openaiResponses?.reasoning) {
    next.openaiResponses = {
      ...policy.openaiResponses,
      reasoning: { ...policy.openaiResponses.reasoning, effort: level },
    };
  }

  return next;
}

/** Optional model metadata used to clamp the soft context cap. */
export interface MmrRegisteredModelMetadata {
  contextWindow?: number;
  maxTokens?: number;
}

// Intentionally a DISTINCT compact format from status.ts's `formatFooterTokens`
// (and the shared mmr-core/token-format.ts compact tiers). This policy display
// uses Number.isInteger gating + toFixed (e.g. 12345 -> "12.3k", 1_000 -> "1k"),
// whereas the footer uses Math.round (12345 -> "12k"). Do not collapse the two
// onto one helper: that would silently change operator-visible numbers.
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return String(count);
}

/**
 * Build a minimal request policy that only caps per-request output tokens.
 *
 * Used for subagent workers, which are not locked modes and therefore have
 * no `MMR_REQUEST_POLICIES` entry, but whose profile may declare a
 * `maxOutputTokens` hard cap. Sets both the Anthropic (`max_tokens`) and OpenAI Responses
 * (`max_output_tokens`) fields so the cap applies regardless of which
 * provider the worker resolved to. Returns `undefined` for non-positive or
 * non-finite inputs so callers can skip applying any policy.
 */
export function buildMmrSubagentOutputPolicy(
  maxOutputTokens: number | undefined,
): MmrRequestPolicy | undefined {
  if (typeof maxOutputTokens !== "number" || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return undefined;
  }
  return {
    anthropic: { maxTokens: maxOutputTokens },
    openaiResponses: { maxOutputTokens },
  };
}

export interface MmrRequestPolicyOptions {
  /** Resolved Pi provider id for the payload, when known. */
  providerId?: string;
}

export function getMmrPolicyMaxOutputTokens(policy: MmrRequestPolicy | undefined): number | undefined {
  if (!policy) return undefined;
  return policy.anthropic?.maxTokens ?? policy.openaiResponses?.maxOutputTokens;
}

export interface MmrPolicyContextOverrides {
  contextWindow?: number;
  /**
   * Mode-policy max output tokens for display.
   *
   * - `number` overrides the policy default.
   * - `undefined` falls back to the policy default.
   * - `null` explicitly omits the field — used when the resolved provider
   *   does not actually accept `max_output_tokens` on the wire (e.g.
   *   `openai-codex`), so display does not lie about what was sent.
   */
  maxOutputTokens?: number | null;
  /**
   * Mode-policy max input tokens for display.
   *
   * - `number` overrides the policy default.
   * - `undefined` falls back to the policy default.
   * - `null` explicitly omits the field — used when the resolved provider
   *   streams output within the context window (e.g. `openai-codex`), where the
   *   profile's `total - max_output` max-input understates the real usable
   *   input, so it is omitted rather than displayed misleadingly.
   */
  effectiveMaxInputTokens?: number | null;
}

/**
 * Provider ids whose Responses-shaped wire payload does not accept
 * `max_output_tokens`. mmr-core uses this both at the wire layer (to skip
 * the field) and at the display layer (to omit it from /mmr-status, footer
 * status, etc.).
 */
const PROVIDERS_OMITTING_MAX_OUTPUT_TOKENS: ReadonlySet<string> = new Set(["openai-codex"]);

export function providerOmitsMaxOutputTokens(providerId: string | undefined): boolean {
  if (!providerId) return false;
  return PROVIDERS_OMITTING_MAX_OUTPUT_TOKENS.has(providerId);
}

export function formatMmrPolicyThinking(policy: MmrRequestPolicy | undefined): string {
  if (!policy) return "native Pi controls";

  const anthropicThinking = policy.anthropic?.thinking;
  if (anthropicThinking?.type === "adaptive") {
    const effort = anthropicThinking.outputConfigEffort ? `/${anthropicThinking.outputConfigEffort}` : "";
    return `Anthropic adaptive${effort}`;
  }
  if (anthropicThinking?.type === "enabled") {
    return `Anthropic budget ${formatTokenCount(anthropicThinking.budgetTokens)}`;
  }
  if (anthropicThinking?.type === "disabled") return "Anthropic disabled";

  const reasoning = policy.openaiResponses?.reasoning;
  if (reasoning) {
    const summary = reasoning.summary ? ` (summary ${reasoning.summary})` : "";
    return `OpenAI Responses ${reasoning.effort}${summary}`;
  }

  return "provider default";
}

export function formatMmrPolicyContext(policy: MmrRequestPolicy | undefined, overrides: MmrPolicyContextOverrides = {}): string {
  if (!policy) return "native Pi controls";

  const contextWindow = overrides.contextWindow ?? policy.contextWindow;
  const maxOutputTokens = overrides.maxOutputTokens === null
    ? undefined
    : (overrides.maxOutputTokens ?? getMmrPolicyMaxOutputTokens(policy));
  const maxInputTokens = overrides.effectiveMaxInputTokens === null
    ? undefined
    : (overrides.effectiveMaxInputTokens ?? policy.effectiveMaxInputTokens);

  const parts: string[] = [];
  if (typeof contextWindow === "number") parts.push(`${formatTokenCount(contextWindow)} total`);
  if (typeof maxOutputTokens === "number") parts.push(`${formatTokenCount(maxOutputTokens)} max out`);
  if (typeof maxInputTokens === "number") parts.push(`${formatTokenCount(maxInputTokens)} max in`);
  if (parts.length > 0) return parts.join(" / ");
  return "provider default";
}

export function formatMmrPolicyStatus(policy: MmrRequestPolicy | undefined, overrides: MmrPolicyContextOverrides = {}): string {
  if (!policy) return "native-controls";
  const thinking = formatMmrPolicyThinking(policy)
    .replace(/^Anthropic /, "")
    .replace(/^OpenAI Responses /, "responses:");
  const context = formatMmrPolicyContext(policy, overrides)
    .replace(/ total \/ /g, "/")
    .replace(/ max out \/ /g, "/")
    .replace(/ max out$/, "")
    .replace(/ total$/, "")
    .replace(/ max in$/, "");
  return `think:${thinking} ctx:${context}`;
}

/**
 * Clamp mode context metadata to the registered model's available input window.
 * If a mode has no `effectiveMaxInputTokens`, the context-window display may
 * still be clamped but no mode max-input profile is shown.
 *
 * When a profile exists, the displayed max-input value is the smaller of:
 *   - the mode policy value, and
 *   - `model.contextWindow - policy max output` (provider registration plus
 *     MMR's actual output cap).
 *
 * mmr-core never enlarges displayed context metadata above what the registered
 * model declares, so a custom provider with a smaller window stays authoritative.
 * Returns a new policy object only when the displayed metadata changed;
 * otherwise returns the input policy for cheap identity comparisons.
 *
 * Display-clamp only: this function shapes `/mmr-status` and footer numbers.
 * It does not enforce a soft cap on provider sends. For most modes Pi-native
 * compaction follows the registered route's `contextWindow`/`maxTokens`
 * verbatim. Every locked mode caps the *active* model's window to its profile
 * total via `withMmrModeContextCap` at the `setModel` call site, and callers
 * pass that already-capped model here, so the clamped display numbers and the
 * window Pi compacts against agree. If a route's (post-cap) window still
 * exceeds the mode profile, the `context.registered-exceeds-profile`
 * diagnostic surfaces that mismatch.
 */
export function clampPolicyToRegisteredModel(
  policy: MmrRequestPolicy,
  model: MmrRegisteredModelMetadata | undefined,
): MmrRequestPolicy {
  if (!model || typeof model.contextWindow !== "number" || !Number.isFinite(model.contextWindow)) {
    return policy;
  }
  const policyMaxOutput = getMmrPolicyMaxOutputTokens(policy);
  const reservedOutput = typeof policyMaxOutput === "number" && Number.isFinite(policyMaxOutput)
    ? Math.max(policyMaxOutput, 0)
    : typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)
      ? Math.max(model.maxTokens, 0)
      : 0;
  const registeredInputCap = Math.max(model.contextWindow - reservedOutput, 0);
  const policyInputProfile = policy.effectiveMaxInputTokens;
  const registeredContextWindow = Math.max(model.contextWindow, 0);
  const contextWindow = typeof policy.contextWindow === "number" && Number.isFinite(policy.contextWindow)
    ? Math.min(policy.contextWindow, registeredContextWindow)
    : policy.contextWindow;

  const withContextWindow = contextWindow !== policy.contextWindow ? { ...policy, contextWindow } : policy;

  if (policyInputProfile === undefined) return withContextWindow;

  if (registeredInputCap === 0 || policyInputProfile <= registeredInputCap) return withContextWindow;
  return { ...withContextWindow, effectiveMaxInputTokens: registeredInputCap };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

/** Anthropic Messages API shape (native + minimalcc + any custom provider that targets it). */
function isAnthropicShape(payload: unknown): payload is Record<string, unknown> & { messages: unknown[]; max_tokens: unknown } {
  if (!isRecord(payload)) return false;
  if (typeof payload.model !== "string") return false;
  if (!Array.isArray(payload.messages)) return false;
  if (!hasOwn(payload, "max_tokens")) return false;

  // `model` + `messages` + `max_tokens` also matches many OpenAI-chat-style
  // and custom payloads. Require an Anthropic-specific top-level marker so
  // unknown/custom lookalikes fall open unchanged.
  return hasOwn(payload, "system")
    || hasOwn(payload, "thinking")
    || hasOwn(payload, "output_config");
}

/** OpenAI Responses API shape (openai, openai-codex, azure-openai-responses, github-copilot, ...). */
function isOpenAiResponsesShape(payload: unknown): payload is Record<string, unknown> & { input: unknown[] } {
  if (!isRecord(payload)) return false;
  if (typeof payload.model !== "string") return false;
  if (!Array.isArray(payload.input)) return false;
  // Plain `{ model, input: [] }` can be a custom provider/RPC bridge shape.
  // Pi's Responses-family providers expose at least one Responses-specific
  // generation/reasoning field by the time this hook runs. Codex's variant
  // (chat-gpt subscription) uses `instructions` + `text.verbosity` instead
  // of `max_output_tokens`, so accept those as Responses markers too.
  if (hasOwn(payload, "max_output_tokens") || hasOwn(payload, "reasoning")) return true;
  if (typeof payload.instructions === "string") return true;
  if (isRecord(payload.text) && typeof (payload.text as Record<string, unknown>).verbosity === "string") return true;
  return false;
}

/**
 * Detect Pi's `openai-codex` variant of the Responses payload.
 *
 * Codex's backend (ChatGPT subscription) rejects `max_output_tokens` on the
 * wire. Pi builds Codex payloads with these distinguishing markers, none of
 * which are emitted by Pi's public OpenAI / Azure OpenAI Responses providers:
 *
 *   - top-level `instructions` as a string (public Responses puts the system
 *     prompt into `input` messages instead),
 *   - `text.verbosity` (Codex-only generation control).
 *
 * `include: ["reasoning.encrypted_content"]` is **not** used as a marker:
 * the public Responses API also accepts that include, so it is not unique.
 */
function isOpenAiCodexVariantPayload(payload: Record<string, unknown>): boolean {
  if (typeof payload.instructions === "string") return true;
  const text = payload.text;
  if (isRecord(text) && typeof (text as Record<string, unknown>).verbosity === "string") return true;
  return false;
}

function withoutOutputConfigEffort(outputConfig: unknown): unknown {
  if (!isRecord(outputConfig)) return undefined;
  const next = { ...outputConfig };
  delete next.effort;
  return Object.keys(next).length > 0 ? next : undefined;
}

function applyAnthropic(payload: Record<string, unknown>, anthropic: NonNullable<MmrRequestPolicy["anthropic"]>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  // Drop body-level `anthropic_beta` (e.g. "interleaved-thinking-2025-05-14")
  // when MMR is applying its own Anthropic policy. The adaptive/budget
  // thinking shapes (`thinking={type:"adaptive"|"enabled"}`) supersede the
  // older interleaved-thinking opt-in, so leaving a stale body-level beta
  // alongside MMR's thinking field can produce conflicting wire signals.
  // No-op when the field is absent. See request-policy tests for coverage.
  if (Object.hasOwn(next, "anthropic_beta")) delete next.anthropic_beta;

  if (typeof anthropic.maxTokens === "number") {
    next.max_tokens = anthropic.maxTokens;
  }

  if (anthropic.thinking) {
    if (anthropic.thinking.type === "adaptive") {
      const thinking: Record<string, unknown> = { type: "adaptive" };
      if (anthropic.thinking.display) thinking.display = anthropic.thinking.display;
      next.thinking = thinking;
      if (anthropic.thinking.outputConfigEffort) {
        const previousOutputConfig = isRecord(payload.output_config) ? payload.output_config : {};
        next.output_config = { ...previousOutputConfig, effort: anthropic.thinking.outputConfigEffort };
      } else {
        // Mode policy did not pin an effort: leave any prior output_config alone.
      }
    } else if (anthropic.thinking.type === "enabled") {
      const thinking: Record<string, unknown> = {
        type: "enabled",
        budget_tokens: anthropic.thinking.budgetTokens,
      };
      if (anthropic.thinking.display) thinking.display = anthropic.thinking.display;
      next.thinking = thinking;
      // Budget-thinking modes (e.g. RUSH) must not also send output_config.effort.
      // Preserve any future unrelated output_config fields if present.
      const stripped = withoutOutputConfigEffort(payload.output_config);
      if (stripped === undefined) delete next.output_config;
      else next.output_config = stripped;
    } else {
      next.thinking = { type: "disabled" };
      const stripped = withoutOutputConfigEffort(payload.output_config);
      if (stripped === undefined) delete next.output_config;
      else next.output_config = stripped;
    }
  }

  return next;
}

function applyOpenAiResponses(
  payload: Record<string, unknown>,
  openai: NonNullable<MmrRequestPolicy["openaiResponses"]>,
  options: { skipMaxOutputTokens?: boolean } = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };

  if (options.skipMaxOutputTokens) {
    // The Codex variant rejects `max_output_tokens` even if the caller
    // pre-populated one. Strip both the policy write and any inbound value
    // so the wire payload matches what Pi's Codex provider accepts.
    delete next.max_output_tokens;
  } else if (typeof openai.maxOutputTokens === "number") {
    next.max_output_tokens = openai.maxOutputTokens;
  }

  if (openai.reasoning) {
    const previous = isRecord(payload.reasoning) ? payload.reasoning : {};
    next.reasoning = {
      ...previous,
      effort: openai.reasoning.effort,
      ...(openai.reasoning.summary ? { summary: openai.reasoning.summary } : {}),
    };
  }

  return next;
}

/**
 * Apply an MMR request policy to a provider-bound payload.
 *
 * Pure transformer: returns the input reference unchanged when the policy is
 * undefined or the payload shape is not recognized. When a known shape
 * matches, returns a shallow-cloned object with only the allowed fields
 * mutated. Never throws on unknown payloads — falling open is intentional so
 * future custom providers continue to work without an mmr-core update.
 */
export function applyMmrRequestPolicy(
  payload: unknown,
  policy: MmrRequestPolicy | undefined,
  options: MmrRequestPolicyOptions = {},
): unknown {
  if (!policy) return payload;

  if (isAnthropicShape(payload) && policy.anthropic) {
    return applyAnthropic(payload, policy.anthropic);
  }

  if (isOpenAiResponsesShape(payload) && policy.openaiResponses) {
    const skipMaxOutputTokens = providerOmitsMaxOutputTokens(options.providerId) || isOpenAiCodexVariantPayload(payload);
    return applyOpenAiResponses(payload, policy.openaiResponses, { skipMaxOutputTokens });
  }

  return payload;
}
