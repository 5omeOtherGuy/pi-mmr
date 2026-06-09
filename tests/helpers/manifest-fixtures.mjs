// Fixture manifest builders for Phase B baseline tests and later phases.
//
// Each helper returns an MmrActiveToolManifestEntry derived from the live
// constants in src/. Tests import these so the baseline snapshots stay in
// sync with whatever the live tool descriptions/snippets/guidelines say,
// without copying long strings into the test file.

import { importSource } from "./load-src.mjs";

export async function applyPatchManifestEntry() {
  const mod = await importSource("extensions/mmr-patch/index.ts");
  return {
    name: "apply_patch",
    owner: "mmr-patch",
    promptSnippet: mod.APPLY_PATCH_PROMPT_SNIPPET,
    promptGuidelines: [...mod.APPLY_PATCH_PROMPT_GUIDELINES],
    description: mod.APPLY_PATCH_DESCRIPTION,
    schema: mod.APPLY_PATCH_PARAMS,
  };
}

export async function taskListManifestEntry() {
  const mod = await importSource("extensions/mmr-tasks/todo-list-tool.ts");
  return {
    name: "task_list",
    owner: "mmr-tasks",
    promptSnippet: mod.TASK_LIST_PROMPT_SNIPPET,
    promptGuidelines: [...mod.TASK_LIST_PROMPT_GUIDELINES],
    description: mod.TASK_LIST_DESCRIPTION,
    schema: mod.TASK_LIST_PARAMS,
  };
}

export async function webSearchManifestEntry() {
  const mod = await importSource("extensions/mmr-web/tools.ts");
  return {
    name: "web_search",
    owner: "mmr-web",
    promptSnippet: mod.WEB_SEARCH_PROMPT_SNIPPET,
    promptGuidelines: [...mod.WEB_SEARCH_PROMPT_GUIDELINES],
    description: mod.WEB_SEARCH_DESCRIPTION,
    schema: mod.WEB_SEARCH_PARAMETERS_SCHEMA,
  };
}

export async function readWebPageManifestEntry() {
  const mod = await importSource("extensions/mmr-web/tools.ts");
  return {
    name: "read_web_page",
    owner: "mmr-web",
    promptSnippet: mod.READ_WEB_PAGE_PROMPT_SNIPPET,
    promptGuidelines: [...mod.READ_WEB_PAGE_PROMPT_GUIDELINES],
    description: mod.READ_WEB_PAGE_DESCRIPTION,
    schema: mod.READ_WEB_PAGE_PARAMETERS_SCHEMA,
  };
}

/**
 * Build a manifest for one of the canonical Phase B tool-set combinations.
 * Active manifest order matches the order in which Pi would surface each
 * tool: patch then tasks tools first (apply_patch, task_list) then web tools
 * (web_search, read_web_page). Callers that need a different order should
 * build the manifest by hand.
 */
export async function buildBaselineManifest(toolSet) {
  const includePatchTasks = toolSet === "core+patch+tasks" || toolSet === "core+patch+tasks+web";
  const includeWeb = toolSet === "core+web" || toolSet === "core+patch+tasks+web";
  const entries = [];
  if (includePatchTasks) {
    entries.push(await applyPatchManifestEntry());
    entries.push(await taskListManifestEntry());
  }
  if (includeWeb) {
    entries.push(await webSearchManifestEntry());
    entries.push(await readWebPageManifestEntry());
  }
  return entries;
}

/**
 * Build the Pi-authored auto-section surface that would exist after Pi has
 * rebuilt the system prompt for the selected active tools. The stored base.md
 * fixture intentionally pins Pi's built-in-only prompt; matrix snapshots use
 * this helper to add active custom-tool snippets/guidelines before mmr-core
 * preserves those Pi-authored blocks byte-for-byte.
 */
export function buildBasePromptForActiveManifest(basePrompt, activeToolManifest) {
  if (activeToolManifest.length === 0) return basePrompt;

  const toolLines = activeToolManifest
    .filter((entry) => typeof entry.promptSnippet === "string" && entry.promptSnippet.trim().length > 0)
    .map((entry) => `- ${entry.name}: ${entry.promptSnippet.trim()}`);
  const guidelineLines = activeToolManifest.flatMap((entry) =>
    entry.promptGuidelines
      .map((guideline) => guideline.trim())
      .filter((guideline) => guideline.length > 0)
      .map((guideline) => `- ${guideline}`),
  );

  let prompt = basePrompt;
  if (toolLines.length > 0) {
    prompt = prompt.replace(
      "- ls: List directory contents\n\nIn addition to the tools above",
      `- ls: List directory contents\n${toolLines.join("\n")}\n\nIn addition to the tools above`,
    );
  }
  if (guidelineLines.length > 0) {
    prompt = prompt.replace(
      "- Use write only for new files or complete rewrites.\n- Be concise in your responses",
      `- Use write only for new files or complete rewrites.\n${guidelineLines.join("\n")}\n- Be concise in your responses`,
    );
  }
  return prompt;
}

export const BASELINE_TOOL_SETS = /** @type {const} */ ([
  "core-only",
  "core+patch+tasks",
  "core+web",
  "core+patch+tasks+web",
]);
