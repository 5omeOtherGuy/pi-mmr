import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./internal/json.js";
import type { MmrModeKey, MmrModelPreference } from "./types.js";

/**
 * Update payload accepted by `applyMmrConfigUpdate` and `writeMmrCoreConfigFile`.
 *
 * Each field, when present, sets the matching preference list for a single
 * mode key or subagent profile name. Setting `preferences: []` clears the
 * entry. Omitted fields are not touched.
 *
 * Updates are scoped to the `mmrCore` block of a Pi settings file. Other
 * top-level settings keys (e.g. `mmrWeb`) and unrelated `mmrCore` fields
 * (e.g. `defaultMode`) are preserved verbatim. The removed `toolAliases`
 * field, if present in legacy files, is preserved verbatim as a dead key
 * (mmr-core ignores it and emits a deprecation warning at load time).
 */
export interface MmrConfigUpdate {
  modeModelPreferences?: { mode: MmrModeKey; preferences: MmrModelPreference[] };
  subagentModelPreferences?: { profile: string; preferences: MmrModelPreference[] };
}

function preferencesToJson(preferences: readonly MmrModelPreference[]): unknown[] {
  return preferences.map((preference) => {
    const hasProviders = Array.isArray(preference.providers) && preference.providers.length > 0;
    if (!hasProviders && !preference.thinkingLevel) {
      return preference.model;
    }
    const out: Record<string, unknown> = { model: preference.model };
    if (hasProviders) out.providers = [...preference.providers!];
    if (preference.thinkingLevel) out.thinkingLevel = preference.thinkingLevel;
    return out;
  });
}

/**
 * Apply a `MmrConfigUpdate` to a parsed settings JSON value and return a new
 * settings object. The input is not mutated; unrelated keys are preserved.
 *
 * Both `mmrCore` and the nested `mmr.core` shape are supported. The writer
 * keeps the existing nesting style when both are absent it defaults to the
 * flat `mmrCore` block.
 */
export function applyMmrConfigUpdate(existing: unknown, update: MmrConfigUpdate): Record<string, unknown> {
  const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  const flatCoreRaw = root.mmrCore;
  const flatCore = isRecord(flatCoreRaw) ? { ...flatCoreRaw } : undefined;

  const mmrRaw = root.mmr;
  const mmrBlock = isRecord(mmrRaw) ? { ...mmrRaw } : undefined;
  const nestedCoreRaw = mmrBlock ? mmrBlock.core : undefined;
  const nestedCore = isRecord(nestedCoreRaw) ? { ...nestedCoreRaw } : undefined;

  // Prefer the layout already used in the file; default to flat mmrCore.
  const useNested = !flatCore && Boolean(nestedCore);
  const core: Record<string, unknown> = useNested
    ? nestedCore ?? {}
    : flatCore ?? (nestedCore ? { ...nestedCore } : {});

  if (update.modeModelPreferences) {
    const { mode, preferences } = update.modeModelPreferences;
    const existingModelPrefs = isRecord(core.modelPreferences) ? { ...core.modelPreferences } : {};
    if (preferences.length === 0) {
      delete existingModelPrefs[mode];
    } else {
      existingModelPrefs[mode] = preferencesToJson(preferences);
    }
    if (Object.keys(existingModelPrefs).length === 0) {
      delete core.modelPreferences;
    } else {
      core.modelPreferences = existingModelPrefs;
    }
  }

  if (update.subagentModelPreferences) {
    const { profile, preferences } = update.subagentModelPreferences;
    const existingSubPrefs = isRecord(core.subagentModelPreferences)
      ? { ...core.subagentModelPreferences }
      : {};
    if (preferences.length === 0) {
      delete existingSubPrefs[profile];
    } else {
      existingSubPrefs[profile] = preferencesToJson(preferences);
    }
    if (Object.keys(existingSubPrefs).length === 0) {
      delete core.subagentModelPreferences;
    } else {
      core.subagentModelPreferences = existingSubPrefs;
    }
  }

  if (useNested) {
    const nextMmr = { ...(mmrBlock ?? {}) };
    if (Object.keys(core).length === 0) {
      delete nextMmr.core;
    } else {
      nextMmr.core = core;
    }
    if (Object.keys(nextMmr).length === 0) {
      delete root.mmr;
    } else {
      root.mmr = nextMmr;
    }
  } else {
    if (Object.keys(core).length === 0) {
      delete root.mmrCore;
    } else {
      root.mmrCore = core;
    }
  }

  return root;
}

/**
 * Atomically rewrite a Pi settings file with the given config update applied.
 * Returns the resolved file path. Creates the parent directory if needed.
 *
 * The file is rewritten with 2-space JSON indentation; if the file did not
 * exist, only the keys touched by `update` are present.
 */
export function writeMmrCoreConfigFile(filePath: string, update: MmrConfigUpdate): string {
  let existing: unknown = {};
  // Read directly and treat a missing file as an empty object instead of
  // an existsSync()-then-read sequence, which is a file-system race: the
  // file could be created or removed between the check and the read.
  let raw: string | undefined;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw !== undefined) {
    try {
      existing = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Refusing to overwrite ${filePath}: contents are not valid JSON (${message}).`);
    }
  }

  const next = applyMmrConfigUpdate(existing, update);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
  return filePath;
}

/**
 * Project settings path for the given cwd. The MMR config command writes
 * here by default so changes are scoped to the workspace.
 */
export function getProjectMmrSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi/settings.json");
}
