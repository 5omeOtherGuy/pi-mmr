import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasMmrGithubOwnedTools, type MmrGithubToolInfoLike } from "../mmr-github/tool-ownership.js";
import { isMmrModeKey } from "./modes.js";
import { setMmrSubagentState, type MmrSubagentState } from "./runtime.js";
import { loadMmrCoreSettings } from "./settings.js";
import {
  MMR_SUBAGENT_MODEL_PREFERENCES_ENV,
  parseMmrSubagentModelPreferencesEnv,
} from "./subagent-model-override-env.js";
import { getMmrSubagentProfile, listMmrSubagentProfiles } from "./subagent-profiles.js";
import {
  MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX,
  resolveMmrSubagentInvocation,
} from "./subagent-resolver.js";
import type { MmrModeKey, MmrModelPreference } from "./types.js";
import { extractExplicitWorkerCliFlags } from "./worker-cli-flags.js";

/**
 * State bindings for {@link applyMmrSubagentProfile}. The bindings own the
 * mutable settings/guard state that lives on the mmr-core extension closure
 * in `index.ts`; the activation helper writes through them so that the
 * extension keeps a single source of truth for `configuredSubagentModelPreferences`,
 * `settingsFilesRead`, `settingsWarnings`, and the `applyingMmrMode` transaction
 * guard.
 */
export interface MmrSubagentActivationBindings {
  setConfiguredSubagentModelPreferences(preferences: Record<string, MmrModelPreference[]>): void;
  setSettingsFilesRead(files: string[]): void;
  setSettingsWarnings(warnings: string[]): void;
  notifyWarnings(ctx: ExtensionContext, warnings: readonly string[]): void;
  setApplyingMmrMode(value: boolean): void;
}

/**
 * Fail-closed startup must surface to the parent (runner) as a nonzero exit or
 * stderr signal, not just an in-process notify(). Notify the UI for human-facing
 * surfaces, write to stderr for the runner that captures the child's stderr
 * stream, and throw so Pi's session_start handler propagates the failure
 * instead of allowing the worker to proceed with un-policied execution.
 */
export function failClosedSubagent(message: string, ctx: ExtensionContext): never {
  ctx.ui.notify(message, "error");
  try {
    process.stderr.write(`${MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX}${message}\n`);
  } catch {
    // best-effort
  }
  throw new Error(message);
}

export function readMmrGithubToolInfos(pi: ExtensionAPI): readonly MmrGithubToolInfoLike[] | undefined {
  try {
    const tools = pi.getAllTools();
    if (!Array.isArray(tools)) return undefined;
    return tools.flatMap((tool) => {
      if (typeof tool !== "object" || tool === null) return [];
      const candidate = tool as { name?: unknown; sourceInfo?: { path?: unknown } };
      if (typeof candidate.name !== "string" || candidate.name.length === 0) return [];
      const sourceInfo = candidate.sourceInfo && typeof candidate.sourceInfo.path === "string"
        ? { path: candidate.sourceInfo.path }
        : undefined;
      return [{ name: candidate.name, ...(sourceInfo !== undefined ? { sourceInfo } : {}) }];
    });
  } catch {
    return undefined;
  }
}

export function validateLibrarianRepoToolOwnership(
  pi: ExtensionAPI,
  profileName: string,
  ctx: ExtensionContext,
): void {
  if (profileName !== "librarian") return;
  const tools = readMmrGithubToolInfos(pi);
  if (tools && hasMmrGithubOwnedTools(tools)) return;
  failClosedSubagent(
    'Subagent "librarian" requires mmr-github-owned read-only GitHub tools (set MMR_GITHUB_ENABLE=true).',
    ctx,
  );
}

export async function applyMmrSubagentProfile(
  pi: ExtensionAPI,
  profileName: string,
  ctx: ExtensionContext,
  bindings: MmrSubagentActivationBindings,
): Promise<void> {
  const profile = getMmrSubagentProfile(profileName);
  if (!profile) {
    const known = listMmrSubagentProfiles().join(", ") || "<none>";
    failClosedSubagent(
      `Unknown subagent profile "${profileName}". Known profiles: ${known}.`,
      ctx,
    );
  }

  // ctx.model reflects whatever Pi currently has selected; that can be
  // an explicit `--model` from argv, a session-restored model, a
  // settings default, or Pi's built-in default. Only validate it
  // against the profile when the runner actually supplied `--model`
  // on the CLI, otherwise activation would false-positive a mismatch
  // on legitimate workers that never asked to override the model.
  // Subagent activation runs from session_start without going through
  // resolveInitialMode, so settings have not been loaded yet. Read the
  // subagent override block (if any) here so `/mmr-config` writes can
  // influence the worker without requiring the parent to be in a locked
  // mode at spawn time.
  const loadedSettings = loadMmrCoreSettings(ctx.cwd);
  const subagentPreferences = loadedSettings.settings.subagentModelPreferences ?? {};
  bindings.setConfiguredSubagentModelPreferences(subagentPreferences);
  bindings.setSettingsFilesRead([...loadedSettings.filesRead]);
  bindings.setSettingsWarnings([...loadedSettings.warnings]);
  bindings.notifyWarnings(ctx, loadedSettings.warnings);

  // Session-scoped fallback override (issue #9) takes precedence over the
  // on-disk settings override. The parent tool forwards the user-selected
  // fallback preferences through the env channel for this spawn only; it
  // is never persisted. A malformed/absent value parses to `undefined`,
  // so the child cleanly falls back to settings/profile resolution.
  const envOverride = parseMmrSubagentModelPreferencesEnv(process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV]);
  const settingsOverride = subagentPreferences[profile.name];
  const subagentOverride = envOverride ?? settingsOverride;

  const explicitFlags = extractExplicitWorkerCliFlags(process.argv.slice(2));
  const explicitModel = explicitFlags.explicitModel !== undefined && ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : undefined;
  let parentMode: MmrModeKey | undefined;
  if (explicitFlags.parentMode !== undefined) {
    if (!isMmrModeKey(explicitFlags.parentMode) || explicitFlags.parentMode === "free") {
      failClosedSubagent(
        `Subagent "${profile.name}" was invoked with invalid --mmr-parent-mode ${JSON.stringify(explicitFlags.parentMode)}.`,
        ctx,
      );
    }
    parentMode = explicitFlags.parentMode;
  }

  // Single resolver for parent spawn and child activation. We pass
  // `invocationContext: "child-activation"` to identify this caller as
  // the child Pi process: the parent already assembled and delivered
  // the worker system prompt via `--system-prompt` before spawning.
  // For mode-derived profiles, parent-mode metadata selects any
  // mode-specific worker route; without it, child activation falls
  // back to the profile's default worker preferences instead of
  // inferring from a model id. Settings-driven `modelPreferences`
  // overrides are forwarded through the resolver instead of mutating
  // `profile.modelPreferences` ad hoc so parent and child agree by
  // construction on which model the worker runs. The child still
  // validates explicit `--model` / `--tools` CLI flags against the
  // deny-aware, registered-tool intersection rather than the raw
  // profile intent allowlist, so a parent-reduced subset is accepted by
  // construction; the invocationContext marker does NOT loosen
  // deny/tool/model validation.
  const registeredTools = pi.getAllTools().map((tool) => tool.name);
  const invocation = resolveMmrSubagentInvocation({
    profile,
    registry: ctx.modelRegistry,
    registeredTools,
    invocationContext: "child-activation",
    ...(parentMode !== undefined ? { parentMode } : {}),
    ...(explicitModel !== undefined ? { explicitModel } : {}),
    ...(explicitFlags.explicitTools !== undefined ? { explicitTools: explicitFlags.explicitTools } : {}),
    ...(subagentOverride && subagentOverride.length > 0
      ? { modelPreferencesOverride: subagentOverride }
      : {}),
  });

  if (!invocation.ok) {
    failClosedSubagent(invocation.message, ctx);
  }

  validateLibrarianRepoToolOwnership(pi, profile.name, ctx);

  const activeWorkerTools = [...invocation.workerTools];

  bindings.setApplyingMmrMode(true);
  try {
    await pi.setModel(invocation.selected.registeredModel);
    if (invocation.selected.thinkingLevel) {
      pi.setThinkingLevel(invocation.selected.thinkingLevel);
    }
    pi.setActiveTools([...activeWorkerTools]);
  } finally {
    await Promise.resolve();
    bindings.setApplyingMmrMode(false);
  }

  const subagentState: MmrSubagentState = {
    profile: profile.name,
    provider: invocation.selected.provider,
    model: invocation.selected.model,
    thinkingLevel: invocation.selected.thinkingLevel,
    ...(typeof profile.maxOutputTokens === "number" ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    promptRoute: invocation.promptRoute,
    activeTools: [...activeWorkerTools],
    activatedAt: new Date().toISOString(),
  };
  setMmrSubagentState(subagentState);
}
