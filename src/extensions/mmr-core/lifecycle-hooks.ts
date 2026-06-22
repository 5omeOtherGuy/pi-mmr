import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { maybeShowMmrChangelogOnSessionStart } from "./changelog.js";
import { buildPromptAssemblyObservation } from "./diagnostics.js";
import { isRecord } from "./internal/json.js";
import { assembleActiveSurface } from "./prompt-assembly.js";
import { applyMmrRequestPolicy, buildMmrSubagentOutputPolicy } from "./request-policy.js";
import {
  MMR_EVENT_SESSION_IDENTITY_CHANGED,
  getMmrManagedModelOverride,
  getMmrModeState,
  getMmrSessionIdentity,
  getMmrSubagentState,
  isMmrManagedModelUpdateActive,
  isToolAllowed,
  setMmrModeState,
  setMmrSessionIdentity,
  setMmrSubagentState,
} from "./runtime.js";
import { applyMmrSubagentProfile } from "./subagent-activation.js";
import { updateMmrStatus } from "./status.js";
import type { MmrModelPreference, MmrSessionIdentity } from "./types.js";
import { notifyWarnings, type MmrModeController } from "./mode-controller.js";

/**
 * Register the seven mmr-core lifecycle/event hooks against `pi`, in the exact
 * order Pi observes: `session_start`, `before_provider_request`,
 * `before_agent_start`, `tool_call`, `model_select`, `input`,
 * `thinking_level_select`. Registration order is load-bearing and pinned by the
 * registration-order characterization test. Hooks read live controller state
 * via `controller.getActivePolicy()` / `controller.isApplyingMmrMode()` (never
 * a value captured at registration time) and forward mode transitions to the
 * controller.
 */
export function registerMmrLifecycleHooks(pi: ExtensionAPI, controller: MmrModeController): void {
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
      controller.setConfiguredSubagentModelPreferences(preferences);
    },
    setSettingsFilesRead: (files: string[]) => {
      controller.setSettingsFilesRead(files);
    },
    setSettingsWarnings: (warnings: string[]) => {
      controller.setSettingsWarnings(warnings);
    },
    notifyWarnings,
    setApplyingMmrMode: (value: boolean) => {
      controller.setApplyingMmrMode(value);
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

    controller.captureBaseline(ctx, { force: true });
    await controller.resolveInitialMode(ctx);
    // Covers resume/reload/fork: if a restored active model came back with its
    // uncapped window, reassert the active mode's context cap. No-op when the
    // cap is already in effect or the mode does not cap (`free`).
    await controller.reassertActiveModelInvariants(ctx);
  });

  pi.on("before_provider_request", async (event, ctx) => {
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
      // carry a profile-declared output-token cap, applied here as a
      // minimal output-only policy.
      const subagentOutputPolicy = buildMmrSubagentOutputPolicy(subagentState.maxOutputTokens);
      if (subagentOutputPolicy) {
        return applyMmrRequestPolicy(event.payload, subagentOutputPolicy, { providerId: subagentState.provider });
      }
      return;
    }
    // Last-chance repair before Pi's post-run / overflow compaction paths read
    // `model.contextWindow`: reassert the active mode's context cap if the
    // model drifted back to its uncapped window. No-op for `free` and when the
    // cap is already in effect.
    await controller.reassertActiveModelInvariants(ctx);
    const activePolicy = controller.getActivePolicy();
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
    if (!state || state.mode === "free" || state.mode === "open") return;

    // Assemble directly (rather than via buildMmrPromptLayer) so we can read
    // the passthrough reason and reconcile the resolved active tools against
    // the tool selection Pi rendered the prompt from. `systemPromptOptions`
    // is present on the event in the supported Pi range, but feature-detect
    // it so hosts/paths that omit it degrade to no diagnostics rather than
    // throwing.
    const options = isRecord(event.systemPromptOptions) ? event.systemPromptOptions : undefined;
    // Drive built-in tool guidance from the tool selection Pi rendered the
    // prompt from (the full callable/active set) rather than the snippet-gated
    // names parsed from the rendered `Available tools:` block. Feature-detect
    // it: hosts/paths without `selectedTools` fall back to the block parse.
    const selectedTools = Array.isArray(options?.selectedTools)
      ? options.selectedTools.filter((name): name is string => typeof name === "string")
      : undefined;
    const surface = assembleActiveSurface({
      state,
      baseSystemPrompt: event.systemPrompt,
      activeToolManifest: [],
      ...(selectedTools !== undefined ? { activeToolNames: selectedTools } : {}),
    });
    // Record the runtime-only diagnostics field (never persisted). The live
    // mode state is deep-frozen, so update it through setMmrModeState with a
    // copy. Only write on a transition (something to report, or clearing a
    // prior observation) so clean turns avoid needless state churn.
    const observation = buildPromptAssemblyObservation(state, surface, options);
    if (observation !== undefined || state.promptAssembly !== undefined) {
      setMmrModeState({ ...state, promptAssembly: observation });
    }

    if (surface.systemPrompt === event.systemPrompt) return;
    return { systemPrompt: surface.systemPrompt };
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
    if (controller.isApplyingMmrMode() || isMmrManagedModelUpdateActive() || event.source === "restore") {
      updateMmrStatus(ctx, getMmrModeState());
      return;
    }
    // Subagent workers must not trip the locked-mode native opt-out path.
    if (getMmrSubagentState()) return;

    await controller.switchLockedModeToFreeForNativeControl(ctx, { nativeModel: event.model });
  });

  pi.on("input", async (_event, ctx) => {
    // Reassert the active mode's context cap before Pi runs its pre-prompt
    // compaction check, in case a provider (re)registration (e.g. `/login`)
    // transiently re-resolved the active model to its uncapped window. Native
    // Pi owns the compaction threshold, pre-prompt/post-run triggers, overflow
    // handling, footer, and `getContextUsage()` — all at the mode's capped
    // profile window. No-op for `free` and when the cap is already in effect.
    await controller.reassertActiveModelInvariants(ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    // Thinking changes have no source field, so the transaction guard is the only
    // signal that a change came from MMR rather than native Pi controls.
    if (controller.isApplyingMmrMode() || isMmrManagedModelUpdateActive()) {
      updateMmrStatus(ctx, getMmrModeState());
      return;
    }
    if (getMmrSubagentState()) return;

    // Pi reserves the thinking-cycle key (shift+tab) and an extension cannot
    // override it, so a native thinking change releases the locked mode to Free
    // (matching native model changes). The MMR-owned alt+r shortcut is the
    // in-mode thinking toggle that does not release.
    await controller.switchLockedModeToFreeForNativeControl(ctx, { nativeThinkingLevel: event.level });
  });
}
