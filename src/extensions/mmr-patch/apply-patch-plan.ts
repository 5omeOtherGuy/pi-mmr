/**
 * Planning and flush phase for the Codex-format `apply_patch` tool.
 *
 * This module owns the side-effecting half of apply_patch:
 *
 * - resolve every path the patch touches against the workspace + same-repo
 *   worktree allowlist;
 * - acquire Pi's per-file mutation-queue locks for the read-validate-write
 *   window, sorted by canonical lock key to avoid deadlocks between
 *   concurrent patches that touch overlapping files;
 * - build a per-file virtual state map so repeated ops on the same file
 *   see earlier ops' changes;
 * - run all hunks against the virtual state (delegating the hunk match
 *   engine to {@link applyHunksToContent}) before any disk write;
 * - pre-flush topology check that rejects parent/child write conflicts
 *   that would otherwise leave partial state on disk;
 * - flush phase that runs deletes first (so a legitimate
 *   replace-file-with-tree pattern works), then writes in sorted lock-path
 *   order, wrapping any filesystem errno into ApplyPatchError with the
 *   workspace-relative path.
 *
 * The parser, hunk-match engine, error type, path safety, line splitting,
 * and unified-diff formatting all live in sibling modules
 * (`apply-patch.ts`, `apply-patch-errors.ts`, `apply-patch-paths.ts`,
 * `apply-patch-lines.ts`, `apply-patch-diff.ts`).
 */

import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { computeUnifiedDiff } from "./apply-patch-diff.js";
import { ApplyPatchError } from "./apply-patch-errors.js";
import { discoverAllowedRoots, resolveSafePath, toPosixRel, type ResolvedPath } from "./apply-patch-paths.js";
import { applyHunksToContent, parseCodexPatch, type CodexFileOp } from "./apply-patch.js";

/**
 * Per-file change record.
 *
 * `path` is the user-facing workspace-relative POSIX path of the final
 * destination (the `Move to:` target for a move; the operation target for
 * everything else). `oldPath` is set only for moves and carries the
 * source path. `uri` is the `file://` URL of the final destination so UI
 * consumers can navigate to the file regardless of how the path was
 * spelled in the patch. `additions`/`deletions` count `+`/`-` lines in
 * the unified diff. `diff` is the unified diff string (with `--- a/` /
 * `+++ b/` headers); `/dev/null` is used for the missing side of an add
 * or delete.
 */
export interface ApplyPatchFile {
  type: "add" | "update" | "move" | "delete";
  path: string;
  oldPath?: string;
  uri: string;
  additions: number;
  deletions: number;
  diff: string;
}

interface FileState {
  /** Current virtual content. `null` means the file does not exist (yet/anymore). */
  content: string | null;
  /** Whether the file existed on disk when we first read it (used to decide whether to unlink). */
  existed: boolean;
  /** Whether the virtual content differs from on-disk and must be written. */
  dirty: boolean;
  /** Absolute filesystem path for this state. */
  absolutePath: string;
  /**
   * Canonical allowed root containing this file. Topology checks walk
   * parents up to (but not including) this root.
   */
  matchedRoot: string;
}

async function readFileIfExists(absolutePath: string, displayPath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: nothing at this path. ENOTDIR: an ancestor on the path is a
    // regular file, so this path can't currently be a readable file either.
    // Both mean "no file here" for our virtual-state model. Same handling
    // is needed for the legitimate replace-file-with-directory pattern
    // (delete `place`, add `place/inside.txt`) where we read state for
    // `place/inside.txt` while `place` is still a file on disk.
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    if (code === "EISDIR") {
      throw new ApplyPatchError(
        `Cannot read ${displayPath}: path is a directory, not a file (EISDIR).`,
      );
    }
    // Documented decision: EACCES/EPERM/etc. on read are *not* treated as
    // "missing". Wrap as ApplyPatchError with the workspace-relative
    // displayPath and the originating errno code, mirroring the flush-
    // phase wrapper, so the absolute path doesn't leak into shared logs.
    throw new ApplyPatchError(`apply_patch: read failed for ${displayPath} (${code ?? "UNKNOWN"}).`);
  }
}

/**
 * Acquire mutation-queue locks on every lock key in `lockPaths`, in the
 * order provided (caller is responsible for sorting + deduping), then run
 * `fn` inside the innermost lock. Distinct lock keys use distinct queues,
 * so nesting is safe; sorting at the call site prevents deadlocks between
 * concurrent patches that touch overlapping files.
 */
function lockAll<T>(lockPaths: readonly string[], fn: () => Promise<T>): Promise<T> {
  // Build the nested-callback chain bottom-up so the runtime stack stays
  // shallow regardless of how many locks the patch needs. Each
  // `withFileMutationQueue` wraps the next inner callback; the innermost
  // callback runs `fn`. No `[head, ...rest]` slicing per step.
  let inner: () => Promise<T> = fn;
  for (let i = lockPaths.length - 1; i >= 0; i -= 1) {
    const key = lockPaths[i]!;
    const nextInner = inner;
    inner = () => withFileMutationQueue(key, nextInner);
  }
  return inner();
}

async function planAndApply(ops: readonly CodexFileOp[], cwd: string): Promise<ApplyPatchFile[]> {
  // Canonicalize the workspace root once. All path-safety, topology, and
  // error-message computations happen against `cwdReal` so we never mix
  // un-canonicalized and canonicalized namespaces (which would silently
  // bypass the topology check when ctx.cwd itself is a symlinked path,
  // e.g. /tmp -> /private/tmp on macOS).
  //
  // resolveSafePath, summary path computation, and topology messages all
  // use `cwdReal` as their root so the user-facing relative form for any
  // path the patch touches stays the same whether the workspace was
  // supplied as a symlinked alias or as the canonical root. (Topology
  // alone using `cwdReal` would still leave the success-path summary
  // emitting `../wd-real/...` strings under a symlinked `ctx.cwd`.)
  const cwdReal = await realpath(cwd);

  // Discover the safety boundary once per patch: cwdReal plus every
  // same-repo git worktree root reachable from `cwdReal`. All
  // resolveSafePath calls use this set; topology checks below use the
  // matchedRoot recorded on each ResolvedPath.
  const allowed = await discoverAllowedRoots(cwdReal);

  // Resolve every path up front so we can lock them all before any read.
  // The individual `realpath` and `stat` calls are independent, so do them
  // in parallel; for typical small patches this is a wash, but for very
  // wide multi-file patches it avoids serializing N round trips.
  const uniqueRawPaths = new Set<string>();
  for (const op of ops) {
    uniqueRawPaths.add(op.rawPath);
    if (op.kind === "update" && op.movePath) uniqueRawPaths.add(op.movePath);
  }
  const resolvedEntries = await Promise.all(
    Array.from(uniqueRawPaths).map(
      async (rp) => [rp, await resolveSafePath(rp, allowed)] as const,
    ),
  );
  const resolved = new Map<string, ResolvedPath>(resolvedEntries);

  // Lock set: dedupe by canonical lockPath, then sort to avoid deadlocks
  // between concurrent patches that touch overlapping files.
  const lockSet = new Set<string>();
  for (const op of ops) {
    lockSet.add(resolved.get(op.rawPath)!.lockPath);
    if (op.kind === "update" && op.movePath) {
      lockSet.add(resolved.get(op.movePath)!.lockPath);
    }
  }
  const lockOrder = Array.from(lockSet).sort();

  return lockAll(lockOrder, async () => {
    // States are keyed by canonical lockPath so that two patch ops that
    // refer to the same underlying file via different alias paths share a
    // single in-memory state.
    const states = new Map<string, FileState>();
    const summary: ApplyPatchFile[] = [];

    async function getState(rp: ResolvedPath, displayPath: string): Promise<FileState> {
      const existing = states.get(rp.lockPath);
      if (existing) return existing;
      const c = await readFileIfExists(rp.absolutePath, displayPath);
      const state: FileState = {
        content: c ?? null,
        existed: c !== undefined,
        dirty: false,
        absolutePath: rp.absolutePath,
        matchedRoot: rp.matchedRoot,
      };
      states.set(rp.lockPath, state);
      return state;
    }

    for (const op of ops) {
      const sourceRp = resolved.get(op.rawPath)!;
      const sourceRel = toPosixRel(cwdReal, sourceRp.lockPath);
      const sourceState = await getState(sourceRp, sourceRel);

      if (op.kind === "delete") {
        if (sourceState.content === null) {
          throw new ApplyPatchError(`Cannot delete missing file: ${sourceRel}`);
        }
        const oldContent = sourceState.content;
        sourceState.content = null;
        sourceState.dirty = true;
        const { diff, additions, deletions } = computeUnifiedDiff(
          `a/${sourceRel}`,
          "/dev/null",
          oldContent,
          "",
        );
        summary.push({
          type: "delete",
          path: sourceRel,
          uri: pathToFileURL(sourceRp.absolutePath).href,
          additions,
          deletions,
          diff,
        });
        continue;
      }

      if (op.kind === "add") {
        if (sourceState.content !== null) {
          throw new ApplyPatchError(`Cannot add file that already exists: ${sourceRel}`);
        }
        const lines = op.addLines ?? [];
        // Default: append a trailing newline to a non-empty body, matching
        // historical behavior. When the patch body ended with
        // `\ No newline at end of file`, omit the trailing newline so the
        // created file matches the documented intent and round-trips with
        // an Update File hunk's no-newline marker.
        const newContent = lines.length === 0
          ? ""
          : lines.join("\n") + (op.addNoTrailingNewline ? "" : "\n");
        sourceState.content = newContent;
        sourceState.dirty = true;
        const { diff, additions, deletions } = computeUnifiedDiff(
          "/dev/null",
          `b/${sourceRel}`,
          "",
          newContent,
        );
        summary.push({
          type: "add",
          path: sourceRel,
          uri: pathToFileURL(sourceRp.absolutePath).href,
          additions,
          deletions,
          diff,
        });
        continue;
      }

      // update
      if (sourceState.content === null) {
        throw new ApplyPatchError(`Cannot update missing file: ${sourceRel}`);
      }
      const oldContent = sourceState.content;
      const newContent = applyHunksToContent(sourceRel, oldContent, op.hunks ?? []);

      if (op.movePath) {
        const moveRp = resolved.get(op.movePath)!;
        const moveRel = toPosixRel(cwdReal, moveRp.lockPath);
        if (moveRp.lockPath !== sourceRp.lockPath) {
          const moveState = await getState(moveRp, moveRel);
          if (moveState.content !== null) {
            throw new ApplyPatchError(
              `Cannot move ${sourceRel} -> ${moveRel}: destination already exists.`,
            );
          }
          moveState.content = newContent;
          moveState.dirty = true;
          sourceState.content = null;
          sourceState.dirty = true;
          const { diff, additions, deletions } = computeUnifiedDiff(
            `a/${sourceRel}`,
            `b/${moveRel}`,
            oldContent,
            newContent,
          );
          summary.push({
            type: "move",
            path: moveRel,
            oldPath: sourceRel,
            uri: pathToFileURL(moveRp.absolutePath).href,
            additions,
            deletions,
            diff,
          });
        } else {
          sourceState.content = newContent;
          sourceState.dirty = true;
          const { diff, additions, deletions } = computeUnifiedDiff(
            `a/${sourceRel}`,
            `b/${sourceRel}`,
            oldContent,
            newContent,
          );
          summary.push({
            type: "update",
            path: sourceRel,
            uri: pathToFileURL(sourceRp.absolutePath).href,
            additions,
            deletions,
            diff,
          });
        }
      } else {
        sourceState.content = newContent;
        sourceState.dirty = true;
        const { diff, additions, deletions } = computeUnifiedDiff(
          `a/${sourceRel}`,
          `b/${sourceRel}`,
          oldContent,
          newContent,
        );
        summary.push({
          type: "update",
          path: sourceRel,
          uri: pathToFileURL(sourceRp.absolutePath).href,
          additions,
          deletions,
          diff,
        });
      }
    }

    // Pre-flush topology check.
    //
    // Any path the patch writes (content !== null) must have an ancestor
    // chain of directories between itself and `cwdReal`. An ancestor is OK if:
    //   1. it is being deleted by this patch (state in our map with
    //      content === null) — the flush runs deletes before writes, so
    //      a regular file gets unlinked before mkdir tries to recreate it
    //      as a directory (the legitimate replace-file-with-tree pattern);
    //   2. it does not exist on disk — mkdir-recursive will create it; or
    //   3. it exists on disk and is a directory.
    // Any other case (an ancestor that is being written as a file, or an
    // ancestor that exists on disk as a non-directory and is not being
    // deleted) would deterministically fail mid-flush and leave earlier
    // writes committed, so we surface it before any write happens.
    //
    // The walk uses `lockPath` (canonical) instead of `absolutePath`
    // (rooted at the user-supplied `cwd`), so that when `cwd` itself is a
    // symlinked path (e.g. macOS `/tmp` -> `/private/tmp`) the namespaces
    // match and the loop guard is honored. `state.absolutePath` is fine
    // for the actual fs ops below (Node accepts either form), but the
    // topology check needs canonical input to be reliable.
    const dirtyWrites = Array.from(states.entries())
      .filter(([, s]) => s.dirty && s.content !== null)
      .map(([lockPath, s]) => ({ lockPath, absolutePath: s.absolutePath, matchedRoot: s.matchedRoot }));
    // Memoize stat results across writes so a patch with N siblings under a
    // deep prefix only stats each ancestor once.
    const statCache = new Map<string, Stats | null>();
    async function ancestorStat(p: string): Promise<Stats | null> {
      if (statCache.has(p)) return statCache.get(p)!;
      let result: Stats | null;
      try {
        result = await stat(p);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") result = null;
        else throw err;
      }
      statCache.set(p, result);
      return result;
    }
    // Walk parents from `path.dirname(w.lockPath)` up to (but not
    // including) `root`. We use `path.relative` rather than string-prefix
    // matching with `root + path.sep`, because the latter silently skips
    // the entire topology check whenever `root` happens to be a
    // filesystem root (e.g. `"/"` on POSIX, `"C:\\"` on Windows): for
    // `root = "/"`, `root + path.sep === "//"`, which no canonical path
    // starts with. `cwdReal` is rejected upstream when it is an fs root,
    // but `discoverAllowedRoots` could in principle admit a worktree
    // listed by git that resolves to one, and we want the topology check
    // to be defensive against that case rather than silently no-oping.
    function isStrictlyUnderRoot(p: string, root: string): boolean {
      if (p === root) return false;
      const rel = path.relative(root, p);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    }
    for (const w of dirtyWrites) {
      let parent = path.dirname(w.lockPath);
      const root = w.matchedRoot;
      while (isStrictlyUnderRoot(parent, root)) {
        const parentState = states.get(parent);
        if (parentState && parentState.dirty) {
          if (parentState.content === null) {
            // Being deleted by this patch — mkdir downstream will recreate it.
            parent = path.dirname(parent);
            continue;
          }
          // Being written as a regular file by this patch.
          const parentRel = toPosixRel(cwdReal, parent);
          const writeRel = toPosixRel(cwdReal, w.lockPath);
          throw new ApplyPatchError(
            `Path topology conflict: this patch would write both a file at ${parentRel} and a descendant ${writeRel}; ${parentRel} cannot be both a file and a parent directory.`,
          );
        }
        const parentStat = await ancestorStat(parent);
        if (parentStat === null) {
          // Doesn't exist on disk; mkdir-recursive will create it. OK.
          parent = path.dirname(parent);
          continue;
        }
        if (!parentStat.isDirectory()) {
          const parentRel = toPosixRel(cwdReal, parent);
          const writeRel = toPosixRel(cwdReal, w.lockPath);
          throw new ApplyPatchError(
            `Path topology conflict: ${parentRel} exists on disk and is not a directory, but this patch would write ${writeRel} beneath it; delete or move ${parentRel} in the same patch if you want to replace it with a directory.`,
          );
        }
        parent = path.dirname(parent);
      }
    }

    // Phase 2: flush every dirty state to disk. All hunks have already
    // validated against in-memory state, so by this point we expect every
    // write to succeed; a filesystem error mid-flush may leave partial
    // state (documented in the README).
    //
    // Ordering matters in one case: if the patch deletes a regular file at
    // P and then adds P/inside.txt (legitimate replace-file-with-directory
    // pattern), the dir mkdir for the add only succeeds after the file at
    // P is unlinked. Process all deletes before any writes; then write in
    // sorted-lock-path order so any common ancestor directories are
    // mkdir'd before their descendants.
    // Wrap fs operations during flush so unexpected errnos (EACCES,
    // EPERM, ELOOP, ENAMETOOLONG, …) surface as ApplyPatchError with the
    // workspace-relative path and the originating errno code instead of
    // raw Node messages that leak the absolute filesystem path. The
    // ApplyPatchError already names the operation that failed; the
    // documented partial-flush limitation still applies.
    function wrapFsError(err: unknown, op: string, lockPath: string, absPath: string): Error {
      const e = err as NodeJS.ErrnoException;
      const code = e.code ?? "UNKNOWN";
      // Prefer the canonical lockPath for the relative form so symlinked
      // aliases render as workspace-relative paths; fall back to the
      // absolute path when the relative form would escape the workspace.
      const rel = toPosixRel(cwdReal, lockPath);
      const display = rel === "" || rel.startsWith("..") ? path.basename(absPath) : rel;
      return new ApplyPatchError(
        `apply_patch: ${op} failed for ${display} (${code}).`,
      );
    }
    const dirty = Array.from(states.entries()).filter(([, s]) => s.dirty);
    for (const [lockPath, state] of dirty) {
      if (state.content === null) {
        if (state.existed) {
          try {
            await unlink(state.absolutePath);
          } catch (err) {
            throw wrapFsError(err, "unlink", lockPath, state.absolutePath);
          }
        }
      }
    }
    const sortedWrites = dirty
      .filter(([, s]) => s.content !== null)
      .sort(([, a], [, b]) => (a.absolutePath < b.absolutePath ? -1 : a.absolutePath > b.absolutePath ? 1 : 0));
    for (const [lockPath, state] of sortedWrites) {
      try {
        await mkdir(path.dirname(state.absolutePath), { recursive: true });
      } catch (err) {
        throw wrapFsError(err, "mkdir", lockPath, state.absolutePath);
      }
      try {
        await writeFile(state.absolutePath, state.content!, "utf8");
      } catch (err) {
        throw wrapFsError(err, "writeFile", lockPath, state.absolutePath);
      }
    }

    return summary;
  });
}

/**
 * apply_patch result envelope.
 *
 * - `summary` is the multi-line `<type>: <path> (+N/-M)` text that the
 *   tool also surfaces as `content[0].text`. Move ops render as
 *   `move: <oldPath> -> <path> (+N/-M)` so the source path is visible.
 * - `files` carries one entry per applied operation in document order,
 *   each with full diff stats and a `file://` URI for UI consumers.
 */
export interface ApplyPatchResult {
  summary: string;
  files: ApplyPatchFile[];
}

function formatSummaryLine(file: ApplyPatchFile): string {
  const stats = `(+${file.additions}/-${file.deletions})`;
  if (file.type === "move" && file.oldPath !== undefined) {
    return `move: ${file.oldPath} -> ${file.path} ${stats}`;
  }
  return `${file.type}: ${file.path} ${stats}`;
}

export async function applyCodexPatch(patchText: string, cwd: string): Promise<ApplyPatchResult> {
  // Make the absolute-cwd contract explicit at the boundary. Pi's
  // `ctx.cwd` is always absolute today; rejecting a relative cwd here
  // prevents silent resolution against `process.cwd()` if a future
  // caller forgets that invariant.
  if (!path.isAbsolute(cwd)) {
    throw new ApplyPatchError(
      `apply_patch requires an absolute workspace path; got ${JSON.stringify(cwd)}.`,
    );
  }
  const parsed = parseCodexPatch(patchText);
  const files = await planAndApply(parsed, cwd);
  const summary = files.map(formatSummaryLine).join("\n");
  return { summary, files };
}
