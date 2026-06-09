/**
 * @deprecated `mmr-toolbox` has been split into two extensions:
 *   - `mmr-patch` owns `apply_patch`
 *   - `mmr-tasks` owns `task_list`
 *
 * This module is a compatibility shim that re-exports the former public
 * `./extensions/mmr-toolbox` surface from the new owners. It is no longer
 * registered in `package.json` `pi.extensions` and registers no tools itself;
 * the `mmr-patch` and `mmr-tasks` entrypoints do that. Import from
 * `@earendil-works/pi-mmr/extensions/mmr-patch` and `.../extensions/mmr-tasks`
 * (or the package root barrel) instead.
 */
import type { MmrToolProvider } from "../mmr-core/types.js";
import { registerMmrPatchProviders } from "../mmr-patch/index.js";
import { registerMmrTasksProviders } from "../mmr-tasks/index.js";

export {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_PARAMS,
  APPLY_PATCH_PROMPT_GUIDELINES,
  APPLY_PATCH_PROMPT_SNIPPET,
  unifiedDiffToEditRenderableDiff,
} from "../mmr-patch/apply-patch-tool.js";

/**
 * @deprecated Use `registerMmrPatchProviders` and `registerMmrTasksProviders`
 * from `mmr-patch` / `mmr-tasks`. Retained so existing callers keep claiming
 * ownership of both former toolbox tools on a registry.
 */
export function registerMmrToolboxProviders(registry: {
  registerProvider(provider: MmrToolProvider): void;
}): void {
  registerMmrPatchProviders(registry);
  registerMmrTasksProviders(registry);
}
