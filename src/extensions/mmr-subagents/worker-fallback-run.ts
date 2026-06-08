import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MmrModelPreference } from "../mmr-core/types.js";
import {
  classifyMmrWorkerOutcome,
  createChildCliMmrSubagentRunner,
  createMmrSubagentRunnerFromRunWorker,
  type MmrSubagentRunner,
  type MmrWorkerRunnerDeps,
  type runMmrSubagentWorker,
} from "./runner.js";
import {
  runMmrWorkerWithModelFallback,
  type MmrWorkerFallbackOutcome,
  type MmrWorkerFallbackRegistry,
  type MmrWorkerFallbackRunArgs,
  type MmrWorkerFallbackRunOutput,
} from "./fallback.js";

/**
 * Narrow, shared spawned-worker plumbing for the `finder`/`oracle`/`librarian`
 * tools. It abstracts ONLY the two pieces those tools repeat identically:
 * effective-runner resolution and the model-fallback call shape. Prompt
 * assembly, params, attachments, provider gating, link sanitization, invocation
 * re-resolution, and result/detail shaping stay per-subagent.
 */

/** Runner test-injection seams accepted by each subagent tool's deps. */
export interface MmrWorkerRunnerResolutionDeps {
  runner?: MmrSubagentRunner;
  runWorker?: typeof runMmrSubagentWorker;
  runnerDeps?: MmrWorkerRunnerDeps;
}

/**
 * Collapse the repeated runner-selection ternary: an explicit `runner` wins
 * (and a one-line warning is emitted if `runWorker` was also supplied), else a
 * `runWorker` adapter, else the child-CLI runner. `runnerDeps` are forwarded so
 * tests can inject a fake spawn or invocation resolver.
 */
export function resolveEffectiveRunner(deps: MmrWorkerRunnerResolutionDeps): MmrSubagentRunner {
  if (deps.runner && deps.runWorker) {
    // eslint-disable-next-line no-console
    console.warn(
      "MMR subagent tool: both runner and runWorker were provided; the runner takes precedence and runWorker is ignored.",
    );
  }
  if (deps.runner) return deps.runner;
  if (deps.runWorker) return createMmrSubagentRunnerFromRunWorker(deps.runWorker, deps.runnerDeps);
  return createChildCliMmrSubagentRunner(deps.runnerDeps);
}

/** Tool-execution context subset needed to drive the model-fallback path. */
type WorkerFallbackCtx = Pick<ExtensionContext, "ui" | "hasUI" | "signal"> & {
  modelRegistry?: unknown;
};

/**
 * Thin pass-through over {@link runMmrWorkerWithModelFallback} that fixes the
 * two bits every subagent caller repeats verbatim: the `fail-on-nonzero`
 * outcome classification and resolving the fallback registry from
 * `ctx.modelRegistry`. The per-subagent `run` closure is passed through
 * unchanged.
 */
export function runMmrWorkerWithSharedFallback(params: {
  ctx: WorkerFallbackCtx;
  sessionId?: string;
  toolName: string;
  profileName: string;
  candidatePreferences: readonly MmrModelPreference[];
  run: (runArgs: MmrWorkerFallbackRunArgs) => Promise<MmrWorkerFallbackRunOutput>;
}): Promise<MmrWorkerFallbackOutcome> {
  return runMmrWorkerWithModelFallback({
    ctx: params.ctx,
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    registry: params.ctx.modelRegistry as unknown as MmrWorkerFallbackRegistry,
    toolName: params.toolName,
    profileName: params.profileName,
    candidatePreferences: params.candidatePreferences,
    classifyOutcome: (result) => classifyMmrWorkerOutcome(result, { partialOutputPolicy: "fail-on-nonzero" }),
    run: params.run,
  });
}
