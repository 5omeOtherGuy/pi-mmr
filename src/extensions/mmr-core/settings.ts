import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readJsonSettingsFile } from "./internal/settings-file.js";
import { isRecord } from "./internal/json.js";
import { isMmrModeKey } from "./modes.js";
import type { MmrCoreSettings, MmrModelPreference } from "./types.js";

/**
 * Locked mode keys plus the `all` bucket accepted by `lockedModeExtraTools`.
 * `open` is native-control, not locked; it inherits Smart's resolved extras
 * when applying its Smart-equivalent tool surface instead of owning a setting
 * bucket of its own.
 */
function isLockedModeExtraToolsKey(key: string): boolean {
  return key === "all" || (isMmrModeKey(key) && key !== "open" && key !== "free");
}

function readToolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

function readLockedModeExtraTools(
  value: unknown,
  context: { filePath: string; settingPath: string; warnings: string[] },
): MmrCoreSettings["lockedModeExtraTools"] | undefined {
  if (!isRecord(value)) {
    context.warnings.push(
      `Ignoring ${context.settingPath} in ${context.filePath}: expected an object mapping locked mode keys (or "all") to arrays of tool names.`,
    );
    return undefined;
  }
  // Keys are validated against a fixed allowlist below, so prototype-polluting
  // keys ("__proto__", "constructor") never reach assignment; a plain object
  // is safe here.
  const result: Partial<Record<string, string[]>> = {};
  for (const [key, names] of Object.entries(value)) {
    if (!isLockedModeExtraToolsKey(key)) {
      context.warnings.push(
        `Ignoring ${context.settingPath}.${key} in ${context.filePath}: expected "all" or a locked mode key (smart, smartGPT, smartSonnet, rush, test, large, deep). "open" and "free" are not configurable.`,
      );
      continue;
    }
    const list = readToolNameList(names);
    if (list.length > 0) result[key] = list;
  }
  return Object.keys(result).length > 0
    ? (result as MmrCoreSettings["lockedModeExtraTools"])
    : undefined;
}

export interface LoadedMmrCoreSettings {
  settings: MmrCoreSettings;
  filesRead: string[];
  warnings: string[];
}

// Route the load path through the same hardened reader the config writers use
// (`O_NOFOLLOW`, refuses symlinked settings, refuses invalid JSON) so a
// symlinked `settings.json` is rejected on read exactly as it is on write.
// The `existsSync` pre-check is retained solely to preserve the loader's
// missing-vs-empty distinction: a truly missing file yields `{}` (no `value`)
// and is skipped (not counted in `filesRead`), while a present-but-empty `{}`
// file reads as `{ value: {} }` and is counted. Helper errors (symlink /
// invalid JSON) are wrapped into the loader's non-fatal read warning so
// loading continues for the sibling file and never throws.
function readJsonFile(filePath: string): { value?: unknown; warning?: string } {
  if (!existsSync(filePath)) return {};

  try {
    return { value: readJsonSettingsFile(filePath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: `Could not read MMR settings from ${filePath}: ${message}` };
  }
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Runtime check that an unknown value is a valid Pi `ThinkingLevel`. Exported
 * so other modules (e.g. persisted-state parsing) reuse the same allow-list
 * instead of trusting an arbitrary cast.
 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value);
}

function readThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return isThinkingLevel(value) ? value : undefined;
}

/**
 * Parse a single model-preference value (string shorthand `provider/model`
 * or `{ model, providers?, thinkingLevel? }` object) into a normalized
 * {@link MmrModelPreference}. Exported so the session-scoped subagent
 * fallback can parse env-forwarded overrides through the same normalizer
 * the settings loader uses, instead of duplicating the shape rules.
 */
export function parseMmrModelPreferenceValue(value: unknown): MmrModelPreference | undefined {
  return readModelPreference(value);
}

function readModelPreference(value: unknown): MmrModelPreference | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
      return { providers: [trimmed.slice(0, slashIndex)], model: trimmed.slice(slashIndex + 1) };
    }
    return { model: trimmed };
  }

  if (!isRecord(value) || typeof value.model !== "string") return undefined;
  const model = value.model.trim();
  if (!model) return undefined;
  const providers = Array.isArray(value.providers)
    ? value.providers.filter((provider): provider is string => typeof provider === "string").map((provider) => provider.trim()).filter(Boolean)
    : undefined;
  const thinkingLevel = readThinkingLevel(value.thinkingLevel);

  return {
    model,
    ...(providers && providers.length > 0 ? { providers } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function readModelPreferencesRecord(
  value: unknown,
  context: { filePath: string; settingPath: string; warnings: string[] },
): MmrCoreSettings["modelPreferences"] | undefined {
  if (!isRecord(value)) {
    context.warnings.push(
      `Ignoring ${context.settingPath} in ${context.filePath}: expected an object mapping mode keys to arrays of model preferences.`,
    );
    return undefined;
  }
  const result: MmrCoreSettings["modelPreferences"] = {};

  for (const [mode, preferences] of Object.entries(value)) {
    if (!isMmrModeKey(mode) || !Array.isArray(preferences)) continue;
    const normalized = preferences.map(readModelPreference).filter((preference): preference is MmrModelPreference => Boolean(preference));
    if (normalized.length > 0) result[mode] = normalized;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function readSubagentModelPreferencesRecord(
  value: unknown,
  context: { filePath: string; settingPath: string; warnings: string[] },
): MmrCoreSettings["subagentModelPreferences"] | undefined {
  if (!isRecord(value)) {
    context.warnings.push(
      `Ignoring ${context.settingPath} in ${context.filePath}: expected an object mapping subagent profile names to arrays of model preferences.`,
    );
    return undefined;
  }
  // Null-prototype destination so attacker-influenced keys ("__proto__",
  // "constructor") become own data properties instead of triggering
  // prototype setters; surface name validity is enforced at apply time
  // against the registered profile list.
  const result = Object.create(null) as Record<string, MmrModelPreference[]>;

  for (const [profile, preferences] of Object.entries(value)) {
    if (typeof profile !== "string" || profile.length === 0) continue;
    if (!Array.isArray(preferences)) continue;
    const normalized = preferences.map(readModelPreference).filter((preference): preference is MmrModelPreference => Boolean(preference));
    if (normalized.length > 0) result[profile] = normalized;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function extractMmrCoreSettings(
  value: unknown,
  context: { filePath: string; warnings: string[] },
): MmrCoreSettings | undefined {
  if (!isRecord(value)) return undefined;

  const hasMmrCore = "mmrCore" in value;
  const mmrCoreValue = (value as Record<string, unknown>).mmrCore;
  const mmrCore = isRecord(mmrCoreValue) ? mmrCoreValue : undefined;
  if (hasMmrCore && !mmrCore) {
    context.warnings.push(
      `Ignoring mmrCore in ${context.filePath}: expected an object of MMR core settings.`,
    );
  }

  const mmr = isRecord(value.mmr) ? value.mmr : undefined;
  const hasNestedCore = mmr ? "core" in mmr : false;
  const nestedCoreValue = mmr ? (mmr as Record<string, unknown>).core : undefined;
  const nestedCore = isRecord(nestedCoreValue) ? nestedCoreValue : undefined;
  if (hasNestedCore && !nestedCore) {
    context.warnings.push(
      `Ignoring mmr.core in ${context.filePath}: expected an object of MMR core settings.`,
    );
  }

  const raw = mmrCore ?? nestedCore;
  if (!raw) return undefined;

  const rootKey = mmrCore ? "mmrCore" : "mmr.core";
  const settings: MmrCoreSettings = {};
  if (typeof raw.defaultMode === "string") settings.defaultMode = raw.defaultMode;
  if (typeof raw.mode === "string") settings.defaultMode = raw.mode;

  if ("toolAliases" in raw) {
    context.warnings.push(
      `Ignoring ${rootKey}.toolAliases in ${context.filePath}: tool alias settings were removed. mmr-core resolves tools by exact Pi tool name; update modes and tool allowlists to use canonical names directly.`,
    );
  }

  if ("modelPreferences" in raw) {
    const modelPreferences = readModelPreferencesRecord(raw.modelPreferences, {
      filePath: context.filePath,
      settingPath: `${rootKey}.modelPreferences`,
      warnings: context.warnings,
    });
    if (modelPreferences) settings.modelPreferences = modelPreferences;
  }

  if ("subagentModelPreferences" in raw) {
    const subagentModelPreferences = readSubagentModelPreferencesRecord(raw.subagentModelPreferences, {
      filePath: context.filePath,
      settingPath: `${rootKey}.subagentModelPreferences`,
      warnings: context.warnings,
    });
    if (subagentModelPreferences) settings.subagentModelPreferences = subagentModelPreferences;
  }

  if ("lockedModeExtraTools" in raw) {
    const lockedModeExtraTools = readLockedModeExtraTools(raw.lockedModeExtraTools, {
      filePath: context.filePath,
      settingPath: `${rootKey}.lockedModeExtraTools`,
      warnings: context.warnings,
    });
    if (lockedModeExtraTools) settings.lockedModeExtraTools = lockedModeExtraTools;
  }

  return settings;
}

function mergeSettings(base: MmrCoreSettings, override: MmrCoreSettings): MmrCoreSettings {
  const merged: MmrCoreSettings = { ...base, ...override };

  if (base.modelPreferences || override.modelPreferences) {
    merged.modelPreferences = { ...(base.modelPreferences ?? {}), ...(override.modelPreferences ?? {}) };
  }
  if (base.subagentModelPreferences || override.subagentModelPreferences) {
    merged.subagentModelPreferences = {
      ...(base.subagentModelPreferences ?? {}),
      ...(override.subagentModelPreferences ?? {}),
    };
  }
  if (base.lockedModeExtraTools || override.lockedModeExtraTools) {
    // Additive per key: project entries extend (not replace) global entries,
    // matching the additive intent of the setting. Values are deduped.
    const mergedExtra: Partial<Record<string, string[]>> = {};
    for (const source of [base.lockedModeExtraTools, override.lockedModeExtraTools]) {
      if (!source) continue;
      for (const [key, names] of Object.entries(source)) {
        if (!names) continue;
        mergedExtra[key] = [...new Set([...(mergedExtra[key] ?? []), ...names])];
      }
    }
    merged.lockedModeExtraTools = mergedExtra as MmrCoreSettings["lockedModeExtraTools"];
  }

  return merged;
}

export function loadMmrCoreSettings(cwd: string, homeDirectory = homedir()): LoadedMmrCoreSettings {
  const files = [path.join(homeDirectory, ".pi/agent/settings.json"), path.join(cwd, ".pi/settings.json")];
  let settings: MmrCoreSettings = {};
  const filesRead: string[] = [];
  const warnings: string[] = [];

  for (const filePath of files) {
    const readResult = readJsonFile(filePath);
    if (readResult.warning) {
      warnings.push(readResult.warning);
      continue;
    }
    if (!readResult.value) continue;

    filesRead.push(filePath);
    const extracted = extractMmrCoreSettings(readResult.value, { filePath, warnings });
    if (extracted) settings = mergeSettings(settings, extracted);
  }

  return { settings, filesRead, warnings };
}
