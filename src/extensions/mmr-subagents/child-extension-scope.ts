/**
 * Child-process extension scoping for spawned subagent workers.
 *
 * Each spawned subagent (`finder`, `oracle`, `librarian`, `Task`) launches a
 * child `pi` process that, by default, performs FULL extension discovery from
 * the user's global settings — loading every extension of every configured
 * package even though a given worker only needs a few of them. Re-transpiling
 * the unneeded extension graphs dominates child startup.
 *
 * This module computes a deny-by-construction "keep set" of extension entry
 * files for the child so the runner can spawn it with
 * `--no-extensions -e <path>...`, loading only what the worker needs:
 *
 *   1. mmr-core (always) — owns the `--mmr-subagent` activation guard, the tool
 *      allowlist, model routing, and thinking policy.
 *   2. The pi-mmr extensions that own the worker's declared tools.
 *   3. EVERY other currently-loaded extension (external provider packages,
 *      unknown third-party tool/command extensions). These are kept verbatim
 *      because the parent resolves the worker's model route against its full
 *      provider set and passes `--model`; the child must keep whatever
 *      extension registers that provider or it fails with "Model not found".
 *
 * The safety posture is "only ever DROP pi-mmr extensions we positively
 * recognize as unneeded for this profile; keep everything else loaded." When
 * anything is uncertain (unknown/custom profile, empty enumeration, debug
 * capture active, unresolvable paths) the resolver returns `undefined`, which
 * the runner treats as "spawn with full discovery" — i.e. today's behavior.
 *
 * Enumeration of the parent's loaded extensions uses the public host surface
 * (`getAllTools()` + `getCommands()` `sourceInfo.path`). Extensions that
 * register neither a tool nor a command (pure hook/provider extensions) are
 * invisible to this enumeration and are therefore not re-loaded under
 * restriction; the runner's retry-on-activation-failure net recovers any route
 * that turns out to depend on such an extension.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../mmr-core/internal/json.js";

/**
 * Per-profile set of pi-mmr extension directory names the child MUST keep
 * loaded. Only built-in subagent profiles appear here; any profile not listed
 * (custom Markdown `sa__*` subagents, future profiles) resolves to `undefined`
 * and spawns with full discovery.
 *
 * Tool ownership backing each set:
 *  - finder       — tools read/grep/find are Pi built-ins; only mmr-core needed.
 *  - oracle       — read/grep/find (built-in) + web_search/read_web_page
 *                   (mmr-web) + read_session/find_session (mmr-history). mmr-
 *                   subagents is also required because read_session's model-
 *                   backed `history-reader` assembly resolves the history-reader
 *                   prompt builder registered by mmr-subagents.
 *  - librarian    — GitHub repository tools owned by mmr-github.
 *  - task-subagent— read/bash/edit/write/skill (built-in) + read_web_page/
 *                   web_search (mmr-web) + finder (mmr-subagents) + task_list
 *                   (mmr-tasks).
 */
export const MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  finder: ["mmr-core"],
  oracle: ["mmr-core", "mmr-web", "mmr-history", "mmr-subagents"],
  librarian: ["mmr-core", "mmr-github"],
  "task-subagent": ["mmr-core", "mmr-web", "mmr-subagents", "mmr-tasks"],
};

/** Minimal host surface for enumerating loaded extension source paths. */
export interface MmrChildExtensionScopeHost {
  getAllTools?: () => readonly unknown[];
  getCommands?: () => readonly unknown[];
}

/** Resolved on-disk location of the pi-mmr extension package. */
export interface MmrChildExtensionLocation {
  /** Absolute path to the pi-mmr `src/extensions` dir (parent of each extension dir). */
  extensionsDir: string;
  /** Source file extension of the loaded entry files (".ts" in source, ".js" in dist). */
  moduleExt: string;
}

function readSourcePath(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const sourceInfo = entry.sourceInfo;
  if (isRecord(sourceInfo) && typeof sourceInfo.path === "string") return sourceInfo.path;
  // Defensive: some command-info shapes may carry the path inline.
  if (typeof entry.path === "string") return entry.path;
  if (typeof entry.source === "string") return entry.source;
  return undefined;
}

/**
 * A loadable extension entry path is an absolute file path that is neither a
 * synthetic builtin marker (`<builtin:read>`) nor a skill/prompt Markdown file
 * (`.md`). Skills and prompt templates are not extensions and are loaded by
 * their own discovery subsystems, which `--no-extensions` does not disable.
 */
function isLoadableExtensionPath(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (candidate.startsWith("<")) return false;
  if (candidate.toLowerCase().endsWith(".md")) return false;
  return path.isAbsolute(candidate);
}

/**
 * Enumerate the parent's currently-loaded extension entry files from the host
 * tool/command inventory. Order is first-seen (tools before commands), deduped.
 * Returns an empty array when the host is absent or both probes throw — callers
 * treat an empty result as "cannot restrict; use full discovery."
 */
export function enumerateLoadedExtensionPaths(host: MmrChildExtensionScopeHost | undefined): string[] {
  if (!host) return [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const collect = (entries: readonly unknown[] | undefined): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const candidate = readSourcePath(entry);
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      if (isLoadableExtensionPath(candidate)) ordered.push(candidate);
    }
  };
  try {
    collect(host.getAllTools?.());
  } catch {
    /* best-effort enumeration */
  }
  try {
    collect(host.getCommands?.());
  } catch {
    /* best-effort enumeration */
  }
  return ordered;
}

/**
 * Detect whether mmr-debug request capture is active. mmr-debug registers no
 * tool or command, so it is invisible to enumeration and would be dropped under
 * restriction. When capture is configured for the child we force full discovery
 * so the child's provider requests are still captured.
 */
export function isMmrDebugCaptureActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MMR_DEBUG_CAPTURE_FILE;
  return typeof value === "string" && value.trim().length > 0;
}

/** Inputs for the pure scope resolver. */
export interface ResolveMmrChildExtensionScopeInput {
  profileName: string;
  loadedPaths: readonly string[];
  location: MmrChildExtensionLocation;
  fileExists?: (candidate: string) => boolean;
  debugCaptureActive?: boolean;
}

/**
 * Pure resolver: given the profile, the parent's loaded extension paths, and
 * the pi-mmr package location, return the ordered child keep set
 * (`["-e"-able paths]`) or `undefined` to mean "use full discovery."
 *
 * Determinism: pi-mmr keep paths come first in their declared order
 * (mmr-core first), followed by all non-pi-mmr loaded paths in first-seen
 * order. Every returned path is verified to exist on disk.
 */
export function resolveMmrChildExtensionScope(
  input: ResolveMmrChildExtensionScopeInput,
): readonly string[] | undefined {
  const keepNames = MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS[input.profileName];
  if (!keepNames) return undefined;
  if (input.debugCaptureActive) return undefined;

  const fileExists = input.fileExists ?? existsSync;
  const { extensionsDir, moduleExt } = input.location;

  const piMmrDirName = (candidate: string): string | undefined => {
    const rel = path.relative(extensionsDir, candidate);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const [first] = rel.split(path.sep);
    return first && first.length > 0 ? first : undefined;
  };

  // Canonical pi-mmr keep paths in declared order. mmr-core resolving is the
  // floor: if we cannot even resolve the keep set's entry files, bail to full
  // discovery rather than spawn a child that cannot activate.
  const piMmrKeepPaths: string[] = [];
  for (const name of keepNames) {
    const candidate = path.join(extensionsDir, name, `index${moduleExt}`);
    if (fileExists(candidate)) piMmrKeepPaths.push(candidate);
  }
  if (piMmrKeepPaths.length !== keepNames.length) return undefined;

  // Keep every loaded extension that is NOT a pi-mmr extension. pi-mmr loaded
  // paths are dropped here and re-added only through the canonical keep set
  // above, so unneeded pi-mmr extensions fall away while external/unknown
  // packages (model providers, third-party tools) are preserved verbatim.
  const externalPaths: string[] = [];
  for (const candidate of input.loadedPaths) {
    if (piMmrDirName(candidate) !== undefined) continue;
    if (!fileExists(candidate)) continue;
    externalPaths.push(candidate);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...piMmrKeepPaths, ...externalPaths]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Resolve the pi-mmr package location from this module's own URL. This module
 * lives at `<pkg>/src/extensions/mmr-subagents/child-extension-scope.<ext>`, so
 * the extensions dir is two levels up and the module extension mirrors the
 * loaded entry files (`.ts` in source, `.js` in dist).
 */
export function defaultMmrChildExtensionLocation(): MmrChildExtensionLocation {
  const here = fileURLToPath(import.meta.url);
  const moduleExt = path.extname(here) || ".ts";
  const extensionsDir = path.dirname(path.dirname(here));
  return { extensionsDir, moduleExt };
}

/** Inputs for the host-driven convenience resolver. */
export interface ComputeMmrChildExtensionScopeInput {
  profileName: string;
  host: MmrChildExtensionScopeHost | undefined;
  location?: MmrChildExtensionLocation;
  fileExists?: (candidate: string) => boolean;
  debugCaptureActive?: boolean;
}

/**
 * Convenience entry used by the tool callsites: enumerate the parent host, then
 * resolve the child keep set. Returns `undefined` (full discovery) for unknown
 * profiles, when enumeration yields nothing (no host / nothing loadable), when
 * the package location cannot be derived, or when the resolver bails. Never
 * throws.
 */
export function computeMmrChildExtensionScope(
  input: ComputeMmrChildExtensionScopeInput,
): readonly string[] | undefined {
  if (!MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS[input.profileName]) return undefined;
  let location: MmrChildExtensionLocation;
  try {
    location = input.location ?? defaultMmrChildExtensionLocation();
  } catch {
    return undefined;
  }
  const loadedPaths = enumerateLoadedExtensionPaths(input.host);
  if (loadedPaths.length === 0) return undefined;
  try {
    return resolveMmrChildExtensionScope({
      profileName: input.profileName,
      loadedPaths,
      location,
      ...(input.fileExists ? { fileExists: input.fileExists } : {}),
      debugCaptureActive: input.debugCaptureActive ?? isMmrDebugCaptureActive(),
    });
  } catch {
    return undefined;
  }
}
