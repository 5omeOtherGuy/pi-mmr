export type MmrCapabilityProfileKey = "read-only" | "read-write";

export const MMR_SUBAGENT_CAPABILITY_PROFILE_KEYS: readonly MmrCapabilityProfileKey[] = [
  "read-only",
  "read-write",
] as const;

export const MMR_SUBAGENT_RECURSIVE_ADVISORY_DENY_TOOLS: readonly string[] = [
  "Task",
  "oracle",
  "librarian",
  "handoff",
  "start_task",
  "task_poll",
  "task_wait",
  "task_cancel",
] as const;

export const MMR_SUBAGENT_TOOLBOX_MCP_DENY_TOOLS: readonly string[] = [
  "apply_patch",
  "read_mcp_resource",
] as const;

export const MMR_SUBAGENT_SHARED_DENY_TOOLS: readonly string[] = [
  ...MMR_SUBAGENT_RECURSIVE_ADVISORY_DENY_TOOLS,
  ...MMR_SUBAGENT_TOOLBOX_MCP_DENY_TOOLS,
] as const;

export const MMR_SUBAGENT_MUTATION_TOOLS: readonly string[] = ["edit", "write"] as const;
export const MMR_SUBAGENT_EXECUTION_TOOLS: readonly string[] = ["bash"] as const;

export const MMR_SUBAGENT_READ_ONLY_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "web_search",
  "read_web_page",
  "read_session",
  "find_session",
  "read_github",
  "list_directory_github",
  "glob_github",
  "search_github",
  "commit_search",
  "diff_github",
  "list_repositories",
  "finder",
  "skill",
  "task_list",
] as const;

export const MMR_SUBAGENT_READ_WRITE_TOOLS: readonly string[] = [
  ...MMR_SUBAGENT_READ_ONLY_TOOLS,
  ...MMR_SUBAGENT_MUTATION_TOOLS,
] as const;

export const MMR_SUBAGENT_CUSTOM_DEFAULT_TOOLS: readonly string[] = [
  "read",
  ...MMR_SUBAGENT_EXECUTION_TOOLS,
  ...MMR_SUBAGENT_MUTATION_TOOLS,
  "find",
  "grep",
  "web_search",
  "read_web_page",
] as const;

export function isMmrCapabilityProfileKey(value: unknown): value is MmrCapabilityProfileKey {
  return typeof value === "string"
    && (MMR_SUBAGENT_CAPABILITY_PROFILE_KEYS as readonly string[]).includes(value);
}

export function resolveMmrCapabilityAllowedTools(
  key: MmrCapabilityProfileKey,
  _baseTools: readonly string[],
): readonly string[] {
  if (key === "read-write") return MMR_SUBAGENT_READ_WRITE_TOOLS;
  return MMR_SUBAGENT_READ_ONLY_TOOLS;
}
