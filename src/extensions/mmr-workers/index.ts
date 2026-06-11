import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedExtensionPath } from "../mmr-core/owned-tools.js";
import { getMmrSubagentState, registerMmrFeatureGateProvider, registerMmrToolProvider } from "../mmr-core/runtime.js";
import { parseBoolEnv } from "../mmr-core/internal/env.js";
import { resetMmrWorkerFallbackState } from "./fallback.js";
import { type FinderToolDeps, maybeNumberFinderReadToolResult, registerFinderTool } from "./finder.js";
import { type LibrarianToolDeps, isLibrarianGithubToolPrerequisiteRegistered, registerLibrarianTool } from "./librarian.js";
import { type CodeReviewToolDeps, registerCodeReviewTool } from "./code-review.js";
import { type MmrAdvisorToolDeps, registerOracleTool } from "./oracle.js";
import { registerMmrSubagentsPromptBuilders } from "./prompts.js";
import { type TaskToolDeps, registerTaskParentPromptCapture, registerTaskTool } from "./task.js";
import {
  type AsyncTaskToolDeps,
  MMR_SUBAGENTS_ASYNC_PUSH_ENV,
  registerAsyncTaskTools,
} from "./async-task-tools.js";
import {
  createMmrWorkersFeatureGateProvider,
  createMmrWorkersToolProvider,
  type MmrWorkersCapabilities,
} from "./provider.js";

// Pi stamps every tool registered through `pi.registerTool` with the
// `sourceInfo.path` of the extension entrypoint that called it. Recording
// our entrypoint path here lets `mmr-core` Free mode confirm ownership of
// the concrete worker tools (`finder`, `oracle`, `Task`, `librarian`, and
// the background task tools) by source path, not just by name, so a
// third-party extension that later re-registers any of those names is
// preserved.
registerMmrOwnedExtensionPath(fileURLToPath(import.meta.url));

/**
 * Internal hooks for tests; not part of the public API.
 *
 * - `finder` exposes the same {@link FinderToolDeps} seams the unit tests
 *   use (injectable runner, model list, system-prompt builder, etc.).
 * - `oracle` exposes the matching {@link MmrAdvisorToolDeps} seams.
 * - `task` exposes the matching {@link TaskToolDeps} seams.
 * - `librarian` exposes the matching {@link LibrarianToolDeps} seams.
 * - `asyncTasks` exposes the background-task seams ({@link AsyncTaskToolDeps}).
 */
export interface MmrWorkersFactoryOverrides {
  finder?: FinderToolDeps;
  oracle?: MmrAdvisorToolDeps;
  task?: TaskToolDeps;
  librarian?: LibrarianToolDeps;
  codeReview?: CodeReviewToolDeps;
  asyncTasks?: AsyncTaskToolDeps;
}

/**
 * Build a Pi extension factory for `mmr-workers` with optional test seams.
 *
 * The default export of this module calls this with no overrides; package
 * code and Pi extension wiring should always use the default export.
 *
 * mmr-workers is the merged worker extension: the blocking `finder`,
 * `oracle`, `Task`, and `librarian` workers plus the background task
 * surface (`start_task`, `task_poll`, `task_wait`, `task_cancel`) ship
 * together behind one feature gate (`mmr-workers`; the pre-merge gate ids
 * remain accepted aliases). `librarian` is registered with the same
 * extension but stays gated until the read-only GitHub tools are
 * registered and source-owned by `mmr-github`.
 */
export function createMmrWorkersExtension(overrides: MmrWorkersFactoryOverrides = {}) {
  return function mmrWorkersExtension(pi: ExtensionAPI): void {
    // Register concrete subagent prompt builders against mmr-core's
    // prompt-assembly registry before any subagent worker can be
    // resolved. Idempotent across reloads.
    registerMmrSubagentsPromptBuilders();
    registerFinderTool(pi, overrides.finder ?? {});
    registerOracleTool(pi, overrides.oracle ?? {});
    registerTaskParentPromptCapture(pi);
    registerTaskTool(pi, overrides.task ?? {});
    registerLibrarianTool(pi, overrides.librarian ?? {});
    registerCodeReviewTool(pi, overrides.codeReview ?? {});
    pi.on("tool_result", maybeNumberFinderReadToolResult);
    // Clear session-scoped worker-model fallback state at session
    // boundaries so one session\'s failure counts and stored overrides can
    // never leak into another (including the degenerate undefined-session
    // case where scope keys collapse to "-"). Only a genuinely fresh
    // session resets: "new" and "fork" start clean, while "resume" keeps
    // any in-process state. Skip the reset inside a subagent worker so a
    // child Pi process never wipes the parent\'s shared in-process map.
    pi.on("session_start", (event) => {
      if (getMmrSubagentState()) return;
      if (event.reason === "new" || event.reason === "fork") {
        resetMmrWorkerFallbackState();
      }
    });
    // User ceiling for automatic async completion delivery: on by default;
    // the env gate can disable both in-turn context notices and idle-wake
    // pushes. Individual starts can opt out with `notify: false`, and the
    // registry bounds idle-wake pushes. Test overrides win so deterministic
    // tests control the seam.
    const asyncPushCeiling = parseBoolEnv(process.env[MMR_SUBAGENTS_ASYNC_PUSH_ENV]) ?? true;
    registerAsyncTaskTools(pi, {
      enableCompletionPush: asyncPushCeiling,
      ...(overrides.finder !== undefined ? { finderDeps: overrides.finder } : {}),
      ...(overrides.task !== undefined ? { taskDeps: overrides.task } : {}),
      ...(overrides.librarian !== undefined ? { librarianDeps: overrides.librarian } : {}),
      ...(overrides.asyncTasks ?? {}),
    });
    const capabilities: MmrWorkersCapabilities = {
      finder: true,
      oracle: true,
      Task: true,
      librarian: () => isLibrarianGithubToolPrerequisiteRegistered(pi),
      code_review: true,
      asyncTasks: true,
    };
    registerMmrFeatureGateProvider(createMmrWorkersFeatureGateProvider(capabilities));
    registerMmrToolProvider(createMmrWorkersToolProvider(capabilities));
  };
}

const mmrWorkersExtension = createMmrWorkersExtension();

export default mmrWorkersExtension;
