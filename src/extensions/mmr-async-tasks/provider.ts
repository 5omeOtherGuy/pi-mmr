import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../mmr-core/types.js";

export const MMR_ASYNC_TASKS_PROVIDER_NAME = "mmr-async-tasks";
export const MMR_ASYNC_TASKS_FEATURE_GATE = "mmr-async-tasks";
/** Deprecated compatibility gate retained while callers migrate. */
export const MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE = "mmr-subagents.async-tasks";

export const MMR_ASYNC_TASK_TOOLS: ReadonlyArray<
  "start_task" | "task_poll" | "task_wait" | "task_cancel"
> = ["start_task", "task_poll", "task_wait", "task_cancel"];

/** @deprecated Use MMR_ASYNC_TASK_TOOLS. */
export const MMR_SUBAGENTS_ASYNC_TASK_TOOLS = MMR_ASYNC_TASK_TOOLS;

const ASYNC_TASK_TOOLS_SET: ReadonlySet<string> = new Set<string>(MMR_ASYNC_TASK_TOOLS);

type MmrAsyncTasksCapability = boolean | (() => boolean);

export interface MmrAsyncTasksCapabilities {
  asyncTasks?: MmrAsyncTasksCapability;
}

function readCapability(value: MmrAsyncTasksCapability | undefined): boolean {
  if (typeof value === "function") {
    try {
      return Boolean(value());
    } catch {
      return false;
    }
  }
  return Boolean(value);
}

export function createMmrAsyncTasksFeatureGateProvider(
  capabilities: MmrAsyncTasksCapabilities = {},
): MmrFeatureGateProvider {
  return {
    name: MMR_ASYNC_TASKS_PROVIDER_NAME,
    evaluate(gate) {
      if (gate !== MMR_ASYNC_TASKS_FEATURE_GATE && gate !== MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE) return undefined;
      const enabled = readCapability(capabilities.asyncTasks);
      return enabled
        ? {
            gate,
            status: "enabled",
            reason: `${MMR_ASYNC_TASKS_PROVIDER_NAME} background task tools available: ${MMR_ASYNC_TASK_TOOLS.join(", ")}.`,
          }
        : {
            gate,
            status: "disabled",
            reason: `${MMR_ASYNC_TASKS_PROVIDER_NAME} background task tools are not enabled.`,
          };
    },
  };
}

export function createMmrAsyncTasksToolProvider(
  capabilities: MmrAsyncTasksCapabilities = {},
): MmrToolProvider {
  return {
    name: MMR_ASYNC_TASKS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!ASYNC_TASK_TOOLS_SET.has(toolName)) return undefined;
      if (readCapability(capabilities.asyncTasks)) return { kind: "active" };
      return {
        kind: "gated",
        gate: MMR_ASYNC_TASKS_FEATURE_GATE,
        reason: `${toolName}: async background task tools are not enabled.`,
      };
    },
  };
}
