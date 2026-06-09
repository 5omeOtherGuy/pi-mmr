/**
 * Codex-format `apply_patch` implementation for mmr-patch.
 *
 * Accepts a structured patch payload wrapped in `*** Begin Patch` /
 * `*** End Patch` markers, with `*** Add File`, `*** Delete File`, and
 * `*** Update File` (optionally with `*** Move to:`) operations. Hunks use
 * `@@` headers (one or more, consecutive `@@` lines narrow scope) and
 * ` `/`-`/`+` body lines, and match by surrounding context — not by line
 * numbers.
 *
 * Path safety:
 * - Patch paths are resolved relative to `ctx.cwd`.
 * - Absolute paths are accepted if their canonical target lands inside
 *   `ctx.cwd` *or* inside any sibling worktree of the same git repository
 *   (discovered with `git worktree list --porcelain` from `ctx.cwd`).
 *   This makes apply_patch usable from a primary checkout when the user
 *   is also editing files in a sibling worktree of the same repo, while
 *   still rejecting unrelated sibling directories.
 * - Any path that resolves outside the current workspace and the
 *   discovered same-repo worktree roots (including symlink traversal) is
 *   rejected before any hunk is applied. Errors include the current
 *   workspace, the allowed worktree roots, and the rejected target.
 *
 * Concurrency and atomicity:
 * - Every file referenced by a single patch is locked through Pi's per-file
 *   mutation queue (`withFileMutationQueue`) for the full read-validate-
 *   write window. Locks are keyed by canonical realpath (with the
 *   unresolved suffix appended for files that don't exist yet) so symlink
 *   aliases collapse onto the same lock; the lock set is sorted before
 *   acquisition so that concurrent patches that touch overlapping files
 *   cannot deadlock.
 * - Repeated operations on the same file in a single patch are processed
 *   against an in-memory virtual file state, not re-read from disk per op,
 *   so later ops see earlier ops' changes.
 * - All hunks for all files are validated against the in-lock state before
 *   any write happens; a single failing hunk leaves the workspace
 *   untouched. A filesystem failure mid-write may still leave partial
 *   state — apply_patch does not implement a cross-file rollback log.
 *
 * Notable behavior:
 * - The patch format and `{ patchText: string }` schema follow the
 *   established Codex-format patch grammar so models trained to call
 *   `apply_patch` can use the tool unchanged.
 * - One deliberate stricter behavior: ambiguous body matches (more than one
 *   location in the file matches the hunk's context+remove lines) are
 *   rejected rather than silently choosing the first match. The model is
 *   forced to add more context.
 *
 * This module owns the parser and the in-memory hunk-match engine. The
 * side-effecting planning + flush phase (path safety boundary, per-file
 * locks, virtual file state, topology check, disk writes) lives in
 * `apply-patch-plan.ts` and is re-exported below to preserve the public
 * surface (`applyCodexPatch`, `ApplyPatchFile`, `ApplyPatchResult`).
 */

import { ApplyPatchError } from "./apply-patch-errors.js";
import { joinFileLines, splitFileLines } from "./apply-patch-lines.js";

export { ApplyPatchError } from "./apply-patch-errors.js";
export { applyCodexPatch, type ApplyPatchFile, type ApplyPatchResult } from "./apply-patch-plan.js";

export type CodexFileOpKind = "add" | "delete" | "update";

export interface CodexHunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

export interface CodexHunk {
  /**
   * Zero or more `@@ <hint>` anchor texts, in document order. Each hint is
   * a substring search; consecutive `@@` lines before any body lines all
   * belong to this hunk and progressively narrow the search position. A
   * missing anchor does not fail the hunk — the matcher falls back to
   * body-only context matching from the cursor.
   */
  headers: string[];
  body: CodexHunkLine[];
  /** True if the hunk ended with `*** End of File`, anchoring the match to file end. */
  endOfFile: boolean;
}

export interface CodexFileOp {
  kind: CodexFileOpKind;
  /** Path as written in the patch (with prefix/whitespace stripped). */
  rawPath: string;
  /** For `*** Update File` with `*** Move to:`. */
  movePath?: string;
  /** For `add`: the file body lines (without leading `+`). */
  addLines?: string[];
  /**
   * For `add` only: true when the patch body ended with `\ No newline at
   * end of file`, requesting that the created file have no trailing
   * newline. Defaults to `false` (the historical behavior of always
   * appending `"\n"` to a non-empty Add File body). Backwards-compatible:
   * existing producers that don't set this still get the old behavior.
   */
  addNoTrailingNewline?: boolean;
  /** For `update`: the parsed hunks. */
  hunks?: CodexHunk[];
}

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const ADD_PREFIX = "*** Add File: ";
const DELETE_PREFIX = "*** Delete File: ";
const UPDATE_PREFIX = "*** Update File: ";
const MOVE_PREFIX = "*** Move to: ";
const HUNK_HEADER = "@@";
const END_OF_FILE_MARKER = "*** End of File";
const NO_NEWLINE_BODY_MARKER = "\\ No newline at end of file";

function isFileOpStart(line: string): boolean {
  return (
    line.startsWith(ADD_PREFIX) ||
    line.startsWith(DELETE_PREFIX) ||
    line.startsWith(UPDATE_PREFIX) ||
    line === END_MARKER
  );
}

function trimPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new ApplyPatchError("Patch contains an empty file path.");
  }
  return trimmed;
}

/**
 * Parse a Codex-format patch into structured file operations.
 *
 * Strict-but-tolerant: requires the `*** Begin Patch` / `*** End Patch`
 * envelope and known file-op headers, but accepts truly blank lines inside a
 * hunk body as empty context lines (a common model behavior). Consecutive
 * `@@` lines before the first body line of a hunk are collected as scope
 * narrowing hints for the same hunk; a `@@` line that follows body lines
 * starts a new hunk.
 */
export function parseCodexPatch(patchText: string): CodexFileOp[] {
  const allLines = patchText.split("\n");
  // Trim a trailing empty line caused by a final newline so we don't treat it
  // as a body line.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  let i = 0;
  while (i < allLines.length && allLines[i]!.trim() === "") i += 1;
  if (i >= allLines.length || allLines[i]!.trim() !== BEGIN_MARKER) {
    throw new ApplyPatchError(`Patch must begin with '${BEGIN_MARKER}'.`);
  }
  i += 1;

  const ops: CodexFileOp[] = [];
  let sawEnd = false;

  while (i < allLines.length) {
    const line = allLines[i]!;
    // Tolerate trailing whitespace on the End Patch marker the same way we
    // do for Begin Patch — keep the envelope match symmetric.
    if (line.trim() === END_MARKER) {
      sawEnd = true;
      i += 1;
      break;
    }

    if (line.startsWith(ADD_PREFIX)) {
      const rawPath = trimPath(line.slice(ADD_PREFIX.length));
      i += 1;
      const addLines: string[] = [];
      let addNoTrailingNewline = false;
      while (i < allLines.length && !isFileOpStart(allLines[i]!)) {
        const bodyLine = allLines[i]!;
        if (bodyLine === NO_NEWLINE_BODY_MARKER) {
          // Must be the last line of the Add File body. The next line
          // (if any) has to be a file-op start or the End Patch marker;
          // anything else is an authoring error (a body line after the
          // marker would be ambiguous about which line lacks the newline).
          const next = allLines[i + 1];
          if (next !== undefined && !isFileOpStart(next)) {
            throw new ApplyPatchError(
              `Add File body for ${rawPath}: '${NO_NEWLINE_BODY_MARKER}' must be the last line of the body.`,
            );
          }
          if (addLines.length === 0) {
            throw new ApplyPatchError(
              `Add File body for ${rawPath}: '${NO_NEWLINE_BODY_MARKER}' requires at least one '+' body line.`,
            );
          }
          addNoTrailingNewline = true;
          i += 1;
          continue;
        }
        if (bodyLine === "") {
          addLines.push("");
        } else if (bodyLine.startsWith("+")) {
          addLines.push(bodyLine.slice(1));
        } else {
          throw new ApplyPatchError(
            `Add File body for ${rawPath} contains a line that does not start with '+': ${JSON.stringify(bodyLine)}`,
          );
        }
        i += 1;
      }
      ops.push({ kind: "add", rawPath, addLines, addNoTrailingNewline });
      continue;
    }

    if (line.startsWith(DELETE_PREFIX)) {
      const rawPath = trimPath(line.slice(DELETE_PREFIX.length));
      ops.push({ kind: "delete", rawPath });
      i += 1;
      continue;
    }

    if (line.startsWith(UPDATE_PREFIX)) {
      const rawPath = trimPath(line.slice(UPDATE_PREFIX.length));
      i += 1;
      let movePath: string | undefined;
      if (i < allLines.length && allLines[i]!.startsWith(MOVE_PREFIX)) {
        movePath = trimPath(allLines[i]!.slice(MOVE_PREFIX.length));
        i += 1;
      }

      const hunks: CodexHunk[] = [];
      while (i < allLines.length && !isFileOpStart(allLines[i]!)) {
        const cur = allLines[i]!;
        if (cur === "") {
          // Tolerate blank lines between hunks.
          i += 1;
          continue;
        }
        if (!cur.startsWith(HUNK_HEADER)) {
          throw new ApplyPatchError(
            `Update File ${rawPath}: expected '@@' hunk header or '*** ' marker, got ${JSON.stringify(cur)}`,
          );
        }

        // Collect consecutive `@@` lines as headers for this hunk. A bare
        // `@@` (empty hint) contributes nothing to `headers`; `@@ <hint>`
        // pushes the trimmed hint. Consecutive `@@` lines narrow scope by stacking
        // consecutive hint lines (e.g. `@@ class Foo` then `@@ def bar()`),
        // and they must all attach to the next body, not start new hunks.
        // The outer guard already verified `cur.startsWith(HUNK_HEADER)`,
        // so this loop is guaranteed to consume at least one header line.
        const headers: string[] = [];
        while (i < allLines.length && allLines[i]!.startsWith(HUNK_HEADER)) {
          const headerLine = allLines[i]!;
          const hint = headerLine.slice(HUNK_HEADER.length).trim();
          if (hint !== "") headers.push(hint);
          i += 1;
        }

        const body: CodexHunkLine[] = [];
        let endOfFile = false;
        while (i < allLines.length) {
          const bl = allLines[i]!;
          if (bl === END_OF_FILE_MARKER) {
            endOfFile = true;
            i += 1;
            break;
          }
          if (bl.startsWith(HUNK_HEADER) || isFileOpStart(bl)) break;
          if (bl === "") {
            body.push({ kind: "context", text: "" });
            i += 1;
            continue;
          }
          const marker = bl[0];
          if (marker === " ") body.push({ kind: "context", text: bl.slice(1) });
          else if (marker === "+") body.push({ kind: "add", text: bl.slice(1) });
          else if (marker === "-") body.push({ kind: "remove", text: bl.slice(1) });
          else {
            throw new ApplyPatchError(
              `Update File ${rawPath}: hunk body line must start with ' ', '+', or '-': ${JSON.stringify(bl)}`,
            );
          }
          i += 1;
        }

        if (body.length === 0 && !endOfFile) {
          throw new ApplyPatchError(`Update File ${rawPath}: empty hunk body.`);
        }
        hunks.push({ headers, body, endOfFile });
      }

      if (hunks.length === 0) {
        throw new ApplyPatchError(`Update File ${rawPath}: no hunks.`);
      }
      ops.push({ kind: "update", rawPath, movePath, hunks });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    throw new ApplyPatchError(`Unexpected line at ${i + 1}: ${JSON.stringify(line)}`);
  }

  if (!sawEnd) {
    throw new ApplyPatchError(`Patch missing '${END_MARKER}' terminator.`);
  }
  if (ops.length === 0) {
    throw new ApplyPatchError("Patch contains no file operations.");
  }
  return ops;
}

/**
 * Walk through the hunk's `@@` anchor hints, advancing the search cursor
 * past each anchor that's actually present in the file. A missing anchor is
 * tolerated — the cursor stays where the previous successful anchor (or
 * the carry-in cursor) left it, and body matching continues from there.
 *
 * Hunks are required to be in document order: once a previous hunk has
 * advanced the cursor past line N, no later hunk may anchor or match
 * earlier than N. If an `@@` hint fails to match forward of the carry-in
 * `cursor` *but does* match somewhere strictly before it, that is a
 * deterministic out-of-order signal and we throw rather than silently
 * skip the anchor (which would cause a body-only match elsewhere or a
 * non-obvious "context did not match" failure). Authors who genuinely
 * want backwards edits should reorder their hunks.
 */
function applyHeaderAnchors(
  lines: readonly string[],
  cursor: number,
  headers: readonly string[],
  filePath: string,
): { cursor: number; anchored: boolean } {
  let pos = cursor;
  let anchored = false;
  for (const hint of headers) {
    let found = -1;
    for (let i = pos; i < lines.length; i += 1) {
      if (lines[i]!.includes(hint)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      // Per the documented anchor semantics, matching/applying continues *after* the anchor
      // line — the anchor is a scope marker, not part of the body.
      pos = found + 1;
      anchored = true;
      continue;
    }
    // Forward search failed. If the hint exists strictly before the
    // carry-in cursor (i.e. inside a region a previous hunk has already
    // advanced past), this hunk is out of document order. Reject loudly.
    if (cursor > 0) {
      for (let i = 0; i < cursor; i += 1) {
        if (lines[i]!.includes(hint)) {
          throw new ApplyPatchError(
            `Hunk in ${filePath}: '@@ ${hint}' anchor only matches before a previously applied hunk; hunks must be in document order.`,
          );
        }
      }
    }
  }
  return { cursor: pos, anchored };
}

/**
 * Find the unique location in `lines` (starting at `searchFrom`) where
 * `before` matches consecutively. Throws on zero or multiple matches.
 *
 * - If `endOfFile` is true, the match must end at the last line of the file.
 * - If `before` is empty (insert-only hunk):
 *   - `endOfFile` → insert at end of file.
 *   - `anchored` → insert at `searchFrom` (the position right after the
 *     anchor line that was matched).
 *   - otherwise → reject as ambiguous.
 */
function locateHunkMatch(
  lines: readonly string[],
  before: readonly string[],
  searchFrom: number,
  endOfFile: boolean,
  anchored: boolean,
  filePath: string,
): number {
  if (before.length === 0) {
    if (endOfFile) return lines.length;
    if (anchored) return searchFrom;
    throw new ApplyPatchError(
      `Hunk in ${filePath} has no context or remove lines; add unchanged context or an @@ anchor to locate the change.`,
    );
  }

  const matches: number[] = [];
  const last = lines.length - before.length;
  for (let i = searchFrom; i <= last; i += 1) {
    let ok = true;
    for (let j = 0; j < before.length; j += 1) {
      if (lines[i + j] !== before[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (endOfFile && i + before.length !== lines.length) continue;
      matches.push(i);
    }
  }

  if (matches.length === 0) {
    throw new ApplyPatchError(
      `Hunk context did not match in ${filePath}. Expected to find:\n${before.join("\n")}`,
    );
  }
  if (matches.length > 1) {
    throw new ApplyPatchError(
      `Hunk context matched ${matches.length} locations in ${filePath}; add more context or an @@ anchor to disambiguate.`,
    );
  }
  return matches[0]!;
}

export function applyHunksToContent(filePath: string, original: string, hunks: readonly CodexHunk[]): string {
  const { lines: originalLines, trailingNewline } = splitFileLines(original);
  let working = originalLines.slice();
  let cursor = 0;

  for (const hunk of hunks) {
    const before: string[] = [];
    const after: string[] = [];
    for (const entry of hunk.body) {
      if (entry.kind === "context") {
        before.push(entry.text);
        after.push(entry.text);
      } else if (entry.kind === "remove") {
        before.push(entry.text);
      } else {
        after.push(entry.text);
      }
    }

    const { cursor: anchorCursor, anchored } = applyHeaderAnchors(working, cursor, hunk.headers, filePath);
    const matchIndex = locateHunkMatch(working, before, anchorCursor, hunk.endOfFile, anchored, filePath);
    working = working.slice(0, matchIndex).concat(after, working.slice(matchIndex + before.length));
    cursor = matchIndex + after.length;
  }

  // Preserve the original trailing-newline behavior. For empty originals
  // (only reachable here from a virtual state that was just emptied), keep
  // a trailing newline iff the resulting body is non-empty.
  //
  // Pinned edge case: if the original file ended with a newline and the
  // hunks remove every line, the result is `"\n"` (one blank line), not
  // `""`. Callers that want a truly empty file should use `*** Delete
  // File` rather than relying on Update File to collapse to empty. The
  // parser-level test exercising this is
  // `applyHunksToContent: removing every line of a file with a trailing
  // newline yields a single blank line, not an empty file` in
  // tests/mmr-patch-apply-patch.test.mjs.
  const finalTrailing = original === "" ? working.length > 0 : trailingNewline;
  return joinFileLines(working, finalTrailing);
}
