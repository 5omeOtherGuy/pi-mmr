import { renderDiff, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { applyCodexPatch, type ApplyPatchFile } from "./apply-patch.js";

export const APPLY_PATCH_PARAMS = Type.Object(
  {
    patchText: Type.String({
      description: "The full patch text that describes all changes to be made",
    }),
  },
  { additionalProperties: false },
);

export type ApplyPatchParams = Static<typeof APPLY_PATCH_PARAMS>;

export const APPLY_PATCH_PROMPT_SNIPPET = "Apply a Codex-format patch to workspace files";

export const APPLY_PATCH_PROMPT_GUIDELINES = [
  "Prefer apply_patch for single-file edits and for patch-style add/delete/rename/multi-file changes. Do not use Python or shell rewrites when a simple apply_patch would suffice.",
  "Wrap every apply_patch input in `*** Begin Patch` / `*** End Patch` and use `*** Add File:` / `*** Delete File:` / `*** Update File:` (optionally with `*** Move to:`) headers.",
  "Read the file before invoking apply_patch. Include 3+ context lines per hunk, and 5-10 lines (or an `@@ class/def` anchor) for repetitive or large files so the apply_patch hunk matches exactly one location.",
  "Avoid unanchored insert-only apply_patch hunks: include a nearby context line or an `@@` header so the insertion site is unambiguous.",
  "If apply_patch fails or rejects an ambiguous hunk, do not retry blindly. Re-read the affected files, widen context or add an `@@` anchor, then re-author the hunks against the actual file contents.",
  "Redact secrets, API keys, and credentials from apply_patch hunks before submission. Patch inputs are echoed in tool results and stored in session logs.",
] as const;

export const APPLY_PATCH_DESCRIPTION = `Apply a patch to one or more files using the Codex patch format.

You MUST read the file before applying a patch to it.

Prefer apply_patch for single-file edits and for patch-style add/delete/rename/multi-file changes. Do not use Python or shell rewrites when a simple apply_patch would suffice.

## Patch Format

The patch must be wrapped in \`*** Begin Patch\` and \`*** End Patch\` markers.

Each operation starts with one of three headers:
- \`*** Add File: <path>\` - create a new file. Every following line must start with \`+\`.
- \`*** Delete File: <path>\` - remove an existing file. Nothing follows.
- \`*** Update File: <path>\` - patch an existing file (optionally with a rename via \`*** Move to:\`).

### Grammar

\`\`\`
Patch       := Begin { FileOp } End
Begin       := "*** Begin Patch" NEWLINE
End         := "*** End Patch" NEWLINE
FileOp      := AddFile | DeleteFile | UpdateFile
AddFile     := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile  := "*** Delete File: " path NEWLINE
UpdateFile  := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo      := "*** Move to: " newPath NEWLINE
Hunk        := "@@" [ " " header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine    := (" " | "-" | "+") text NEWLINE
\`\`\`

## Context Rules
- By default, show **3 lines** of unchanged code immediately above and 3 lines immediately below each change.
- Treat 3 lines as a minimum, not a target. For large files, repeated code, or any edit that could plausibly match in multiple places, prefer **5-10 lines** of unchanged context on each side.
- If a change is within the chosen context window of a previous change, do NOT duplicate the first change's context-after lines in the second change's context-before lines.
- If 3 lines of context is insufficient to uniquely identify the location, use the \`@@\` operator to indicate the class or function the snippet belongs to. For example:
  \`@@ class BaseClass\`
  [3+ lines of pre-context]
  [changes]
  [3+ lines of post-context]
- If a code block is repeated so many times that even a single \`@@\` header and 3 lines of context cannot uniquely identify it, use multiple \`@@\` statements to narrow the location:
  \`@@ class BaseClass\`
  \`@@ def method():\`
  [3+ lines of pre-context]
  [changes]
  [3+ lines of post-context]
  Each hint is a plain text substring search; matching continues on the line after the first matched anchor. A missing anchor is tolerated and falls back to body-only context matching from the carry-in cursor.

## Additional Rules
- **When editing conflict markers**, ensure their length matches the file's existing marker length (e.g., jj markers like \`<<<<<<<\`, \`%%%%%%%\`, or \`\\\\\\\\\`/longer).
- For Add File: every content line MUST start with \`+\` (which gets stripped).
- For Update File hunks: lines start with \` \` (context), \`-\` (remove), or \`+\` (add).
- Use \`*** End of File\` marker to anchor changes at end of file.
- Multiple files can be patched in a single call.
- File paths can be relative or absolute.
- Don't use apply patch for edits that an available linter or formatter could do based on the instructions in the users AGENTS.md file.
- **Ambiguous matches are rejected.** mmr-toolbox does not silently take the first match when more than one body location passes; add more context or an \`@@\` anchor to disambiguate.

## Reliability Tips (Hard Cases)
- Repeated blocks (CSS vars, test mocks, large "god" files): include a *unique* \`@@ ...\` header, and add 5-10 or more context lines until the target is unique.
- If you only read part of a file, do not guess. Read more of the file and expand the context until the hunk can match only once.
- Indentation-sensitive files (Svelte/CSS/TS): keep indentation exactly as in the file (tabs vs spaces). Do not reindent unrelated lines.
- Insert-only hunks (no \`-\` lines): avoid unanchored insert-only hunks; include a nearby unchanged context line (either via \`@@\` header or \` \` context lines) to show *where* to insert.
- Ambiguous matches are worse than verbose hunks. Prefer a longer patch over a shorter patch that could apply in multiple places.
- Whitespace drift: avoid changing internal spacing in context lines (e.g., \`get: () =>\` vs \`get:  () =>\`). Copy context lines from the file.
- CRLF files: keep line endings consistent with the file you're patching.

## Examples

### Add a new file

\`\`\`
*** Begin Patch
*** Add File: path/to/new/file.ts
+const hello = 'world'
+export { hello }
*** End Patch
\`\`\`

### Simple update with context

\`\`\`
*** Begin Patch
*** Update File: src/utils/helpers.ts
@@
 export function processData(input: string) {
   const normalized = input.trim()
   if (!normalized) {
     return 'default'
   }
-  return normalized
+  return normalized.toLowerCase()
 }

 export function formatLabel(label: string) {
   return label.toUpperCase()
 }
*** End Patch
\`\`\`

### Update a nested structure (include extra context lines to disambiguate the edit)

\`\`\`
*** Begin Patch
*** Update File: src/services/user-service.ts
@@ class UserService
   constructor(
     private readonly repo: UserRepo,
     private readonly logger: Logger,
   ) {}

   async updateUser(id: string, data: UserData) {
     const user = await this.findById(id)
-    user.name = data.name
+    user.name = data.name?.trim() || user.name
+    user.updatedAt = new Date()
     await this.save(user)
     return user
   }
 }
*** End Patch
\`\`\`

### Large or repetitive files: prefer 5+ context lines so the hunk matches only once

\`\`\`
*** Begin Patch
*** Update File: src/theme/button-tokens.ts
@@ export const buttonTokens = {
   primary: {
     background: colors.blue[500],
     foreground: colors.white,
     border: colors.blue[600],
     hoverBackground: colors.blue[600],
     activeBackground: colors.blue[700],
-    focusRing: colors.blue[300],
+    focusRing: colors.cyan[300],
     disabledBackground: colors.gray[300],
     disabledForeground: colors.gray[500],
   },
   secondary: {
*** End Patch
\`\`\`

### Use multiple @@ blocks to skip intervening code

\`\`\`
*** Begin Patch
*** Update File: src/config/settings.ts
@@
 const defaultConfig = {
   name: 'myapp',
   version: '1.0.0',
   featureFlags: {
     metrics: true,
     tracing: false,
   },
@@
   logging: {
     destination: 'stdout',
-    level: 'info',
+    level: 'debug',
     format: 'json',
     redact: ['token'],
   },
   retries: 3,
*** End Patch
\`\`\`

### Anchor a change at end of file

Use the \`*** End of File\` marker on the last hunk of an Update File when the change is at — or relative to — the file's final line. The marker anchors the hunk to EOF so a short trailing context is unambiguous even in a long file.

\`\`\`
*** Begin Patch
*** Update File: CHANGELOG.md
@@
 ## Unreleased
 
-- old trailing entry
+- new trailing entry
*** End of File
*** End Patch
\`\`\`

### Editing content within jj conflict markers

\`\`\`
*** Begin Patch
*** Update File: src/config.ts
@@
 <<<<<<< Conflict 1 of 1
 %%%%%%% Changes from base to side #1
 \\\\\\       (rebase destination)
- const API_URL = 'http://localhost:3000'
+ const API_URL = 'https://api.example.com'
 +++++++ Contents of side #2
 const API_URL = process.env.API_URL
 >>>>>>> Conflict 1 of 1 ends
*** End Patch
\`\`\`

### Delete a file

\`\`\`
*** Begin Patch
*** Delete File: src/legacy/obsolete.ts
*** End Patch
\`\`\`

### Moving/renaming a file with changes

\`\`\`
*** Begin Patch
*** Update File: src/old-name.ts
*** Move to: src/new-name.ts
@@
 export function greet(name: string) {
-  return 'Hello, ' + name
+  return \`Hello, \${name}!\`
 }
*** End Patch
\`\`\`

## Path Safety (pi-mmr)

Paths may be relative to the workspace root, or absolute paths that resolve inside the workspace
or inside any sibling worktree of the same git repository (discovered via \`git worktree list\`).
Paths that escape via \`..\` to an unrelated directory, and paths that traverse a symlink out of
every allowed root, are rejected. Errors include the current workspace, the discovered worktree
roots, and the rejected target.

All hunks are validated before any file is written; a single failing hunk leaves the workspace
untouched. A patch that would write a file beneath an ancestor that is not (and will not be) a
directory — either another file in the same patch or a pre-existing regular file on disk that
this patch does not delete — is rejected pre-flush as a path topology conflict. The path-safety
check runs before the per-file mutation lock is acquired; in the single-user CLI context this
tool is designed for, that is sufficient. A hostile concurrent process that swaps a symlink
between resolution and read could still race the workspace boundary check.
`;

interface ApplyPatchDetails {
  summary: string;
  files: ApplyPatchFile[];
}

function isApplyPatchDetails(value: unknown): value is ApplyPatchDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { summary?: unknown; files?: unknown };
  return typeof candidate.summary === "string" && Array.isArray(candidate.files);
}

function textFromToolContent(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function stripUnifiedDiffEnvelope(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => !(line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@ ")))
    .join("\n")
    .trimEnd();
}

function formatVisibleFileHeader(file: ApplyPatchFile): string {
  const stats = `(+${file.additions}/-${file.deletions})`;
  if (file.type === "move" && file.oldPath !== undefined) {
    return `${file.oldPath} -> ${file.path} ${stats}`;
  }
  return `${file.path} ${stats}`;
}

/**
 * Convert a unified diff (as stored in `details.files[].diff`) into the
 * numbered renderable diff format that Pi's built-in `edit` tool feeds into
 * `renderDiff()`. The output looks like:
 *
 *      ` 73 context line`
 *      `-75 removed line`
 *      `+75 added line`
 *      `    ...`
 *
 * with line numbers padded to a uniform width per file. Hunks are joined by
 * an `...` marker on its own line so the result mirrors `edit`'s elided
 * context style. Unified-diff envelope lines (`---`, `+++`, `@@`) and
 * `\ No newline at end of file` markers are stripped — Pi's renderable diff
 * format has no equivalent and `edit` does not display them either.
 */
export function unifiedDiffToEditRenderableDiff(diff: string): string {
  const lines = diff.split("\n");
  let maxLineNum = 1;
  for (const line of lines) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      const oldStart = Number(m[1]);
      const oldCount = m[2] ? Number(m[2]) : 1;
      const newStart = Number(m[3]);
      const newCount = m[4] ? Number(m[4]) : 1;
      maxLineNum = Math.max(maxLineNum, oldStart + Math.max(0, oldCount - 1), newStart + Math.max(0, newCount - 1));
    }
  }
  const lineNumWidth = String(maxLineNum).length;
  const padNum = (n: number) => String(n).padStart(lineNumWidth, " ");
  const padBlank = " ".repeat(lineNumWidth);

  const out: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let firstHunk = true;

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      if (!firstHunk) out.push(` ${padBlank} ...`);
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      inHunk = true;
      firstHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line === "") continue;
    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === " ") {
      out.push(` ${padNum(oldLine)} ${text}`);
      oldLine += 1;
      newLine += 1;
    } else if (prefix === "-") {
      out.push(`-${padNum(oldLine)} ${text}`);
      oldLine += 1;
    } else if (prefix === "+") {
      out.push(`+${padNum(newLine)} ${text}`);
      newLine += 1;
    }
  }

  return out.join("\n");
}

/**
 * Build the LLM-visible text returned in `content[0].text`.
 *
 * The format is a single `Applied patch: …` status line, a blank line,
 * then the structured diff body:
 *
 * - Single file: `Applied patch: <path> (+a/-d)` followed by the diff body.
 * - Multi file:  `Applied patch: N files` followed by per-file sections,
 *   each prefixed with a `<path> (+a/-d)` label so the model can tell
 *   which file each diff belongs to.
 *
 * The status line exists so API surfaces that hide `details` and show
 * only `content` give the model an unambiguous success marker, instead
 * of a bare diff body that's easy to misread as a partial tool result.
 * It is a single prefix line plus blank line, trivially stripped by any
 * downstream consumer that expects pure diff text.
 */
function formatVisiblePatchText(_summary: string, files: readonly ApplyPatchFile[]): string {
  const sections = files
    .map((file) => ({ file, body: stripUnifiedDiffEnvelope(file.diff) }))
    .filter((section) => section.body.length > 0);

  if (sections.length === 0) {
    // No diff bodies (e.g. patch produced empty diffs). Fall back to a
    // status line that still signals success without leaking the legacy
    // `Applied patch to N files:` wording.
    return files.length === 1 && files[0] !== undefined
      ? `Applied patch: ${formatVisibleFileHeader(files[0])}`
      : `Applied patch: ${files.length} files`;
  }
  if (sections.length === 1) {
    const only = sections[0]!;
    return `Applied patch: ${formatVisibleFileHeader(only.file)}\n\n${only.body}`;
  }

  const body = sections
    .map(({ file, body: section }) => `${formatVisibleFileHeader(file)}\n${section}`)
    .join("\n\n");
  return `Applied patch: ${sections.length} files\n\n${body}`;
}

export function createApplyPatchTool(): ToolDefinition {
  return {
    name: "apply_patch",
    label: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    promptSnippet: APPLY_PATCH_PROMPT_SNIPPET,
    promptGuidelines: [...APPLY_PATCH_PROMPT_GUIDELINES],
    parameters: APPLY_PATCH_PARAMS,
    // Workspace-mutating tool: force sequential scheduling so an assistant
    // turn that batches apply_patch with other tool calls runs the whole
    // batch in model order instead of racing concurrent edits.
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Errors from `applyCodexPatch` (ApplyPatchError or otherwise)
      // propagate as-is; Pi's tool runtime turns a thrown error into a
      // failed tool result, and ApplyPatchError already carries a
      // human-readable message.
      // ToolDefinition exposes execute params as unknown; Pi supplies
      // values validated against APPLY_PATCH_PARAMS before this callback.
      const applyPatchParams = params as ApplyPatchParams;
      const result = await applyCodexPatch(applyPatchParams.patchText, ctx.cwd);
      // Visible-text contract (see formatVisiblePatchText):
      // - `content[0].text` begins with one `Applied patch: …` status
      //   line, then a blank line, then a structured display diff body
      //   (context lines plus `-`/`+` lines, without `---`, `+++`, `@@`
      //   unified-diff metadata). The status line gives API surfaces that
      //   hide `details` an unambiguous success marker; the diff body
      //   keeps showing the actual changed lines instead of only a
      //   compact summary like `update: file (+1/-1)`.
      // - `details` keeps the compact summary plus structured per-file
      //   metadata (type, path, uri, additions, deletions, unified diff)
      //   for downstream UI/parser consumers. The interactive TUI
      //   `renderResult` path renders directly from `details`, so the
      //   visible status line is naturally suppressed there (the diff
      //   already renders visually).
      const visibleText = formatVisiblePatchText(result.summary, result.files);
      return {
        content: [{ type: "text", text: visibleText }],
        details: { summary: result.summary, files: result.files },
      };
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        return new Text(textFromToolContent(result.content), 1, 0);
      }
      const details = result.details;
      if (!isApplyPatchDetails(details)) {
        return new Text(textFromToolContent(result.content), 1, 0);
      }
      // Convert each per-file unified diff into Pi's edit-style renderable
      // numbered diff, then hand it to Pi's renderDiff() — the same path
      // the built-in `edit` tool uses — so apply_patch results render with
      // identical colors, intra-line highlights, and spacing. For multi-
      // file patches, prepend each section with a bold path label so the
      // user can tell which file each diff belongs to.
      const sections = details.files
        .map((file) => {
          const renderable = unifiedDiffToEditRenderableDiff(file.diff);
          if (renderable.length === 0) return "";
          let body: string;
          try {
            body = renderDiff(renderable, { filePath: file.path });
          } catch {
            // Tests/headless paths may invoke renderResult before Pi's
            // interactive theme is initialized; fall back to the raw
            // numbered diff text rather than failing to render.
            body = renderable;
          }
          if (details.files.length === 1) return body;
          let header: string;
          try {
            header = theme.fg("toolTitle", theme.bold(formatVisibleFileHeader(file)));
          } catch {
            header = formatVisibleFileHeader(file);
          }
          return `${header}\n${body}`;
        })
        .filter((section) => section.length > 0);

      if (sections.length === 0) {
        return new Text(details.summary, 1, 0);
      }
      return new Text(sections.join("\n\n"), 1, 0);
    },
  } satisfies ToolDefinition;
}
