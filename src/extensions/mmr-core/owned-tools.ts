/**
 * Shared registry of concrete Pi tools owned by the `pi-mmr` package.
 *
 * Two registries are tracked:
 *
 * 1. **Owned tool names** — set by sibling MMR package extensions
 *    (`mmr-toolbox`, `mmr-web`, future packages) calling
 *    `registerMmrOwnedTool(name)` next to their `pi.registerTool({...})`
 *    calls. This is the legacy/name-based view and is also used as the
 *    fallback when Pi cannot tell us the source of a tool.
 *
 * 2. **Owned extension entrypoint paths** — set by each MMR package
 *    extension entrypoint via `registerMmrOwnedExtensionPath(...)`. Pi
 *    stamps every registered tool with `sourceInfo.path` matching the
 *    extension entrypoint that registered it, so Free mode can use this
 *    set to confirm that the currently-active registration for a given
 *    tool name still belongs to `pi-mmr`. If another extension later
 *    re-registers a tool with the same name, its `sourceInfo.path` will
 *    not be in this set and Free mode will preserve it.
 *
 * Both registries are anchored on `globalThis` for the same reason as the
 * rest of `mmr-core/runtime.ts`: Pi may load package extensions with
 * isolated module caches, and a module-local Set would split the registry
 * across those caches. `globalThis` ensures `mmr-toolbox` / `mmr-web`
 * registrations are visible to the `mmr-core` instance that runs
 * `applyFreeMode`.
 */

const MMR_OWNED_TOOLS_GLOBAL_KEY = "__pi_mmr_owned_tools_v1__";
const MMR_OWNED_EXT_PATHS_GLOBAL_KEY = "__pi_mmr_owned_extension_paths_v1__";
const MMR_OWNED_TOOL_SOURCE_PATHS_BY_OWNER_GLOBAL_KEY = "__pi_mmr_owned_tool_source_paths_by_owner_v1__";

const globalStore = globalThis as typeof globalThis & {
  [MMR_OWNED_TOOLS_GLOBAL_KEY]?: Set<string>;
  [MMR_OWNED_EXT_PATHS_GLOBAL_KEY]?: Set<string>;
  [MMR_OWNED_TOOL_SOURCE_PATHS_BY_OWNER_GLOBAL_KEY]?: Map<string, Set<string>>;
};

const ownedToolNames: Set<string> = (globalStore[MMR_OWNED_TOOLS_GLOBAL_KEY] ??= new Set<string>());
const ownedExtensionPaths: Set<string> = (globalStore[MMR_OWNED_EXT_PATHS_GLOBAL_KEY] ??= new Set<string>());
const ownedToolSourcePathsByOwner: Map<string, Set<string>> = (globalStore[
  MMR_OWNED_TOOL_SOURCE_PATHS_BY_OWNER_GLOBAL_KEY
] ??= new Map<string, Set<string>>());

/**
 * Register a concrete Pi tool name as owned by the `pi-mmr` package.
 *
 * Safe to call repeatedly; the set is idempotent. Names must match the
 * exact `definition.name` passed to `pi.registerTool({...})`.
 */
export function registerMmrOwnedTool(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) return;
  ownedToolNames.add(trimmed);
}

/**
 * Register the absolute filesystem path of an MMR package extension
 * entrypoint. Each MMR extension entrypoint should call this once with
 * `fileURLToPath(import.meta.url)` so Free mode can match the path Pi
 * stamps on `ToolInfo.sourceInfo.path` for tools registered through it.
 *
 * Safe to call repeatedly; the set is idempotent. No-ops on empty input.
 */
export function registerMmrOwnedExtensionPath(absolutePath: string): void {
  const trimmed = absolutePath.trim();
  if (trimmed.length === 0) return;
  ownedExtensionPaths.add(trimmed);
}

/**
 * Snapshot of all concrete Pi tool names registered as MMR-owned.
 */
export function getMmrOwnedToolNames(): readonly string[] {
  return [...ownedToolNames];
}

/**
 * Snapshot of all MMR extension entrypoint paths registered with
 * `registerMmrOwnedExtensionPath`.
 */
export function getMmrOwnedExtensionPaths(): readonly string[] {
  return [...ownedExtensionPaths];
}

/**
 * Register an extension entrypoint `sourceInfo.path` under a named owner
 * (the canonical extension name, e.g. `"mmr-github"`). This is the generic,
 * owner-scoped counterpart to {@link registerMmrOwnedExtensionPath}: it lets
 * `mmr-core` verify that a specific tool is owned by a *specific* sibling
 * extension without importing that sibling. Owning extensions call this once
 * with `fileURLToPath(import.meta.url)`.
 *
 * Safe to call repeatedly; idempotent. No-ops on empty owner or path.
 */
export function registerMmrOwnedToolSourcePath(owner: string, absolutePath: string): void {
  const ownerKey = owner.trim();
  const trimmed = absolutePath.trim();
  if (ownerKey.length === 0 || trimmed.length === 0) return;
  let paths = ownedToolSourcePathsByOwner.get(ownerKey);
  if (paths === undefined) {
    paths = new Set<string>();
    ownedToolSourcePathsByOwner.set(ownerKey, paths);
  }
  paths.add(trimmed);
}

/**
 * Snapshot of the entrypoint source paths registered under `owner`.
 */
export function getMmrOwnedToolSourcePaths(owner: string): readonly string[] {
  const paths = ownedToolSourcePathsByOwner.get(owner.trim());
  return paths ? [...paths] : [];
}

/**
 * Fail-closed ownership check: returns `true` only when EVERY name in
 * `requiredToolNames` is present in `allTools` with a `sourceInfo.path`
 * registered under `owner` via {@link registerMmrOwnedToolSourcePath}.
 *
 * Returns `false` when the owner has no registered paths, the required list
 * is empty, a required tool is absent, its source metadata is missing, or a
 * third-party registration has taken over the name (path not in the owner
 * set). This lets `mmr-core` gate a worker on owner-specific tools without
 * importing the owning extension.
 */
export function hasOwnedToolsFromOwner(
  owner: string,
  requiredToolNames: readonly string[],
  allTools: readonly ToolInfoLike[],
): boolean {
  if (requiredToolNames.length === 0) return false;
  const ownerPaths = ownedToolSourcePathsByOwner.get(owner.trim());
  if (ownerPaths === undefined || ownerPaths.size === 0) return false;
  return requiredToolNames.every((name) => {
    const match = allTools.find((tool) => tool.name === name);
    const sourcePath = match?.sourceInfo?.path;
    if (typeof sourcePath !== "string" || sourcePath.length === 0) return false;
    return ownerPaths.has(sourcePath);
  });
}

/**
 * Returns `true` when the given concrete tool name was registered by an
 * MMR package extension.
 */
export function isMmrOwnedTool(name: string): boolean {
  return ownedToolNames.has(name);
}

/**
 * Minimal `ToolInfo`-compatible shape used by `shouldDropToolForFreeMode`.
 * We accept a structural subset so this helper stays decoupled from Pi's
 * full `ToolInfo` type and remains easy to exercise from tests.
 */
export interface ToolInfoLike {
  name: string;
  sourceInfo?: { path?: string };
}

/**
 * Decide whether Free mode should drop a given tool name from the
 * restored baseline so that Pi behaves as if `pi-mmr` were not installed.
 *
 * Behavior matrix:
 *
 * - Name not in the MMR-owned name registry → keep (never our tool).
 * - Name in registry + active registration's `sourceInfo.path` is an
 *   MMR extension path → drop (still ours).
 * - Name in registry + active registration's `sourceInfo.path` is set
 *   and not an MMR extension path → keep (a third-party extension has
 *   taken over this name; treat as not-ours).
 * - Name in registry + `sourceInfo` (or its `path`) is missing or the
 *   tool is not listed in `allTools` at all → drop (conservative
 *   fallback to the name-based behavior, so Free mode still removes
 *   tools Pi cannot describe).
 */
export function shouldDropToolForFreeMode(name: string, allTools: readonly ToolInfoLike[]): boolean {
  if (!ownedToolNames.has(name)) return false;
  const active = allTools.find((tool) => tool.name === name);
  const sourcePath = active?.sourceInfo?.path;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    // No reliable source metadata → fall back to name-based filtering.
    return true;
  }
  return ownedExtensionPaths.has(sourcePath);
}

/**
 * Test-only: clear the owner-scoped tool source-path registry. Production
 * code must not call this.
 */
export function __resetMmrOwnedToolSourcePathsForTests(): void {
  ownedToolSourcePathsByOwner.clear();
}

/**
 * Test-only: clear all registries. Production code must not call this.
 */
export function __resetMmrOwnedToolsForTests(): void {
  ownedToolNames.clear();
  ownedExtensionPaths.clear();
  ownedToolSourcePathsByOwner.clear();
}
