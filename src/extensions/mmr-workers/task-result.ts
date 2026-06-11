import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getMmrSubagentProfile } from "../mmr-core/subagent-profiles.js";
import type { MmrSubagentInvocation } from "../mmr-core/subagent-resolver.js";
import {
  classifyMmrWorkerOutcomeForProfile,
  emptyMmrWorkerUsageStats,
  hasUsableMmrWorkerFinalOutput,
  type MmrSpawnedSubagentWorkerDetailsBase,
  type MmrSubagentDetailsStatus,
  type MmrWorkerProgressSnapshot,
  type MmrWorkerResult,
} from "./runner.js";
import {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
  progressTextOrPlaceholder,
} from "./worker-result-shaping.js";

/**
 * Pure result/outcome shaping for the Task tool: the Task status classifier
 * and its input shape, the `TaskDetails` projection, the progress/final
 * `AgentToolResult` builders, and the synthetic failure-result builders
 * shared with the async `start_task` path. No tool registration, settings,
 * mode, or process state lives here. `task.ts` re-exports the public
 * surface, so the entry file remains the stable import path.
 *
 * This module is a leaf at runtime toward the entry file: the `import type`
 * reference back to `./task.js` is erased and creates no runtime cycle.
 */

/**
 * Subagent profile backing the Task tool. Defined here (the runtime-leaf
 * module) so both `task.ts` and the pure result shaping can reference it
 * without a cycle; `task.ts` re-exports it as the stable public name.
 */
export const TASK_SUBAGENT_PROFILE = "task-subagent";

/**
 * Discriminator for the outcome of a Task invocation. Pi's `AgentToolResult`
 * has no top-level error flag, so the parent agent infers failure from the
 * Task-prefixed content text plus this status. Precedence is fixed (see
 * `classifyTaskOutcome`) so the parent can rely on it during integration.
 *
 * Task stamps the full canonical `details.status` discriminator set
 * (every shared classifier outcome plus the pre-spawn
 * `validation-error` state), so the type is the canonical union rather
 * than a Task-private list.
 */
export type TaskStatus = MmrSubagentDetailsStatus;

/** Worker-details payload attached to every Task AgentToolResult. */
export interface TaskDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: "mmr-subagents.Task";
  /** Outcome discriminator; see {@link TaskStatus}. */
  status: TaskStatus;
  prompt: string;
  description: string;
}

/**
 * Inputs to {@link classifyTaskOutcome}. Narrower than `MmrWorkerResult` so
 * the classifier is unit-testable without constructing a full worker result.
 */
export interface TaskOutcomeInput {
  spawnError?: string;
  subagentActivationError?: string;
  aborted: boolean;
  signal: NodeJS.Signals | null;
  exitCode: number | null;
  finalOutput: string;
  truncatedFinalOutput: string;
  /**
   * Optional: did the child Pi process emit `agent_start`? When absent,
   * the classifier treats the agent loop as having run (backwards
   * compatible with older callers). When `false`, clean-exit empty
   * output classifies as `no-agent-start` instead of `empty-output`.
   * See `MmrWorkerResult.agentStarted` for the underlying signal.
   */
  agentStarted?: boolean;
}

/**
 * Predicate from spec §9.4: "usable final text". Thin wrapper around
 * the shared `hasUsableMmrWorkerFinalOutput` helper, kept for callers
 * that import the Task-specific name. The truncated form wins when
 * present so partial responses still count.
 */
export function hasUsableTaskFinalText(input: Pick<TaskOutcomeInput, "finalOutput" | "truncatedFinalOutput">): boolean {
  return hasUsableMmrWorkerFinalOutput(input);
}

/**
 * Precedence-ordered classifier for Task outcomes (spec §9.4). Thin
 * wrapper around the shared profile-driven classifier: the
 * `task-subagent` profile declares `partialOutputPolicy:
 * "prefer-usable-output"`, so non-zero exit with usable final text
 * still classifies as `success`. Task's additional `validation-error`
 * state is handled by the caller before any worker-result input is
 * available, so it is intentionally not part of this classifier.
 */
export function classifyTaskOutcome(input: TaskOutcomeInput): TaskStatus {
  return classifyMmrWorkerOutcomeForProfile(
    {
      ...(input.spawnError !== undefined ? { spawnError: input.spawnError } : {}),
      ...(input.subagentActivationError !== undefined
        ? { subagentActivationError: input.subagentActivationError }
        : {}),
      aborted: input.aborted,
      signal: input.signal,
      exitCode: input.exitCode,
      finalOutput: input.finalOutput,
      truncatedFinalOutput: input.truncatedFinalOutput,
      ...(input.agentStarted !== undefined ? { agentStarted: input.agentStarted } : {}),
    },
    getMmrSubagentProfile(TASK_SUBAGENT_PROFILE),
  );
}

/** Progress text shown while the worker has not yet streamed any output. */
export const TASK_PROGRESS_PLACEHOLDER = "Task: worker running…";

/** Latest streamed worker text, or the placeholder before any output. */
function progressContent(snapshot: MmrWorkerProgressSnapshot): string {
  return progressTextOrPlaceholder(snapshot, TASK_PROGRESS_PLACEHOLDER);
}

/** Caller-resolved invocation context threaded into every details build. */
export interface TaskDetailsContext {
  prompt: string;
  description: string;
  cwd: string;
  workerTools: readonly string[];
  resolvedModel?: string;
  contextWindow?: number;
}

/** Build the in-flight TaskDetails for a progress snapshot. */
function buildProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  ctx: TaskDetailsContext,
): TaskDetails {
  // Progress is intentionally classified as `success`; a final non-success
  // status is only known once the worker exits and the runner returns a
  // complete `MmrWorkerResult`.
  const base = buildSpawnedProgressDetailsBase({
    snapshot,
    cwd: ctx.cwd,
    workerTools: ctx.workerTools,
    ...(ctx.resolvedModel !== undefined ? { resolvedModel: ctx.resolvedModel } : {}),
    ...(ctx.contextWindow !== undefined ? { contextWindow: ctx.contextWindow } : {}),
  });
  return {
    worker: "mmr-subagents.Task",
    status: "success",
    prompt: ctx.prompt,
    description: ctx.description,
    ...base,
  };
}

/** Build the final TaskDetails for a completed worker result. */
function buildDetails(
  result: MmrWorkerResult,
  ctx: TaskDetailsContext,
  statusOverride?: TaskStatus,
): TaskDetails {
  // Task's status policy stays local: classify from the result (with
  // structured spawn/activation discriminators forwarded to the
  // classifier) unless the caller is building a pre-spawn failure
  // result and passes an explicit override.
  const status = statusOverride ?? classifyTaskOutcome({
    aborted: result.aborted,
    signal: result.signal,
    exitCode: result.exitCode,
    finalOutput: result.finalOutput,
    truncatedFinalOutput: result.truncatedFinalOutput,
    agentStarted: result.agentStarted,
    ...(result.spawnError ? { spawnError: result.spawnError } : {}),
    ...(result.subagentActivationError ? { subagentActivationError: result.subagentActivationError } : {}),
  });
  const base = buildSpawnedFinalDetailsBase({
    result,
    cwd: ctx.cwd,
    workerTools: ctx.workerTools,
    ...(ctx.resolvedModel !== undefined ? { resolvedModel: ctx.resolvedModel } : {}),
    ...(ctx.contextWindow !== undefined ? { contextWindow: ctx.contextWindow } : {}),
  });
  return {
    worker: "mmr-subagents.Task",
    status,
    prompt: ctx.prompt,
    description: ctx.description,
    ...base,
  };
}

/** Model-visible final content text for a completed worker result. */
function buildFinalContent(result: MmrWorkerResult): string {
  if (result.spawnError) {
    return `Task: worker failed to spawn: ${result.spawnError}`;
  }
  if (result.subagentActivationError) {
    return `Task: subagent activation failed: ${result.subagentActivationError}`;
  }
  const text = result.truncatedFinalOutput || result.finalOutput;
  if (text && text.trim().length > 0) return text;
  if (result.aborted) return "Task: worker was cancelled before producing a result.";
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `Task: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  // Clean exit, no text. Distinguish "agent ran and produced nothing"
  // from "agent loop never started" so operators see the right hint.
  if (result.agentStarted === false) {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `Task: worker exited before the agent loop started. No output was produced; another Pi extension's input handler likely consumed the prompt. Check stderr for extension diagnostics.${detail}`;
  }
  return "Task: worker produced no final output. Re-run with a narrower prompt or more context.";
}

/** Inputs for {@link makeFailureResult}. */
interface MakeFailureResultArgs {
  status: TaskStatus;
  prompt: string;
  description: string;
  cwd: string;
  workerTools: readonly string[];
  content: string;
  errorMessage: string;
  resolvedModel?: string;
  contextWindow?: number;
  spawnError?: string;
  subagentActivationError?: string;
}

/**
 * Build a Pi `AgentToolResult` for a pre-spawn failure path: validation,
 * resolver, or spawn errors. Ensures every failure path emits a complete
 * {@link TaskDetails} shape with the correct {@link TaskStatus}.
 */
export function makeFailureResult(args: MakeFailureResultArgs): AgentToolResult<TaskDetails> {
  const synthetic: MmrWorkerResult = {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    exitCode: null,
    signal: null,
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    // Pre-spawn failures never reach the agent loop. The classifier reads
    // `agentStarted` only when nothing earlier in the precedence ladder
    // fired, so this is documentation as much as it is correctness.
    agentStarted: false,
    usage: emptyMmrWorkerUsageStats(),
    stderr: "",
    command: "",
    args: [],
    prompt: args.prompt,
    cwd: args.cwd,
    trail: [],
    errorMessage: args.errorMessage,
    ...(args.subagentActivationError ? { subagentActivationError: args.subagentActivationError } : {}),
  };
  const detailsCtx: TaskDetailsContext = {
    prompt: args.prompt,
    description: args.description,
    cwd: args.cwd,
    workerTools: args.workerTools,
    ...(args.resolvedModel !== undefined ? { resolvedModel: args.resolvedModel } : {}),
    ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
  };
  const details = buildDetails(synthetic, detailsCtx, args.status);
  if (args.spawnError !== undefined) details.spawnError = args.spawnError;
  return {
    content: [{ type: "text", text: args.content }],
    details,
  };
}

/** Model-visible content text for a failed worker-invocation resolution. */
export function buildResolverFailureContent(invocation: MmrSubagentInvocation): string {
  if (invocation.ok) return "";
  switch (invocation.code) {
    case "tools.empty":
      return `Task worker has no available tools after deny + registered intersection: ${invocation.message}`;
    case "prompt-base.unresolved":
      return `Task worker requires a Task-enabled parent mode: ${invocation.message}`;
    case "model.no-route":
      return `Task worker could not resolve a model route: ${invocation.message}`;
    default:
      return `Task worker could not be prepared: ${invocation.message}`;
  }
}

/** Build the streaming-progress `AgentToolResult` for a Task worker snapshot. */
export function buildTaskProgressResult(
  snapshot: MmrWorkerProgressSnapshot,
  ctx: TaskDetailsContext,
): AgentToolResult<TaskDetails> {
  return {
    content: [{ type: "text", text: progressContent(snapshot) }],
    details: buildProgressDetails(snapshot, ctx),
  };
}

/** Build the final `AgentToolResult` from a completed worker run. */
export function buildTaskFinalResult(
  result: MmrWorkerResult,
  ctx: TaskDetailsContext,
): AgentToolResult<TaskDetails> {
  return {
    content: [{ type: "text", text: buildFinalContent(result) }],
    details: buildDetails(result, ctx),
  };
}

/**
 * Build a synthetic {@link MmrWorkerResult} for a runner `run()` throw
 * (spawn failure). Used by the worker-tool factory's prepared runs so a
 * worker that fails to spawn settles in the registry with the SAME
 * `spawn-error` status and final shaping on every surface, rather than a
 * generic registry error. The `spawnError` discriminator drives the
 * outcome classifiers deterministically.
 */
export function buildSpawnErrorWorkerResult(
  err: unknown,
  ctx: { prompt: string; cwd: string },
): MmrWorkerResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    exitCode: null,
    signal: null,
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: false,
    usage: emptyMmrWorkerUsageStats(),
    stderr: "",
    command: "",
    args: [],
    prompt: ctx.prompt,
    cwd: ctx.cwd,
    trail: [],
    errorMessage: message,
    spawnError: message,
  };
}

// Internal factory seams: the Task worker-tool spec consumes the
// details/content builders directly (the AgentToolResult wrappers above
// remain the stable public surface).
export const buildTaskProgressDetails = buildProgressDetails;
export const buildTaskDetails = buildDetails;
export const buildTaskFinalContent = buildFinalContent;
