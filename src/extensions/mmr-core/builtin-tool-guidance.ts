/**
 * Built-in tool guidance.
 *
 * Pi's auto-emitted `Guidelines:` block is concise; many high-signal
 * "how to use this tool well" rules from comparable agents are missing.
 * pi-mmr supplements that by inserting a `## Built-in tool guidance`
 * block immediately after Pi's `Guidelines:` block, scoped to whichever
 * built-in tools are currently listed in Pi's `Available tools:` block.
 *
 * Pi's `Available tools:` and `Guidelines:` blocks remain byte-identical;
 * this module only adds an MMR-owned augmentation block that names every
 * bullet's tool explicitly so the model knows what each bullet steers.
 *
 * Guidance bullets are curated for Pi's built-in tool contracts. Bullets
 * are included only when they match Pi-native tool shape: parameter names,
 * defaults, path conventions, and available capabilities.
 */

/**
 * Built-in tool names that have curated guidance. The array doubles as
 * the stable emission order for `buildBuiltinToolGuidance` and the
 * compile-time key set for `BUILTIN_TOOL_GUIDANCE_BULLETS`, so adding or
 * removing an entry is caught by `tsc` everywhere this module is consumed.
 */
const BUILTIN_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find"] as const;
type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

const BUILTIN_TOOL_GUIDANCE_BULLETS: Record<BuiltinToolName, readonly string[]> = {
  bash: [
    "Do NOT chain commands with `;` or `&&` or use `&` for background processes; make separate tool calls instead.",
    "Do NOT emit dependent or stateful `bash` calls (e.g. git checkout/commit/push/PR-create, install/build/test/release) as parallel sibling tool calls in one assistant turn; the runtime may run siblings concurrently, so order them as separate sequential steps.",
    "Do NOT use interactive commands (REPLs, editors, password prompts).",
    "Environment variables and `cd` do not persist between commands; make separate tool calls instead.",
    "On Windows, use PowerShell commands and `\\` path separators.",
    "ALWAYS quote file paths: `cat \"path with spaces/file.txt\"`.",
    "When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)",
    "Do NOT run `find` (or any recursive search) from `/`, `~`, or another large unrelated root; scope it to the workspace or a specific directory you have reason to search, otherwise it will be extremely slow and waste tokens.",
    "When using `find` or `grep -r`, exclude heavy directories like `node_modules`, `.git`, `dist`, `build`, and `target` (`rg` already skips these via gitignore).",
    "Do NOT pipe `cat file | grep/awk/sed/...`; pass the file directly to the command (e.g. `grep pattern file`).",
    "When using `grep`, pass `-E` (or use `egrep`) to enable extended regular expressions; `rg` uses extended regex by default.",
    "Only run `git commit` and `git push` if explicitly instructed by the user.",
  ],
  read: [
    "Use grep to find specific content in large files or files with long lines.",
    "If you are unsure of the correct file path, use find to look up filenames by glob pattern.",
    "This tool can read images (such as PNG, JPEG, and GIF files) and present them to the model visually.",
    "When possible, call this tool in parallel for all files you will want to read.",
    "Avoid tiny repeated slices (e.g., 50-line chunks). If you need more context from the same file, read a larger range or the full default window instead.",
  ],
  edit: [
    "`edits[].oldText` MUST exist in the file. Use read to understand the files you are editing before changing them.",
    "`edits[].oldText` and `edits[].newText` MUST be different from each other.",
    "`edits[].oldText` MUST be unique within the file or the edit will fail. Additional lines of context can be added to make the string more unique.",
    "Each `edits[]` item has exactly two keys, `oldText` and `newText`. The schema rejects unknown keys, so never add annotation/comment keys (`newText_comment`, `_unused`, `_x`) or numbered variants (`oldText2`); use separate `edits[]` items instead.",
    "If an edit call fails before applying changes with empty arguments or missing required fields, do not retry the identical call; re-read the file, rebuild the input, or switch tools.",
    "Prefer write or bash heredoc for large, whole-file, or escape-dense replacements; reserve edit for small targeted replacements.",
    "If you need to replace the entire contents of a file, use write instead, since it requires fewer tokens for the same action.",
  ],
  write: [
    "Use this tool to create a new file that does not yet exist.",
    "For existing files, prefer `edit` instead—even for extensive changes. Only use write to overwrite an existing file when you are replacing nearly all of its content AND the file is small (under ~250 lines).",
  ],
  grep: [
    "Scope with `path` first; add `glob` when file type matters.",
    "Prefer several focused searches over one repo-wide scan.",
    "Use `literal: true` for exact text; keep regex for patterns.",
  ],
  find: [
    "Use find to find files by name patterns across your codebase. Results are returned in ripgrep's traversal order, not by modification time.",
  ],
};

export const MMR_BUILTIN_TOOL_GUIDANCE_HEADING = "## Built-in tool guidance";

/** Built-in tool names that have curated guidance, in stable emission order. */
export function listBuiltinToolGuidanceTools(): readonly string[] {
  return BUILTIN_TOOL_NAMES;
}

/**
 * Render the `## Built-in tool guidance` block restricted to the given
 * active tool names. Returns `null` when no covered tool is active so the
 * caller can skip emitting an empty block.
 *
 * Tools are emitted in the order they appear in `BUILTIN_TOOL_GUIDANCE_BULLETS`,
 * not in `activeToolNames` order, so the block is stable across callers.
 */
export function buildBuiltinToolGuidance(
  activeToolNames: readonly string[],
): string | null {
  const active = new Set(activeToolNames);
  const groups: string[] = [];
  for (const name of BUILTIN_TOOL_NAMES) {
    if (!active.has(name)) continue;
    const bullets = BUILTIN_TOOL_GUIDANCE_BULLETS[name];
    const body = bullets.map((b) => `- ${b}`).join("\n");
    groups.push(`${name}:\n${body}`);
  }
  if (groups.length === 0) return null;
  return `${MMR_BUILTIN_TOOL_GUIDANCE_HEADING}\n\n${groups.join("\n\n")}`;
}

/**
 * Extract Pi-built-in tool names that appear in a Pi-authored
 * `Available tools:` block body. Returns the subset that has curated
 * guidance; other names (custom tools registered by other extensions,
 * unrecognized lines) are ignored.
 */
export function extractActiveBuiltinToolNames(
  availableToolsBlock: string,
): string[] {
  const known: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);
  const found: string[] = [];
  // Pi-authored `Available tools:` lines have the shape `- <name>: <desc>`,
  // and Pi's built-in tool identifiers are lowercase snake_case by
  // convention. The lowercase-only character class is intentional: it
  // mirrors current Pi output and the `known` set below filters out
  // anything outside the curated guidance map anyway.
  for (const line of availableToolsBlock.split("\n")) {
    const m = /^- ([a-z_][a-z0-9_]*):/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (known.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}
