import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedExtensionPath } from "../mmr-core/owned-tools.js";
import { getMmrSubagentState, registerMmrFeatureGateProvider, registerMmrToolProvider } from "../mmr-core/runtime.js";
import { resetMmrWorkerFallbackState } from "./fallback.js";
import { type FinderToolDeps, maybeNumberFinderReadToolResult, registerFinderTool } from "./finder.js";
import { type LibrarianToolDeps, isLibrarianGithubToolPrerequisiteRegistered, registerLibrarianTool } from "./librarian.js";
import { type MmrAdvisorToolDeps, registerOracleTool } from "./oracle.js";
import { registerMmrSubagentsPromptBuilders } from "./prompts.js";
import { type TaskToolDeps, registerTaskParentPromptCapture, registerTaskTool } from "./task.js";
import { type AsyncTaskToolDeps, MMR_SUBAGENTS_ASYNC_PUSH_ENV, registerAsyncTaskTools } from "./async-task-tools.js";
import {
  type RegisterMmrCustomSubagentToolsOptions,
  countLegacyClaudeSubagentCandidates,
  registerMmrCustomSubagentTools,
} from "./custom-runtime.js";
import { resolveEnabledMmrCustomSubagents } from "./custom-config.js";
import { getMmrAsyncTaskRegistry } from "./async-task-registry.js";
import { parseBoolEnv } from "../mmr-core/internal/env.js";
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
  task?: TaskToolDeps;
  librarian?: LibrarianToolDeps;
  asyncTasks?: AsyncTaskToolDeps;
  customSubagents?: RegisterMmrCustomSubagentToolsOptions;
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
    registerTaskParentPromptCapture(pi);
    registerTaskTool(pi, overrides.task ?? {});
    registerLibrarianTool(pi, overrides.librarian ?? {});
    const customSubagentTools = registerMmrCustomSubagentTools(pi, overrides.customSubagents ?? {});
    // User ceiling for async completion push: on by default; the env gate can
    // force pull-only behavior. Individual starts can opt out with
    // start_task({ notify: false }), and the registry bounds pushes.
    // Test overrides win so deterministic tests control the seam.
    const asyncPushCeiling = parseBoolEnv(process.env[MMR_SUBAGENTS_ASYNC_PUSH_ENV]) ?? true;
    registerAsyncTaskTools(pi, {
      enableCompletionPush: asyncPushCeiling,
      finderDeps: overrides.finder,
      taskDeps: overrides.task,
      librarianDeps: overrides.librarian,
      ...(overrides.asyncTasks ?? {}),
    });
    pi.on("tool_result", maybeNumberFinderReadToolResult);
    // Tear down background tasks when the session ends: abort active
    // worker controllers and clear all session-scoped records. The
    // registry is in-memory and process-local; nothing survives here.
    pi.on("session_shutdown", () => {
      getMmrAsyncTaskRegistry().shutdownSession(undefined, "session_shutdown");
    });
    // Clear session-scoped worker-model fallback state at session
    // boundaries so one session's failure counts and stored overrides can
    // never leak into another (including the degenerate undefined-session
    // case where scope keys collapse to "-"). Only a genuinely fresh
    // session resets: "new" and "fork" start clean, while "resume" keeps
    // any in-process state. Skip the reset inside a subagent worker so a
    // child Pi process never wipes the parent's shared in-process map.
    pi.on("session_start", (event, ctx) => {
      if (getMmrSubagentState()) return;
      if (event.reason === "new" || event.reason === "fork") {
        resetMmrWorkerFallbackState();
      }
      maybeNotifyLegacyClaudeMigration(ctx);
    });
    const capabilities: MmrSubagentsCapabilities = {
      finder: true,
      oracle: true,
      Task: true,
      librarian: () => isLibrarianGithubToolPrerequisiteRegistered(pi),
      asyncTasks: true,
      customTools: () => customSubagentTools.map((tool) => tool.name),
    };
    registerMmrFeatureGateProvider(createMmrSubagentsFeatureGateProvider(capabilities));
    registerMmrToolProvider(createMmrSubagentsToolProvider(capabilities));
  };
}

// Per-cwd sentinel so the migration notice / config warnings are surfaced at
// most once per process per project, even if Pi emits several session_start
// events for the same session. In-memory and process-local by design.
const mmrCustomSubagentStartupNotified = new Set<string>();

/**
 * One-time-per-project startup advisories for custom subagents:
 *  - Migration: pi-mmr no longer auto-loads Claude-style `.claude/agents`;
 *    when candidates exist but nothing is enabled through config, point the
 *    user at `/mmr-config` → "subagent (setup/import custom)".
 *  - Config warnings: surface invalid/duplicate/out-of-scope record warnings
 *    that registration otherwise discards.
 * Suppressed without a UI and after the first emission for a given cwd.
 */
function maybeNotifyLegacyClaudeMigration(ctx: ExtensionContext): void {
  try {
    if (ctx.hasUI === false) return;
    const key = ctx.cwd;
    if (mmrCustomSubagentStartupNotified.has(key)) return;
    mmrCustomSubagentStartupNotified.add(key);

    const { resolved, warnings } = resolveEnabledMmrCustomSubagents({ cwd: ctx.cwd });
    if (warnings.length > 0) {
      ctx.ui.notify(`Custom subagent config warnings:\n- ${warnings.join("\n- ")}`, "warning");
    }
    if (resolved.length > 0) return;
    if (countLegacyClaudeSubagentCandidates(ctx.cwd) === 0) return;
    ctx.ui.notify(
      "Claude-style agents are no longer auto-loaded by pi-mmr. Run /mmr-config → \"subagent (setup/import custom)\" to review and enable selected agents.",
      "info",
    );
  } catch {
    // Best-effort advisory; never block session start.
  }
}

const mmrSubagentsExtension = createMmrSubagentsExtension();

export default mmrSubagentsExtension;
