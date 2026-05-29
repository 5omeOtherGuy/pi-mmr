import { parseMmrModelPreferenceValue } from "./settings.js";
import type { MmrModelPreference } from "./types.js";

/**
 * Session-scoped subagent model-preference override, forwarded from a
 * parent tool to its spawned child Pi worker through the process env.
 *
 * Issue #9: when the parent prompts the user for a worker-model fallback
 * after repeated failures, the chosen preferences must reach the child so
 * the child's activation guard resolves the SAME route the parent passed
 * via `--model`. Settings (`subagentModelPreferences`) already give parent
 * and child a shared source, but a session fallback must not be written to
 * the on-disk settings file (that would make it global/persistent). This
 * env channel mirrors the settings override mechanism for the spawn only:
 * it is read once during child activation and never persisted.
 *
 * The value is a JSON-encoded array of {@link MmrModelPreference}. The
 * runner injects it into the child's environment; child activation reads
 * it and forwards it as a `modelPreferencesOverride` to the subagent
 * resolver, taking precedence over the settings override and the profile
 * defaults.
 */
export const MMR_SUBAGENT_MODEL_PREFERENCES_ENV = "PI_MMR_SUBAGENT_MODEL_PREFERENCES";

/**
 * Serialize a model-preference list for the env channel. Returns
 * `undefined` for an empty/absent list so callers can skip injecting the
 * variable entirely (no override).
 */
export function serializeMmrSubagentModelPreferencesEnv(
  preferences: readonly MmrModelPreference[] | undefined,
): string | undefined {
  if (!preferences || preferences.length === 0) return undefined;
  return JSON.stringify(preferences);
}

/**
 * Parse the env channel back into a normalized model-preference list.
 *
 * Falls safe: returns `undefined` for missing, blank, malformed-JSON,
 * non-array, or fully-unparseable payloads so a corrupt env value can
 * never weaken the activation guard — it is simply ignored and the child
 * falls back to settings/profile resolution. Each entry is normalized
 * through {@link parseMmrModelPreferenceValue}; unparseable entries are
 * dropped.
 */
export function parseMmrSubagentModelPreferencesEnv(
  raw: string | undefined,
): MmrModelPreference[] | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded)) return undefined;

  const preferences = decoded
    .map((entry) => parseMmrModelPreferenceValue(entry))
    .filter((entry): entry is MmrModelPreference => Boolean(entry));

  return preferences.length > 0 ? preferences : undefined;
}
