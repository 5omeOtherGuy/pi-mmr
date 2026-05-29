import type { SessionEntry, SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Lazy enrichment cache layered on top of `SessionManager`. Only opens a
 * session and walks its entries when an enrichment that needs per-entry
 * inspection (currently `getTouchedFiles`) is requested. The default
 * lexical fast path in {@link "./session-catalog"} never triggers a
 * session open.
 *
 * The catalog enumerates **all** local Pi sessions on disk — every
 * encoded-cwd directory under `~/.pi/agent/sessions/` — so the index
 * holds a single global TTL cache rather than a per-cwd one.
 *
 * Cache invalidation:
 * - global list cache: invalidated when the set of
 *   `id|modified|messageCount` tuples changes, or when its short TTL
 *   expires.
 * - per-session enrichment cache: keyed by `id|modified|messageCount`,
 *   so a modified session evicts naturally on the next list.
 *
 * No filesystem watchers, no persisted state, no cross-process cache.
 */

export interface SessionIndexDeps {
  /** Enumerate every local Pi session across all project cwds. */
  listSessions(): Promise<SessionInfo[]>;
  openSession(path: string): Pick<SessionManager, "getEntries">;
}

export interface SessionIndex {
  /** Delegates to the global session listing with a small TTL cache. */
  list(): Promise<SessionInfo[]>;
  /**
   * Return the set of files referenced by structured tool calls in the
   * given session. Paths are normalized to lowercase POSIX form,
   * cwd-relative when inside the session's own cwd; absolute paths
   * outside the session cwd are dropped. Bash stdout, prose, and
   * tool-result content are never parsed.
   */
  getTouchedFiles(info: SessionInfo): Promise<ReadonlySet<string>>;
}

const DEFAULT_LIST_TTL_MS = 10_000;

interface GlobalCache {
  fingerprint: string;
  sessions: SessionInfo[];
  expiresAt: number;
  touched: Map<string, ReadonlySet<string>>;
}

function sessionCacheKey(info: SessionInfo): string {
  return `${info.id}|${info.modified.toISOString()}|${info.messageCount}`;
}

function listFingerprint(sessions: readonly SessionInfo[]): string {
  return sessions.map(sessionCacheKey).sort().join("\n");
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function stripLeadingDot(value: string): string {
  return value.replace(/^(?:\.\/)+/, "");
}

/** Remove trailing `/` characters without an unanchored-quantifier regex. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

/**
 * Normalize a raw path argument seen in a tool call to a cwd-relative POSIX
 * string suitable for case-insensitive substring matching. Returns undefined
 * for paths that should be ignored (empty, outside cwd, non-string).
 */
export function normalizeTouchedPath(raw: unknown, cwd: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const posix = toPosix(trimmed);
  const cwdPosix = stripTrailingSlashes(toPosix(cwd));
  // Absolute path: must be inside session cwd to count as a touched file.
  if (/^([a-zA-Z]:)?\//.test(posix)) {
    if (!cwdPosix) return undefined;
    if (posix === cwdPosix) return undefined;
    const prefix = `${cwdPosix}/`;
    if (!posix.toLowerCase().startsWith(prefix.toLowerCase())) return undefined;
    return stripLeadingDot(posix.slice(prefix.length)).toLowerCase();
  }
  return stripLeadingDot(posix).toLowerCase();
}

const PATCH_HEADER_RE = /^\*\*\*\s+(?:Update|Add|Delete|Move)\s+File:\s*(.+?)\s*(?:->\s*(.+?)\s*)?$/gim;

function extractPatchPaths(patchText: unknown): string[] {
  if (typeof patchText !== "string" || !patchText) return [];
  const paths: string[] = [];
  for (const match of patchText.matchAll(PATCH_HEADER_RE)) {
    if (match[1]) paths.push(match[1]);
    if (match[2]) paths.push(match[2]);
  }
  return paths;
}

/**
 * Pull candidate path strings from a single structured tool-call argument
 * object. Only path-bearing tools that operate on one file are considered
 * (`read`/`edit`/`write`/`apply_patch`). Search-directory args from `grep` /
 * `find` are intentionally excluded: those are directories, not touched files,
 * and including them would create false-positive `file:` matches.
 */
export function collectToolCallPaths(toolName: string, args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  switch (toolName) {
    case "read":
    case "edit":
    case "write": {
      const path = typeof record.path === "string" ? record.path : typeof record.file_path === "string" ? record.file_path : undefined;
      return path ? [path] : [];
    }
    case "apply_patch":
      return extractPatchPaths(record.patchText ?? record.patch);
    default:
      return [];
  }
}

export function extractTouchedFilesFromEntries(entries: readonly SessionEntry[], cwd: string): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: string }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const blockRecord = block as { type?: unknown; name?: unknown; arguments?: unknown };
      if (blockRecord.type !== "toolCall") continue;
      const name = typeof blockRecord.name === "string" ? blockRecord.name : "";
      if (!name) continue;
      for (const raw of collectToolCallPaths(name, blockRecord.arguments)) {
        const normalized = normalizeTouchedPath(raw, cwd);
        if (normalized) out.add(normalized);
      }
    }
  }
  return out;
}

export interface CreateSessionIndexOptions {
  /** TTL for the global session list cache, in milliseconds. Defaults to 10s. */
  listTtlMs?: number;
  /** Clock source for tests. */
  now?: () => number;
}

export function createSessionIndex(deps: SessionIndexDeps, options: CreateSessionIndexOptions = {}): SessionIndex {
  const ttl = options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let cache: GlobalCache | undefined;

  async function refreshList(): Promise<GlobalCache> {
    const sessions = await deps.listSessions();
    const fingerprint = listFingerprint(sessions);
    if (cache && cache.fingerprint === fingerprint) {
      // Same content; just renew the TTL and reuse the touched cache.
      cache.sessions = sessions;
      cache.expiresAt = now() + ttl;
      return cache;
    }
    // Cache fingerprint change discards per-session touched-file
    // enrichment for every session, not just the changed ones.
    // Acceptable trade-off given the short TTL and small local scope;
    // revisit with per-session retention if `file:` query latency
    // becomes visible.
    cache = {
      fingerprint,
      sessions,
      expiresAt: now() + ttl,
      touched: new Map(),
    };
    return cache;
  }

  async function getCache(): Promise<GlobalCache> {
    if (cache && cache.expiresAt > now()) return cache;
    return refreshList();
  }

  return {
    async list() {
      const cached = await getCache();
      return cached.sessions;
    },
    async getTouchedFiles(info) {
      const cached = await getCache();
      const key = sessionCacheKey(info);
      const cachedTouched = cached.touched.get(key);
      if (cachedTouched) return cachedTouched;
      const manager = deps.openSession(info.path);
      const touched = extractTouchedFilesFromEntries(manager.getEntries(), info.cwd || "");
      const frozen: ReadonlySet<string> = touched;
      cached.touched.set(key, frozen);
      return frozen;
    },
  };
}
