import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../mmr-core/types.js";
import { LIBRARIAN_GATING_REASON } from "./librarian.js";

export const MMR_SUBAGENTS_PROVIDER_NAME = "mmr-subagents";
export const MMR_SUBAGENTS_FEATURE_GATE = "mmr-subagents";

/**
 * Logical tool names owned by `mmr-subagents`. Mirrors the deferred entries
 * in `mmr-core`'s default tool rules so the runtime override stays narrow:
 * the provider returns `undefined` for any other logical name and never
 * shadows unrelated providers.
 */
export const MMR_SUBAGENTS_OWNED_TOOLS: ReadonlyArray<
  | "Task"
  | "finder"
  | "oracle"
  | "librarian"
  | "code_review"
> = [
  "Task",
  "finder",
  "oracle",
  "librarian",
  "code_review",
];

const OWNED_TOOLS_SET: ReadonlySet<string> = new Set<string>(MMR_SUBAGENTS_OWNED_TOOLS);

/**
 * Per-tool ship state. Each entry is `true` when the matching concrete Pi
 * tool is registered by this extension; the provider then claims the
 * name with `{ kind: "active" }` so the registry credits mmr-subagents
 * as owner and confirms by identity match against the live Pi inventory.
 * The default value of every flag is `false`, which preserves the
 * shell-slice behavior for callers that build the providers without
 * arguments (every owned tool reports `gated`).
 */
type MmrSubagentsCapability = boolean | (() => boolean);

export interface MmrSubagentsCapabilities {
  finder?: MmrSubagentsCapability;
  oracle?: MmrSubagentsCapability;
  Task?: MmrSubagentsCapability;
  librarian?: MmrSubagentsCapability;
  code_review?: MmrSubagentsCapability;
}

function readCapability(value: MmrSubagentsCapability | undefined): boolean {
  if (typeof value === "function") {
    try {
      return Boolean(value());
    } catch {
      return false;
    }
  }
  return Boolean(value);
}

function isCapabilityActive(capabilities: MmrSubagentsCapabilities, name: string): boolean {
  switch (name) {
    case "finder":
      return readCapability(capabilities.finder);
    case "oracle":
      return readCapability(capabilities.oracle);
    case "Task":
      return readCapability(capabilities.Task);
    case "librarian":
      return readCapability(capabilities.librarian);
    case "code_review":
      return readCapability(capabilities.code_review);
    default:
      return false;
  }
}

function formatActiveCapabilities(capabilities: MmrSubagentsCapabilities): string {
  const active: string[] = MMR_SUBAGENTS_OWNED_TOOLS.filter((name) => isCapabilityActive(capabilities, name));
  return active.length === 0 ? "" : active.join(", ");
}

/**
 * Feature-gate provider for `mmr-subagents`.
 *
 * Returns `enabled` when at least one owned worker tool has shipped (per
 * the `capabilities` argument); otherwise reports `disabled` with the
 * shell-slice reason. Default-args callers get the shell behavior so the
 * provider works the same way for tests that exercise an empty extension.
 */
export function createMmrSubagentsFeatureGateProvider(
  capabilities: MmrSubagentsCapabilities = {},
): MmrFeatureGateProvider {
  return {
    name: MMR_SUBAGENTS_PROVIDER_NAME,
    evaluate(gate) {
      if (gate !== MMR_SUBAGENTS_FEATURE_GATE) return undefined;
      const active = formatActiveCapabilities(capabilities);
      if (active.length === 0) {
        return {
          gate,
          status: "disabled",
          reason: "mmr-subagents is loaded; worker tools are not yet implemented.",
        };
      }
      return {
        gate,
        status: "enabled",
        reason: `mmr-subagents worker tools available: ${active}.`,
      };
    },
  };
}

/**
 * Tool provider for `mmr-subagents`.
 *
 * For every owned tool, the rule returned depends on whether the matching
 * capability is active. Active capabilities defer to identity-match
 * resolution against Pi's live tool inventory (the mmr-core status
 * catalog credits mmr-subagents as the owner); inactive capabilities
 * return `gated` against `mmr-subagents` with a per-tool reason.
 * `librarian` is active only while its required mmr-web-owned tools are
 * registered; execute-time checks still fail closed if those tools are not
 * currently active in the parent process. Future repository-provider variants
 * can add their own provider rules.
 */
export function createMmrSubagentsToolProvider(
  capabilities: MmrSubagentsCapabilities = {},
): MmrToolProvider {
  return {
    name: MMR_SUBAGENTS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!OWNED_TOOLS_SET.has(toolName)) return undefined;
      if (isCapabilityActive(capabilities, toolName)) {
        return { kind: "active" };
      }
      return {
        kind: "gated",
        gate: MMR_SUBAGENTS_FEATURE_GATE,
        reason: toolName === "librarian"
          ? LIBRARIAN_GATING_REASON
          : `${toolName}: implementation pending in mmr-subagents.`,
      };
    },
  };
}


// ---------------------------------------------------------------------------
// mmr-async-tasks compatibility surface (the extension is merged into
// mmr-workers; these names remain for callers that compose providers
// manually and for the legacy feature-gate ids).
// ---------------------------------------------------------------------------

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

function readAsyncCapability(value: MmrAsyncTasksCapability | undefined): boolean {
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
      const enabled = readAsyncCapability(capabilities.asyncTasks);
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
      if (readAsyncCapability(capabilities.asyncTasks)) return { kind: "active" };
      return {
        kind: "gated",
        gate: MMR_ASYNC_TASKS_FEATURE_GATE,
        reason: `${toolName}: async background task tools are not enabled.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Unified mmr-workers provider: ONE feature gate (with the legacy ids kept
// as accepted aliases) and ONE tool provider covering the whole worker
// surface — blocking tools and the background task tools.
// ---------------------------------------------------------------------------

export const MMR_WORKERS_PROVIDER_NAME = "mmr-workers";
export const MMR_WORKERS_FEATURE_GATE = "mmr-workers";

/**
 * Legacy gate ids the unified provider keeps answering for, so settings,
 * docs, or callers still querying the pre-merge gates keep working.
 */
export const MMR_WORKERS_LEGACY_FEATURE_GATES: readonly string[] = [
  MMR_SUBAGENTS_FEATURE_GATE,
  MMR_ASYNC_TASKS_FEATURE_GATE,
  MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
];

export const MMR_WORKERS_OWNED_TOOLS: readonly string[] = [
  ...MMR_SUBAGENTS_OWNED_TOOLS,
  ...MMR_ASYNC_TASK_TOOLS,
];

/** Capabilities for the merged extension: the blocking workers plus the background surface. */
export interface MmrWorkersCapabilities extends MmrSubagentsCapabilities, MmrAsyncTasksCapabilities {}

const WORKERS_GATES_SET: ReadonlySet<string> = new Set<string>([
  MMR_WORKERS_FEATURE_GATE,
  ...MMR_WORKERS_LEGACY_FEATURE_GATES,
]);

/**
 * Feature-gate provider for the merged `mmr-workers` extension. Answers the
 * unified `mmr-workers` gate and every legacy id with one status derived
 * from the merged capability set.
 */
export function createMmrWorkersFeatureGateProvider(
  capabilities: MmrWorkersCapabilities = {},
): MmrFeatureGateProvider {
  return {
    name: MMR_WORKERS_PROVIDER_NAME,
    evaluate(gate) {
      if (!WORKERS_GATES_SET.has(gate)) return undefined;
      const activeWorkers = formatActiveCapabilities(capabilities);
      const asyncActive = readAsyncCapability(capabilities.asyncTasks);
      const active = [
        ...(activeWorkers.length > 0 ? [activeWorkers] : []),
        ...(asyncActive ? [MMR_ASYNC_TASK_TOOLS.join(", ")] : []),
      ].join(", ");
      if (active.length === 0) {
        return {
          gate,
          status: "disabled",
          reason: "mmr-workers is loaded; worker tools are not yet implemented.",
        };
      }
      return {
        gate,
        status: "enabled",
        reason: `mmr-workers worker tools available: ${active}.`,
      };
    },
  };
}

/**
 * Tool provider for the merged `mmr-workers` extension: one rule source for
 * the blocking worker tools and the background task tools.
 */
export function createMmrWorkersToolProvider(
  capabilities: MmrWorkersCapabilities = {},
): MmrToolProvider {
  const subagents = createMmrSubagentsToolProvider(capabilities);
  const asyncTasks = createMmrAsyncTasksToolProvider(capabilities);
  return {
    name: MMR_WORKERS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      return subagents.resolve(toolName) ?? asyncTasks.resolve(toolName);
    },
  };
}
