import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type MmrModelRegistryLike,
  type MmrRegisteredModelLike,
  selectMmrModelRoute,
} from "./model-resolver.js";
import type { MmrSubagentProfile, MmrSubagentPromptRoute } from "./subagent-profiles.js";
import {
  MMR_SUBAGENT_SHARED_DENY_TOOLS,
  isMmrCapabilityProfileKey,
  resolveMmrCapabilityAllowedTools,
  type MmrCapabilityProfileKey,
} from "./subagent-tool-policy.js";
import type { MmrModelCandidateResolution, MmrModelPreference, MmrModeKey } from "./types.js";

/**
 * Stable, public marker that the child Pi process writes to its own
 * stderr when subagent activation fails closed. The runner in
 * `mmr-subagents` scans for this exact prefix to convert the run into a
 * hard failure regardless of Pi's own exit code (Pi currently exits 0
 * even when an extension's `session_start` throws).
 *
 * Both producer (`mmr-core/index.ts:failClosedSubagent`) and consumer
 * (`mmr-subagents/runner.ts`) reference this constant so the string
 * cannot drift across the boundary.
 */
export const MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX =
  "pi-mmr: subagent activation failed: ";

/**
 * Parse a child Pi process's stderr for the activation-failure marker.
 * Returns the trimmed reason string from the last marker occurrence, or
 * `undefined` when no marker is present.
 *
 * The last occurrence wins so multi-failure stderr surfaces the most
 * recent (and typically most specific) cause; the consumer treats the
 * mere presence of a marker as failure regardless of which line it
 * picks.
 */
export function extractMmrSubagentActivationFailure(stderr: unknown): string | undefined {
  if (typeof stderr !== "string" || stderr.length === 0) return undefined;
  let last: string | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith(MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX)) continue;
    last = line.slice(MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX.length).trim();
  }
  return last && last.length > 0 ? last : undefined;
}

export type MmrSubagentResolveCode =
  | "model.no-route"
  | "model.mismatch"
  | "tools.mismatch"
  | "tools.empty"
  | "tools.capability"
  | "prompt-base.unresolved";

export interface MmrSubagentResolveDiagnostic {
  code: MmrSubagentResolveCode | "model.skipped";
  severity: "warning" | "error";
  message: string;
}

export interface MmrSubagentRouteSelectionOk<TModel extends MmrRegisteredModelLike> {
  ok: true;
  profile: MmrSubagentProfile;
  selected: {
    provider: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
    registeredModel: TModel;
  };
  tools: readonly string[];
  promptRoute: MmrSubagentPromptRoute;
  candidates: MmrModelCandidateResolution[];
  diagnostics: MmrSubagentResolveDiagnostic[];
}

export interface MmrSubagentRouteSelectionFail {
  ok: false;
  profile: MmrSubagentProfile;
  code: MmrSubagentResolveCode;
  message: string;
  selected?: undefined;
  tools: readonly string[];
  promptRoute: MmrSubagentPromptRoute;
  candidates: MmrModelCandidateResolution[];
  diagnostics: MmrSubagentResolveDiagnostic[];
}

export type MmrSubagentRouteSelection<TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike> =
  | MmrSubagentRouteSelectionOk<TModel>
  | MmrSubagentRouteSelectionFail;

export interface ResolveMmrSubagentRouteArgs<TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike> {
  profile: MmrSubagentProfile;
  registry: MmrModelRegistryLike<TModel>;
  /**
   * Optional explicit `--model` value (provider/id or bare id) the worker
   * was invoked with. Compared against the resolved route; mismatch fails
   * closed before any model mutation.
   */
  explicitModel?: string;
  /**
   * Optional explicit `--tools` list the worker was invoked with. Compared
   * against `profile.tools` order-independent; mismatch fails closed
   * before any tool mutation.
   */
  explicitTools?: readonly string[];
}

function describeRoute(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function explicitModelMatches(explicit: string, providerSlashModel: string, bareModel: string): boolean {
  const normalized = explicit.trim();
  if (normalized.length === 0) return true;
  if (normalized === providerSlashModel) return true;
  if (normalized === bareModel) return true;
  // Allow `<provider>/<bare>` even when provider differs but model matches?
  // No: the spec says profile is authoritative. If the provider differs, fail.
  return false;
}

function toolsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i += 1) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

function describeCandidates(candidates: readonly MmrModelCandidateResolution[]): string {
  if (candidates.length === 0) return "no candidate provider routes";
  return candidates
    .map((c) => `${c.provider}/${c.model}: ${c.reason ?? (c.registered ? "registered" : "not registered")}`)
    .join("; ");
}

/**
 * Internal pure subagent route resolver. Public callers should use
 * {@link resolveMmrSubagentInvocation}, which is the single source of
 * truth for parent spawn, child activation, prompt assembly's worker
 * tool manifest, and settings-driven model overrides.
 *
 * Steps:
 *  1. Pick the first registered+authenticated provider/model route from
 *     `profile.modelPreferences` via `selectMmrModelRoute`.
 *  2. If `explicitModel` is supplied, require it to match the resolved
 *     route (provider/id or bare id). Mismatch fails closed.
 *  3. If `explicitTools` is supplied, require an exact (order-independent)
 *     match with `profile.tools`. Mismatch fails closed.
 *  4. Return `{ ok: true, selected, tools, promptRoute, ... }` on success;
 *     `{ ok: false, code, message, ... }` on failure.
 *
 * Failure cases never mutate any caller state; activation code reads
 * `result.ok` and emits the fail-closed diagnostic before touching
 * `pi.setModel` / `pi.setActiveTools` / `pi.setThinkingLevel`.
 *
 * Not re-exported from the package root: this helper validates only
 * the model route and raw profile-tool intent. Resolving through
 * `resolveMmrSubagentInvocation` also applies the profile's deny set,
 * intersects against the host's registered tools, and resolves the
 * `from-parent` prompt-base mode, so consumers cannot accidentally
 * bypass those policies by reaching for the route helper directly.
 */
export function resolveMmrSubagentRoute<TModel extends MmrRegisteredModelLike>(
  args: ResolveMmrSubagentRouteArgs<TModel>,
): MmrSubagentRouteSelection<TModel> {
  const { profile, registry } = args;
  const diagnostics: MmrSubagentResolveDiagnostic[] = [];

  const route = selectMmrModelRoute({
    modelPreferences: profile.modelPreferences,
    modeThinkingLevel: profile.thinkingLevel,
    registry,
  });

  for (const candidate of route.candidates) {
    if (route.selected
      && candidate.provider === route.selected.provider
      && candidate.model === route.selected.model) {
      break;
    }
    diagnostics.push({
      code: "model.skipped",
      severity: "warning",
      message: `Skipped ${describeRoute(candidate.provider, candidate.model)}: ${candidate.reason ?? "not selected"}`,
    });
  }

  if (!route.selected) {
    const message = `Subagent "${profile.name}" could not resolve any model route. Tried: ${describeCandidates(route.candidates)}.`;
    diagnostics.push({ code: "model.no-route", severity: "error", message });
    return {
      ok: false,
      profile,
      code: "model.no-route",
      message,
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: route.candidates,
      diagnostics,
    };
  }

  if (args.explicitModel !== undefined) {
    const matches = explicitModelMatches(
      args.explicitModel,
      describeRoute(route.selected.provider, route.selected.model),
      route.selected.model,
    );
    if (!matches) {
      const message = `Subagent "${profile.name}" was invoked with --model ${args.explicitModel}, but the profile resolves to ${describeRoute(route.selected.provider, route.selected.model)}.`;
      diagnostics.push({ code: "model.mismatch", severity: "error", message });
      return {
        ok: false,
        profile,
        code: "model.mismatch",
        message,
        tools: profile.tools,
        promptRoute: profile.promptRoute,
        candidates: route.candidates,
        diagnostics,
      };
    }
  }

  if (args.explicitTools !== undefined && !toolsEqual(args.explicitTools, profile.tools)) {
    const explicitList = [...args.explicitTools].join(",");
    const profileList = [...profile.tools].join(",");
    const message = `Subagent "${profile.name}" was invoked with --tools ${explicitList}, but the profile tool allowlist is ${profileList}.`;
    diagnostics.push({ code: "tools.mismatch", severity: "error", message });
    return {
      ok: false,
      profile,
      code: "tools.mismatch",
      message,
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: route.candidates,
      diagnostics,
    };
  }

  return {
    ok: true,
    profile,
    selected: route.selected,
    tools: profile.tools,
    promptRoute: profile.promptRoute,
    candidates: route.candidates,
    diagnostics,
  };
}

/**
 * Per-invocation subagent resolver. Single public surface used by:
 *  - parent spawn (Task tool) to compute the worker `--model`,
 *    `--tools`, and prompt manifest;
 *  - child activation (`mmr-core/index.ts` `applySubagentProfile`) to
 *    validate the explicit `--model` and `--tools` CLI flags the child
 *    process was invoked with against the deny-aware, registered-tool
 *    intersection;
 *  - prompt assembly to filter `Available tools:` by the same effective
 *    worker tool set.
 *
 * Layers on top of the internal {@link resolveMmrSubagentRoute} and
 * adds:
 *  - parent-mode aware `promptBaseMode` with `deep → smart` aliasing for
 *    `from-parent` profiles;
 *  - effective worker tool set computed as
 *    `(profile.tools \ profile.denyTools) ∩ registeredTools`;
 *  - fail-closed when the worker tool set is empty;
 *  - explicit `--tools` validation against the effective worker tool set
 *    rather than `profile.tools`;
 *  - opt-in `modelPreferencesOverride` for settings-driven Task model preferences
 *    overrides (model preferences only; prompt base / deny set are pinned);
 *  - `invocationContext` marker (`"parent-spawn"` ↑ default vs
 *    `"child-activation"`) so the child activation path can validate
 *    model/tools without rejecting `from-parent` profiles that have no
 *    parentMode signal of their own (the parent owns prompt assembly and
 *    already delivered the worker system prompt before spawning). The
 *    marker does not loosen deny/tool/model validation in either context.
 *
 * Profiles without `denyTools` and without a `from-parent` base mode see
 * behavior identical to the underlying route helper.
 */
export interface MmrSubagentToolResolution {
  /** Profile tools after subtracting `profile.denyTools`. */
  readonly intendedTools: readonly string[];
  /** `profile.denyTools ?? []` for observability. */
  readonly deniedTools: readonly string[];
  /**
   * Host-registered tool names provided by the caller, or `undefined` when
   * the caller skipped the intersection step (e.g. profile validation that
   * does not have a Pi host).
   */
  readonly registeredTools?: readonly string[];
  /** Parent host's active tools at invocation time, diagnostics only. */
  readonly parentActiveTools?: readonly string[];
  /** Intended tools that were not registered in the host or were removed by a capability profile. */
  readonly omittedTools: readonly string[];
  readonly capabilityProfile?: MmrCapabilityProfileKey;
  readonly capabilityAllowedTools?: readonly string[];
}

interface MmrSubagentInvocationBase {
  readonly parentMode?: MmrModeKey;
  /**
   * Resolved parent mode for prompt assembly. Computed from
   * `profile.baseMode`:
   *  - concrete mode key → that key;
   *  - `"from-parent"` → `parentMode === "deep" ? "smart" : parentMode`;
   *  - undefined for `standalone` profiles.
   */
  readonly promptBaseMode?: MmrModeKey;
  readonly workerTools: readonly string[];
  readonly toolResolution: MmrSubagentToolResolution;
  readonly capabilityProfile?: MmrCapabilityProfileKey;
}

export interface MmrSubagentInvocationOk<
  TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike,
> extends MmrSubagentRouteSelectionOk<TModel>, MmrSubagentInvocationBase {
  /** `${provider}/${model}` form ready for `--model`. */
  readonly modelArg: string;
}

export interface MmrSubagentInvocationFail
  extends MmrSubagentRouteSelectionFail, MmrSubagentInvocationBase {
  readonly modelArg?: string;
}

export type MmrSubagentInvocation<
  TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike,
> = MmrSubagentInvocationOk<TModel> | MmrSubagentInvocationFail;

export interface ResolveMmrSubagentInvocationArgs<
  TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike,
> {
  readonly profile: MmrSubagentProfile;
  readonly registry: MmrModelRegistryLike<TModel>;
  readonly parentMode?: MmrModeKey;
  /**
   * Concrete tool names registered in the host process at invocation time
   * (e.g. `pi.getAllTools().map(t => t.name)`). When omitted, the
   * intersection step is skipped and `workerTools === intendedTools`.
   */
  readonly registeredTools?: readonly string[];
  /** Parent host active tools, recorded in diagnostics only. */
  readonly parentActiveTools?: readonly string[];
  readonly capabilityProfile?: MmrCapabilityProfileKey | string;
  readonly explicitModel?: string;
  /** Compared against the resolved `workerTools` order-independent. */
  readonly explicitTools?: readonly string[];
  /**
   * Settings-driven model preference override. Spec §6.3: settings may
   * override `modelPreferences` only — prompt base, deny set, allowMcp,
   * and allowToolbox are not user-overrideable.
   */
  readonly modelPreferencesOverride?: readonly MmrModelPreference[];
  /**
   * Identifies which side of the parent/child boundary is calling the
   * resolver. The resolver behaves identically for model and tool
   * resolution either way; only `from-parent` prompt-base resolution
   * depends on the caller context:
   *
   *  - `"parent-spawn"` (default): the Task tool (or any future parent
   *    that spawns a worker through this resolver) is computing the
   *    invocation. The parent owns prompt assembly, so a missing or
   *    `"free"` `parentMode` on a `from-parent` profile is a fail-closed
   *    condition (`prompt-base.unresolved`) — we cannot assemble a
   *    Task-enabled worker prompt without a Task-enabled parent mode.
   *  - `"child-activation"`: the child Pi process (`applySubagentProfile`
   *    in `mmr-core/index.ts`) is validating its CLI flags. The parent
   *    already assembled and delivered the worker system prompt via
   *    `--system-prompt` before spawning. Parent-mode metadata is used
   *    when present to select mode-specific worker routes; when absent,
   *    the resolver returns `promptBaseMode: undefined` for missing
   *    parent modes instead of failing closed.
   *
   * This is a caller-identity marker, not a safety toggle. It does not
   * loosen deny-list, tool intersection, model route, or explicit-tools
   * validation, all of which apply equally to parent and child.
   */
  readonly invocationContext?: "parent-spawn" | "child-activation";
}

function resolvePromptBaseMode(
  profile: MmrSubagentProfile,
  parentMode: MmrModeKey | undefined,
  invocationContext: "parent-spawn" | "child-activation",
): { promptBaseMode?: MmrModeKey; failure?: string } {
  if (profile.promptRoute !== "mode-derived" || profile.baseMode === undefined) {
    return {};
  }
  if (profile.baseMode !== "from-parent") {
    return { promptBaseMode: profile.baseMode };
  }
  if (!parentMode || parentMode === "open" || parentMode === "free") {
    // Child activation is downstream of parent prompt assembly: the
    // parent already delivered the worker system prompt via
    // `--system-prompt` before spawning. Older callers may not provide
    // parent-mode metadata, so child validation can still continue
    // without a prompt-base mode; model resolution then uses the profile's
    // default preferences.
    if (invocationContext === "child-activation") return {};
    return {
      failure: `Subagent "${profile.name}" is mode-derived (baseMode "from-parent") but no Task-enabled parent mode is active.`,
    };
  }
  // Spec §6.1: deep aliases to smart for prompt base, route list,
  // selected route, and thinking level. The route list / selected route
  // / thinking aliasing is realized by the profile being pinned to a
  // single `modelPreferences` array shared by all Task-enabled modes;
  // here we only need to flip the prompt-base key from deep to smart.
  return { promptBaseMode: parentMode === "deep" ? "smart" : parentMode };
}

function resolveInvocationModelPreferences(
  profile: MmrSubagentProfile,
  preferenceMode: MmrModeKey | undefined,
  override: readonly MmrModelPreference[] | undefined,
): readonly MmrModelPreference[] {
  if (override && override.length > 0) return override;
  if (preferenceMode) {
    return profile.modeModelPreferences?.[preferenceMode] ?? profile.modelPreferences;
  }
  return profile.modelPreferences;
}

function buildToolResolution(
  profile: MmrSubagentProfile,
  registeredTools: readonly string[] | undefined,
  parentActiveTools: readonly string[] | undefined,
  capabilityProfile: MmrCapabilityProfileKey | undefined,
  toolCeiling?: readonly string[],
): { resolution: MmrSubagentToolResolution; workerTools: readonly string[] } {
  const deniedTools: readonly string[] = [...new Set([...MMR_SUBAGENT_SHARED_DENY_TOOLS, ...(profile.denyTools ?? [])])];
  const denySet = new Set(deniedTools);
  const intendedTools = profile.tools.filter((t) => !denySet.has(t));
  let workerTools: readonly string[];
  let omittedTools: readonly string[];
  if (registeredTools === undefined) {
    workerTools = intendedTools;
    omittedTools = [];
  } else {
    const registeredSet = new Set(registeredTools);
    workerTools = intendedTools.filter((t) => registeredSet.has(t));
    omittedTools = intendedTools.filter((t) => !registeredSet.has(t));
  }
  const capabilityAllowedTools = capabilityProfile !== undefined
    ? resolveMmrCapabilityAllowedTools(capabilityProfile, profile.tools)
    : undefined;
  if (capabilityAllowedTools !== undefined) {
    const capabilitySet = new Set(capabilityAllowedTools);
    const beforeCapability = workerTools;
    workerTools = beforeCapability.filter((t) => capabilitySet.has(t));
    omittedTools = [...new Set([...omittedTools, ...beforeCapability.filter((t) => !capabilitySet.has(t))])];
  }
  if (toolCeiling !== undefined) {
    const ceilingSet = new Set(toolCeiling);
    const beforeCeiling = workerTools;
    workerTools = beforeCeiling.filter((t) => ceilingSet.has(t));
    omittedTools = [...new Set([...omittedTools, ...beforeCeiling.filter((t) => !ceilingSet.has(t))])];
  }
  const resolution: MmrSubagentToolResolution = {
    intendedTools,
    deniedTools,
    omittedTools,
    ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
    ...(capabilityAllowedTools !== undefined ? { capabilityAllowedTools } : {}),
    ...(registeredTools !== undefined ? { registeredTools } : {}),
    ...(parentActiveTools !== undefined ? { parentActiveTools } : {}),
  };
  return { resolution, workerTools };
}

export function resolveMmrSubagentInvocation<TModel extends MmrRegisteredModelLike>(
  args: ResolveMmrSubagentInvocationArgs<TModel>,
): MmrSubagentInvocation<TModel> {
  const { profile, registry, parentMode } = args;
  const invocationContext = args.invocationContext ?? "parent-spawn";
  const diagnostics: MmrSubagentResolveDiagnostic[] = [];

  // 1. Resolve prompt base mode (deep → smart aliasing for from-parent).
  const promptBaseRes = resolvePromptBaseMode(profile, parentMode, invocationContext);
  const baseModeFailure = promptBaseRes.failure;
  const promptBaseMode = promptBaseRes.promptBaseMode;

  let capabilityProfile: MmrCapabilityProfileKey | undefined;
  if (args.capabilityProfile !== undefined) {
    if (!isMmrCapabilityProfileKey(args.capabilityProfile)) {
      const message = `Unknown capability profile "${String(args.capabilityProfile)}" for subagent "${profile.name}".`;
      diagnostics.push({ code: "tools.capability", severity: "error", message });
      const base = buildToolResolution(profile, args.registeredTools, args.parentActiveTools, undefined);
      return {
        ok: false,
        profile,
        code: "tools.capability",
        message,
        tools: profile.tools,
        promptRoute: profile.promptRoute,
        candidates: [],
        diagnostics,
        ...(parentMode !== undefined ? { parentMode } : {}),
        ...(promptBaseMode !== undefined ? { promptBaseMode } : {}),
        workerTools: base.workerTools,
        toolResolution: base.resolution,
      };
    }
    capabilityProfile = args.capabilityProfile;
  }

  // 2. Resolve effective worker tool set.
  const { resolution, workerTools } = buildToolResolution(
    profile,
    args.registeredTools,
    args.parentActiveTools,
    capabilityProfile,
    invocationContext === "child-activation" ? args.explicitTools : undefined,
  );

  if (baseModeFailure) {
    diagnostics.push({
      code: "prompt-base.unresolved",
      severity: "error",
      message: baseModeFailure,
    });
    return {
      ok: false,
      profile,
      code: "prompt-base.unresolved",
      message: baseModeFailure,
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: [],
      diagnostics,
      ...(parentMode !== undefined ? { parentMode } : {}),
      ...(promptBaseMode !== undefined ? { promptBaseMode } : {}),
      workerTools,
      toolResolution: resolution,
      ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
    };
  }

  if (args.explicitTools !== undefined) {
    const explicitSorted = [...args.explicitTools].sort();
    const workerSorted = [...workerTools].sort();
    const equal = explicitSorted.length === workerSorted.length
      && explicitSorted.every((t, i) => t === workerSorted[i]);
    if (!equal) {
      const explicitList = [...args.explicitTools].join(",");
      const workerList = [...workerTools].join(",");
      const message = `Subagent "${profile.name}" was invoked with --tools ${explicitList}, but the resolved worker tool set is ${workerList}.`;
      diagnostics.push({ code: "tools.mismatch", severity: "error", message });
      return {
        ok: false,
        profile,
        code: "tools.mismatch",
        message,
        tools: profile.tools,
        promptRoute: profile.promptRoute,
        candidates: [],
        diagnostics,
        ...(parentMode !== undefined ? { parentMode } : {}),
        ...(promptBaseMode !== undefined ? { promptBaseMode } : {}),
        workerTools,
        toolResolution: resolution,
        ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
      };
    }
  }

  // Only fail `tools.empty` when the profile *intended* at least one
  // tool that was then removed by deny/registered intersection. Profiles
  // that intentionally declare `tools: []` (e.g. `history-reader` runs
  // its analysis prompt without local tool calls) must activate cleanly.
  if (profile.tools.length > 0 && workerTools.length === 0) {
    const message = `Subagent "${profile.name}" has no available worker tools after deny + registered intersection.`;
    diagnostics.push({ code: "tools.empty", severity: "error", message });
    return {
      ok: false,
      profile,
      code: "tools.empty",
      message,
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: [],
      diagnostics,
      ...(parentMode !== undefined ? { parentMode } : {}),
      ...(promptBaseMode !== undefined ? { promptBaseMode } : {}),
      workerTools,
      toolResolution: resolution,
      ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
    };
  }

  // 3. Resolve model route through the existing route resolver. We pass
  //    `explicitTools: undefined` so the underlying route resolver does
  //    not compare against profile.tools; we validate explicit tools
  //    against `workerTools` below instead.
  const resolvedModelPreferences = resolveInvocationModelPreferences(
    profile,
    promptBaseMode ?? parentMode,
    args.modelPreferencesOverride,
  );
  const overrideProfile = resolvedModelPreferences === profile.modelPreferences
    ? profile
    : { ...profile, modelPreferences: resolvedModelPreferences };
  const routeArgs: ResolveMmrSubagentRouteArgs<TModel> = {
    profile: overrideProfile,
    registry,
  };
  if (args.explicitModel !== undefined) routeArgs.explicitModel = args.explicitModel;
  const route = resolveMmrSubagentRoute(routeArgs);
  diagnostics.push(...route.diagnostics);

  if (!route.ok) {
    return {
      ok: false,
      profile,
      code: route.code,
      message: route.message,
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: route.candidates,
      diagnostics,
      ...(parentMode !== undefined ? { parentMode } : {}),
      ...(promptBaseMode !== undefined ? { promptBaseMode } : {}),
      workerTools,
      toolResolution: resolution,
      ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
    };
  }

  const modelArg = `${route.selected.provider}/${route.selected.model}`;
  return {
    ok: true,
    profile,
    selected: route.selected,
    tools: profile.tools,
    promptRoute: profile.promptRoute,
    candidates: route.candidates,
    diagnostics,
    ...(parentMode !== undefined ? { parentMode } : {}),
    ...(promptBaseMode !== undefined ? { promptBaseMode } : {}),
    workerTools,
    toolResolution: resolution,
    ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
    modelArg,
  };
}
