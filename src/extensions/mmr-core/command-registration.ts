import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runMmrConfigFlow } from "./config-flow.js";
import { formatMmrModeList, isMmrModeKey, MMR_MODE_KEYS } from "./modes.js";
import { getMmrModeHistory, getMmrModeState } from "./runtime.js";
import { showMmrChangelogCommand } from "./changelog.js";
import { formatMmrStatus } from "./status.js";
import type { MmrModeController } from "./mode-controller.js";

const MMR_MODE_PICKER_SHORTCUTS = ["ctrl+shift+s", "alt+m"] as const;

function modeCompletions(prefix: string) {
  return MMR_MODE_KEYS.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode }));
}

function parseMmrStatusDebugFlag(args: unknown): boolean {
  if (typeof args !== "string") return false;
  return args
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .some((token) => token === "debug" || token === "--debug");
}

/**
 * Register the MMR commands (`/mode`, `/mmr-status`, `/mmr-changelog`,
 * `/mmr-config`) followed by the four mode shortcuts (mode-picker pair,
 * `ctrl+space` cycle, `alt+r` thinking toggle). Registration order is
 * load-bearing and verified by the registration-order characterization test;
 * keep commands-before-shortcuts and the picker→cycle→toggle sequence intact.
 * Every handler body delegates to the controller.
 */
export function registerMmrCommands(pi: ExtensionAPI, controller: MmrModeController): void {
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

      await controller.applyMode(requested, ctx, { source: "command", persist: true, notify: true });
    },
  });

  pi.registerCommand("mmr-status", {
    description: "Show current MMR locked-mode status. Pass 'debug' or '--debug' for model/tool resolution detail.",
    handler: async (args, ctx) => {
      const debug = parseMmrStatusDebugFlag(args);
      ctx.ui.notify(formatMmrStatus(getMmrModeState(), { debug, modeHistory: debug ? getMmrModeHistory() : undefined }), "info");
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
        getConfiguredModelPreferences: () => controller.getConfiguredModelPreferences(),
        getConfiguredSubagentModelPreferences: () => controller.getConfiguredSubagentModelPreferences(),
        setConfiguredModePreferences: (mode, preferences) => {
          controller.setConfiguredModePreferences(mode, preferences);
        },
        setConfiguredSubagentPreferences: (profile, preferences) => {
          controller.setConfiguredSubagentPreferences(profile, preferences);
        },
        getAvailableTools: () => pi.getAllTools().map((tool) => tool.name),
      });
    },
  });

  for (const shortcut of MMR_MODE_PICKER_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Select MMR mode",
      handler: async (ctx) => {
        await controller.selectModeFromShortcut(ctx);
      },
    });
  }

  pi.registerShortcut("ctrl+space", {
    description: "Cycle MMR mode",
    handler: async (ctx) => {
      await controller.cycleModeFromShortcut(ctx);
    },
  });

  // `alt+r` (reasoning), not `alt+t`: mmr-toolbox already defaults its
  // task-list widget toggle to `alt+t`, and Pi's loader resolves duplicate
  // extension shortcut keys as last-registered-wins, so sharing `alt+t` would
  // silently shadow one of them. `alt+r` is free across pi-mmr and is not a
  // Pi default binding.
  pi.registerShortcut("alt+r", {
    description: "Toggle MMR thinking level (smart/smartGPT/smartSonnet/smartFable/deep)",
    handler: async (ctx) => {
      await controller.toggleThinkingFromShortcut(ctx);
    },
  });
}
