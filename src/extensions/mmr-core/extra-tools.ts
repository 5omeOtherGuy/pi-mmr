/**
 * Locked-mode "extra tools" support.
 *
 * Locked modes ship a fixed, exact-name tool allowlist (see `modes.ts`). The
 * `mmrCore.lockedModeExtraTools` setting lets a user keep additional concrete
 * Pi tools (their own extension tools, third-party tools, or MCP tools)
 * callable while a locked mode is active, without releasing to Free mode.
 *
 * Design invariants (mirrors the additive, exact-name posture of per-mode
 * `modelPreferences`):
 *
 * - Exact-name only. No aliases, no source/path globbing, no wildcards.
 * - Additive. Extras extend a mode's allowlist; they never replace it.
 * - Fail-closed preserved. Extras are resolved and merged *after* the base
 *   mode resolution, so they never satisfy the zero-active-tools activation
 *   abort, and a missing extra is a non-fatal no-op surfaced in status.
 * - Owner-neutral. Extras are not added to the default tool catalog; an extra
 *   that falls through to the core owner is relabeled `user-allowlist` for
 *   diagnostics, while provider/catalog-owned names keep their owner.
 */

import { CORE_OWNER } from "./tool-registry.js";
import type { MmrCoreSettings, MmrLockedModeKey, MmrToolDecision, MmrToolResolution } from "./types.js";

/** Diagnostic owner credited to extra tools that resolve via plain identity. */
export const USER_ALLOWLIST_OWNER = "user-allowlist";

/**
 * Reserved tool-name prefix for managed custom Markdown subagents. These tools
 * are exposed to locked modes *exclusively* through the scoped mode-extra-tool
 * provider (which enforces each subagent's per-mode/per-project record scope).
 * They must never be enabled through the user-controlled
 * `mmrCore.lockedModeExtraTools` setting, which has no mode/project scope of
 * its own — allowing it would let a global `sa__*` entry leak a subagent into
 * a mode/project its record does not permit.
 */
export const MMR_RESERVED_SUBAGENT_TOOL_PREFIX = "sa__";

/**
 * Drop any reserved `sa__*` names from a user-controlled extra-tool list. The
 * `mmrCore.lockedModeExtraTools` setting has no per-mode/per-project scope of
 * its own, so it must never be a second path to enable a managed custom
 * subagent; those are exposed only through the scope-aware mode-extra-tool
 * provider.
 */
export function excludeReservedSubagentNames(names: readonly string[]): string[] {
  return names.filter((name) => !name.startsWith(MMR_RESERVED_SUBAGENT_TOOL_PREFIX));
}

/**
 * Compute the ordered, deduped extra tool names for a locked mode.
 *
 * Combines the `all` bucket with the per-mode bucket and drops any name that
 * is already part of the mode's base allowlist (so it is never requested or
 * resolved twice).
 */
export function selectExtraToolNames(
  modeKey: MmrLockedModeKey,
  extras: MmrCoreSettings["lockedModeExtraTools"] | undefined,
  baseToolNames: readonly string[],
): string[] {
  if (!extras) return [];
  const base = new Set(baseToolNames);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of [...(extras.all ?? []), ...(extras[modeKey] ?? [])]) {
    const trimmed = name.trim();
    if (trimmed.length === 0 || base.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Relabel extra-tool decisions that fell through to the core owner so status
 * surfaces them as user-provided rather than as `mmr-core` tools.
 */
export function relabelExtraOwners(resolution: MmrToolResolution): MmrToolResolution {
  const decisions = resolution.decisions.map((decision): MmrToolDecision =>
    decision.owner === CORE_OWNER ? { ...decision, owner: USER_ALLOWLIST_OWNER } : decision,
  );
  return { ...resolution, decisions };
}

function uniqueConcat(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Merge an extra-tool resolution into the base mode resolution. Buckets are
 * concatenated and deduped; decisions are appended in order (base first).
 */
export function mergeToolResolutions(
  base: MmrToolResolution,
  extra: MmrToolResolution,
): MmrToolResolution {
  return {
    requestedTools: uniqueConcat(base.requestedTools, extra.requestedTools),
    activeTools: uniqueConcat(base.activeTools, extra.activeTools),
    missingTools: uniqueConcat(base.missingTools, extra.missingTools),
    deferredTools: uniqueConcat(base.deferredTools, extra.deferredTools),
    gatedTools: uniqueConcat(base.gatedTools, extra.gatedTools),
    disabledTools: uniqueConcat(base.disabledTools, extra.disabledTools),
    decisions: [...base.decisions, ...extra.decisions],
  };
}
