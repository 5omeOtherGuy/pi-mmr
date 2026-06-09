import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ApplyPatchError } from "./apply-patch-errors.js";

const execFileP = promisify(execFile);

async function findExistingAncestor(absolutePath: string): Promise<string> {
  let current = absolutePath;
  // Walk parents until stat succeeds or we reach the filesystem root
  // (where `path.dirname(root) === root`). No magic cap needed: the loop
  // terminates in at most one iteration per path component.
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Compute a workspace-relative POSIX-style path for messages and summaries.
 * Both arguments must already be in the same namespace (both un-canonical
 * or both canonical) for the relative form to make sense. Callers that
 * have a ResolvedPath should prefer its canonical `lockPath` so symlinked
 * aliases still render as workspace-relative paths without `../` escapes.
 */
export function toPosixRel(rootAbs: string, targetAbs: string): string {
  return path.relative(rootAbs, targetAbs).split(path.sep).join("/");
}

export interface ResolvedPath {
  /** Absolute filesystem path to use for read/write/unlink/rename. */
  absolutePath: string;
  /**
   * Canonical lock key: realpath(absolutePath) if the path exists, else
   * realpath(deepestExistingAncestor) + the unresolved suffix. Pi's
   * mutation queue canonicalizes existing paths internally; matching the
   * same canonicalization here ensures symlink aliases share a lock and
   * dedupe correctly. The queue treats this string as an opaque key, so
   * it is fine for `lockPath` to refer to a path that does not yet
   * exist on disk — we just need every path the patch touches to map to
   * the same key the queue would produce for the same target.
   */
  lockPath: string;
  /**
   * Canonical root that contains `lockPath`. Either `cwdReal` or one of
   * the same-repo sibling worktree roots. Topology checks walk parents
   * up to (but not including) this boundary.
   */
  matchedRoot: string;
}

export interface AllowedRoots {
  /** Canonical realpath of `ctx.cwd`. */
  cwdReal: string;
  /**
   * All canonical roots inside which a patch path may land. Always
   * includes `cwdReal`; also includes every same-repo git worktree root
   * discovered via `git worktree list --porcelain` (canonicalized).
   */
  roots: string[];
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.normalize(p);
  }
}

/**
 * Process-lifetime cache for `discoverAllowedRoots`. The result rarely
 * changes within a Pi session (worktrees are not added/removed mid-run
 * in any common workflow), and the discovery costs 2 + N × `git`
 * subprocess invocations per call. Caching by `cwdReal` keeps every
 * `applyCodexPatch` after the first one for the same workspace at
 * essentially zero discovery cost. We deliberately omit invalidation
 * hooks; if a user adds a sibling worktree mid-session and immediately
 * runs apply_patch, the new worktree won't be visible until the next
 * process — a documented, narrow trade-off.
 */
const allowedRootsCache = new Map<string, Promise<AllowedRoots>>();

/**
 * Discover the safety boundary for `apply_patch`.
 *
 * - If `ctx.cwd` is not inside a git repository (or git is unavailable),
 *   the only allowed root is `cwdReal` — preserving the historical
 *   cwd-only behavior for non-git workspaces.
 * - Otherwise, ask git for the repository's common dir and the list of
 *   worktrees attached to it. Each listed worktree path is canonicalized;
 *   any whose realpath'd common dir doesn't match the current repo is
 *   discarded as a defensive sanity check (filesystem moves, stale
 *   gitfile entries, etc.).
 *
 * All git invocations have a short timeout so a hung git process can't
 * stall a patch. Any failure falls back to the cwd-only behavior; we
 * never widen the boundary on the basis of a failed/ambiguous lookup.
 *
 * Memoized per `cwdReal` for the process lifetime via
 * `allowedRootsCache`; concurrent callers share the in-flight promise.
 */
export async function discoverAllowedRoots(cwdReal: string): Promise<AllowedRoots> {
  const cached = allowedRootsCache.get(cwdReal);
  if (cached) return cached;
  const inflight = discoverAllowedRootsUncached(cwdReal);
  allowedRootsCache.set(cwdReal, inflight);
  return inflight;
}

async function discoverAllowedRootsUncached(cwdReal: string): Promise<AllowedRoots> {
  const gitOpts = { cwd: cwdReal, timeout: 5000, encoding: "utf8" as const };
  let commonDirReal: string;
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwdReal, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      gitOpts,
    );
    commonDirReal = await safeRealpath(stdout.trim());
  } catch {
    return { cwdReal, roots: [cwdReal] };
  }

  let listing: string;
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwdReal, "worktree", "list", "--porcelain"],
      gitOpts,
    );
    listing = stdout;
  } catch {
    return { cwdReal, roots: [cwdReal] };
  }

  const roots = new Set<string>([cwdReal]);
  // `git worktree list --porcelain` emits records separated by blank
  // lines; the first line of each record is `worktree <path>`.
  for (const block of listing.split(/\n\s*\n/)) {
    const match = block.match(/^worktree (.+)$/m);
    if (!match) continue;
    const wtPath = match[1]!.trim();
    let wtReal: string;
    try {
      wtReal = await realpath(wtPath);
    } catch {
      continue;
    }
    // Verify the listed worktree still resolves to the same repo. A
    // realpath comparison of common dirs catches symlink games and stale
    // entries cheaply.
    try {
      const { stdout } = await execFileP(
        "git",
        ["-C", wtReal, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: wtReal, timeout: 5000, encoding: "utf8" as const },
      );
      const wtCommonReal = await safeRealpath(stdout.trim());
      if (wtCommonReal !== commonDirReal) continue;
    } catch {
      continue;
    }
    roots.add(wtReal);
  }
  return { cwdReal, roots: Array.from(roots) };
}

/**
 * Pick the most specific allowed root that contains `canonical`, or
 * `undefined` if `canonical` is outside every allowed root. Roots and
 * `canonical` must already be canonical (realpath'd).
 */
function pickContainingRoot(
  canonical: string,
  roots: readonly string[],
): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    if (canonical !== root && !canonical.startsWith(root + path.sep)) continue;
    if (best === undefined || root.length > best.length) best = root;
  }
  return best;
}

function formatBoundaryError(
  rawPath: string,
  resolvedTarget: string,
  allowed: AllowedRoots,
): string {
  const others = allowed.roots.filter((r) => r !== allowed.cwdReal).sort();
  const lines = [
    `Refusing patch path that resolves outside workspace: ${rawPath}`,
    `  current workspace: ${allowed.cwdReal}`,
  ];
  if (others.length > 0) {
    lines.push(`  allowed worktree roots:`);
    for (const r of others) lines.push(`    - ${r}`);
  } else {
    lines.push(
      `  allowed worktree roots: (none — current workspace is not part of a multi-worktree git repository)`,
    );
  }
  lines.push(`  rejected target: ${resolvedTarget}`);
  return lines.join("\n");
}

/**
 * Resolve a patch path against the active safety boundary.
 *
 * Relative paths resolve against `allowed.cwdReal`. Absolute paths are
 * accepted only if their canonical target lands inside one of
 * `allowed.roots` (the workspace plus any same-repo sibling worktrees).
 * The matched root is recorded on the returned `ResolvedPath` so the
 * topology check can walk parents up to that boundary.
 *
 * Symlink traversal that escapes every allowed root is rejected (the
 * lock-key canonicalization makes this check robust).
 *
 * Caveat: realpath happens here, but the per-file mutation queue lock is
 * acquired *after* this call returns. If a symlink along the path is
 * swapped between resolveSafePath and the lock-held read, the workspace
 * boundary check is no longer a guarantee. For a single-user CLI this is
 * a documented limitation, not an exploitable vector.
 */
export async function resolveSafePath(rawPath: string, allowed: AllowedRoots): Promise<ResolvedPath> {
  if (rawPath.trim() === "") {
    throw new ApplyPatchError("Empty patch path.");
  }
  const absolute = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(allowed.cwdReal, rawPath);

  // Compute the canonical lock key. realpath(absolute) for files that exist;
  // realpath(deepest existing ancestor) joined with the unresolved suffix
  // for files that don't (yet).
  let lockPath: string;
  try {
    lockPath = await realpath(absolute);
  } catch {
    const ancestor = await findExistingAncestor(absolute);
    // findExistingAncestor returned a path it just successfully stat'd, so
    // realpath is expected to succeed in steady state. The fallback covers
    // the narrow TOCTOU case where that ancestor is removed between the two
    // awaits. Falling back to the un-canonical ancestor is fail-safe: the
    // boundary check below compares lockPath against the allowed roots and
    // will reject an alias-namespace key rather than silently accept an
    // escaped path.
    let realAncestor: string;
    try {
      realAncestor = await realpath(ancestor);
    } catch {
      realAncestor = ancestor;
    }
    const suffix = path.relative(ancestor, absolute);
    lockPath = suffix ? path.join(realAncestor, suffix) : realAncestor;
  }

  // Pick the most specific allowed root that contains the canonical path.
  // This catches absolute paths outside the workspace, `..` escapes, and
  // symlink traversal in one go: every escape route results in a lockPath
  // that does not start with any allowed root.
  const matchedRoot = pickContainingRoot(lockPath, allowed.roots);
  if (!matchedRoot) {
    throw new ApplyPatchError(formatBoundaryError(rawPath, lockPath, allowed));
  }
  return { absolutePath: absolute, lockPath, matchedRoot };
}
