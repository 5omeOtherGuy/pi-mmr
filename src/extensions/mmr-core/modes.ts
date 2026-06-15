import type { MmrModeDefinition, MmrModeKey } from "./types.js";
import { MMR_REQUEST_POLICIES, formatMmrPolicyContext, formatMmrPolicyThinking } from "./request-policy.js";

export const DEFAULT_MMR_MODE: MmrModeKey = "smart";

export const MMR_MODE_KEYS = ["smart", "smartGPT", "rush", "large", "deep", "free"] as const satisfies readonly MmrModeKey[];

/**
 * MMR mode table.
 *
 * Model preferences are provider-neutral and per-mode-scoped: each locked
 * mode lists its model preference order, including explicit cross-provider
 * fallback preferences where a mode has a supported OpenAI or Anthropic
 * substitute. mmr-core resolves each model ID against the local
 * Pi model registry, prefers subscription-backed provider entries (for
 * example claude-subscription or openai-codex) over API-key providers, and
 * applies provider/model aliases (see `model-resolver.ts`) so the same
 * preference resolves against either bare or date-suffixed registrations.
 *
 * Tool lists name concrete Pi tools directly. mmr-core resolves each name
 * by identity against the active Pi tool inventory and reports unavailable
 * extension-owned tools as deferred via the exact-name status catalog.
 */
export const MMR_MODES: Record<MmrModeKey, MmrModeDefinition> = {
  smart: {
    key: "smart",
    displayName: "Smart",
    description: "Balanced default mode for general coding tasks.",
    modelPreferences: [
      { model: "claude-opus-4-8" },
      { model: "gpt-5.5" },
    ],
    // Default thinking level. Smart is a toggleable mode: the MMR-owned alt+r
    // shortcut flips it between the two presets in `MMR_MODE_THINKING_TOGGLES`
    // (medium/high) without releasing the mode.
    thinkingLevel: "medium",
    tools: [
      "read",
      "bash",
      "write",
      "edit",
      "web_search",
      "read_web_page",
      "read_session",
      "find_session",
      "skill",
      "oracle",
      "librarian",
      "Task",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
      "task_list",
      "finder",
      "code_review",
      "handoff",
      "read_mcp_resource",
    ],
    promptRoute: "default",
    featureGates: ["mmr-subagents", "mmr-async-tasks"],
  },

  smartGPT: {
    key: "smartGPT",
    displayName: "SmartGPT",
    description: "Smart-style balanced mode with GPT-5.5 as its model preference. Toggleable thinking (medium/xhigh).",
    modelPreferences: [
      { model: "gpt-5.5" },
    ],
    // Default thinking level; alt+r toggles between medium and xhigh.
    thinkingLevel: "medium",
    tools: [
      "read",
      "bash",
      "write",
      "edit",
      "web_search",
      "read_web_page",
      "read_session",
      "find_session",
      "skill",
      "oracle",
      "librarian",
      "Task",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
      "task_list",
      "finder",
      "code_review",
      "handoff",
      "read_mcp_resource",
    ],
    promptRoute: "default",
    featureGates: ["mmr-subagents", "mmr-async-tasks"],
  },

  rush: {
    key: "rush",
    displayName: "Rush",
    description: "Fast, low-token GPT-5.5 mode for small, well-defined tasks.",
    modelPreferences: [
      { model: "gpt-5.5", thinkingLevel: "off" },
      { model: "claude-haiku-4-5-20251001", thinkingLevel: "off" },
      { model: "claude-haiku-4-5", thinkingLevel: "off" },
    ],
    thinkingLevel: "off",
    tools: [
      "read",
      "grep",
      "find",
      "finder",
      "bash",
      "write",
      "edit",
      "web_search",
      "read_web_page",
      "read_mcp_resource",
      "chart",
      "read_session",
      "find_session",
      "skill",
      "oracle",
      "handoff",
      "librarian",
      "Task",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
      "task_list",
    ],
    promptRoute: "rush",
    featureGates: ["mmr-subagents", "mmr-async-tasks"],
  },

  large: {
    key: "large",
    displayName: "Large",
    description: "High-capability mode for broad implementation and reasoning tasks.",
    modelPreferences: [
      { model: "claude-opus-4-6" },
      { model: "gpt-5.4" },
    ],
    thinkingLevel: "medium",
    tools: [
      "read",
      "bash",
      "write",
      "edit",
      "web_search",
      "read_web_page",
      "read_session",
      "find_session",
      "skill",
      "oracle",
      "librarian",
      "Task",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
      "task_list",
      "finder",
      "code_review",
      "handoff",
      "read_mcp_resource",
    ],
    promptRoute: "default",
    featureGates: ["mmr-subagents", "mmr-async-tasks"],
  },

  deep: {
    key: "deep",
    displayName: "Deep",
    description: "Reasoning-heavy mode for difficult investigations.",
    modelPreferences: [
      { model: "gpt-5.5" },
      { model: "claude-opus-4-8" },
    ],
    // Default thinking level; alt+r toggles between medium and xhigh.
    thinkingLevel: "medium",
    // `write` is deliberately exposed in deep alongside `apply_patch`. A narrow
    // create tool matters when an atomic patch is heavier than needed; revisit
    // when the deep tool set is hardened further.
    tools: [
      "bash",
      "apply_patch",
      "write",
      "web_search",
      "read_web_page",
      "chart",
      "skill",
      "read_session",
      "find_session",
      "librarian",
      "oracle",
      "Task",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
      "finder",
      "code_review",
      "task_list",
      "handoff",
    ],
    promptRoute: "deep",
    featureGates: ["mmr-subagents", "mmr-async-tasks", "mmr-history", "mmr-web"],
  },

  free: {
    key: "free",
    displayName: "Free",
    description: "Normal native Pi controls with no MMR model, thinking, prompt, or tool enforcement.",
    modelPreferences: [],
    tools: [],
    promptRoute: "default",
  },
};

export function isMmrModeKey(value: string): value is MmrModeKey {
  return (MMR_MODE_KEYS as readonly string[]).includes(value);
}

export function getMmrMode(key: MmrModeKey): MmrModeDefinition {
  return MMR_MODES[key];
}

export function formatMmrModeList(): string {
  return MMR_MODE_KEYS.map((key) => {
    const mode = MMR_MODES[key];
    const policy = key === "free" ? undefined : MMR_REQUEST_POLICIES[key];
    const models = mode.modelPreferences.length > 0
      ? mode.modelPreferences
        .map((preference) => preference.model)
        .join(" → ")
      : "native Pi controls";
    const policySummary = policy
      ? ` — thinking: ${formatMmrPolicyThinking(policy)}; context: ${formatMmrPolicyContext(policy)}`
      : "";
    return `${mode.key.padEnd(5)} ${models}${policySummary} — ${mode.description}`;
  }).join("\n");
}
