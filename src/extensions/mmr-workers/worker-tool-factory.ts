import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { loadMmrCoreSettings } from "../mmr-core/settings.js";
import {
  getMmrSubagentProfile,
  type MmrSubagentPartialOutputPolicy,
} from "../mmr-core/subagent-profiles.js";
import type { MmrSubagentInvocation } from "../mmr-core/subagent-resolver.js";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { readMmrWorkerSessionId } from "./fallback.js";
import { getMmrBackgroundDispatcher } from "./background-dispatch.js";
import {
  refreshBackgroundTaskWidget,
  renderMmrSubagentCall,
  renderMmrSubagentResult,
} from "./progress-rendering.js";
import { computeMmrChildExtensionScope } from "./child-extension-scope.js";
import {
  resolveMmrWorkerSessionKey,
  resolveWorkerCwd,
  type ToolHostLike,
} from "./worker-host.js";
import {
  runMmrWorkerWithSharedFallback,
  type MmrWorkerRunnerResolutionDeps,
} from "./worker-fallback-run.js";
import {
  getMmrAsyncTaskRegistry,
  type MmrAsyncTaskRegistry,
  type MmrAsyncTaskRun,
} from "./async-task-registry.js";
import { buildSpawnErrorWorkerResult } from "./task-result.js";
import {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  emptyMmrWorkerUsageStats,
  type MmrSubagentRunOptions,
  type MmrSubagentRunner,
  type MmrWorkerProgressSnapshot,
  type MmrWorkerResult,
} from "./runner.js";
import { progressTextOrPlaceholder } from "./worker-result-shaping.js";

/**
 * Declarative worker-tool factory for the spawned-subagent tools
 * (`finder`, `oracle`, `librarian`, `Task`). One execute skeleton —
 * coerce params → pre-spawn gate → parent-side invocation resolution →
 * runner options → session-scoped model fallback → final shaping —
 * generated from a per-tool {@link MmrWorkerToolSpec}, so each concrete
 * tool file shrinks to its spec, its prompt text, and its per-tool
 * detail/content builders.
 *
 * All four tools resolve their invocation parent-side through one
 * resolver seam (the Task/librarian pattern) and run through the one
 * shared fallback wrapper. Differences that are part of each tool's
 * pinned public contract are expressed as spec data, not parallel code
 * paths:
 *
 *  - `resolutionFailure: "fail-closed"` (librarian, Task) returns the
 *    spec's pre-spawn failure result when the resolver cannot produce a
 *    route; `"degrade"` (finder, oracle) proceeds with no explicit
 *    `--model` so the child Pi process resolves the route itself — the
 *    long-standing contract pinned by the finder/oracle tests.
 *  - `mirrorWorkerTools` controls whether the resolved worker tool set
 *    is passed to the child as explicit `--tools`. librarian/Task
 *    mirror (the child re-resolves and fails closed on disagreement);
 *    finder/oracle deliberately do not, because their profiles list
 *    tools whose owning extension may be loaded differently in the
 *    child environment — the child's own deny-aware, registered
 *    intersection stays the source of truth for them.
 *  - `progressModelBinding` preserves which model id progress events
 *    report during a fallback attempt: finder/oracle re-resolve per
 *    attempt; librarian/Task keep the initially resolved route until
 *    the run settles.
 *
 * This module is intentionally internal: no extension entry point
 * re-exports it, and it is not part of the package-level public API.
 */

/** Resolver seam input shared by every worker tool's invocation resolution. */
export interface MmrWorkerToolResolveInput {
  ctx: ExtensionContext | undefined;
  registeredTools?: readonly string[];
  /**
   * Effective settings-driven (or explicit programmatic) model
   * preference override resolved by the factory before calling the
   * resolver; absent when neither source supplies one.
   */
  modelPreferencesOverride?: readonly MmrModelPreference[];
}

/**
 * Mutable per-execute run context threaded through the spec's
 * progress/final builders. `resolvedModel`/`contextWindow` are updated
 * per fallback attempt (`progressModelBinding: "per-attempt"`) or after
 * the run settles (`"initial"`), mirroring each tool's pre-factory
 * behavior.
 */
export interface MmrWorkerToolRunContext<TParams, TRun = void> {
  params: TParams;
  cwd: string;
  /** Per-execute data computed by {@link MmrWorkerToolSpec.computeRunData} (e.g. oracle attachments). */
  runData: TRun;
  /** Successful parent-side invocation; undefined when the spec degraded on a resolution failure. */
  invocation: (MmrSubagentInvocation & { ok: true }) | undefined;
  /** Worker tool list reported in details (per {@link MmrWorkerToolSpec.detailsWorkerTools}). */
  workerTools: readonly string[];
  resolvedModel: string | undefined;
  contextWindow: number | undefined;
}

/** Runtime dependency seams every factory-built worker tool accepts. */
export interface MmrWorkerToolFactoryDeps extends MmrWorkerRunnerResolutionDeps {
  /** Override the worker output byte cap. */
  outputByteLimit?: number;
  /** Pi host, captured at registration so resolution can inspect tool state. */
  pi?: ToolHostLike;
  /**
   * Async-task registry every blocking run registers with (register + await
   * settle). Defaults to the process singleton; injectable for deterministic
   * tests.
   */
  registry?: MmrAsyncTaskRegistry;
  /** Deterministic registry partition key override for tests. */
  sessionKey?: string;
}

export interface MmrWorkerToolSpec<TParams, TDetails, TRun = void> {
  toolName: string;
  profileName: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: readonly string[];
  parameters: TSchema;
  /** Set for workflow workers that must not run concurrently (Task). */
  executionMode?: "sequential";
  /** Override the call renderer (defaults to the shared subagent call renderer). */
  renderCall?(args: unknown, theme: unknown, context: unknown): unknown;
  /** Override the result renderer (defaults to the shared subagent result renderer). */
  renderResult?(result: unknown, options: unknown, theme: unknown, context: unknown): unknown;
  /** Compact progress text shown before the worker streams any output. */
  progressPlaceholder: string;

  /**
   * v2 background surface: the tool's schema carries
   * `background?`/`group?`/`notify?` and a `background: true` call is
   * delegated to the registered background dispatcher instead of running
   * the blocking path. The factory strips the three fields before
   * {@link coerceParams}, so per-tool validation sees only the worker's
   * own params. Off (undefined) for oracle, which is blocking-only.
   */
  backgroundCapable?: boolean;

  /**
   * Validate/coerce raw params. Throw to reject; whether the throw
   * propagates to Pi (finder/oracle) or becomes a structured
   * validation-error result (librarian/Task) is decided by
   * {@link paramsFailure}.
   */
  coerceParams(raw: unknown): TParams;
  /**
   * Map a {@link coerceParams} throw to a structured failure result.
   * Omit to propagate the throw to the Pi tool host (the pinned
   * finder/oracle contract).
   */
  paramsFailure?(message: string, raw: unknown, cwd: string): AgentToolResult<TDetails>;
  /**
   * Pre-spawn gate evaluated after params validate (e.g. librarian's
   * mmr-github prerequisite). Return a result to short-circuit.
   */
  preSpawnGate?(params: TParams, cwd: string): AgentToolResult<TDetails> | undefined;
  /**
   * Compute per-execute run data available to the prompt and detail
   * builders (e.g. oracle's resolved attachments). Runs after the
   * pre-spawn gate, before invocation resolution.
   */
  computeRunData?(params: TParams, cwd: string): TRun;

  /**
   * Parent-side invocation resolver seam (deps-injectable per tool).
   * `params`/`runData` let mode-derived specs thread per-call inputs
   * (Task's parentMode and capabilityProfile) into the resolution.
   */
  resolveInvocation(input: MmrWorkerToolResolveInput, params: TParams, runData: TRun): MmrSubagentInvocation;
  /**
   * `"fail-closed"`: a non-ok invocation returns
   * {@link resolutionFailureResult}. `"degrade"`: proceed with no
   * explicit model (child resolves the route), preserving the
   * finder/oracle no-registry contract.
   */
  resolutionFailure: "fail-closed" | "degrade";
  /** Required when `resolutionFailure` is `"fail-closed"`. */
  resolutionFailureResult?(
    invocation: MmrSubagentInvocation & { ok: false },
    params: TParams,
    cwd: string,
  ): AgentToolResult<TDetails>;
  /** Pass the resolved worker tool set to the child as explicit `--tools`. */
  mirrorWorkerTools: boolean;
  /** Which tool list `runCtx.workerTools` reports in details. */
  detailsWorkerTools: "profile-constant" | "invocation";
  /** The profile-derived constant reported when `detailsWorkerTools` is `"profile-constant"` (and pre-resolution failures). */
  workerToolsConstant: readonly string[];
  /** Which model id progress events report during fallback attempts. */
  progressModelBinding: "per-attempt" | "initial";

  /**
   * Board identity for a registered run: the short display label and the
   * display prompt stamped on the registry record (shown by task_list, the
   * pinned widget, and group cards). Formats match the background surface's
   * member normalization so a blocking row and a background row of the same
   * worker read identically.
   */
  describeRun(params: TParams, runData: TRun): { description: string; displayPrompt: string };

  /** Worker user prompt (the child's task text). */
  buildUserPrompt(params: TParams, runData: TRun): string;
  /**
   * Assemble the worker system prompt. `workerTools` is the resolved
   * invocation tool set when available — specs that pin their prompt
   * without a tool manifest (finder/oracle) ignore it. `runCtx` carries
   * the invocation and per-execute run data for mode-derived prompts.
   */
  assembleSystemPrompt(
    cwd: string,
    workerTools: readonly string[] | undefined,
    runCtx: MmrWorkerToolRunContext<TParams, TRun>,
  ): string;
  /**
   * Resolve the context window for the current route. Degrade-mode
   * tools read it from the host model registry by id; fail-closed
   * tools read it from the resolved invocation's registered model.
   */
  resolveContextWindow?(
    ctx: ExtensionContext | undefined,
    model: string | undefined,
    invocation: (MmrSubagentInvocation & { ok: true }) | undefined,
  ): number | undefined;
  /** Extra runner options merged into the base options (e.g. Task's parentMode + replace delivery). */
  extraRunnerOptions?(runCtx: MmrWorkerToolRunContext<TParams, TRun>): Partial<MmrSubagentRunOptions>;

  /** Fallback candidate preferences (profile defaults; Task ranks by parent mode). */
  candidatePreferences(runCtx: MmrWorkerToolRunContext<TParams, TRun>): readonly MmrModelPreference[];
  /** Fallback scope key component for mode-derived profiles (Task). */
  fallbackParentMode?(runCtx: MmrWorkerToolRunContext<TParams, TRun>): string | undefined;

  buildProgressDetails(snapshot: MmrWorkerProgressSnapshot, runCtx: MmrWorkerToolRunContext<TParams, TRun>): TDetails;
  buildFinalDetails(result: MmrWorkerResult, runCtx: MmrWorkerToolRunContext<TParams, TRun>): TDetails;
  buildFinalContent(result: MmrWorkerResult, runCtx: MmrWorkerToolRunContext<TParams, TRun>): string;
  /**
   * Map a runner/fallback throw to a final result (librarian's
   * context-window/spawn-error mapping, Task's §9.4 rule 2). Omit to
   * propagate the throw (finder/oracle).
   */
  mapRunError?(err: unknown, runCtx: MmrWorkerToolRunContext<TParams, TRun>): AgentToolResult<TDetails>;
}

/**
 * Resolve the effective model-preference override for a worker execute
 * call. Precedence (top wins): explicit programmatic override →
 * settings-driven `subagentModelPreferences.<profile>` (re-read every
 * invocation so `/mmr-config` changes apply without a restart) →
 * `undefined` (resolver falls back to profile defaults). Settings read
 * errors never block a spawn; the child activation path surfaces its
 * own settings warnings.
 */
export function resolveWorkerModelPreferencesOverride(args: {
  profileName: string;
  cwd: string;
  explicit?: readonly MmrModelPreference[];
  settingsOverride?: readonly MmrModelPreference[];
  loadSettings?: (cwd: string) => Record<string, readonly MmrModelPreference[]> | undefined;
}): readonly MmrModelPreference[] | undefined {
  if (args.explicit !== undefined && args.explicit.length > 0) return args.explicit;
  let settingsBlock: readonly MmrModelPreference[] | undefined;
  if (args.settingsOverride !== undefined) {
    settingsBlock = args.settingsOverride;
  } else {
    try {
      const loaded = args.loadSettings
        ? args.loadSettings(args.cwd)
        : loadMmrCoreSettings(args.cwd).settings.subagentModelPreferences;
      settingsBlock = loaded?.[args.profileName];
    } catch {
      // fall through to profile defaults
    }
  }
  if (settingsBlock && settingsBlock.length > 0) return settingsBlock;
  return undefined;
}

/** Registered tool names from the captured Pi host, when enumerable. */
export function readWorkerRegisteredTools(pi: ToolHostLike | undefined): readonly string[] | undefined {
  if (!pi) return undefined;
  try {
    const tools = pi.getAllTools?.();
    if (!Array.isArray(tools)) return undefined;
    return tools.flatMap((t) => {
      if (t === null || typeof t !== "object") return [];
      const name = (t as { name?: unknown }).name;
      return typeof name === "string" && name.length > 0 ? [name] : [];
    });
  } catch {
    return undefined;
  }
}

/** Shared 80-char display clip used for worker run descriptions (board rows, group cards). */
export function clipMmrWorkerDescription(text: string): string {
  const summary = text.replace(/\s+/g, " ").trim();
  return summary.length > 80 ? `${summary.slice(0, 77)}…` : summary;
}

/**
 * A fully prepared worker run: everything the async-task registry needs to
 * register it (board identity + policy bits), the run thunk, and the ONE
 * projection from the raw worker result to the final tool result.
 *
 * This is the convergence point of the blocking and background surfaces:
 * the factory's blocking execute registers a prepared run and awaits settle;
 * `executeBackgroundStart` (start_task and the named tools' `background:
 * true` path) registers the same prepared run and returns the task id.
 */
export interface MmrPreparedWorkerRun<TDetails = unknown> {
  /** Public worker name (the tool name); the registry record's `agent`. */
  agent: string;
  /** Short display label for the board record. */
  description: string;
  /** Display prompt stamped on the board record (the worker's primary input). */
  displayPrompt: string;
  cwd: string;
  workerTools: readonly string[];
  resolvedModel?: string;
  contextWindow?: number;
  capabilityProfile?: string;
  /** Profile-declared nonzero-exit policy for registry classification. */
  partialOutputPolicy?: MmrSubagentPartialOutputPolicy;
  /**
   * Run thunk for the registry: receives the REGISTRY's signal/progress sink
   * and resolves with the raw worker result. Never rejects — a runner/
   * fallback throw is captured in {@link runError} and converted into a
   * synthetic spawn-error result so the registry always classifies a
   * terminal payload.
   */
  run: MmrAsyncTaskRun;
  /**
   * Project a raw terminal worker result into the tool's pinned final
   * content/details. Handed to the registry so projection happens exactly
   * once at settle; the blocking path returns the projected result inline
   * and task_poll/task_cancel read the same `finalToolResult`. Absent for
   * tool-execute adapters whose run thunk settles with an already-shaped
   * tool result.
   */
  projectResult?: (result: MmrWorkerResult) => AgentToolResult<TDetails>;
  /**
   * Runner/fallback throw captured by {@link run}. Specs without
   * `mapRunError` (finder, oracle) keep their throw-to-host contract: the
   * blocking execute rethrows this after the registered task settles.
   */
  runError?: unknown;
  /**
   * Board reference, stamped by the registrant right after `startTask`.
   * Progress/final details produced afterwards carry these renderer-only
   * fields so the renderer can resolve the live registry snapshot.
   */
  sessionKey?: string;
  taskId?: string;
}

export type MmrPreparedWorkerRunResult<TDetails = unknown> =
  | { ok: true; prepared: MmrPreparedWorkerRun<TDetails> }
  | { ok: false; result: AgentToolResult<TDetails> };

/** Per-call preparation seam produced by {@link createWorkerRunPreparer}. */
export type MmrWorkerRunPreparer<TDetails = unknown> = (
  rawParams: unknown,
  ctx: ExtensionContext,
  opts?: {
    /** Blocking tool-call progress sink; receives the shaped progress results. */
    onUpdate?: (update: AgentToolResult<TDetails>) => void;
  },
) => MmrPreparedWorkerRunResult<TDetails>;

/**
 * Build the per-call run preparer for a worker spec: params validation →
 * pre-spawn gate → parent-side invocation resolution → runner options →
 * a registry-ready prepared run whose thunk wraps the session-scoped model
 * fallback and whose projector owns the final shaping.
 *
 * Contract notes preserved from the pre-registry execute skeleton:
 *  - a `coerceParams` throw propagates to the caller when the spec has no
 *    `paramsFailure` (the pinned finder/oracle throw-to-host contract);
 *  - `"degrade"` resolution proceeds with no explicit model;
 *  - the settled fallback route wins for the final details regardless of
 *    the progress binding.
 */
export function createWorkerRunPreparer<TParams, TDetails, TRun = void>(
  spec: MmrWorkerToolSpec<TParams, TDetails, TRun>,
  deps: MmrWorkerToolFactoryDeps,
  factoryOptions: {
    effectiveRunner: MmrSubagentRunner;
    resolveModelPreferencesOverride(cwd: string): readonly MmrModelPreference[] | undefined;
  },
): MmrWorkerRunPreparer<TDetails> {
  const outputByteLimit = deps.outputByteLimit ?? DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT;
  return (rawParams, ctx, opts = {}) => {
    const cwd = resolveWorkerCwd(ctx);

    // 1. Params. Specs without paramsFailure keep the throw-to-host contract.
    let params: TParams;
    try {
      params = spec.coerceParams(rawParams);
    } catch (err) {
      if (!spec.paramsFailure) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, result: spec.paramsFailure(message, rawParams, cwd) };
    }

    // 2. Pre-spawn gate, then per-execute run data.
    const gated = spec.preSpawnGate?.(params, cwd);
    if (gated) return { ok: false, result: gated };
    const runData = (spec.computeRunData ? spec.computeRunData(params, cwd) : undefined) as TRun;

    // 3. Parent-side invocation resolution (one resolver path for all
    //    tools). The preference override is re-resolved on every call so
    //    parent and child read settings through the same code path.
    const registeredTools = readWorkerRegisteredTools(deps.pi);
    const preferencesOverride = factoryOptions.resolveModelPreferencesOverride(cwd);
    const resolveInput: MmrWorkerToolResolveInput = { ctx };
    if (registeredTools !== undefined) resolveInput.registeredTools = registeredTools;
    if (preferencesOverride !== undefined) resolveInput.modelPreferencesOverride = preferencesOverride;
    const invocation = spec.resolveInvocation(resolveInput, params, runData);

    let okInvocation: (MmrSubagentInvocation & { ok: true }) | undefined;
    if (invocation.ok) {
      okInvocation = invocation;
    } else if (spec.resolutionFailure === "fail-closed") {
      if (!spec.resolutionFailureResult) {
        throw new Error(`${spec.toolName}: resolutionFailureResult is required for fail-closed resolution.`);
      }
      return { ok: false, result: spec.resolutionFailureResult(invocation, params, cwd) };
    }
    // "degrade": continue with no explicit model/tools; the child Pi
    // process resolves the route and tool set itself.

    const runCtx: MmrWorkerToolRunContext<TParams, TRun> = {
      params,
      cwd,
      runData,
      invocation: okInvocation,
      workerTools:
        spec.detailsWorkerTools === "invocation" && okInvocation
          ? okInvocation.workerTools
          : spec.workerToolsConstant,
      resolvedModel: okInvocation?.modelArg,
      contextWindow: spec.resolveContextWindow?.(ctx, okInvocation?.modelArg, okInvocation),
    };

    // 4. Runner options (minus the per-run signal/progress seams, which the
    //    registry supplies when it fires the run thunk).
    const childExtensionScope = computeMmrChildExtensionScope({
      profileName: spec.profileName,
      host: deps.pi,
    });
    const userPrompt = spec.buildUserPrompt(params, runData);
    const baseRunnerOptions: Omit<MmrSubagentRunOptions, "signal" | "onProgress"> = {
      profileName: spec.profileName,
      prompt: userPrompt,
      cwd,
      ...(okInvocation?.modelArg !== undefined ? { model: okInvocation.modelArg } : {}),
      ...(spec.mirrorWorkerTools && okInvocation ? { tools: okInvocation.workerTools } : {}),
      systemPrompt: spec.assembleSystemPrompt(cwd, okInvocation?.workerTools, runCtx),
      ...(childExtensionScope ? { childExtensionScope } : {}),
      outputByteLimit,
      ...(spec.extraRunnerOptions ? spec.extraRunnerOptions(runCtx) : {}),
    };

    // Renderer-only board reference, stamped onto every details payload
    // produced AFTER the registrant assigns it (never into model `content`).
    const stampBoardRef = (details: TDetails): TDetails => {
      if (prepared.sessionKey === undefined || prepared.taskId === undefined) return details;
      if (typeof details !== "object" || details === null) return details;
      return { ...details, sessionKey: prepared.sessionKey, taskId: prepared.taskId };
    };
    const stampResult = (result: AgentToolResult<TDetails>): AgentToolResult<TDetails> => ({
      ...result,
      details: stampBoardRef(result.details as TDetails),
    });

    const described = spec.describeRun(params, runData);
    const partialOutputPolicy = getMmrSubagentProfile(spec.profileName)?.partialOutputPolicy;
    // Task-only narrowing knob, threaded onto the board record when the
    // worker's params carry it (the schema admits it only for Task).
    const capabilityProfile = (params as { capabilityProfile?: unknown }).capabilityProfile;

    const prepared: MmrPreparedWorkerRun<TDetails> = {
      agent: spec.toolName,
      description: described.description,
      displayPrompt: described.displayPrompt,
      cwd,
      workerTools: runCtx.workerTools,
      ...(runCtx.resolvedModel !== undefined ? { resolvedModel: runCtx.resolvedModel } : {}),
      ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
      ...(typeof capabilityProfile === "string" ? { capabilityProfile } : {}),
      ...(partialOutputPolicy !== undefined ? { partialOutputPolicy } : {}),
      run: async ({ signal, onProgress }) => {
        // Each progress event feeds the registry twice — the raw snapshot
        // (board freshness, usage, tool counts) and the shaped tool result
        // (poll-while-running text) — plus the blocking call's own updater.
        const handleProgress = (snapshot: MmrWorkerProgressSnapshot): void => {
          onProgress(snapshot);
          const shaped: AgentToolResult<TDetails> = {
            content: [{ type: "text", text: progressTextOrPlaceholder(snapshot, spec.progressPlaceholder) }],
            details: stampBoardRef(spec.buildProgressDetails(snapshot, runCtx)),
          };
          onProgress(shaped);
          opts.onUpdate?.(shaped);
        };

        // 5. Session-scoped model fallback (one shared wrapper for all
        //    tools). Under an applied override the closure re-resolves the
        //    invocation (so parent spawn and child activation agree) and
        //    forwards the override to the child via the runner env channel.
        const runWorkerOnce = async (
          runArgs: { override?: readonly MmrModelPreference[] },
        ): Promise<{ result: MmrWorkerResult; route: string | undefined }> => {
          let runOptions: Omit<MmrSubagentRunOptions, "signal" | "onProgress"> = baseRunnerOptions;
          let route = runCtx.invocation?.modelArg;
          if (runArgs.override) {
            const overrideInput: MmrWorkerToolResolveInput = { ctx };
            if (registeredTools !== undefined) overrideInput.registeredTools = registeredTools;
            overrideInput.modelPreferencesOverride = runArgs.override;
            const overrideInvocation = spec.resolveInvocation(overrideInput, params, runData);
            if (overrideInvocation.ok) {
              route = overrideInvocation.modelArg;
              runOptions = {
                ...baseRunnerOptions,
                model: overrideInvocation.modelArg,
                ...(spec.mirrorWorkerTools ? { tools: overrideInvocation.workerTools } : {}),
                modelPreferencesOverride: runArgs.override,
              };
              if (spec.progressModelBinding === "per-attempt") {
                runCtx.resolvedModel = overrideInvocation.modelArg;
                runCtx.contextWindow = spec.resolveContextWindow?.(ctx, overrideInvocation.modelArg, overrideInvocation);
              }
            } else if (spec.resolutionFailure === "degrade") {
              // Degrade-mode tools historically selected straight from the
              // override list; an unresolvable override falls back to "no
              // explicit model" (rather than the original route) so the
              // child still resolves against the forwarded override.
              route = undefined;
              const { model: _model, ...withoutModel } = baseRunnerOptions;
              runOptions = { ...withoutModel, modelPreferencesOverride: runArgs.override };
              if (spec.progressModelBinding === "per-attempt") {
                runCtx.resolvedModel = undefined;
                runCtx.contextWindow = spec.resolveContextWindow?.(ctx, undefined, undefined);
              }
            }
            // fail-closed specs keep the original route when the override
            // does not resolve, WITHOUT forwarding the override env, so
            // parent --model and child activation still agree rather than
            // guaranteeing a mismatch.
          }
          const result = await factoryOptions.effectiveRunner.run({
            ...runOptions,
            signal,
            onProgress: handleProgress,
          });
          return { result, route };
        };

        try {
          const fallbackParentMode = spec.fallbackParentMode?.(runCtx);
          const outcome = await runMmrWorkerWithSharedFallback({
            ctx,
            sessionId: readMmrWorkerSessionId(ctx),
            toolName: spec.toolName,
            profileName: spec.profileName,
            ...(fallbackParentMode !== undefined ? { parentMode: fallbackParentMode } : {}),
            candidatePreferences: spec.candidatePreferences(runCtx),
            run: runWorkerOnce,
          });
          // 6. The settled route wins for the final details regardless of
          //    the progress binding (the projector reads runCtx at settle).
          if (outcome.route !== undefined) {
            runCtx.resolvedModel = outcome.route;
            if (spec.progressModelBinding === "per-attempt") {
              runCtx.contextWindow = spec.resolveContextWindow?.(ctx, outcome.route, runCtx.invocation);
            }
          }
          return outcome.result;
        } catch (err) {
          // Never reject into the registry: capture the throw (specs without
          // mapRunError rethrow it on the blocking path) and settle with a
          // synthetic spawn-error result so classification and the board
          // record stay coherent.
          prepared.runError = err;
          return buildSpawnErrorWorkerResult(err, { prompt: userPrompt, cwd });
        }
      },
      projectResult: (result) => {
        if (prepared.runError !== undefined && spec.mapRunError) {
          return stampResult(spec.mapRunError(prepared.runError, runCtx));
        }
        return stampResult({
          content: [{ type: "text", text: spec.buildFinalContent(result, runCtx) }],
          details: spec.buildFinalDetails(result, runCtx),
        });
      },
    };
    return { ok: true, prepared };
  };
}

/** Synthetic aborted worker result for runs finalized without a runner payload. */
function syntheticAbortedWorkerResult(prompt: string, cwd: string, errorMessage?: string): MmrWorkerResult {
  return {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    exitCode: null,
    signal: null,
    aborted: true,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: false,
    usage: emptyMmrWorkerUsageStats(),
    stderr: "",
    command: "",
    args: [],
    prompt,
    cwd,
    trail: [],
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

/**
 * Build a spawned-subagent ToolDefinition from a declarative spec.
 *
 * Every blocking run is a task: execute prepares the run (see
 * {@link createWorkerRunPreparer}), registers it with the async-task
 * registry (`runMode: "blocking"`, cap-exempt, tool-call signal adapted to
 * task cancellation), awaits settle, and returns the projected result —
 * projection through the registry is the only result path, and the run is
 * visible on the task_list board and the pinned widget like any background
 * run.
 */
export function createWorkerTool<TParams, TDetails, TRun = void>(
  spec: MmrWorkerToolSpec<TParams, TDetails, TRun>,
  deps: MmrWorkerToolFactoryDeps,
  factoryOptions: {
    effectiveRunner: MmrSubagentRunner;
    /** Per-execute settings/override resolution (per-tool precedence). */
    resolveModelPreferencesOverride(cwd: string): readonly MmrModelPreference[] | undefined;
  },
): ToolDefinition {
  const prepareRun = createWorkerRunPreparer(spec, deps, factoryOptions);
  return {
    name: spec.toolName,
    label: spec.toolName,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: [...spec.promptGuidelines],
    parameters: spec.parameters,
    ...(spec.executionMode !== undefined ? { executionMode: spec.executionMode } : {}),
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      if (spec.renderCall) {
        return spec.renderCall(args, theme, context) as ReturnType<NonNullable<ToolDefinition["renderCall"]>>;
      }
      return renderMmrSubagentCall(spec.toolName, args, theme, context);
    },
    renderResult(result, renderOptions, theme, context) {
      if (spec.renderResult) {
        return spec.renderResult(result, renderOptions, theme, context) as ReturnType<NonNullable<ToolDefinition["renderResult"]>>;
      }
      return renderMmrSubagentResult(spec.toolName, result, renderOptions, theme, context);
    },
    async execute(
      _toolCallId,
      rawParams,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<TDetails>> {
      const cwd = resolveWorkerCwd(ctx);

      // 0. v2 background surface. Strip background/group/notify before the
      //    per-tool params validation; a background:true call validates the
      //    worker params fail-closed and then delegates to the background
      //    dispatcher (no blocking run, no spawn).
      const fail = (message: string): AgentToolResult<TDetails> => {
        if (spec.paramsFailure) return spec.paramsFailure(message, rawParams, cwd);
        throw new Error(message);
      };
      if (spec.backgroundCapable && typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)) {
        const { background, group, notify, ...workerParams } = rawParams as Record<string, unknown>;
        if (background !== undefined && typeof background !== "boolean") {
          return fail(`${spec.toolName}: background must be a boolean.`);
        }
        if (group !== undefined && (typeof group !== "string" || group.trim().length === 0)) {
          return fail(`${spec.toolName}: group must be a non-empty string.`);
        }
        if (notify !== undefined && typeof notify !== "boolean") {
          return fail(`${spec.toolName}: notify must be a boolean.`);
        }
        if (background !== true && (group !== undefined || notify !== undefined)) {
          return fail(`${spec.toolName}: group and notify require background: true.`);
        }
        if (background === true) {
          // Fail closed on the worker's own params BEFORE any registry side
          // effect, mirroring the background surface's pre-spawn contract.
          try {
            spec.coerceParams(workerParams);
          } catch (err) {
            if (!spec.paramsFailure) throw err;
            const message = err instanceof Error ? err.message : String(err);
            return spec.paramsFailure(message, rawParams, cwd);
          }
          const dispatch = getMmrBackgroundDispatcher();
          if (!dispatch) {
            return fail(
              `${spec.toolName}: background runs are unavailable (the background task surface is not registered in this session).`,
            );
          }
          return (await dispatch({
            agent: spec.toolName,
            params: workerParams,
            group: group as string | undefined,
            notify: notify as boolean | undefined,
            toolCallId: _toolCallId,
            ctx,
          })) as AgentToolResult<TDetails>;
        }
        // Blocking path: continue with the v2 fields stripped (an explicit
        // background:false call behaves exactly like an unadorned one).
        rawParams = workerParams;
      }

      // 1. Prepare the run: params → gate → invocation resolution → runner
      //    options → run thunk + projector. Pre-spawn failures return their
      //    shaped result without registering anything.
      const prep = prepareRun(rawParams, ctx, onUpdate ? { onUpdate } : {});
      if (!prep.ok) return prep.result;
      const prepared = prep.prepared;

      // 2. Register: every worker run is a task. Blocking runs are
      //    cap-exempt, never deduplicated, and carry no watchdog; the
      //    tool-call signal is adapted to task cancellation by the registry,
      //    so task_cancel and a tool-call abort converge on one path.
      const registry = deps.registry ?? getMmrAsyncTaskRegistry();
      const sessionKey = resolveMmrWorkerSessionKey(ctx, deps.sessionKey);
      const refreshWidget = (): void => {
        try {
          refreshBackgroundTaskWidget(ctx, registry.listTasks(sessionKey), (groupId) =>
            registry.getGroup(sessionKey, groupId),
          );
        } catch {
          // UI mirror only; a widget failure must never affect the run.
        }
      };
      const started = registry.startTask({
        sessionKey,
        originToolCallId: _toolCallId,
        runMode: "blocking",
        ...(signal !== undefined ? { externalSignal: signal } : {}),
        agent: prepared.agent,
        description: prepared.description,
        prompt: prepared.displayPrompt,
        cwd: prepared.cwd,
        workerTools: prepared.workerTools,
        ...(prepared.resolvedModel !== undefined ? { resolvedModel: prepared.resolvedModel } : {}),
        ...(prepared.contextWindow !== undefined ? { contextWindow: prepared.contextWindow } : {}),
        ...(prepared.capabilityProfile !== undefined ? { capabilityProfile: prepared.capabilityProfile } : {}),
        ...(prepared.partialOutputPolicy !== undefined ? { partialOutputPolicy: prepared.partialOutputPolicy } : {}),
        ...(prepared.projectResult !== undefined
          ? { projectResult: prepared.projectResult as (result: MmrWorkerResult) => AgentToolResult<unknown> }
          : {}),
        run: prepared.run,
        deliveryOptIn: false,
        onSettle: refreshWidget,
      });
      if (!started.ok) {
        // Unreachable: blocking starts are cap-exempt. Surface loudly rather
        // than running outside the registry.
        throw new Error(
          `${spec.toolName}: could not register the worker run (${started.runningCount}/${started.cap} running).`,
        );
      }
      prepared.sessionKey = sessionKey;
      prepared.taskId = started.snapshot.taskId;
      refreshWidget();

      // 3. Blocking = register + await settle. The registry materialized the
      //    projected result at settle; return it inline.
      const snapshot = await registry.waitForSettle(sessionKey, started.snapshot.taskId);
      if (prepared.runError !== undefined && !spec.mapRunError) throw prepared.runError;
      const project = prepared.projectResult;
      if (!project) {
        throw new Error(`${spec.toolName}: prepared run is missing its result projection.`);
      }
      const final = snapshot?.finalToolResult as AgentToolResult<TDetails> | undefined;
      if (final) return final;
      if (snapshot?.finalResult) return project(snapshot.finalResult);
      // Settled without a runner payload (session shutdown or the cancel
      // grace finalized the record first): project a synthetic aborted
      // result so the call still returns the tool's pinned cancelled shape.
      return project(
        syntheticAbortedWorkerResult(prepared.displayPrompt, prepared.cwd, snapshot?.errorMessage),
      );
    },
  } satisfies ToolDefinition;
}
