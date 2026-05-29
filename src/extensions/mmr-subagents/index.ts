import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedExtensionPath } from "../mmr-core/owned-tools.js";
import { registerMmrFeatureGateProvider, registerMmrToolProvider } from "../mmr-core/runtime.js";
import { type FinderToolDeps, maybeNumberFinderReadToolResult, registerFinderTool } from "./finder.js";
import { type LibrarianToolDeps, isLibrarianGithubToolPrerequisiteRegistered, registerLibrarianTool } from "./librarian.js";
import { type MmrAdvisorToolDeps, registerOracleTool } from "./oracle.js";
import { registerCthuluTool } from "./cthulu.js";
import { registerMmrSubagentsPromptBuilders } from "./prompts.js";
import { type TaskToolDeps, registerTaskParentPromptCapture, registerTaskTool } from "./task.js";
import { type AsyncTaskToolDeps, registerAsyncTaskTools } from "./async-task-tools.js";
import { getMmrAsyncTaskRegistry } from "./async-task-registry.js";
import {
  createMmrSubagentsFeatureGateProvider,
  createMmrSubagentsToolProvider,
  type MmrSubagentsCapabilities,
} from "./provider.js";

// Pi stamps every tool registered through `pi.registerTool` with the
// `sourceInfo.path` of the extension entrypoint that called it. Recording
// our entrypoint path here lets `mmr-core` Free mode confirm ownership of
// concrete worker tools (`finder`, `oracle`, `Task`, and `librarian`)
// by source path, not just by name, so a third-party extension that later
// re-registers any of those names is preserved.
registerMmrOwnedExtensionPath(fileURLToPath(import.meta.url));

/**
 * Internal hooks for tests; not part of the public API.
 *
 * - `finder` exposes the same {@link FinderToolDeps} seams the unit tests
 *   use (injectable runner, model list, system-prompt builder, etc.).
 * - `oracle` exposes the matching {@link OracleToolDeps} seams.
 * - `task` exposes the matching {@link TaskToolDeps} seams.
 * - `librarian` exposes the matching {@link LibrarianToolDeps} seams.
 */
export interface MmrSubagentsFactoryOverrides {
  finder?: FinderToolDeps;
  oracle?: MmrAdvisorToolDeps;
  /** Hidden cthulu advisor seams (shares the advisor dependency shape). */
  cthulu?: MmrAdvisorToolDeps;
  task?: TaskToolDeps;
  librarian?: LibrarianToolDeps;
  asyncTasks?: AsyncTaskToolDeps;
}

/**
 * Build a Pi extension factory for `mmr-subagents` with optional test seams.
 *
 * The default export of this module calls this with no overrides; package
 * code and Pi extension wiring should always use the default export.
 *
 * This slice ships the `finder`, `oracle`, `Task`, and `librarian`
 * workers. `librarian` is registered with the same extension but stays
 * gated until the read-only GitHub tools are registered and source-owned
 * by `mmr-github`.
 */
export function createMmrSubagentsExtension(overrides: MmrSubagentsFactoryOverrides = {}) {
  return function mmrSubagentsExtension(pi: ExtensionAPI): void {
    // Register concrete subagent prompt builders against mmr-core's
    // prompt-assembly registry before any subagent worker can be
    // resolved. Idempotent across reloads.
    registerMmrSubagentsPromptBuilders();
    registerFinderTool(pi, overrides.finder ?? {});
    registerOracleTool(pi, overrides.oracle ?? {});
    registerCthuluTool(pi, overrides.cthulu ?? {});
    registerTaskParentPromptCapture(pi);
    registerTaskTool(pi, overrides.task ?? {});
    registerLibrarianTool(pi, overrides.librarian ?? {});
    registerAsyncTaskTools(pi, overrides.asyncTasks ?? {});
    pi.on("tool_result", maybeNumberFinderReadToolResult);
    // Tear down background tasks when the session ends: abort active
    // worker controllers and clear all session-scoped records. The
    // registry is in-memory and process-local; nothing survives here.
    pi.on("session_shutdown", () => {
      getMmrAsyncTaskRegistry().shutdownSession(undefined, "session_shutdown");
    });
    const capabilities: MmrSubagentsCapabilities = {
      finder: true,
      oracle: true,
      cthulu: true,
      Task: true,
      librarian: () => isLibrarianGithubToolPrerequisiteRegistered(pi),
      asyncTasks: true,
    };
    registerMmrFeatureGateProvider(createMmrSubagentsFeatureGateProvider(capabilities));
    registerMmrToolProvider(createMmrSubagentsToolProvider(capabilities));
  };
}

const mmrSubagentsExtension = createMmrSubagentsExtension();

export default mmrSubagentsExtension;
