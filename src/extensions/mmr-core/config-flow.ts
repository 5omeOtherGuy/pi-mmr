import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listMmrConfigFlowSections } from "./config-flow-registry.js";
import { getProjectMmrSettingsPath, writeMmrCoreConfigFile, type MmrConfigUpdate } from "./config-writer.js";
import { MMR_MODE_KEYS, getMmrMode, isMmrModeKey } from "./modes.js";
import { isThinkingLevel, loadMmrCoreSettings } from "./settings.js";
import { getMmrSubagentProfile, listMmrSubagentProfiles } from "./subagent-profiles.js";
import type { MmrModeKey, MmrModelPreference } from "./types.js";

const CONFIG_THINKING_LEVEL_DEFAULT = "(default)" as const;
const CONFIG_CLEAR_OVERRIDE = "(clear override – use built-in defaults)" as const;
const CONFIG_THINKING_LEVEL_CHOICES: readonly string[] = [
  CONFIG_THINKING_LEVEL_DEFAULT,
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface MmrCoreConfigFlowBindings {
  getConfiguredModelPreferences(): Partial<Record<MmrModeKey, MmrModelPreference[]>>;
  getConfiguredSubagentModelPreferences(): Record<string, MmrModelPreference[]>;
  setConfiguredModePreferences(mode: MmrModeKey, preferences: MmrModelPreference[] | undefined): void;
  setConfiguredSubagentPreferences(profile: string, preferences: MmrModelPreference[] | undefined): void;
  /** Registered Pi tool names, forwarded to the subagent setup/import wizard. */
  getAvailableTools?(): readonly string[];
}

/**
 * Re-read the persisted mode/subagent preferences from disk so the menu shows
 * what is actually saved right now, not the in-memory snapshot captured at
 * session start. Without this, an external edit to `<cwd>/.pi/settings.json`
 * (or a write earlier this session) leaves the rendered "current" values stale.
 * The on-disk shape (`MmrCoreSettings.modelPreferences` /
 * `subagentModelPreferences`) matches the bindings' return shapes, so we reuse
 * the shared loader/parsers instead of hand-parsing JSON. Falls back to the
 * in-memory bindings if the load throws.
 */
function readPersistedPreferences(
  ctx: ExtensionContext,
  bindings: MmrCoreConfigFlowBindings,
): {
  modePreferences: Partial<Record<MmrModeKey, MmrModelPreference[]>>;
  subagentPreferences: Record<string, MmrModelPreference[]>;
} {
  try {
    const { settings } = loadMmrCoreSettings(ctx.cwd);
    return {
      modePreferences: settings.modelPreferences ?? {},
      subagentPreferences: settings.subagentModelPreferences ?? {},
    };
  } catch {
    return {
      modePreferences: bindings.getConfiguredModelPreferences(),
      subagentPreferences: bindings.getConfiguredSubagentModelPreferences(),
    };
  }
}

function describeConfiguredPreferences(
  preferences: readonly MmrModelPreference[] | undefined,
  defaults: readonly MmrModelPreference[],
): string {
  const source = preferences && preferences.length > 0 ? preferences : defaults;
  if (source.length === 0) return "(none)";
  return source
    .map((preference) => {
      const providers = preference.providers && preference.providers.length > 0
        ? `${preference.providers.join(",")}/`
        : "";
      const thinking = preference.thinkingLevel ? ` thinking:${preference.thinkingLevel}` : "";
      return `${providers}${preference.model}${thinking}`;
    })
    .join(" → ");
}

function listAvailableModelChoices(ctx: ExtensionContext): { label: string; provider: string; model: string }[] {
  const candidates: { label: string; provider: string; model: string }[] = [];
  const seen = new Set<string>();
  let models: { provider?: string; id?: string }[] = [];
  try {
    models = ctx.modelRegistry.getAvailable() as { provider?: string; id?: string }[];
  } catch {
    models = [];
  }
  for (const model of models) {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string") continue;
    const label = `${model.provider}/${model.id}`;
    if (seen.has(label)) continue;
    seen.add(label);
    candidates.push({ label, provider: model.provider, model: model.id });
  }
  candidates.sort((a, b) => a.label.localeCompare(b.label));
  return candidates;
}

async function pickModelPreference(
  ctx: ExtensionContext,
  targetLabel: string,
): Promise<{ kind: "clear" } | { kind: "set"; preference: MmrModelPreference } | undefined> {
  const choices = listAvailableModelChoices(ctx);
  if (choices.length === 0) {
    ctx.ui.notify(
      "No authenticated Pi models found. Configure a provider with `pi login` (or set API keys) and try again.",
      "warning",
    );
    return undefined;
  }

  const labels = [CONFIG_CLEAR_OVERRIDE, ...choices.map((choice) => choice.label)];
  const selection = await ctx.ui.select(`Pick a model for ${targetLabel}`, labels);
  if (!selection) return undefined;
  if (selection === CONFIG_CLEAR_OVERRIDE) return { kind: "clear" };

  const matched = choices.find((choice) => choice.label === selection);
  if (!matched) return undefined;

  const thinkingChoice = await ctx.ui.select(
    `Thinking level for ${targetLabel} (optional)`,
    [...CONFIG_THINKING_LEVEL_CHOICES],
  );
  if (!thinkingChoice) return undefined;

  const preference: MmrModelPreference = {
    model: matched.model,
    providers: [matched.provider],
  };
  if (thinkingChoice !== CONFIG_THINKING_LEVEL_DEFAULT && isThinkingLevel(thinkingChoice)) {
    preference.thinkingLevel = thinkingChoice;
  }
  return { kind: "set", preference };
}

export async function runMmrConfigFlow(
  ctx: ExtensionContext,
  bindings: MmrCoreConfigFlowBindings,
): Promise<void> {
  if (ctx.hasUI === false) {
    ctx.ui.notify("`/mmr-config` requires an interactive UI.", "warning");
    return;
  }

  // Sibling extensions register their own sections (e.g. `web`, custom
  // subagents) into the core registry, so `mmr-core` dispatches without
  // importing them. Built-in `mode`/`subagent` sections stay core-owned.
  const registeredSections = listMmrConfigFlowSections();
  const targetChoice = await ctx.ui.select("MMR config: what do you want to set?", [
    "mode",
    "subagent",
    ...registeredSections.map((section) => section.label),
  ]);
  if (!targetChoice) return;

  const selectedSection = registeredSections.find((section) => section.label === targetChoice);
  if (selectedSection) {
    await selectedSection.run(
      ctx,
      bindings.getAvailableTools ? { getAvailableTools: bindings.getAvailableTools } : {},
    );
    return;
  }

  if (targetChoice === "mode") {
    // Re-read disk so the "current" values reflect external edits / prior
    // writes this session, not the startup snapshot held by the bindings.
    const configuredModelPreferences = readPersistedPreferences(ctx, bindings).modePreferences;
    const modeChoices = MMR_MODE_KEYS.filter((key) => key !== "open" && key !== "free").map((key) => {
      const defaults = getMmrMode(key).modelPreferences;
      const current = configuredModelPreferences[key];
      return `${key} — ${describeConfiguredPreferences(current, defaults)}`;
    });
    const modeSelection = await ctx.ui.select("Pick the MMR mode to configure", modeChoices);
    if (!modeSelection) return;
    const modeKey = modeSelection.split(" \u2014 ")[0] ?? modeSelection.split(" — ")[0];
    if (!isMmrModeKey(modeKey) || modeKey === "open" || modeKey === "free") return;

    const picked = await pickModelPreference(ctx, `mode "${modeKey}"`);
    if (!picked) return;

    const preferences = picked.kind === "clear" ? [] : [picked.preference];
    const update: MmrConfigUpdate = { modeModelPreferences: { mode: modeKey, preferences } };
    await writeAndApplyMmrConfig(ctx, update, () => {
      bindings.setConfiguredModePreferences(modeKey, picked.kind === "clear" ? undefined : preferences);
    }, `Run \`/mode ${modeKey}\` to re-apply with the new preference.`);
    return;
  }

  if (targetChoice === "subagent") {
    const profileNames = listMmrSubagentProfiles();
    if (profileNames.length === 0) {
      ctx.ui.notify("No subagent profiles are registered.", "warning");
      return;
    }
    // Re-read disk so the "current" values reflect external edits / prior
    // writes this session, not the startup snapshot held by the bindings.
    const configuredSubagentModelPreferences = readPersistedPreferences(ctx, bindings).subagentPreferences;
    const subagentChoices = profileNames.map((name) => {
      const profile = getMmrSubagentProfile(name);
      const defaults = profile?.modelPreferences ?? [];
      const current = configuredSubagentModelPreferences[name];
      return `${name} — ${describeConfiguredPreferences(current, defaults)}`;
    });
    const subagentSelection = await ctx.ui.select("Pick the subagent to configure", subagentChoices);
    if (!subagentSelection) return;
    const profileName = subagentSelection.split(" — ")[0];
    if (!profileName || !getMmrSubagentProfile(profileName)) return;

    const picked = await pickModelPreference(ctx, `subagent "${profileName}"`);
    if (!picked) return;

    const preferences = picked.kind === "clear" ? [] : [picked.preference];
    const update: MmrConfigUpdate = { subagentModelPreferences: { profile: profileName, preferences } };
    await writeAndApplyMmrConfig(ctx, update, () => {
      bindings.setConfiguredSubagentPreferences(profileName, picked.kind === "clear" ? undefined : preferences);
    }, "New subagent runs will pick up this preference automatically.");
  }
}

async function writeAndApplyMmrConfig(
  ctx: ExtensionContext,
  update: MmrConfigUpdate,
  updateInMemory: () => void,
  followUp: string,
): Promise<void> {
  const filePath = getProjectMmrSettingsPath(ctx.cwd);
  try {
    writeMmrCoreConfigFile(filePath, update);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to write MMR config to ${filePath}: ${message}`, "error");
    return;
  }
  updateInMemory();
  ctx.ui.notify(`Saved MMR config to ${filePath}.\n${followUp}`, "info");
}
