import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { loadMmrCoreSettings } from "../mmr-core/settings.js";
import type { MmrSubagentInvocation } from "../mmr-core/subagent-resolver.js";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { readMmrWorkerSessionId } from "./fallback.js";
import { renderMmrSubagentCall, renderMmrSubagentResult } from "./progress-rendering.js";
import { computeMmrChildExtensionScope } from "./child-extension-scope.js";
import { resolveWorkerCwd, type ToolHostLike } from "./worker-host.js";
import {
  runMmrWorkerWithSharedFallback,
  type MmrWorkerRunnerResolutionDeps,
} from "./worker-fallback-run.js";
import {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
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

/**
 * Build a spawned-subagent ToolDefinition from a declarative spec. See
 * the module doc for the execute skeleton and the spec knobs that
 * encode each tool's pinned contract.
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
  const outputByteLimit = deps.outputByteLimit ?? DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT;
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

      // 1. Params. Specs without paramsFailure keep the throw-to-host contract.
      let params: TParams;
      try {
        params = spec.coerceParams(rawParams);
      } catch (err) {
        if (!spec.paramsFailure) throw err;
        const message = err instanceof Error ? err.message : String(err);
        return spec.paramsFailure(message, rawParams, cwd);
      }

      // 2. Pre-spawn gate, then per-execute run data.
      const gated = spec.preSpawnGate?.(params, cwd);
      if (gated) return gated;
      const runData = (spec.computeRunData ? spec.computeRunData(params, cwd) : undefined) as TRun;

      // 3. Parent-side invocation resolution (one resolver path for all
      //    four tools). The preference override is re-resolved on every
      //    execute so parent and child read settings through the same
      //    code path.
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
        return spec.resolutionFailureResult(invocation, params, cwd);
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

      // 4. Runner options.
      const childExtensionScope = computeMmrChildExtensionScope({
        profileName: spec.profileName,
        host: deps.pi,
      });
      const baseRunnerOptions: MmrSubagentRunOptions = {
        profileName: spec.profileName,
        prompt: spec.buildUserPrompt(params, runData),
        cwd,
        ...(okInvocation?.modelArg !== undefined ? { model: okInvocation.modelArg } : {}),
        ...(spec.mirrorWorkerTools && okInvocation ? { tools: okInvocation.workerTools } : {}),
        systemPrompt: spec.assembleSystemPrompt(cwd, okInvocation?.workerTools, runCtx),
        ...(childExtensionScope ? { childExtensionScope } : {}),
        signal,
        outputByteLimit,
        ...(spec.extraRunnerOptions ? spec.extraRunnerOptions(runCtx) : {}),
        onProgress: onUpdate
          ? (snapshot) => {
              onUpdate({
                content: [{ type: "text", text: progressTextOrPlaceholder(snapshot, spec.progressPlaceholder) }],
                details: spec.buildProgressDetails(snapshot, runCtx),
              });
            }
          : undefined,
      };

      // 5. Session-scoped model fallback (one shared wrapper for all
      //    four tools). Under an applied override the closure re-resolves
      //    the invocation (so parent spawn and child activation agree)
      //    and forwards the override to the child via the runner env
      //    channel.
      const runWorkerOnce = async (
        runArgs: { override?: readonly MmrModelPreference[] },
      ): Promise<{ result: MmrWorkerResult; route: string | undefined }> => {
        let runOptions = baseRunnerOptions;
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
        const result = await factoryOptions.effectiveRunner.run(runOptions);
        return { result, route };
      };

      let result: MmrWorkerResult;
      let settledRoute: string | undefined;
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
        result = outcome.result;
        settledRoute = outcome.route;
      } catch (err) {
        if (!spec.mapRunError) throw err;
        return spec.mapRunError(err, runCtx);
      }

      // 6. Final shaping. The settled route wins for the final details
      //    regardless of the progress binding.
      if (settledRoute !== undefined) {
        runCtx.resolvedModel = settledRoute;
        if (spec.progressModelBinding === "per-attempt") {
          runCtx.contextWindow = spec.resolveContextWindow?.(ctx, settledRoute, runCtx.invocation);
        }
      }
      return {
        content: [{ type: "text", text: spec.buildFinalContent(result, runCtx) }],
        details: spec.buildFinalDetails(result, runCtx),
      };
    },
  } satisfies ToolDefinition;
}
