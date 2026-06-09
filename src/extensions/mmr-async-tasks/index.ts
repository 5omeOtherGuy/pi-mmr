import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedExtensionPath } from "../mmr-core/owned-tools.js";
import { registerMmrFeatureGateProvider, registerMmrToolProvider } from "../mmr-core/runtime.js";
import { parseBoolEnv } from "../mmr-core/internal/env.js";
import type { FinderToolDeps } from "../mmr-subagents/finder.js";
import type { LibrarianToolDeps } from "../mmr-subagents/librarian.js";
import type { TaskToolDeps } from "../mmr-subagents/task.js";
import {
  type AsyncTaskToolDeps,
  MMR_SUBAGENTS_ASYNC_PUSH_ENV,
  registerAsyncTaskTools,
} from "./async-task-tools.js";
import {
  createMmrAsyncTasksFeatureGateProvider,
  createMmrAsyncTasksToolProvider,
  type MmrAsyncTasksCapabilities,
} from "./provider.js";

registerMmrOwnedExtensionPath(fileURLToPath(import.meta.url));

export interface MmrAsyncTasksFactoryOverrides {
  finder?: FinderToolDeps;
  task?: TaskToolDeps;
  librarian?: LibrarianToolDeps;
  asyncTasks?: AsyncTaskToolDeps;
}

export function createMmrAsyncTasksExtension(overrides: MmrAsyncTasksFactoryOverrides = {}) {
  return function mmrAsyncTasksExtension(pi: ExtensionAPI): void {
    // User ceiling for automatic async completion delivery: on by default; the
    // env gate can disable both in-turn context notices and idle-wake pushes.
    // Individual starts can opt out with start_task({ notify: false }), and the
    // registry bounds idle-wake pushes. Test overrides win so deterministic
    // tests control the seam.
    const asyncPushCeiling = parseBoolEnv(process.env[MMR_SUBAGENTS_ASYNC_PUSH_ENV]) ?? true;
    registerAsyncTaskTools(pi, {
      enableCompletionPush: asyncPushCeiling,
      finderDeps: overrides.finder,
      taskDeps: overrides.task,
      librarianDeps: overrides.librarian,
      ...(overrides.asyncTasks ?? {}),
    });

    const capabilities: MmrAsyncTasksCapabilities = { asyncTasks: true };
    registerMmrFeatureGateProvider(createMmrAsyncTasksFeatureGateProvider(capabilities));
    registerMmrToolProvider(createMmrAsyncTasksToolProvider(capabilities));
  };
}

const mmrAsyncTasksExtension = createMmrAsyncTasksExtension();

export default mmrAsyncTasksExtension;
