import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MMR_SUBAGENT_SHARED_DENY_TOOLS } from "./subagent-tool-policy.js";
import type { MmrModeKey, MmrModelPreference } from "./types.js";

/**
 * Subagent prompt-assembly route.
 *
 * - `standalone` — the subagent uses a concrete prompt template
 *   produced by a registered prompt builder (e.g. finder, oracle,
 *   librarian). The prompt does not inherit from any user-facing
 *   locked mode and is assembled from scratch.
 * - `mode-derived` — the subagent derives its prompt from an existing
 *   user-facing mode's prompt assembly (`profile.baseMode`) and then
 *   appends a worker-role block plus any subagent-specific overrides.
 *   Reserved for workers that should behave like a sub-instance of a
 *   parent mode (e.g. Task).
 *
 * Distinct from the user-facing `MmrPromptRoute`
 * (`default`/`rush`/`deep`/`free`): subagent workers are not locked
 * modes, do not capture/restore Pi baselines, and do not apply
 * locked-mode prompt templates. `mmr-core` preserves Pi's base prompt
 * and the worker's `--append-system-prompt` content as-is unless a
 * prompt-assembly path explicitly replaces them.
 */
export type MmrSubagentPromptRoute = "standalone" | "mode-derived";

/**
 * Parent mode source for mode-derived subagent prompts.
 *
 * A concrete MMR mode key pins the worker to that mode's prompt
 * assembly. `from-parent` defers the choice to the invocation site;
 * `assembleMmrSubagentSurface` then requires a `parentMode` input and
 * fails closed if it is missing.
 */
export type MmrSubagentBaseMode = MmrModeKey | "from-parent";

/**
 * Canonical execution profile for a subagent worker. Resolved by
 * `mmr-core` from `--mmr-subagent <name>` in the child Pi process and
 * by the prompt-assembly framework when building a subagent's
 * effective surface.
 *
 * Profiles are the single source of truth for subagent behavior; the
 * runner mirrors the resolved values into `--model` / `--tools` only for
 * compatibility and observability. If the explicit CLI args disagree
 * with the profile-resolved route, activation fails closed before any
 * model/tool mutation.
 */
/**
 * Owner-scoped tool prerequisite for a subagent profile. Each group names the
 * canonical owning extension (e.g. `"mmr-github"`) and the concrete tool names
 * that must be present AND owned by that extension (matched by
 * `sourceInfo.path`) in the worker's tool inventory. Subagent activation
 * validates these fail-closed via `mmr-core`'s generic owned-tools registry,
 * which lets `mmr-core` gate a worker (e.g. `librarian` on `mmr-github` repo
 * tools) without importing the owning sibling extension.
 */
export interface MmrRequiredOwnedToolGroup {
  /** Canonical owning extension name, e.g. `"mmr-github"`. */
  readonly owner: string;
  /** Tool names that must be present and owned by `owner`. */
  readonly toolNames: readonly string[];
  /** Human-readable phrase for the fail-closed message; defaults to an owner/tool list. */
  readonly description?: string;
  /** Optional remediation hint appended in parentheses to the fail-closed message. */
  readonly unmetHint?: string;
}

/**
 * Policy controlling how a worker's nonzero exits are classified when
 * usable final text is present:
 *
 *  - `"fail-on-nonzero"` — nonzero exit is always a worker error,
 *    regardless of output. The default for workers whose output is
 *    consumed verbatim by the parent (finder, oracle, librarian,
 *    history-reader, custom Markdown subagents).
 *  - `"prefer-usable-output"` — nonzero exit with usable final text
 *    still counts as success; nonzero exit without usable text is a
 *    worker error. Declared only by `task-subagent`, whose worker may
 *    exit nonzero after emitting a usable final answer.
 *
 * Consumed by the shared worker-outcome classifier in `mmr-subagents`;
 * `mmr-core` only declares the bit so every surface (blocking tools,
 * model fallback, background tasks) reads one source of truth.
 */
export type MmrSubagentPartialOutputPolicy = "fail-on-nonzero" | "prefer-usable-output";

export interface MmrSubagentProfile {
  /** Profile identifier used by `--mmr-subagent`. */
  readonly name: string;
  /** Human-facing label surfaced in diagnostics and fixtures. */
  readonly displayName: string;
  /** Ordered worker-model preferences, resolved against the local Pi model registry. */
  readonly modelPreferences: readonly MmrModelPreference[];
  /** Optional parent-mode-specific worker-model preferences for mode-derived profiles. */
  readonly modeModelPreferences?: Partial<Record<MmrModeKey, readonly MmrModelPreference[]>>;
  /** Optional thinking level. When omitted, Pi's default thinking level applies. */
  readonly thinkingLevel?: ThinkingLevel;
  /**
   * Optional hard cap on the worker's per-request output tokens. When set,
   * the child Pi process applies it through mmr-core's
   * `before_provider_request` hook (Anthropic `max_tokens` /
   * OpenAI Responses `max_output_tokens`) even though subagent workers are
   * not locked modes. Profiles omit it to keep Pi's provider default.
   */
  readonly maxOutputTokens?: number;
  /** Concrete Pi tool allowlist applied via `pi.setActiveTools`. */
  readonly tools: readonly string[];
  /**
   * Optional explicit deny list of tool names that must never appear in
   * the worker's effective tool set, even if they leak in through
   * parent-active tools or future profile changes. Recursive/advisory
   * tools (`Task`, `oracle`, `librarian`, `handoff`) belong here for
   * profiles that delegate to workers. Defaults to an empty list when
   * omitted; `resolveMmrSubagentInvocation` enforces the subtraction.
   */
  readonly denyTools?: readonly string[];
  /**
   * Owner-scoped tool prerequisites enforced at activation. When set, the
   * worker fails closed unless every named tool is present AND owned by the
   * declared extension. Lets `mmr-core` gate owner-specific tools (e.g.
   * `librarian` repo tools owned by `mmr-github`) without importing the owner.
   */
  readonly requiredOwnedTools?: readonly MmrRequiredOwnedToolGroup[];
  /** Optional maximum inference turns for future in-process runners. */
  readonly maxTurns?: number;
  /**
   * Optional nonzero-exit output policy; see
   * {@link MmrSubagentPartialOutputPolicy}. Omitted profiles default to
   * `"fail-on-nonzero"`; only `task-subagent` declares
   * `"prefer-usable-output"`.
   */
  readonly partialOutputPolicy?: MmrSubagentPartialOutputPolicy;
  /**
   * Whether this worker may run as a background task (`start_task`).
   * Defaults to `true` when omitted, so registered profiles — including
   * runtime-registered custom Markdown subagents — are backgroundable
   * unless they opt out. `oracle` (always blocking by contract) and
   * `history-reader` (an internal extraction worker, not a public
   * background agent) declare `false`.
   */
  readonly backgroundable?: boolean;
  /**
   * Whether the worker's parameters accept the narrowing
   * `capabilityProfile` field (`read-only` / `read-write`). Defaults to
   * `false`; only `task-subagent` declares `true`. The background
   * surface derives its Task-only capabilityProfile rule from this flag
   * instead of hardcoding the agent name.
   */
  readonly acceptsCapabilityProfile?: boolean;
  /**
   * Prompt-assembly route. `standalone` uses the registered prompt
   * builder for `promptBuilder`; `mode-derived` builds on
   * `assembleActiveSurface(baseMode)` and then appends a worker role
   * block.
   */
  readonly promptRoute: MmrSubagentPromptRoute;
  /**
   * Parent user-facing mode for `mode-derived` profiles. Must be
   * `undefined` for `standalone` profiles. The profile registry is
   * checked to enforce this invariant at module load.
   */
  readonly baseMode?: MmrSubagentBaseMode;
  /**
   * Identifier of the prompt builder registered through the
   * subagent prompt-builder registry. For `standalone` profiles the
   * builder produces the entire system prompt; for `mode-derived`
   * profiles the builder produces the appended worker-role block.
   */
  readonly promptBuilder: string;
  /**
   * Whether the worker may surface MCP-bridged tools. Reserved for
   * profiles that explicitly need MCP reach. Read-only research workers
   * keep this `false` unless a profile-specific safety contract opens it.
   */
  readonly allowMcp: boolean;
  /**
   * Whether the worker may surface `mmr-toolbox` mutation tools
   * (`apply_patch`, etc.). Read-only research workers must keep this
   * `false`.
   */
  readonly allowToolbox: boolean;
  /** Subagent workers never apply locked-mode policy. */
  readonly enforceLockedMode: false;
  /** Subagent workers never persist mode/subagent state through Pi entries. */
  readonly persistSubagentState: false;
}

/**
 * Read-only GitHub repository provider tools owned by `mmr-github`. The
 * `librarian` profile activates these by name and also requires them to be
 * `mmr-github`-owned at runtime; defined once so the allowlist and the
 * ownership requirement never drift.
 */
const LIBRARIAN_REPO_TOOLS = [
  "read_github",
  "list_directory_github",
  "glob_github",
  "search_github",
  "commit_search",
  "diff_github",
  "list_repositories",
] as const;

/**
 * Deep-freeze a JSON-shaped value (objects, arrays, primitives only).
 * Returned reference is the same object, now frozen recursively.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

/**
 * Canonical subagent profile table. Add new profiles here.
 *
 * Each entry is deep-frozen at module-load time so callers that retain
 * `getMmrSubagentProfile(...)` references cannot accidentally corrupt the
 * runtime contract.
 */
const MMR_SUBAGENT_PROFILE_TABLE: Record<string, MmrSubagentProfile> = {
  finder: deepFreeze({
    name: "finder",
    displayName: "Finder",
    modelPreferences: [
      // Finder pins thinking to MINIMAL, so the provider-pinned Flash
      // route is used as the low-effort primary while keeping higher-
      // effort routes available for reasoning-heavy modes.
      { model: "gemini-3.5-flash-extra-low", providers: ["antigravity"] },
      { model: "gpt-5.4-mini" },
      { model: "claude-haiku-4-5" },
    ],
    // Finder is a search/grep planner, not a reasoner. Pin worker
    // thinking to MINIMAL so providers that support a low-effort
    // reasoning lane (Anthropic, OpenAI Responses) actually use it.
    // Providers without such a lane resolve `minimal` via mmr-core's
    // existing thinking-level policy / Pi's clamp.
    thinkingLevel: "minimal",
    tools: ["grep", "find", "read"],
    promptRoute: "standalone",
    promptBuilder: "finder",
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  } satisfies MmrSubagentProfile),

  "history-reader": deepFreeze({
    name: "history-reader",
    displayName: "History Reader",
    modelPreferences: [
      // History-reader is a focused extraction worker, so it uses the
      // same low-effort Flash primary as finder and keeps GPT/Haiku
      // fallbacks for environments without the provider-pinned route.
      { model: "gemini-3.5-flash-extra-low", providers: ["antigravity"] },
      { model: "gpt-5.4-mini" },
      { model: "claude-haiku-4-5" },
    ],
    thinkingLevel: "minimal",
    tools: [],
    maxTurns: 1,
    // Internal extraction worker driven by the mmr-history read tools; it is
    // not a public background agent.
    backgroundable: false,
    promptRoute: "standalone",
    promptBuilder: "history-reader",
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  } satisfies MmrSubagentProfile),

  oracle: deepFreeze({
    name: "oracle",
    displayName: "Oracle",
    // Oracle is the high-capability advisory worker. Primary route is
    // GPT-5.5 at HIGH reasoning; the Claude Opus 4.6 fallback also
    // runs at HIGH so both routes deliver the same advisor posture
    // even when the primary provider is not authenticated.
    modelPreferences: [
      { model: "gpt-5.5" },
      { model: "claude-opus-4-6", thinkingLevel: "high" },
    ],
    thinkingLevel: "high",
    // The full advisory tool surface. Pi-native concrete names where a
    // direct equivalent exists (Read → read, Grep → grep, glob → find);
    // mmr-web / mmr-history names where the tool is owned by a sibling
    // extension. Tools whose owning extension is not yet shipped (e.g.
    // mmr-history) are listed here for honest profile intent and are
    // dropped from the worker's actual active set by Pi's tool resolver
    // the same way unimplemented mode tools are reported as deferred.
    tools: [
      "read",
      "grep",
      "find",
      "web_search",
      "read_web_page",
      "read_session",
      "find_session",
    ],
    // Oracle is always blocking: the advisory result is consumed inline and
    // the worker can never run as a background task.
    backgroundable: false,
    promptRoute: "standalone",
    promptBuilder: "oracle",
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  } satisfies MmrSubagentProfile),

  librarian: deepFreeze({
    name: "librarian",
    displayName: "Librarian",
    modelPreferences: [
      { model: "claude-opus-4-6" },
      { model: "gpt-5.4" },
    ],
    thinkingLevel: "medium",
    // Read-only GitHub repository provider tools owned by `mmr-github`.
    // The worker activates these by name through `--tools`; they are not
    // part of any user-facing mode allowlist.
    tools: [...LIBRARIAN_REPO_TOOLS],
    // Fail closed unless the repo tools are present AND owned by `mmr-github`,
    // validated through mmr-core's generic owned-tools registry (no import of
    // mmr-github from core).
    requiredOwnedTools: [
      {
        owner: "mmr-github",
        toolNames: [...LIBRARIAN_REPO_TOOLS],
        description: "mmr-github-owned read-only GitHub tools",
        unmetHint: "set MMR_GITHUB_ENABLE=true",
      },
    ],
    promptRoute: "standalone",
    promptBuilder: "librarian",
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  } satisfies MmrSubagentProfile),

  "task-subagent": deepFreeze({
    name: "task-subagent",
    displayName: "Task Subagent",
    // Pinned Task route order: claude-opus-4-8 is the canonical Task route
    // shared by all Task-enabled modes (including deep, which aliases to smart
    // through the resolver). The goal is Anthropic *medium* reasoning effort on
    // the wire whenever the Task worker runs on Opus 4.8.
    //
    // The canonical thinking level required to land on Anthropic effort
    // "medium" is PROVIDER-SPECIFIC, because each provider's Opus 4.8 model
    // definition carries a different `thinkingLevelMap` while both use the same
    // adaptive-effort algorithm (mapped = thinkingLevelMap[level]; if unmapped,
    // default: minimal/low -> "low", medium -> "medium", high -> "high"):
    //  - claude-subscription/claude-opus-4-8 maps levels up one notch
    //    (low -> "medium"), so canonical "low" yields Anthropic effort
    //    "medium".
    //  - anthropic/claude-opus-4-8 maps only xhigh; every other level hits the
    //    identity default, so canonical "medium" yields Anthropic effort
    //    "medium" (canonical "low" would wrongly yield "low").
    // Opus 4.8 is therefore pinned per provider. A bare (provider-neutral)
    // Opus 4.8 entry is deliberately NOT listed: it would resolve against any
    // provider whose level->effort contract we have not verified and silently
    // produce the wrong effort, so the route falls through to gpt-5.5 instead.
    //
    // claude-opus-4-6 uses the manual budget path, where canonical "medium"
    // selects the medium-tier thinking budget.
    //
    // Each preference entry carries its own thinking level so the resolver
    // returns a deterministic thinkingLevel without consulting any
    // profile-level default. Keep these levels in sync with the per-provider
    // contract fixtures in tests/mmr-core-subagent-resolve.test.mjs.
    modelPreferences: [
      { model: "claude-opus-4-8", providers: ["claude-subscription"], thinkingLevel: "low" },
      { model: "claude-opus-4-8", providers: ["anthropic"], thinkingLevel: "medium" },
      { model: "gpt-5.5", thinkingLevel: "medium" },
      { model: "claude-opus-4-6", thinkingLevel: "medium" },
      { model: "claude-haiku-4-5-20251001", thinkingLevel: "low" },
      { model: "claude-haiku-4-5", thinkingLevel: "low" },
    ],
    // Rush workers follow the parent mode's latency-first route instead of
    // the shared high-capability Task default: GPT-5.5 with thinking off,
    // falling back to Haiku 4.5 with thinking off when GPT routes are not
    // registered or authenticated.
    modeModelPreferences: {
      rush: [
        { model: "gpt-5.5", thinkingLevel: "off" },
        { model: "claude-haiku-4-5-20251001", thinkingLevel: "off" },
        { model: "claude-haiku-4-5", thinkingLevel: "off" },
      ],
    },
    // Concrete Pi/MMR names matching the task worker's intended tool
    // surface: local read/shell/edit/create, web page/search, finder,
    // skills, and session task tracking. Recursive subagent/advisory
    // tools live in denyTools so they cannot leak in.
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "read_web_page",
      "web_search",
      "finder",
      "skill",
      "task_list",
    ],
    denyTools: MMR_SUBAGENT_SHARED_DENY_TOOLS,
    // Task is the only worker whose nonzero exit with usable final text
    // still counts as success; every other profile keeps the
    // fail-on-nonzero default.
    partialOutputPolicy: "prefer-usable-output",
    // Task is the only worker whose parameters accept the narrowing
    // capabilityProfile field.
    acceptsCapabilityProfile: true,
    promptRoute: "mode-derived",
    baseMode: "from-parent",
    promptBuilder: "task-subagent",
    // MCP/toolbox stay false in this slice (spec §5); a follow-up may
    // open them once the safety semantics for child mutations are pinned.
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  } satisfies MmrSubagentProfile),
};

// Enforce promptRoute/baseMode invariant at module load so a registry
// entry that names a baseMode for a standalone profile (or omits one
// for a mode-derived profile) is caught before any caller resolves
// against it.
for (const profile of Object.values(MMR_SUBAGENT_PROFILE_TABLE)) {
  if (profile.promptRoute === "standalone" && profile.baseMode !== undefined) {
    throw new Error(
      `mmr-core subagent profile "${profile.name}" is standalone but declares baseMode "${profile.baseMode}"`,
    );
  }
  if (profile.promptRoute === "mode-derived" && profile.baseMode === undefined) {
    throw new Error(
      `mmr-core subagent profile "${profile.name}" is mode-derived but does not declare a baseMode`,
    );
  }
}

/**
 * Frozen, ordered list of registered subagent profile names. Deterministic
 * (Object.keys order at module-load time).
 */
const MMR_DYNAMIC_SUBAGENT_PROFILES_GLOBAL_KEY = "__pi_mmr_dynamic_subagent_profiles_v1__";

const globalProfileStore = globalThis as typeof globalThis & {
  [MMR_DYNAMIC_SUBAGENT_PROFILES_GLOBAL_KEY]?: Map<string, MmrSubagentProfile>;
};

function resolveDynamicProfileRegistry(): Map<string, MmrSubagentProfile> {
  const existing = globalProfileStore[MMR_DYNAMIC_SUBAGENT_PROFILES_GLOBAL_KEY];
  if (existing instanceof Map) return existing;
  const fresh = new Map<string, MmrSubagentProfile>();
  globalProfileStore[MMR_DYNAMIC_SUBAGENT_PROFILES_GLOBAL_KEY] = fresh;
  return fresh;
}

function listStaticMmrSubagentProfiles(): readonly string[] {
  return Object.keys(MMR_SUBAGENT_PROFILE_TABLE);
}

/**
 * Look up a subagent profile by name. Returns `undefined` for unknown or
 * empty names. The returned profile is deep-frozen.
 */
export function getMmrSubagentProfile(name: string): MmrSubagentProfile | undefined {
  if (typeof name !== "string" || name.length === 0) return undefined;
  return MMR_SUBAGENT_PROFILE_TABLE[name] ?? resolveDynamicProfileRegistry().get(name);
}

/**
 * Register or replace a runtime subagent profile. Used by mmr-subagents for
 * user-authored Markdown subagents whose profile shape is discovered at
 * extension activation instead of being shipped in mmr-core's static table.
 */
export function registerMmrSubagentProfile(profile: MmrSubagentProfile): void {
  if (typeof profile.name !== "string" || profile.name.length === 0) {
    throw new Error("registerMmrSubagentProfile requires a non-empty profile.name");
  }
  if (Object.hasOwn(MMR_SUBAGENT_PROFILE_TABLE, profile.name)) {
    throw new Error(`registerMmrSubagentProfile cannot replace built-in profile "${profile.name}"`);
  }
  if (profile.promptRoute === "standalone" && profile.baseMode !== undefined) {
    throw new Error(`runtime subagent profile "${profile.name}" is standalone but declares baseMode "${profile.baseMode}"`);
  }
  if (profile.promptRoute === "mode-derived" && profile.baseMode === undefined) {
    throw new Error(`runtime subagent profile "${profile.name}" is mode-derived but does not declare a baseMode`);
  }
  resolveDynamicProfileRegistry().set(profile.name, deepFreeze({ ...profile }));
}

/** Remove a runtime profile. Intended for tests and profile reloads. */
export function unregisterMmrSubagentProfile(name: string): void {
  resolveDynamicProfileRegistry().delete(name);
}

/** Test seam: clear runtime profiles without touching built-ins. */
export function clearMmrDynamicSubagentProfiles(): void {
  resolveDynamicProfileRegistry().clear();
}

/**
 * Enumerate registered subagent profile names in stable order.
 */
export function listMmrSubagentProfiles(): readonly string[] {
  return Object.freeze([
    ...listStaticMmrSubagentProfiles(),
    ...resolveDynamicProfileRegistry().keys(),
  ]);
}

/**
 * Expand an ordered `MmrModelPreference[]` (e.g. a profile's
 * `modelPreferences` or a settings-level
 * `subagentModelPreferences[<profileName>]` override) into the flat
 * `string[]` shape consumed by the loose-match helper used by the
 * `selectHistoryReaderWorkerModel` subagent tool. (Finder and oracle
 * resolve their route through the registry-aware `selectMmrModelRoute`
 * instead and no longer use the loose-match path.)
 *
 * For each preference, the resulting list emits canonical
 * `provider/model` entries using the preference's explicit `providers`
 * when present. Explicit provider routes do not get a bare-id fallback,
 * because falling through to any provider with the same model id would
 * disagree with child subagent activation. When providers are omitted,
 * the helper emits the same provider hint used by
 * `getDefaultProvidersForModel`: `gpt-*` → `openai-codex`,
 * `gemini-*` / `gemma-*` → `google`, `claude-*` →
 * `claude-subscription`, then emits the bare model id so consumers can
 * fall back when the parent Pi registry exposes only bare names. The
 * helper preserves preference order and never reorders, deduplicates,
 * or drops entries.
 */
export function expandMmrModelPreferencesToStrings(
  preferences: readonly MmrModelPreference[] | undefined,
): readonly string[] {
  if (!preferences || preferences.length === 0) return [];
  const expanded: string[] = [];
  for (const preference of preferences) {
    const bare = preference.model;
    if (typeof bare !== "string" || bare.length === 0) continue;
    const explicitProviders = preference.providers?.filter((provider) => typeof provider === "string" && provider.length > 0);
    if (explicitProviders && explicitProviders.length > 0) {
      for (const provider of explicitProviders) {
        expanded.push(`${provider}/${bare}`);
      }
      continue;
    }
    if (bare.startsWith("gpt-")) {
      expanded.push(`openai-codex/${bare}`);
    } else if (bare.startsWith("gemini-") || bare.startsWith("gemma-")) {
      expanded.push(`google/${bare}`);
    } else if (bare.startsWith("claude-")) {
      expanded.push(`claude-subscription/${bare}`);
    }
    expanded.push(bare);
  }
  return expanded;
}

/**
 * Options for {@link selectFirstMatchingAvailableModel}.
 */
export interface SelectFirstMatchingAvailableModelOptions {
  /**
   * When `true`, a preference that already pins a provider route (contains
   * `/`) is matched strictly: it resolves only to an exact entry or an entry
   * ending with the full `/provider/model` suffix, and never falls through to
   * bare-tail matching that could cross provider routes. When the strict
   * match fails, the preference is skipped rather than loosened.
   *
   * Defaults to `false`, which always falls through to bare-tail matching
   * (matching any entry equal to the tail after the last `/`, or ending with
   * `/tail`).
   */
  strictProviderRoutes?: boolean;
}

/**
 * Pick the first preferred model that the parent Pi process actually exposes a
 * matching route for, walking `preferences` in order. Returns `undefined` when
 * none match or no models are available.
 *
 * Shared matching core for the `selectHistoryReaderWorkerModel` worker
 * model selector. (Finder and oracle now resolve their route through the
 * registry-aware `selectMmrModelRoute` and no longer use this path.)
 * The selector keeps its own
 * profile-specific default preference list and chooses the matching policy via
 * {@link SelectFirstMatchingAvailableModelOptions}; this helper owns only the
 * common scan: trim and drop empty available entries, then for each preference
 * try an exact match, then (subject to `strictProviderRoutes`) a
 * provider-suffix or bare-tail match. Preference order is preserved and entries
 * are never reordered or deduplicated.
 */
export function selectFirstMatchingAvailableModel(
  availableModels: readonly string[],
  preferences: readonly string[],
  options?: SelectFirstMatchingAvailableModelOptions,
): string | undefined {
  const available = availableModels.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  if (available.length === 0) return undefined;
  const strictProviderRoutes = options?.strictProviderRoutes ?? false;
  for (const preference of preferences) {
    const target = typeof preference === "string" ? preference.trim() : "";
    if (target.length === 0) continue;
    if (available.includes(target)) return target;
    if (strictProviderRoutes && target.includes("/")) {
      const providerMatch = available.find((entry) => entry.endsWith(`/${target}`));
      if (providerMatch) return providerMatch;
      continue;
    }
    const tail = target.split("/").pop() ?? target;
    const match = available.find((entry) => entry === tail || entry.endsWith(`/${tail}`));
    if (match) return match;
  }
  return undefined;
}
