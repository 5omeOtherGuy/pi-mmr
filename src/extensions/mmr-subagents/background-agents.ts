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
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  getMmrSubagentProfile,
  listMmrSubagentProfiles,
} from "../mmr-core/subagent-profiles.js";
import {
  createFinderTool,
  FINDER_PARAMETERS_SCHEMA,
  FINDER_TOOL_NAME,
  FINDER_WORKER_TOOLS,
  type FinderToolDeps,
} from "./finder.js";
import {
  createLibrarianTool,
  LIBRARIAN_PARAMETERS_SCHEMA,
  LIBRARIAN_TOOL_NAME,
  LIBRARIAN_WORKER_TOOLS,
  type LibrarianToolDeps,
} from "./librarian.js";
import { TASK_SUBAGENT_PROFILE, TASK_TOOL_NAME } from "./task.js";

/** The agent `start_task` launches when the caller omits `agent`. */
export const DEFAULT_MMR_BACKGROUND_AGENT = TASK_TOOL_NAME;

/**
 * How a background agent's run thunk is built.
 *
 * - `"tool"` — the generic path: validate `params` against
 *   `parametersSchema`, build the blocking tool with `createTool`, and run
 *   its `execute()` as the task's run thunk (finder, librarian, custom
 *   Markdown subagents).
 * - `"task"` — the Task path: the run thunk comes from `prepareTaskRun`
 *   (pre-spawn validation, model resolution, capability-profile narrowing)
 *   and returns a raw worker result. This strategy discriminator replaces
 *   the old per-agent-name branches; it converges with `"tool"` when every
 *   run registers through the task registry.
 */
export type MmrBackgroundAgentStart =
  | {
      readonly kind: "tool";
      /** Pre-spawn parameters schema; an invalid start creates no record. */
      readonly parametersSchema: TSchema;
      /** Worker tool names stamped on the background record for display/projection. */
      readonly workerTools: readonly string[];
      /** `AsyncTaskToolDeps` key holding this agent's tool-specific seams. */
      readonly depsKey?: string;
      /** Build the executable tool whose `execute()` is the run thunk. */
      readonly createTool: (deps: Record<string, unknown>) => ToolDefinition;
    }
  | {
      readonly kind: "task";
      /** `AsyncTaskToolDeps` key holding the Task tool's seams. */
      readonly depsKey: string;
    };

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
  readonly start: MmrBackgroundAgentStart;
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
        start: { kind: "task", depsKey: "taskDeps" },
      },
      {
        agent: FINDER_TOOL_NAME,
        profileName: "finder",
        toolName: FINDER_TOOL_NAME,
        paramsHint: "{query}",
        promptParamKey: "query",
        start: {
          kind: "tool",
          parametersSchema: FINDER_PARAMETERS_SCHEMA,
          workerTools: FINDER_WORKER_TOOLS,
          depsKey: "finderDeps",
          createTool: (deps) => createFinderTool(deps as FinderToolDeps),
        },
      },
      {
        agent: LIBRARIAN_TOOL_NAME,
        profileName: "librarian",
        toolName: LIBRARIAN_TOOL_NAME,
        paramsHint: "{query, context?}",
        promptParamKey: "query",
        start: {
          kind: "tool",
          parametersSchema: LIBRARIAN_PARAMETERS_SCHEMA,
          workerTools: LIBRARIAN_WORKER_TOOLS,
          depsKey: "librarianDeps",
          createTool: (deps) => createLibrarianTool(deps as LibrarianToolDeps),
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
