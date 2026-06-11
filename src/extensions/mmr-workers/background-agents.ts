/**
 * Background-agent registry: the dispatch table behind `start_task`.
 *
 * The set of agents the background surface offers is DERIVED, not hardcoded:
 * a profile appears as a `start_task` agent exactly when
 *   1. it is registered in mmr-core's subagent-profile registry
 *      (`listMmrSubagentProfiles()`, static ∪ dynamic), AND
 *   2. its profile does not declare `backgroundable: false`, AND
 *   3. a worker extension registered a descriptor here saying how to launch it.
 *
 * mmr-subagents registers the built-in descriptors (finder, librarian, Task)
 * at module load; mmr-custom-subagents registers one per enabled custom
 * Markdown subagent at activation, which is what makes custom subagents
 * backgroundable without any per-agent branch in the async-task tools.
 *
 * This module is intentionally internal (not exported from src/index.ts):
 * the public contract is the derived `start_task` surface, not the registry.
 */
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { isRecord } from "../mmr-core/internal/json.js";
import type { MmrAsyncTaskStatus } from "./async-task-types.js";
import {
  getMmrSubagentProfile,
  listMmrSubagentProfiles,
} from "../mmr-core/subagent-profiles.js";
import type {
  MmrPreparedWorkerRunResult,
} from "./worker-tool-factory.js";
import {
  createFinderRunPreparer,
  FINDER_PARAMETERS_SCHEMA,
  FINDER_TOOL_NAME,
  FINDER_WORKER_TOOLS,
  type FinderToolDeps,
} from "./finder.js";
import {
  createLibrarianRunPreparer,
  LIBRARIAN_PARAMETERS_SCHEMA,
  LIBRARIAN_TOOL_NAME,
  LIBRARIAN_WORKER_TOOLS,
  type LibrarianToolDeps,
} from "./librarian.js";
import {
  createTaskRunPreparer,
  TASK_SUBAGENT_PROFILE,
  TASK_TOOL_NAME,
  type TaskToolDeps,
} from "./task.js";
import {
  CODE_REVIEW_PARAMETERS_SCHEMA,
  CODE_REVIEW_SUBAGENT_PROFILE,
  CODE_REVIEW_TOOL_NAME,
  CODE_REVIEW_WORKER_TOOLS,
  createCodeReviewRunPreparer,
  type CodeReviewToolDeps,
} from "./code-review.js";

/** The agent `start_task` launches when the caller omits `agent`. */
export const DEFAULT_MMR_BACKGROUND_AGENT = TASK_TOOL_NAME;

/**
 * Per-call inputs forwarded to a descriptor's {@link MmrBackgroundAgentStart.prepareRun}.
 */
export interface MmrBackgroundAgentPrepareOptions {
  /** Originating Pi tool-call id (tool-execute adapters derive child call ids from it). */
  toolCallId: string;
}

/**
 * How a background agent's run is built. ONE strategy for every agent: the
 * descriptor prepares a registry-ready run (validation → invocation
 * resolution → run thunk + result projection) and `executeBackgroundStart`
 * registers it. Factory-built workers (finder, librarian, Task) plug their
 * run preparers in directly, so the background surface shares the blocking
 * tools' preparation path verbatim; non-factory tools (custom Markdown
 * subagents) adapt their blocking `execute()` via
 * {@link prepareRunFromToolExecute}. This replaces the former
 * `kind: "task" | "tool"` duality — `prepareTaskRun` is gone and Task is
 * not a special case anywhere in the dispatch path.
 */
export interface MmrBackgroundAgentStart {
  /**
   * Pre-spawn parameters schema validated by the start path BEFORE
   * `prepareRun`; an invalid start creates no record. Omitted for agents
   * whose preparer owns the full deterministic validation surface (Task's
   * byte caps and pinned messages).
   */
  readonly parametersSchema?: TSchema;
  /** Worker tool names stamped on the background record for display/projection. */
  readonly workerTools: readonly string[];
  /** `AsyncTaskToolDeps` key holding this agent's tool-specific seams. */
  readonly depsKey?: string;
  /**
   * Prepare a registry-ready run from validated params. A `{ok: false}`
   * outcome is a pre-spawn failure (no record, no group); a throw is
   * treated as a validation failure by the start path.
   */
  prepareRun(
    deps: Record<string, unknown>,
    params: unknown,
    ctx: ExtensionContext,
    opts: MmrBackgroundAgentPrepareOptions,
  ): MmrPreparedWorkerRunResult;
}

export interface MmrBackgroundAgentDescriptor {
  /** Public agent name accepted by `start_task` (a stable worker tool name). */
  readonly agent: string;
  /** Backing subagent profile (policy source: backgroundable, capabilityProfile, output policy). */
  readonly profileName: string;
  /** Tool name used as the validation-error prefix for this agent's params. */
  readonly toolName: string;
  /**
   * The agent's params shape as shown in the start_task schema text, e.g.
   * `"{query, context?}"`. Whitespace is compacted where the surrounding
   * text calls for the compact form.
   */
  readonly paramsHint: string;
  /** Params key holding the worker's primary prompt/query, for summaries. */
  readonly promptParamKey: string;
  /**
   * Params key a top-level start_task `description` folds into when the
   * agent's params accept one (Task). Drives member normalization data-only,
   * with no agent-name or strategy branch.
   */
  readonly descriptionParamKey?: string;
  readonly start: MmrBackgroundAgentStart;
}

/**
 * Adapt a blocking ToolDefinition's `execute()` into the prepared-run
 * contract for agents that are not built on the worker-tool factory (custom
 * Markdown subagents). The tool's execute owns validation, spawn, and final
 * shaping; the adapter's run thunk feeds the registry the tool-run result
 * union (`finalToolResult` path), so no separate projection is needed.
 */
/**
 * Infer the terminal task status of a tool-delegating background run from
 * its final `AgentToolResult`. Pi tool results have no top-level error flag,
 * so this reads the conventional `details.status`/error discriminators the
 * worker tools stamp. Lives here (not in the tool-format module) so the
 * tool-execute adapter below can use it without an import cycle.
 */
export function inferToolRunStatus(result: AgentToolResult<unknown>, signal: AbortSignal): MmrAsyncTaskStatus {
  const details = isRecord(result.details) ? result.details : {};
  const status = details.status;
  if (signal.aborted || status === "aborted" || details.aborted === true) return "cancelled";
  if (status === "success") return "succeeded";
  if (typeof status === "string") {
    if (
      status === "no-agent-start"
      || status === "empty-output"
      || status.includes("error")
      || status.includes("gated")
      || status.includes("exhausted")
    ) return "failed";
  }
  if (typeof details.exitCode === "number" && details.exitCode !== 0) return "failed";
  if (typeof details.spawnError === "string" || typeof details.subagentActivationError === "string") return "failed";
  return "succeeded";
}

/** Companion to {@link inferToolRunStatus}: the error text a failed tool run reports. */
export function inferToolErrorMessage(result: AgentToolResult<unknown>): string | undefined {
  const details = isRecord(result.details) ? result.details : {};
  return typeof details.errorMessage === "string" && details.errorMessage.length > 0
    ? details.errorMessage
    : undefined;
}

export function prepareRunFromToolExecute(args: {
  tool: ToolDefinition;
  agent: string;
  workerTools: readonly string[];
}): MmrBackgroundAgentStart["prepareRun"] {
  return (_deps, params, ctx, opts) => ({
    ok: true,
    prepared: {
      agent: args.agent,
      // The start path labels the record from its normalized member
      // (description/prompt summaries); these placeholders are never used.
      description: args.agent,
      displayPrompt: args.agent,
      cwd: typeof (ctx as { cwd?: unknown }).cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd(),
      workerTools: args.workerTools,
      run: async ({ signal, onProgress }) => {
        const result = await args.tool.execute(
          `${opts.toolCallId}:${args.agent}`,
          params,
          signal,
          (update) => onProgress(update as Parameters<typeof onProgress>[0]),
          ctx,
        );
        const status = inferToolRunStatus(result, signal);
        return {
          toolResult: result,
          status,
          terminalOutcome: status === "succeeded" ? "success" : status === "failed" ? "failed" : undefined,
          ...(status === "failed" ? { errorMessage: inferToolErrorMessage(result) } : {}),
        };
      },
      // No raw projection: the run thunk settles with a tool-run result,
      // which the registry finalizes directly as finalToolResult.
    },
  });
}

const BUILTIN_BACKGROUND_AGENTS: ReadonlyMap<string, MmrBackgroundAgentDescriptor> = new Map(
  (
    [
      {
        agent: TASK_TOOL_NAME,
        profileName: TASK_SUBAGENT_PROFILE,
        toolName: TASK_TOOL_NAME,
        paramsHint: "{prompt, description}",
        promptParamKey: "prompt",
        descriptionParamKey: "description",
        start: {
          // No parametersSchema: coerceTaskParams owns Task's deterministic
          // validation order and pinned message surface (byte caps, control
          // characters), and the preparer reports through it.
          workerTools: [],
          depsKey: "taskDeps",
          prepareRun: (deps, params, ctx) => createTaskRunPreparer(deps as TaskToolDeps)(params, ctx),
        },
      },
      {
        agent: FINDER_TOOL_NAME,
        profileName: "finder",
        toolName: FINDER_TOOL_NAME,
        paramsHint: "{query}",
        promptParamKey: "query",
        start: {
          parametersSchema: FINDER_PARAMETERS_SCHEMA,
          workerTools: FINDER_WORKER_TOOLS,
          depsKey: "finderDeps",
          prepareRun: (deps, params, ctx) => createFinderRunPreparer(deps as FinderToolDeps)(params, ctx),
        },
      },
      {
        agent: LIBRARIAN_TOOL_NAME,
        profileName: "librarian",
        toolName: LIBRARIAN_TOOL_NAME,
        paramsHint: "{query, context?}",
        promptParamKey: "query",
        start: {
          parametersSchema: LIBRARIAN_PARAMETERS_SCHEMA,
          workerTools: LIBRARIAN_WORKER_TOOLS,
          depsKey: "librarianDeps",
          prepareRun: (deps, params, ctx) => createLibrarianRunPreparer(deps as LibrarianToolDeps)(params, ctx),
        },
      },
      {
        agent: CODE_REVIEW_TOOL_NAME,
        profileName: CODE_REVIEW_SUBAGENT_PROFILE,
        toolName: CODE_REVIEW_TOOL_NAME,
        paramsHint: "{diff_description, files?, instructions?}",
        promptParamKey: "diff_description",
        start: {
          parametersSchema: CODE_REVIEW_PARAMETERS_SCHEMA,
          workerTools: CODE_REVIEW_WORKER_TOOLS,
          depsKey: "codeReviewDeps",
          prepareRun: (deps, params, ctx) => createCodeReviewRunPreparer(deps as CodeReviewToolDeps)(params, ctx),
        },
      },
    ] satisfies MmrBackgroundAgentDescriptor[]
  ).map((descriptor) => [descriptor.profileName, descriptor]),
);

// Dynamic descriptors live on globalThis, mirroring the dynamic subagent
// profile registry, so duplicate module instantiations in one process share
// one table.
const MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY = "__pi_mmr_dynamic_background_agents_v1__";

const globalAgentStore = globalThis as typeof globalThis & {
  [MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY]?: Map<string, MmrBackgroundAgentDescriptor>;
};

function resolveDynamicAgentRegistry(): Map<string, MmrBackgroundAgentDescriptor> {
  const existing = globalAgentStore[MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY];
  if (existing instanceof Map) return existing;
  const fresh = new Map<string, MmrBackgroundAgentDescriptor>();
  globalAgentStore[MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY] = fresh;
  return fresh;
}

/**
 * Register or replace a runtime background-agent descriptor, keyed by its
 * backing profile name. Used by mmr-custom-subagents for custom Markdown
 * subagents. Built-in descriptors cannot be replaced.
 */
export function registerMmrBackgroundAgent(descriptor: MmrBackgroundAgentDescriptor): void {
  if (typeof descriptor.profileName !== "string" || descriptor.profileName.length === 0) {
    throw new Error("registerMmrBackgroundAgent requires a non-empty profileName");
  }
  if (BUILTIN_BACKGROUND_AGENTS.has(descriptor.profileName)) {
    throw new Error(
      `registerMmrBackgroundAgent cannot replace built-in background agent "${descriptor.profileName}"`,
    );
  }
  resolveDynamicAgentRegistry().set(descriptor.profileName, descriptor);
}

/** Remove a runtime descriptor. Intended for tests and profile reloads. */
export function unregisterMmrBackgroundAgent(profileName: string): void {
  resolveDynamicAgentRegistry().delete(profileName);
}

/** Test seam: clear runtime descriptors without touching built-ins. */
export function clearMmrDynamicBackgroundAgents(): void {
  resolveDynamicAgentRegistry().clear();
}

function descriptorForProfile(profileName: string): MmrBackgroundAgentDescriptor | undefined {
  return BUILTIN_BACKGROUND_AGENTS.get(profileName) ?? resolveDynamicAgentRegistry().get(profileName);
}

/**
 * The background agents `start_task` offers, derived from the live profile
 * registry: every registered profile that is backgroundable and has a
 * descriptor. The default agent leads (it heads the public enum and the
 * docs); the rest keep profile-registry order, so the built-in set yields
 * `Task, finder, librarian` and custom subagents append in registration
 * order.
 */
export function listMmrBackgroundAgents(): readonly MmrBackgroundAgentDescriptor[] {
  const ordered: MmrBackgroundAgentDescriptor[] = [];
  for (const profileName of listMmrSubagentProfiles()) {
    const profile = getMmrSubagentProfile(profileName);
    if (!profile || profile.backgroundable === false) continue;
    const descriptor = descriptorForProfile(profileName);
    if (descriptor) ordered.push(descriptor);
  }
  return Object.freeze([
    ...ordered.filter((descriptor) => descriptor.agent === DEFAULT_MMR_BACKGROUND_AGENT),
    ...ordered.filter((descriptor) => descriptor.agent !== DEFAULT_MMR_BACKGROUND_AGENT),
  ]);
}

/** Resolve one background agent by its public agent name (exact match). */
export function getMmrBackgroundAgent(agent: string): MmrBackgroundAgentDescriptor | undefined {
  return listMmrBackgroundAgents().find((descriptor) => descriptor.agent === agent);
}

/**
 * Normalize a raw `agent` input to a registered agent's public name:
 * `undefined` selects the default agent; strings match the agent name or its
 * backing profile name case-insensitively (so `task` and `task-subagent`
 * both resolve to `Task`). Returns `undefined` for unknown agents.
 */
export function normalizeMmrBackgroundAgentName(raw: unknown): string | undefined {
  if (raw === undefined) return DEFAULT_MMR_BACKGROUND_AGENT;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  for (const descriptor of listMmrBackgroundAgents()) {
    if (normalized === descriptor.agent.toLowerCase() || normalized === descriptor.profileName.toLowerCase()) {
      return descriptor.agent;
    }
  }
  return undefined;
}
