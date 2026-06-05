import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type MmrModeKey = "smart" | "smartGPT" | "rush" | "large" | "deep" | "free";

/**
 * Locked mode keys (every mode except `free`). Used by settings that only
 * apply while a locked mode is active, such as `lockedModeExtraTools`.
 */
export type MmrLockedModeKey = Exclude<MmrModeKey, "free">;

export type MmrPromptRoute = "default" | "rush" | "deep";

export type MmrModeSelectionSource = "flag" | "command" | "session" | "settings" | "default" | "native";

export interface MmrModelPreference {
  /** Provider-neutral model ID, e.g. "gpt-5.5" or "claude-opus-4-8". */
  model: string;
  /** Optional explicit provider route override. Omit to let MMR prefer subscription routes automatically. */
  providers?: string[];
  /** Optional thinking level override for this fallback candidate. */
  thinkingLevel?: ThinkingLevel;
}

export interface MmrModeDefinition {
  key: MmrModeKey;
  displayName: string;
  description: string;
  /** Ordered provider-neutral model preferences. Providers are resolved from the local Pi registry. */
  modelPreferences: MmrModelPreference[];
  /** Default thinking level for model preferences without their own override. */
  thinkingLevel?: ThinkingLevel;
  /** Concrete Pi tool names this mode requests. Resolved by identity against the active Pi tool inventory. */
  tools: string[];
  promptRoute: MmrPromptRoute;
  featureGates?: string[];
  availabilityNotes?: string[];
}

export type MmrToolStatus = "active" | "missing" | "deferred" | "gated" | "disabled";

/**
 * Status rule a provider can return for an exact (canonical) tool name.
 *
 * Active-tool resolution is identity-only: a requested name activates when
 * Pi's live tool inventory exposes a tool with that exact name. Providers do
 * not map between names; they only claim ownership and report status for
 * tools they own.
 *
 * - `active`: the provider claims ownership and the tool should be active.
 *   The registry confirms by identity match against the live Pi inventory;
 *   if Pi has not registered the tool with this name, the decision is
 *   reported as `missing` and credited to this provider as owner.
 * - `deferred`: the owning MMR extension has not shipped or registered the
 *   tool yet. Used to give /mmr-status a stable owner for catalog entries.
 * - `gated`: the tool exists but its owning feature gate is currently off.
 * - `disabled`: the tool exists but is administratively disabled.
 *
 * A provider returns `undefined` only for tool names it does not own; the
 * registry then walks lower-priority providers and finally falls back to
 * the exact-name status catalog (`DEFAULT_TOOL_CATALOG`) plus identity
 * match against the live Pi inventory.
 */
export type MmrToolRule =
  | { kind: "active" }
  | { kind: "deferred"; reason: string }
  | { kind: "gated"; reason: string; gate?: string }
  | { kind: "disabled"; reason: string };

export interface MmrToolProvider {
  /** Provider identifier shown in `/mmr-status` and decision diagnostics; doubles as default owner. */
  name: string;
  /**
   * Report a status rule for an exact (canonical) tool name owned by this
   * provider. Return `undefined` to defer (either to a lower-priority
   * provider or to identity-match resolution against the live Pi tool
   * inventory).
   *
   * The registry trims `toolName` before invoking providers (see
   * `lookupRule` in `tool-registry.ts`), so providers may compare it
   * exactly (for example, `Set.has(toolName)`) without defensive trimming.
   * Direct callers that bypass the registry must trim first.
   */
  resolve(toolName: string): MmrToolRule | undefined;
}

export interface MmrToolDecision {
  /** Canonical tool name as requested by the mode. */
  requested: string;
  /** Chosen concrete Pi tool name when active; identity match of `requested`. Undefined for non-active statuses. */
  chosen?: string;
  /** Concrete Pi tool names activated. Singleton `[requested]` when active; empty otherwise. */
  chosenTools: string[];
  /** Tool names considered. `[requested]` when active or when a provider claimed `active` but Pi did not register the tool; empty for deferred/gated/disabled and for default missing. */
  candidates: string[];
  /** Resolved status. */
  status: MmrToolStatus;
  /** Owner extension that produced the rule (e.g. `mmr-core`, `mmr-web`, `mmr-subagents`). */
  owner: string;
  /** User-facing diagnostic text surfaced in `/mmr-status` and activation warnings. */
  diagnostic: string;
}

export interface MmrToolResolution {
  requestedTools: string[];
  /** Concrete Pi tool names activated for the current mode (deduped, order-preserving). */
  activeTools: string[];
  /** Requested tools with no matching Pi tool: either no provider claim plus no identity match and no catalog entry, or a provider claimed `active` but Pi has not registered the tool. */
  missingTools: string[];
  /** Requested tools claimed by an extension catalog entry whose owning extension has not shipped/registered yet. */
  deferredTools: string[];
  /** Requested tools whose owning feature gate is off. */
  gatedTools: string[];
  /** Requested tools explicitly disabled by a provider. */
  disabledTools: string[];
  decisions: MmrToolDecision[];
}

export interface MmrRejectedModeSource {
  source: string;
  value: string;
  reason: string;
}

export interface MmrModeSelection {
  mode: MmrModeKey;
  source: MmrModeSelectionSource;
  warnings: string[];
  rejectedSources: MmrRejectedModeSource[];
}

export type MmrFeatureGateStatus = "missing" | "enabled" | "disabled";

export interface MmrFeatureGateDecision {
  gate: string;
  status: MmrFeatureGateStatus;
  reason: string;
  /** Identifier of the resolver/provider that produced this decision. */
  source: string;
}

/** Decision shape a provider returns; runtime tags it with the provider name. */
export type MmrFeatureGateProviderDecision = Omit<MmrFeatureGateDecision, "source">;

export interface MmrFeatureGateProvider {
  /** Provider identifier shown in `/mmr-status` and decision diagnostics. */
  name: string;
  /** Resolve a single gate; return undefined to defer to lower-priority providers. */
  evaluate(gate: string): MmrFeatureGateProviderDecision | undefined;
}

export interface MmrFeatureGateRegistry {
  registerProvider(provider: MmrFeatureGateProvider): void;
  resolve(gates: readonly string[]): MmrFeatureGateDecision[];
  getProviders(): MmrFeatureGateProvider[];
}

export interface MmrModeResolution {
  selectedSource: MmrModeSelectionSource;
  rejectedSources: MmrRejectedModeSource[];
  modelDecision: {
    fallbackApplied: boolean;
    reason?: string;
  };
  toolDecisions: MmrToolResolution["decisions"];
  featureGateDecisions: MmrFeatureGateDecision[];
}

export interface MmrModelCandidateResolution {
  requestedModel: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  registered: boolean;
  authenticated: boolean;
  subscription: boolean;
  attempted: boolean;
  applied: boolean;
  reason?: string;
}

export interface MmrModelResolution {
  targetModel: string;
  requestedModels: string[];
  selectedProvider?: string;
  selectedModel?: string;
  selectedThinkingLevel?: ThinkingLevel;
  modelFound: boolean;
  modelApplied: boolean;
  fallbackApplied: boolean;
  fallbackReason?: string;
  candidates: MmrModelCandidateResolution[];
}

export interface MmrModeState {
  /** State schema version. Bump when the persisted shape changes incompatibly. */
  version: number;
  mode: MmrModeKey;
  displayName: string;
  source: MmrModeSelectionSource;
  targetModel: string;
  requestedModels: string[];
  /** Selected/applied provider, or empty when no usable model was applied. */
  provider: string;
  /** Selected/applied model ID, or empty when no usable model was applied. */
  model: string;
  modelFound: boolean;
  modelApplied: boolean;
  modelFallbackApplied: boolean;
  modelFallbackReason?: string;
  modelCandidates: MmrModelCandidateResolution[];
  thinkingLevel?: ThinkingLevel;
  /** Runtime-only MMR total context profile; undefined means model default/no MMR context profile. */
  effectiveContextWindow?: number;
  /** Runtime-only MMR max-output profile; undefined means provider default/no MMR output profile. */
  effectiveMaxOutputTokens?: number;
  /** Runtime-only MMR max-input cap; undefined means model default/no MMR cap. */
  effectiveMaxInputTokens?: number;
  /**
   * Runtime-only registered context window of the selected provider model, as
   * declared by Pi's model registry. Captured so diagnostics can detect when
   * the registered window exceeds the mode's profile (`effectiveContextWindow`);
   * Pi-native compaction follows the registered window, not the mode profile,
   * so a smaller mode profile becomes a cosmetic display budget rather than a
   * compaction trigger. Not persisted.
   */
  registeredContextWindow?: number;
  /** Runtime-only baseline diagnostics used by /mmr-status; not persisted. */
  baselineCaptured?: boolean;
  baselineModel?: string;
  promptRoute: MmrPromptRoute;
  requestedTools: string[];
  activeTools: string[];
  missingTools: string[];
  deferredTools: string[];
  gatedTools: string[];
  disabledTools: string[];
  featureGates: string[];
  availabilityNotes: string[];
  resolution: MmrModeResolution;
  appliedAt: string;
  /**
   * Settings files (global + project `.pi/settings.json`) that were read
   * during the most recent settings load. Surfaced by `/mmr-status` for
   * diagnostics; intentionally not persisted because it describes the
   * current filesystem environment, not the resolved mode.
   */
  settingsFilesRead?: string[];
  /**
   * Warnings produced while loading settings (unreadable files, malformed
   * MMR-specific blocks). Surfaced by `/mmr-status` so users can see and
   * act on them; intentionally not persisted.
   */
  settingsWarnings?: string[];
  /**
   * Runtime-only observation from the most recent `before_agent_start`
   * prompt assembly. Captures (a) an unexpected prompt-head passthrough
   * (anchor drift / section reorder) so the locked-mode posture loss is no
   * longer silent, and (b) any mismatch between the mode's resolved active
   * tool set and the tool selection Pi rendered the prompt from. Surfaced by
   * `/mmr-status` via the policy-diagnostics pipeline; never persisted and
   * cleared to `undefined` on a clean turn.
   */
  promptAssembly?: MmrPromptAssemblyObservation;
}

/**
 * Why `assembleActiveSurface` returned Pi's prompt unchanged instead of
 * splicing in the locked-mode head. `undefined` on the result means the
 * splice succeeded. `not-prompted-mode` is benign (free / unrecognized
 * mode); the remaining reasons indicate the Pi-auto head could not be
 * located in the expected shape.
 */
export type MmrPromptPassthroughReason =
  | "not-prompted-mode"
  | "identity-anchor-missing"
  | "section-anchor-missing"
  | "section-order-invalid"
  | "section-boundary-missing";

/** Runtime-only prompt-assembly observation recorded per turn. */
export interface MmrPromptAssemblyObservation {
  /**
   * Set when the locked-mode head was dropped for an unexpected reason
   * (i.e. not a custom system prompt and not free mode). Drives the
   * `prompt.head-not-applied` diagnostic.
   */
  unexpectedPassthroughReason?: MmrPromptPassthroughReason;
  /** Resolved active tools that are absent from Pi's rendered tool selection. */
  selectedToolsMissingFromPrompt?: string[];
  /** Tools Pi rendered the prompt selection around that the mode did not resolve as active. */
  selectedToolsExtraInPrompt?: string[];
}

export interface PersistedMmrModeState {
  /** Present on all freshly-written entries; absent on legacy pre-v1 records. */
  version?: number;
  mode: MmrModeKey;
  source: MmrModeSelectionSource;
  targetModel?: string;
  requestedModels?: string[];
  provider: string;
  model: string;
  modelFallbackApplied?: boolean;
  modelFallbackReason?: string;
  thinkingLevel?: ThinkingLevel;
  activeTools: string[];
  missingTools: string[];
  deferredTools: string[];
  gatedTools: string[];
  disabledTools: string[];
  appliedAt: string;
}

/**
 * Where the current session identity came from. Stable categorical label
 * surfaced through diagnostics; new sources should be added here, not
 * stringly-typed at call sites.
 *
 * - `pi-context`: captured from `ExtensionContext` / Pi session manager.
 * - `session-manager`: captured directly from a `ReadonlySessionManager`
 *   instance outside of an event-driven `ExtensionContext` flow.
 * - `manual`: explicitly set by an extension or user-driven flow (tests, REPL).
 */
export type MmrSessionIdentitySource = "pi-context" | "session-manager" | "manual";

/**
 * Shared runtime context that names the current Pi session so
 * downstream extensions (mmr-toolbox task_list, mmr-subagents, mmr-history)
 * can stamp provenance without each rediscovering identity.
 *
 * This is intentionally separate from `MmrModeState`: mode state describes
 * routing/policy, identity changes on different lifecycle boundaries, and the
 * two should not force each other's schema churn.
 */
export interface MmrSessionIdentity {
  /** Identity schema version. Bump on incompatible shape change. */
  version: 1;
  /** Pi cwd when the identity was observed. */
  cwd?: string;
  /** Canonical Pi/MMR conversation identifier exposed by Pi. */
  sessionId?: string;
  /** Optional human-friendly session label exposed by Pi. */
  sessionName?: string;
  /** Origin tag for the identity. */
  source: MmrSessionIdentitySource;
  /** ISO-8601 timestamp at which this identity was captured. */
  observedAt: string;
}

/**
 * Logical kind of a prompt block emitted by the prompt-assembly
 * registry. Defined here so the debug/fixture renderer can
 * type-check against the same vocabulary the registry uses;
 * `blocks` is currently passed through without being populated or
 * consumed here.
 */
export type MmrPromptBlockKind =
  | "identity"
  | "tool-lead-in"
  | "active-tools"
  | "active-guidelines"
  | "builtin-tool-guidance"
  | "pi-docs"
  | "shared-tool-guidance"
  | "shared-coding-guidance"
  | "mode-posture"
  | "response-style"
  | "sunken-rite"
  | "preserved-tail";

export interface MmrPromptBlock {
  id: string;
  kind: MmrPromptBlockKind;
  text: string;
  source: "mmr-core" | "pi" | "extension";
}

/**
 * One entry in the active tool manifest consumed by the debug/fixture
 * renderer. Callers are responsible for assembling only active tools;
 * deferred/planned/gated/disabled entries must not appear here.
 */
export interface MmrActiveToolManifestEntry {
  name: string;
  owner: string;
  promptSnippet?: string;
  promptGuidelines: string[];
  description: string;
  schema: unknown;
}

/**
 * Metadata describing a tool that pi-mmr has scoped for a future
 * extension but has not yet implemented. Planned entries are tracked in
 * `MMR_PLANNED_TOOL_CATALOG` (see `planned-catalog.ts`) so that the
 * intended owner extension, tool name, and short pi-mmr-authored
 * summary are visible in code rather than only in plans/docs that drift.
 *
 * Planned entries are inert by construction: they are not consumed by
 * `assembleActiveSurface` and never appear in the active manifest or the
 * model-facing system prompt. The negative-injection test
 * enforces this. When a planned tool ships for real, its entry is
 * removed from the catalog and replaced by a real active registration
 * inside the owning extension.
 */
export interface MmrPlannedToolMetadata {
  /** Model-facing tool name the planned extension will register. */
  name: string;
  /** Planned owner extension identifier (e.g. `mmr-history`, `mmr-subagents`). */
  owner: string;
  /** Lifecycle status. Currently always `"planned"`; the type leaves room for `"deferred"` once a non-shipping but registered status is needed. */
  status: "planned";
  /** Short pi-mmr-authored summary of the tool's intent. Never surfaced in the model-facing prompt. */
  summary: string;
}

/**
 * Output contract of the prompt-assembly registry and
 * input contract of the debug/fixture renderer. The renderer
 * never inspects `blocks` directly; it flattens `systemPrompt` and the
 * caller-provided `activeToolManifest`.
 */
export interface MmrPromptAssemblyResult {
  mode: string;
  provider?: string;
  model?: string;
  blocks: MmrPromptBlock[];
  systemPrompt: string;
  activeToolManifest: MmrActiveToolManifestEntry[];
  /**
   * Why the splice fell back to passing Pi's prompt through unchanged, or
   * `undefined` when the locked-mode head was spliced in successfully. Lets
   * callers distinguish a benign passthrough (free mode, custom system
   * prompt) from unexpected anchor drift.
   */
  passthroughReason?: MmrPromptPassthroughReason;
}

export interface MmrCoreSettings {
  defaultMode?: string;
  /** Per-mode ordered model preferences. Strings may be bare model IDs or provider/model explicit routes. */
  modelPreferences?: Partial<Record<MmrModeKey, MmrModelPreference[]>>;
  /**
   * Per-subagent ordered model preferences keyed by subagent profile name
   * (e.g. `finder`, `oracle`). When present, overrides the profile's built-in
   * `modelPreferences` for the matching subagent. Same string/object shape as
   * `modelPreferences`.
   */
  subagentModelPreferences?: Record<string, MmrModelPreference[]>;
  /**
   * Additive, exact-name tool allowlist extensions for locked modes. Each
   * value is a list of concrete Pi tool names (e.g. user/third-party or MCP
   * tools) that should remain callable while the keyed locked mode is active,
   * on top of the mode's built-in allowlist.
   *
   * The `all` bucket applies to every locked mode; a per-mode key applies to
   * that mode only. Names resolve by exact identity against Pi's live tool
   * inventory (no aliases). Extra tools never satisfy the fail-closed
   * zero-active-tools activation check, and a missing extra tool is a
   * non-fatal no-op. `free` is not configurable here.
   */
  lockedModeExtraTools?: Partial<Record<MmrLockedModeKey | "all", string[]>>;
}

/**
 * Stable codes for policy diagnostics surfaced by mmr-core.
 *
 * Worker tools and later extensions can branch on `code` and ignore prose;
 * `message` is the human-readable text that `/mmr-status` and activation
 * warnings render verbatim.
 */
export type MmrPolicyDiagnosticCode =
  | "model.not-applied"
  | "model.fallback-applied"
  | "tools.none-active"
  | "tools.missing"
  | "tools.gated"
  | "tools.disabled"
  | "availability"
  | "context.registered-exceeds-profile"
  | "prompt.head-not-applied"
  | "tools.prompt-selection-mismatch";

export type MmrPolicyDiagnosticSeverity = "info" | "warning";

export interface MmrPolicyDiagnostic {
  code: MmrPolicyDiagnosticCode;
  severity: MmrPolicyDiagnosticSeverity;
  message: string;
  /** Identifier of the producer; mmr-core diagnostics always use "mmr-core". */
  source: string;
  /** Optional structured payload; shape is per-code and intentionally minimal. */
  data?: Record<string, unknown>;
}
