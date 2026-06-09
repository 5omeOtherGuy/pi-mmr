import { splitFileLines } from "./apply-patch-lines.js";

/**
 * Compact line-LCS used to derive a unified diff for the structured
 * `details.files[].diff` field. Walks back the LCS table to produce a
 * sequence of equal/add/remove operations and groups consecutive
 * non-equal ops into hunks with up to `context` lines of unchanged
 * context on each side.
 *
 * This is intentionally not a full Myers diff — patches in practice
 * touch a handful of lines per file, so an O(N*M) LCS is fine and the
 * implementation footprint stays tiny. Above `MAX_LCS_CELLS` cells the
 * caller falls back to a coarse "full rewrite" representation rather than
 * allocating a multi-hundred-MB DP table; see `computeUnifiedDiff`.
 */
interface DiffOp { kind: "equal" | "add" | "remove"; lines: string[] }

/**
 * Cap on the line-LCS DP table size, in cells (each cell is a JS number,
 * ~8 bytes when V8 stores the row as a packed-double array). 4M cells
 * ≈ 32 MB worst-case allocation, comfortably handles updates of files
 * up to ~2000 × 2000 lines on either side. Above this threshold,
 * `computeUnifiedDiff` returns a coarse "diff omitted" representation
 * with conservative full-rewrite additions/deletions so the structured
 * summary still surfaces the change without OOM-ing the agent.
 */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Sentinel suffix appended to a logical-line representation of the last
 * line of a content snapshot when that snapshot does not end with a
 * newline. The sentinel makes the LCS treat `"foo"` (no trailing
 * newline) and `"foo"` (with trailing newline) as distinct lines, so a
 * trailing-newline-only delta is reflected in additions/deletions and
 * the unified-diff `\ No newline at end of file` markers. The sentinel
 * leads with a NUL byte (`\u0000`), which is essentially never present
 * in real source-line text, and includes a unique tag so an accidental
 * NUL in a binary blob being diffed cannot collide.
 */
const NO_NEWLINE_SENTINEL = "\u0000\u0000__pi_mmr_no_newline__\u0000\u0000";

function toLogicalLines(content: string): { lines: string[]; trailingNewline: boolean } {
  const { lines, trailingNewline } = splitFileLines(content);
  if (!trailingNewline && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = lines[last]! + NO_NEWLINE_SENTINEL;
  }
  return { lines, trailingNewline };
}

function stripNoNewlineSentinel(line: string): { text: string; missingNewline: boolean } {
  if (line.endsWith(NO_NEWLINE_SENTINEL)) {
    return { text: line.slice(0, -NO_NEWLINE_SENTINEL.length), missingNewline: true };
  }
  return { text: line, missingNewline: false };
}

function lineDiffOps(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const m = oldLines.length;
  const n = newLines.length;
  // dp[i][j] = LCS length for oldLines[i..] vs newLines[j..]; computed
  // from the bottom up so the forward walk below can pick the larger
  // tail at each branch. Caller guarantees `m * n <= MAX_LCS_CELLS`.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  function push(kind: DiffOp["kind"], line: string): void {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) last.lines.push(line);
    else ops.push({ kind, lines: [line] });
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      push("equal", oldLines[i]!);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push("remove", oldLines[i]!);
      i += 1;
    } else {
      push("add", newLines[j]!);
      j += 1;
    }
  }
  while (i < m) push("remove", oldLines[i++]!);
  while (j < n) push("add", newLines[j++]!);
  return ops;
}

export function computeUnifiedDiff(
  oldDisplayPath: string | null,
  newDisplayPath: string | null,
  oldContent: string,
  newContent: string,
  context = 3,
): { diff: string; additions: number; deletions: number } {
  const { lines: oldLines } = toLogicalLines(oldContent);
  const { lines: newLines } = toLogicalLines(newContent);

  // LCS budget guard. The line-LCS DP table is O(m * n) cells; above
  // ~4M cells the allocation is large enough that a single pathological
  // patch (a whole-file rewrite of a multi-thousand-line generated file)
  // could allocate hundreds of MB and stall the agent. Fall back to a
  // coarse full-rewrite representation that still gives correct path
  // headers and conservative additions/deletions counts, plus a clear
  // sentinel line so consumers know the body was elided. Add-only and
  // delete-only paths are safe (one of m/n is zero, dp shrinks to a
  // single row).
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    const additions = newLines.length;
    const deletions = oldLines.length;
    const out: string[] = [];
    if (oldDisplayPath !== null) out.push(`--- ${oldDisplayPath}`);
    if (newDisplayPath !== null) out.push(`+++ ${newDisplayPath}`);
    out.push(
      `[unified diff omitted: ${oldLines.length}-line old vs ${newLines.length}-line new exceeds the ${MAX_LCS_CELLS}-cell LCS budget; additions/deletions reflect a full-rewrite upper bound]`,
    );
    return { diff: out.join("\n") + "\n", additions, deletions };
  }

  const ops = lineDiffOps(oldLines, newLines);

  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === "add") additions += op.lines.length;
    else if (op.kind === "remove") deletions += op.lines.length;
  }
  if (additions === 0 && deletions === 0) {
    return { diff: "", additions: 0, deletions: 0 };
  }

  // Linearize ops into per-line steps with old/new line numbers so the
  // unified-diff hunk header can be emitted from line indices directly.
  // `text` is the display text (sentinel stripped) and `noNewlineMarker`
  // records whether to emit `\ No newline at end of file` after this
  // step, per unified-diff convention.
  type Step = {
    kind: "equal" | "add" | "remove";
    oldLine: number;
    newLine: number;
    text: string;
    /** Side that this step's missing-newline marker applies to. Empty for none. */
    noNewlineMarker: "old" | "new" | "both" | "";
  };
  const steps: Step[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    for (const rawText of op.lines) {
      const { text, missingNewline } = stripNoNewlineSentinel(rawText);
      if (op.kind === "equal") {
        // An equal line that carries the sentinel means *both* sides have
        // identical content and both end without a trailing newline at
        // this exact line position; emit one marker (collapsed form), as
        // `git diff` does for content-equal trailing lines.
        steps.push({
          kind: "equal",
          oldLine,
          newLine,
          text,
          noNewlineMarker: missingNewline ? "both" : "",
        });
        oldLine += 1;
        newLine += 1;
      } else if (op.kind === "add") {
        steps.push({
          kind: "add",
          oldLine,
          newLine,
          text,
          noNewlineMarker: missingNewline ? "new" : "",
        });
        newLine += 1;
      } else {
        steps.push({
          kind: "remove",
          oldLine,
          newLine,
          text,
          noNewlineMarker: missingNewline ? "old" : "",
        });
        oldLine += 1;
      }
    }
  }

  const out: string[] = [];
  if (oldDisplayPath !== null) out.push(`--- ${oldDisplayPath}`);
  if (newDisplayPath !== null) out.push(`+++ ${newDisplayPath}`);

  // Indices of every non-equal step. Adjacent change indices that are
  // within `context * 2` of each other share a hunk so the trailing
  // context of one change merges with the leading context of the next.
  const changeIndices: number[] = [];
  for (let k = 0; k < steps.length; k += 1) {
    if (steps[k]!.kind !== "equal") changeIndices.push(k);
  }
  let k = 0;
  while (k < changeIndices.length) {
    let endIdx = changeIndices[k]!;
    let next = k + 1;
    while (next < changeIndices.length && changeIndices[next]! - endIdx <= context * 2) {
      endIdx = changeIndices[next]!;
      next += 1;
    }
    const start = Math.max(0, changeIndices[k]! - context);
    const end = Math.min(steps.length - 1, endIdx + context);

    let oldStart = 0;
    let oldCount = 0;
    let newStart = 0;
    let newCount = 0;
    for (let s = start; s <= end; s += 1) {
      const step = steps[s]!;
      if (step.kind !== "add") {
        if (oldCount === 0) oldStart = step.oldLine;
        oldCount += 1;
      }
      if (step.kind !== "remove") {
        if (newCount === 0) newStart = step.newLine;
        newCount += 1;
      }
    }

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let s = start; s <= end; s += 1) {
      const step = steps[s]!;
      const prefix = step.kind === "equal" ? " " : step.kind === "add" ? "+" : "-";
      out.push(prefix + step.text);
      if (step.noNewlineMarker !== "") {
        // "both" → single collapsed marker after an equal line whose
        // content is identical on both sides and which terminates both
        // files without a trailing newline. "old" / "new" → marker on
        // the corresponding side after a remove/add step.
        out.push("\\ No newline at end of file");
      }
    }
    k = next;
  }

  return { diff: out.join("\n") + "\n", additions, deletions };
}
