/**
 * Source-path ownership registry for the `mmr-github` tools.
 *
 * Mirrors `mmr-web/tool-ownership.ts`: the extension entrypoint records its
 * `sourceInfo.path` here so consumers (the `librarian` gating in
 * `mmr-subagents` and child-process activation in `mmr-core`) can confirm
 * that the live registration for a GitHub tool name still belongs to
 * `mmr-github` by source path, not just by name. A third-party extension that
 * later re-registers any of these names is therefore preserved and never
 * satisfies the librarian gate.
 *
 * Registration also mirrors each source path into `mmr-core`'s generic
 * owner-scoped registry under the `"mmr-github"` owner, so child-process
 * subagent activation can gate `librarian` on `mmr-github`-owned repo tools
 * without `mmr-core` importing this module.
 */

import { registerMmrOwnedToolSourcePath } from "../mmr-core/owned-tools.js";

/** Canonical owner key used in `mmr-core`'s owner-scoped tool registry. */
export const MMR_GITHUB_TOOL_OWNER = "mmr-github";

const MMR_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY = "__pi_mmr_github_tool_source_paths_v1__";

const globalStore = globalThis as typeof globalThis & {
  [MMR_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY]?: Set<string>;
};

const toolSourcePaths: Set<string> = (globalStore[MMR_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY] ??= new Set<string>());

export const MMR_GITHUB_TOOL_NAMES = [
  "read_github",
  "list_directory_github",
  "glob_github",
  "search_github",
  "commit_search",
  "diff_github",
  "list_repositories",
] as const;
export type MmrGithubToolName = typeof MMR_GITHUB_TOOL_NAMES[number];

export interface MmrGithubToolInfoLike {
  name: string;
  sourceInfo?: { path?: string };
}

export function registerMmrGithubToolSourcePath(absolutePath: string): void {
  const trimmed = absolutePath.trim();
  if (trimmed.length === 0) return;
  toolSourcePaths.add(trimmed);
  registerMmrOwnedToolSourcePath(MMR_GITHUB_TOOL_OWNER, trimmed);
}

export function getMmrGithubToolSourcePaths(): readonly string[] {
  return [...toolSourcePaths];
}

export function isMmrGithubToolName(name: string): name is MmrGithubToolName {
  return (MMR_GITHUB_TOOL_NAMES as readonly string[]).includes(name);
}

export function isMmrGithubOwnedToolInfo(tool: MmrGithubToolInfoLike, expectedName?: MmrGithubToolName): boolean {
  if (expectedName !== undefined && tool.name !== expectedName) return false;
  if (!isMmrGithubToolName(tool.name)) return false;
  const sourcePath = tool.sourceInfo?.path;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return false;
  return toolSourcePaths.has(sourcePath);
}

export function hasMmrGithubOwnedTools(
  allTools: readonly MmrGithubToolInfoLike[],
  requiredTools: readonly MmrGithubToolName[] = MMR_GITHUB_TOOL_NAMES,
): boolean {
  return requiredTools.every((name) => allTools.some((tool) => isMmrGithubOwnedToolInfo(tool, name)));
}

export function __resetMmrGithubToolSourcePathsForTests(): void {
  toolSourcePaths.clear();
}
