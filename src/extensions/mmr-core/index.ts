import { writeFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildReplayContent, decideAutoCompact } from "./auto-compact.js";
import { maybeShowMmrChangelogOnSessionStart, showMmrChangelogCommand } from "./changelog.js";
import { runMmrConfigFlow } from "./config-flow.js";
import { getMmrPolicyDiagnostics } from "./diagnostics.js";
import { DEFAULT_MMR_MODE, formatMmrModeList, getMmrMode, isMmrModeKey, MMR_MODE_KEYS } from "./modes.js";
import { formatActivationFailure, formatZeroToolActivationFailure } from "./activation-errors.js";
import { resolveAndApplyMmrModel } from "./model-resolver.js";
import { shouldDropToolForFreeMode } from "./owned-tools.js";
import { buildMmrPromptLayer } from "./prompt.js";
import {
  MMR_REQUEST_POLICIES,
  applyMmrRequestPolicy,
  applyMmrThinkingLevelToPolicy,
  buildMmrSubagentOutputPolicy,
  clampPolicyToRegisteredModel,
  getDefaultToggleThinkingLevel,
  getMmrPolicyMaxOutputTokens,
  getOtherToggleThinkingLevel,
  isToggleableMmrMode,
  type MmrRequestPolicy,
  type MmrToggleableModeKey,
  type MmrToggleThinkingLevel,
} from "./request-policy.js";
import { resolveMmrModeSelection } from "./routing.js";
import {
  MMR_EVENT_SESSION_IDENTITY_CHANGED,
  MMR_EVENT_STATE_CHANGED,
  clearMmrManagedModelOverride,
  getMmrManagedModelOverride,
  getMmrModeState,
  getMmrSessionIdentity,
  getMmrSubagentState,
  isMmrManagedModelUpdateActive,
  isToolAllowed,
  resolveMmrFeatureGates,
  resolveMmrTools,
  setMmrModeState,
  setMmrSessionIdentity,
  setMmrSubagentState,
} from "./runtime.js";
import { applyMmrSubagentProfile } from "./subagent-activation.js";
import { mergeToolResolutions, relabelExtraOwners, selectExtraToolNames } from "./extra-tools.js";
import { resolveMmrTools as resolveMmrToolNames } from "./tool-registry.js";
import { loadMmrCoreSettings } from "./settings.js";
import { createMmrModeState, findLatestPersistedModeState, MMR_MODE_STATE_ENTRY, toPersistedModeState } from "./state.js";
import { formatMmrStatus, updateMmrStatus } from "./status.js";
import type { MmrCoreSettings, MmrLockedModeKey, MmrModeKey, MmrModeSelectionSource, MmrModeState, MmrModelPreference, MmrRejectedModeSource, MmrSessionIdentity } from "./types.js";

const CYCLABLE_MMR_MODE_KEYS: MmrModeKey[] = MMR_MODE_KEYS.filter((mode) => mode !== "free");
const MMR_MODE_PICKER_SHORTCUTS = ["ctrl+shift+s", "alt+m"] as const;

interface ApplyModeOptions {
  source: MmrModeSelectionSource;
  persist?: boolean;
  notify?: boolean;
  nativeControlOptOut?: boolean;
  rejectedSources?: readonly MmrRejectedModeSource[];
  nativeModel?: Parameters<ExtensionAPI["setModel"]>[0];
  nativeThinkingLevel?: ThinkingLevel;
}

interface MmrBaseline {
  model?: Parameters<ExtensionAPI["setModel"]>[0];
  thinkingLevel?: ThinkingLevel;
  activeTools: string[];
}

function modeCompletions(prefix: string) {
  return MMR_MODE_KEYS.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode }));
}

function notifyWarnings(ctx: ExtensionContext, warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  ctx.ui.notify(warnings.join("\n"), "warning");
}

function parseMmrStatusDebugFlag(args: unknown): boolean {
  if (typeof args !== "string") return false;
  return args
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .some((token) => token === "debug" || token === "--debug");
}

export default function mmrCoreExtension(pi: ExtensionAPI): void {
  pi.registerFlag("mmr-mode", {
    description: "Start with an MMR mode: smart, smartGPT, rush, large, deep, or free",
    type: "string",
  });

  pi.registerFlag("mmr-subagent", {
    description: "Run as an MMR subagent worker with a named profile (e.g. finder). Bypasses user-facing MMR locked modes.",
    type: "string",
  });

  pi.registerFlag("mmr-parent-mode", {
    description: "Parent MMR mode metadata for mode-derived subagent workers.",
    type: "string",
  });

  const nativeFreeModeWarning = [
    "MMR switched to Free mode because the Pi model/thinking setting changed.",
    "",
    "Free mode implications:",
    "- Native Pi model/thinking controls are active.",
    "- MMR mode prompt is disabled.",
    "- MMR tool allowlist is disabled.",
    "- Standard Pi tools are restored.",
    "",
    "Use /mode smart, /mode rush, /mode large, or /mode deep to re-enter MMR routing.",
  ].join("\n");

  let configuredModelPreferences: Partial<Record<MmrModeKey, MmrModelPreference[]>> = {};
  let configuredSubagentModelPreferences: Record<string, MmrModelPreference[]> = {};
  let configuredLockedModeExtraTools: MmrCoreSettings["lockedModeExtraTools"] = {};
  let settingsFilesRead: string[] = [];
  let settingsWarnings: string[] = [];
  let baseline: MmrBaseline | undefined;
  let activePolicy: MmrRequestPolicy | undefined;
  let applyingMmrMode = false;
  let modeCycleQueue: Promise<void> = Promise.resolve();
  let thinkingToggleQueue: Promise<void> = Promise.resolve();
  // Per-mode, session-scoped thinking-level toggle overrides for toggleable
  // modes (smart/smartGPT/deep). Lives only in process memory: persisted mode
  // state records the applied thinking level for diagnostics, but the toggle
  // default is re-derived on each apply so stale persisted levels never pin a
  // mode away from its default after a reload.
  const modeThinkingOverrides: Partial<Record<MmrToggleableModeKey, MmrToggleThinkingLevel>> = {};

  function safeGetThinkingLevel(): ThinkingLevel | undefined {
    try {
      return pi.getThinkingLevel?.();
    } catch {
      return undefined;
    }
  }

  function captureBaseline(ctx: ExtensionContext, options: { force?: boolean; model?: Parameters<ExtensionAPI["setModel"]>[0]; thinkingLevel?: ThinkingLevel } = {}): MmrBaseline {
    if (baseline && !options.force) return baseline;
    baseline = {
      model: options.model ?? ctx.model,
      thinkingLevel: options.thinkingLevel ?? safeGetThinkingLevel(),
      activeTools: pi.getActiveTools(),
    };
    return baseline;
  }

  function formatBaselineModel(model: Parameters<ExtensionAPI["setModel"]>[0] | undefined): string | undefined {
    if (!model) return undefined;
    return `${model.provider}/${model.id}`;
  }

  function currentBaselineFields(): Pick<MmrModeState, "baselineCaptured" | "baselineModel"> {
    return {
      baselineCaptured: Boolean(baseline),
      baselineModel: formatBaselineModel(baseline?.model),
    };
  }

  function createFreeModeState(source: MmrModeSelectionSource, activeTools: string[], rejectedSources?: readonly MmrRejectedModeSource[]): MmrModeState {
    const free = getMmrMode("free");
    return createMmrModeState({
      ...currentBaselineFields(),
      mode: free,
      source,
      rejectedSources,
      modelResolution: {
        targetModel: "",
        requestedModels: [],
        modelFound: false,
        modelApplied: false,
        fallbackApplied: false,
        candidates: [],
      },
      tools: {
        requestedTools: [],
        activeTools,
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [],
      },
      featureGateDecisions: resolveMmrFeatureGates(free.featureGates ?? []),
      settingsFilesRead,
      settingsWarnings,
    });
  }

  function notifyFreeMode(ctx: ExtensionContext, state: MmrModeState, options: ApplyModeOptions): void {
    if (!options.notify) return;

    if (options.nativeControlOptOut) {
      ctx.ui.notify(nativeFreeModeWarning, "warning");
      return;
    }

    ctx.ui.notify(
      [
        `MMR Free mode activated (${state.mode}).`,
        "Native Pi model/thinking controls are active.",
        "MMR prompt and tool allowlist enforcement are disabled.",
        "Standard Pi tools have been restored.",
      ].join("\n"),
      "info",
    );
  }

  function publishStateChange(): void {
    // Emit the live (deep-frozen) singleton reference. Raw `pi.events.on`
    // subscribers receive a frozen, read-only payload as documented on
    // MMR_EVENT_STATE_CHANGED; handlers that need a mutable copy attach via
    // `onMmrStateChanged`, which clones once per handler. Avoids the
    // previous double-clone (snapshot here + per-handler clone in
    // onMmrStateChanged) — addresses M8 in the run2 review.
    pi.events.emit(MMR_EVENT_STATE_CHANGED, getMmrModeState());
  }

  async function applyFreeMode(ctx: ExtensionContext, options: ApplyModeOptions): Promise<MmrModeState> {
    activePolicy = undefined;
    clearMmrManagedModelOverride();
    const previousState = getMmrModeState();
    const shouldRestoreBaseline = Boolean(baseline && previousState && previousState.mode !== "free" && !options.nativeControlOptOut);
    // Free mode means "Pi as if `pi-mmr` were not installed". Drop tools
    // registered by MMR package extensions (apply_patch, web_search,
    // read_web_page, ...) from the baseline before handing control back to
    // Pi. Pi rebuilds its system prompt and provider `tools` payload from
    // the active tool set, so removing them here also removes their
    // descriptions/schemas from the model context.
    //
    // Ownership is checked against `ToolInfo.sourceInfo.path` when Pi
    // provides it, so a third-party extension that re-registers a tool
    // with the same name as one we own (e.g. `apply_patch`) is preserved.
    // When Pi cannot tell us the source, we fall back to the name-only
    // registry so Free mode still removes the tools we know about. See
    // `shouldDropToolForFreeMode` for the full matrix.
    const allTools = pi.getAllTools();
    const baselineTools = baseline ? [...baseline.activeTools] : pi.getActiveTools();
    const activeTools = baselineTools.filter((name) => !shouldDropToolForFreeMode(name, allTools));

    applyingMmrMode = true;
    try {
      pi.setActiveTools(activeTools);
      if (shouldRestoreBaseline) {
        if (baseline?.model) await pi.setModel(baseline.model);
        if (baseline?.thinkingLevel) pi.setThinkingLevel(baseline.thinkingLevel);
      }
    } finally {
      applyingMmrMode = false;
    }

    if (options.nativeControlOptOut) {
      captureBaseline(ctx, {
        force: true,
        model: options.nativeModel ?? ctx.model,
        thinkingLevel: options.nativeThinkingLevel ?? safeGetThinkingLevel(),
      });
    } else if (shouldRestoreBaseline) {
      baseline = undefined;
    }

    const state = createFreeModeState(options.source, activeTools, options.rejectedSources);
    setMmrModeState(state);
    publishStateChange();

    if (options.persist) {
      pi.appendEntry(MMR_MODE_STATE_ENTRY, toPersistedModeState(state));
    }

    updateMmrStatus(ctx, state);
    notifyFreeMode(ctx, state, options);
    return state;
  }

  async function applyMode(modeKey: MmrModeKey, ctx: ExtensionContext, options: ApplyModeOptions): Promise<MmrModeState | undefined> {
    clearMmrManagedModelOverride();
    const mode = getMmrMode(modeKey);

    if (mode.key === "free") {
      return applyFreeMode(ctx, options);
    }

    captureBaseline(ctx);

    // Toggleable modes (smart/smartGPT/deep) carry a runtime thinking-level
    // override flipped by the MMR-owned alt+r shortcut. Re-derive the effective level on every
    // apply (override or the mode default), force every candidate to it so the
    // active and fallback routes agree with the wire reasoning effort, and use
    // it as the mode thinking level passed to model resolution.
    const toggleableKey: MmrToggleableModeKey | undefined = isToggleableMmrMode(mode.key) ? mode.key : undefined;
    const toggleLevel: MmrToggleThinkingLevel | undefined = toggleableKey
      ? (modeThinkingOverrides[toggleableKey] ?? getDefaultToggleThinkingLevel(toggleableKey))
      : undefined;
    const effectiveThinkingLevel: ThinkingLevel | undefined = toggleLevel ?? mode.thinkingLevel;

    const configuredPreferences = configuredModelPreferences[mode.key] ?? mode.modelPreferences;
    const modelPreferences = toggleLevel
      ? configuredPreferences.map((preference) => ({ ...preference, thinkingLevel: toggleLevel }))
      : configuredPreferences;
    const previousState = getMmrModeState();

    const availableTools = pi.getAllTools().map((tool) => tool.name);
    // Base resolution drives the fail-closed activation check: only the mode's
    // own allowlist may satisfy (or fail) activation. User extras are merged
    // afterward so a typo'd or missing extra can never abort, nor mask a mode
    // that resolved zero of its own tools.
    const baseResolution = resolveMmrTools(mode.key, availableTools);
    if (mode.tools.length > 0 && baseResolution.activeTools.length === 0) {
      if (options.notify) ctx.ui.notify(formatZeroToolActivationFailure(mode, baseResolution, previousState), "error");
      updateMmrStatus(ctx, previousState);
      return previousState;
    }
    const extraToolNames = selectExtraToolNames(
      mode.key as MmrLockedModeKey,
      configuredLockedModeExtraTools,
      mode.tools,
    );
    const toolResolution = extraToolNames.length > 0
      ? mergeToolResolutions(baseResolution, relabelExtraOwners(resolveMmrToolNames(extraToolNames, availableTools)))
      : baseResolution;

    applyingMmrMode = true;
    try {
      const modelResolution = await resolveAndApplyMmrModel({
        modelPreferences,
        modeThinkingLevel: effectiveThinkingLevel,
        registry: ctx.modelRegistry,
        setModel: async (model) => pi.setModel(model),
      });

      if (!modelResolution.modelApplied) {
        if (options.notify) ctx.ui.notify(formatActivationFailure(mode, modelResolution, previousState), "error");
        return previousState;
      }

      pi.setActiveTools(toolResolution.activeTools);

      if (modelResolution.selectedThinkingLevel) {
        pi.setThinkingLevel(modelResolution.selectedThinkingLevel);
      }

      const selectedModel = modelResolution.selectedProvider && modelResolution.selectedModel
        ? ctx.modelRegistry.find(modelResolution.selectedProvider, modelResolution.selectedModel)
        : undefined;
      const basePolicy = clampPolicyToRegisteredModel(MMR_REQUEST_POLICIES[mode.key], selectedModel);
      activePolicy = toggleableKey && toggleLevel
        ? applyMmrThinkingLevelToPolicy(toggleableKey, basePolicy, toggleLevel)
        : basePolicy;
      const registeredContextWindow = typeof selectedModel?.contextWindow === "number" && Number.isFinite(selectedModel.contextWindow)
        ? selectedModel.contextWindow
        : undefined;

      const state = createMmrModeState({
        ...currentBaselineFields(),
        effectiveContextWindow: activePolicy.contextWindow,
        effectiveMaxOutputTokens: getMmrPolicyMaxOutputTokens(activePolicy),
        effectiveMaxInputTokens: activePolicy.effectiveMaxInputTokens,
        registeredContextWindow,
        mode,
        source: options.source,
        rejectedSources: options.rejectedSources,
        modelResolution,
        tools: toolResolution,
        featureGateDecisions: resolveMmrFeatureGates(mode.featureGates ?? []),
        settingsFilesRead,
        settingsWarnings,
      });
      setMmrModeState(state);
      publishStateChange();

      if (options.persist) {
        pi.appendEntry(MMR_MODE_STATE_ENTRY, toPersistedModeState(state));
      }

      updateMmrStatus(ctx, state);

      if (options.notify) {
        // Policy warnings come from the same diagnostic pipeline that drives
        // /mmr-status, so the two surfaces stay in sync. Deferred-tool messages
        // are intentionally not policy warnings (they are informational "what
        // is coming" announcements), so they are appended separately.
        const policyMessages = getMmrPolicyDiagnostics(state).map((diag) => diag.message);
        const deferredMessages = toolResolution.decisions
          .filter((decision) => decision.status === "deferred")
          .map((decision) => decision.diagnostic);
        const warnings = [...policyMessages, ...deferredMessages];

        const selectedModel = state.modelApplied ? `${state.provider}/${state.model} thinking:${state.thinkingLevel ?? "Pi default"}` : "none";
        const modelLine = `\nSelected model: ${selectedModel}`;
        const targetLine = `\nTarget models: ${state.requestedModels.join(" → ") || state.targetModel || "none"}`;
        const suffix = warnings.length > 0 ? `\nWarnings:\n- ${warnings.join("\n- ")}` : "";
        ctx.ui.notify(`MMR mode activated: ${mode.displayName} (${mode.key})${targetLine}${modelLine}${suffix}`, warnings.length > 0 ? "warning" : "info");
      }

      return state;
    } finally {
      // Defer the guard reset by one microtask so that any `model_select` /
      // `thinking_level_select` events Pi delivers synchronously after
      // pi.setModel/setThinkingLevel inside this transaction still see
      // applyingMmrMode === true and bypass the native-control opt-out path.
      // If Pi ever delivers those events asynchronously, this defer is what
      // keeps the guard correct; revisit if event delivery semantics change.
      await Promise.resolve();
      applyingMmrMode = false;
    }
  }

  async function resolveInitialMode(ctx: ExtensionContext): Promise<void> {
    const loadedSettings = loadMmrCoreSettings(ctx.cwd);
    configuredModelPreferences = loadedSettings.settings.modelPreferences ?? {};
    configuredSubagentModelPreferences = loadedSettings.settings.subagentModelPreferences ?? {};
    configuredLockedModeExtraTools = loadedSettings.settings.lockedModeExtraTools ?? {};
    settingsFilesRead = [...loadedSettings.filesRead];
    settingsWarnings = [...loadedSettings.warnings];
    notifyWarnings(ctx, loadedSettings.warnings);

    const persisted = findLatestPersistedModeState(ctx.sessionManager.getEntries());
    const selection = resolveMmrModeSelection({
      flagValue: pi.getFlag("mmr-mode"),
      persistedMode: persisted?.mode,
      settingsMode: loadedSettings.settings.defaultMode,
      defaultMode: DEFAULT_MMR_MODE,
    });

    notifyWarnings(ctx, selection.warnings);
    await applyMode(selection.mode, ctx, {
      source: selection.source,
      persist: selection.source === "flag",
      notify: selection.source === "flag",
      rejectedSources: selection.rejectedSources,
    });
  }

  async function switchLockedModeToFreeForNativeControl(
    ctx: ExtensionContext,
    options: Pick<ApplyModeOptions, "nativeModel" | "nativeThinkingLevel"> = {},
  ): Promise<void> {
    const state = getMmrModeState();
    if (!state || state.mode === "free") {
      captureBaseline(ctx, {
        force: true,
        model: options.nativeModel ?? ctx.model,
        thinkingLevel: options.nativeThinkingLevel ?? safeGetThinkingLevel(),
      });
      updateMmrStatus(ctx, state);
      return;
    }

    await applyMode("free", ctx, {
      source: "native",
      persist: true,
      notify: true,
      nativeControlOptOut: true,
      ...options,
    });
  }

  async function selectModeFromShortcut(ctx: ExtensionContext): Promise<void> {
    if (ctx.hasUI === false) return;

    const currentMode = getMmrModeState()?.mode;
    const title = currentMode ? `MMR mode (current: ${currentMode})` : "MMR mode";
    const choice = await ctx.ui.select(title, [...MMR_MODE_KEYS]);
    if (!choice || !isMmrModeKey(choice)) return;

    await applyMode(choice, ctx, { source: "command", persist: true, notify: true });
  }

  function getNextCycledMode(): MmrModeKey {
    const currentMode = getMmrModeState()?.mode;
    const currentIndex = currentMode ? CYCLABLE_MMR_MODE_KEYS.indexOf(currentMode) : -1;
    const nextIndex = (currentIndex + 1) % CYCLABLE_MMR_MODE_KEYS.length;
    return CYCLABLE_MMR_MODE_KEYS[nextIndex] ?? DEFAULT_MMR_MODE;
  }

  async function cycleModeNow(ctx: ExtensionContext): Promise<void> {
    await applyMode(getNextCycledMode(), ctx, { source: "command", persist: true, notify: true });
  }

  async function cycleModeFromShortcut(ctx: ExtensionContext): Promise<void> {
    const run = modeCycleQueue.then(() => cycleModeNow(ctx), () => cycleModeNow(ctx));
    // Keep the queue alive across failures, but surface the error so a
    // persistent fault (e.g. registry/setModel crashes) is not silently
    // swallowed every time the user presses the cycle shortcut.
    modeCycleQueue = run.then(
      () => undefined,
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`MMR mode cycle failed: ${message}`, "error");
      },
    );
    await run;
  }

  function formatToggleBudget(tokens: number | undefined): string {
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) return "";
    const value = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
    return `, max out ${value}`;
  }

  async function toggleThinkingNow(ctx: ExtensionContext): Promise<void> {
    // Re-read live state inside the queued task so rapid presses toggle from
    // the latest applied level, not a snapshot captured at enqueue time. The
    // toggle is bound to an MMR-owned shortcut (not Pi's reserved thinking
    // cycle), so MMR fully controls the level and its on-screen feedback.
    const state = getMmrModeState();
    if (!state || !isToggleableMmrMode(state.mode)) {
      if (state && ctx.hasUI !== false) {
        ctx.ui.notify(
          `MMR thinking toggle is only available in smart, smartGPT, or deep (current: ${state?.mode ?? "none"}).`,
          "info",
        );
      }
      return;
    }
    const modeKey: MmrToggleableModeKey = state.mode;
    const previous = modeThinkingOverrides[modeKey];
    const next = getOtherToggleThinkingLevel(modeKey, state.thinkingLevel);
    modeThinkingOverrides[modeKey] = next;
    // notify:false keeps the toggle quiet — no full "mode activated" banner or
    // deferred-tool warnings on every press; a concise line is emitted below.
    const applied = await applyMode(modeKey, ctx, { source: "command", persist: true, notify: false });
    if (!applied || applied.mode !== modeKey || applied.thinkingLevel !== next) {
      // Re-apply did not land the toggled level (model not applied, zero active
      // tools, etc.); roll the override back so it matches the still-active state.
      if (previous === undefined) delete modeThinkingOverrides[modeKey];
      else modeThinkingOverrides[modeKey] = previous;
      if (ctx.hasUI !== false) ctx.ui.notify(`MMR thinking toggle failed for ${modeKey}.`, "error");
      return;
    }
    if (ctx.hasUI !== false) {
      ctx.ui.notify(`MMR thinking: ${modeKey} → ${next}${formatToggleBudget(applied.effectiveMaxOutputTokens)}`, "info");
    }
  }

  async function toggleThinkingFromShortcut(ctx: ExtensionContext): Promise<void> {
    const run = thinkingToggleQueue.then(() => toggleThinkingNow(ctx), () => toggleThinkingNow(ctx));
    thinkingToggleQueue = run.then(
      () => undefined,
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`MMR thinking toggle failed: ${message}`, "error");
      },
    );
    await run;
  }

  pi.registerCommand("mode", {
    description: "Show or switch MMR mode",
    getArgumentCompletions: modeCompletions,
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested || requested === "list") {
        ctx.ui.notify(`Available MMR modes:\n${formatMmrModeList()}\n\nCurrent:\n${formatMmrStatus(getMmrModeState())}`, "info");
        return;
      }

      if (!isMmrModeKey(requested)) {
        ctx.ui.notify(`Unknown MMR mode "${requested}". Available modes: ${MMR_MODE_KEYS.join(", ")}`, "error");
        return;
      }

      await applyMode(requested, ctx, { source: "command", persist: true, notify: true });
    },
  });

  pi.registerCommand("mmr-status", {
    description: "Show current MMR routing state. Pass 'debug' or '--debug' for mode-resolution detail.",
    handler: async (args, ctx) => {
      const debug = parseMmrStatusDebugFlag(args);
      ctx.ui.notify(formatMmrStatus(getMmrModeState(), { debug }), "info");
    },
  });

  pi.registerCommand("mmr-changelog", {
    description: "Show pi-mmr changelog entries",
    handler: async (_args, ctx) => {
      showMmrChangelogCommand(ctx);
    },
  });

  pi.registerCommand("mmr-config", {
    description: "Pick the model used for an MMR mode or subagent, or configure mmr-web, and persist to project settings.",
    handler: async (_args, ctx) => {
      await runMmrConfigFlow(ctx, {
        getConfiguredModelPreferences: () => configuredModelPreferences,
        getConfiguredSubagentModelPreferences: () => configuredSubagentModelPreferences,
        setConfiguredModePreferences: (mode, preferences) => {
          if (preferences) configuredModelPreferences[mode] = preferences;
          else delete configuredModelPreferences[mode];
        },
        setConfiguredSubagentPreferences: (profile, preferences) => {
          if (preferences) configuredSubagentModelPreferences[profile] = preferences;
          else delete configuredSubagentModelPreferences[profile];
        },
      });
    },
  });

  for (const shortcut of MMR_MODE_PICKER_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Select MMR mode",
      handler: async (ctx) => {
        await selectModeFromShortcut(ctx);
      },
    });
  }

  pi.registerShortcut("ctrl+space", {
    description: "Cycle MMR mode",
    handler: async (ctx) => {
      await cycleModeFromShortcut(ctx);
    },
  });

  // `alt+r` (reasoning), not `alt+t`: mmr-toolbox already defaults its
  // task-list widget toggle to `alt+t`, and Pi's loader resolves duplicate
  // extension shortcut keys as last-registered-wins, so sharing `alt+t` would
  // silently shadow one of them. `alt+r` is free across pi-mmr and is not a
  // Pi default binding.
  pi.registerShortcut("alt+r", {
    description: "Toggle MMR thinking level (smart/smartGPT/deep)",
    handler: async (ctx) => {
      await toggleThinkingFromShortcut(ctx);
    },
  });

  function captureSessionIdentity(ctx: ExtensionContext): void {
    // Read fields opportunistically: Pi's ReadonlySessionManager exposes a
    // UUID-like session id and optional session name. MMR treats sessionId as
    // the canonical Pi/MMR conversation identity for provenance (tasks,
    // handoffs, subagents, history) and does not introduce a separate threadID
    // alias. The field name mirrors Pi's `getSessionId()` accessor (camelCase).
    let sessionId: string | undefined;
    let sessionName: string | undefined;
    try { sessionId = ctx.sessionManager.getSessionId?.(); } catch { /* ignore */ }
    try { sessionName = ctx.sessionManager.getSessionName?.(); } catch { /* ignore */ }

    const identity: MmrSessionIdentity = {
      version: 1,
      cwd: ctx.cwd,
      sessionId,
      sessionName,
      source: "pi-context",
      observedAt: new Date().toISOString(),
    };

    const { changed } = setMmrSessionIdentity(identity);
    if (changed) {
      pi.events.emit(MMR_EVENT_SESSION_IDENTITY_CHANGED, getMmrSessionIdentity());
    }
  }

  const subagentActivationBindings = {
    setConfiguredSubagentModelPreferences: (preferences: Record<string, MmrModelPreference[]>) => {
      configuredSubagentModelPreferences = preferences;
    },
    setSettingsFilesRead: (files: string[]) => {
      settingsFilesRead = files;
    },
    setSettingsWarnings: (warnings: string[]) => {
      settingsWarnings = warnings;
    },
    notifyWarnings,
    setApplyingMmrMode: (value: boolean) => {
      applyingMmrMode = value;
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    captureSessionIdentity(ctx);

    const subagentFlag = pi.getFlag("mmr-subagent");
    if (typeof subagentFlag === "string" && subagentFlag.length > 0) {
      // Subagent workers run as a dedicated, non-locked execution profile.
      // Skip baseline capture, locked-mode resolution, mode persistence,
      // status footer, and Free-mode tool restoration so a child Pi process
      // honors the worker's profile-resolved policy verbatim.
      await applyMmrSubagentProfile(pi, subagentFlag, ctx, subagentActivationBindings);
      return;
    }

    // Explicitly clear any prior subagent runtime state. The mmr-core
    // runtime is a process-singleton inside the child Pi process; without
    // this reset, a previous subagent activation could leak its posture
    // into a normal session and silently disable locked-mode policy.
    setMmrSubagentState(undefined);

    await maybeShowMmrChangelogOnSessionStart(_event, ctx);

    captureBaseline(ctx, { force: true });
    await resolveInitialMode(ctx);
  });

  pi.on("before_provider_request", (event) => {
    // Optional diagnostics: when MMR_DEBUG_CAPTURE_SYSTEM_PROMPT_FILE is
    // set, write the assembled system prompt that Pi is about to send to
    // the provider to that path (subagent-only). This is intentionally
    // gated on an env var and only captures inside subagent activations
    // so production sessions never write to disk. Useful for verifying
    // the worker's assembled prompt during live smoke runs.
    const subagentState = getMmrSubagentState();
    if (subagentState) {
      const capturePath = process.env.MMR_DEBUG_CAPTURE_SYSTEM_PROMPT_FILE;
      if (capturePath && capturePath.length > 0) {
        const payload = event.payload as Record<string, unknown>;
        // Provider payloads vary by shape:
        //   - OpenAI Codex / Responses variant: `instructions` (string)
        //   - Anthropic Messages API: `system` (string)
        //   - OpenAI Responses public: the system prompt lives inside
        //     `input[]` messages, so dump the whole array as JSON.
        let captured: string | undefined;
        if (typeof payload.instructions === "string") {
          captured = payload.instructions;
        } else if (typeof payload.system === "string") {
          captured = payload.system;
        } else if (Array.isArray(payload.input)) {
          try {
            captured = JSON.stringify(payload.input, null, 2);
          } catch {
            captured = undefined;
          }
        }
        if (captured !== undefined) {
          try {
            // Synchronous write keeps the side effect bounded to this
            // handler; failure is silent because diagnostics must never
            // disturb the provider request.
            writeFileSync(capturePath, captured, { encoding: "utf8", mode: 0o600 });
          } catch {
            // ignore: diagnostics must not interfere with the request
          }
        }
      }
      // Subagent workers do not apply locked-mode policy. They may still
      // carry a profile-declared output-token cap (e.g. the hidden cthulu
      // worker at 128k), applied here as a minimal output-only policy.
      const subagentOutputPolicy = buildMmrSubagentOutputPolicy(subagentState.maxOutputTokens);
      if (subagentOutputPolicy) {
        return applyMmrRequestPolicy(event.payload, subagentOutputPolicy, { providerId: subagentState.provider });
      }
      return;
    }
    if (!activePolicy) return;
    if (getMmrManagedModelOverride()) return;
    return applyMmrRequestPolicy(event.payload, activePolicy, { providerId: getMmrModeState()?.provider });
  });

  pi.on("before_agent_start", async (event) => {
    // Subagent workers preserve Pi's base prompt (including any
    // `--append-system-prompt` content) byte-for-byte and do not apply
    // locked-mode prompt templates.
    if (getMmrSubagentState()) return;

    const state = getMmrModeState();
    if (!state || state.mode === "free") return;

    const systemPrompt = buildMmrPromptLayer({
      state,
      baseSystemPrompt: event.systemPrompt,
    });

    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });

  pi.on("tool_call", async (event) => {
    // Subagent workers rely on the profile-resolved tool allowlist applied
    // via pi.setActiveTools; Pi already gates calls against it, so mmr-core
    // does not double-gate from locked-mode state.
    if (getMmrSubagentState()) return;

    const state = getMmrModeState();
    if (!state || state.mode === "free") return;
    if (isToolAllowed(event.toolName)) return;

    return {
      block: true,
      reason: `Tool "${event.toolName}" is not enabled by current MMR mode "${state.mode}". Active tools: ${state.activeTools.join(", ") || "none"}`,
    };
  });

  pi.on("model_select", async (event, ctx) => {
    // Pi uses source:"set" both for pi.setModel(...) and picker-style model changes;
    // applyingMmrMode separates MMR transactions from native user opt-outs.
    if (applyingMmrMode || isMmrManagedModelUpdateActive() || event.source === "restore") {
      updateMmrStatus(ctx, getMmrModeState());
      return;
    }
    // Subagent workers must not trip the locked-mode native opt-out path.
    if (getMmrSubagentState()) return;

    await switchLockedModeToFreeForNativeControl(ctx, { nativeModel: event.model });
  });

  pi.on("input", async (event, ctx) => {
    // Smart-mode pre-prompt auto-compact for the Opus route. See
    // `auto-compact.ts` for the gating rules and replay-loop guard.
    const state = getMmrModeState();
    const usage = ctx.getContextUsage();
    const decision = decideAutoCompact({
      source: event.source,
      text: event.text,
      images: event.images,
      modeState: state ? { mode: state.mode, model: state.model } : undefined,
      subagentActive: Boolean(getMmrSubagentState()),
      usageTokens: usage?.tokens,
    });
    if (decision.kind === "noop") return;

    const replayContent = buildReplayContent(decision.text, decision.images);
    ctx.compact({
      onComplete: () => {
        pi.sendUserMessage(replayContent as string | { type: "text"; text: string }[]);
      },
      onError: (error) => {
        // Surface a notification when compaction fails so the user knows the
        // prompt was dropped and can resubmit. The original text is also
        // re-queued via pi.sendUserMessage so the work is not lost.
        ctx.ui.notify(
          `mmr-core: auto-compact failed (${error.message}); replaying original prompt.`,
          "warning",
        );
        pi.sendUserMessage(replayContent as string | { type: "text"; text: string }[]);
      },
    });
    return { action: "handled" };
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    // Thinking changes have no source field, so the transaction guard is the only
    // signal that a change came from MMR rather than native Pi controls.
    if (applyingMmrMode || isMmrManagedModelUpdateActive()) {
      updateMmrStatus(ctx, getMmrModeState());
      return;
    }
    if (getMmrSubagentState()) return;

    // Pi reserves the thinking-cycle key (shift+tab) and an extension cannot
    // override it, so a native thinking change releases the locked mode to Free
    // (matching native model changes). The MMR-owned alt+r shortcut is the
    // in-mode thinking toggle that does not release.
    await switchLockedModeToFreeForNativeControl(ctx, { nativeThinkingLevel: event.level });
  });
}
