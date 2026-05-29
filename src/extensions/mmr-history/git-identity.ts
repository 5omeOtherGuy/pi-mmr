import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Repo identity derived from a session's project git remote. Resolved
 * per session cwd by `searchSessionsWithDiagnostics`'s repo: pass; the
 * shared resolver caches per cwd internally.
 *
 * Aliases are the strings that a `repo:<value>` query token can match against,
 * compared case-insensitively after both sides are lowercased and trimmed.
 * The credential-stripped remote URL is included so users can paste a URL
 * straight from their browser; `host/owner/repo` and `owner/repo` cover the
 * common shorthand forms.
 *
 * The display string preserves the credential-stripped URL form (or, for
 * SCP-style remotes, the parsed `host/path` form), with userinfo always
 * removed.
 */
export interface RepoIdentity {
  aliases: ReadonlySet<string>;
  display: string;
}

export interface GitIdentityDeps {
  /**
   * Read the project's primary remote URL for the given cwd. Should return
   * the credentialed form as-is if that is what is on disk; this module is
   * responsible for stripping credentials before storage and output. Return
   * undefined when no remote can be determined.
   */
  readRemoteUrl(cwd: string): Promise<string | undefined>;
}

export interface GitIdentityResolver {
  resolve(cwd: string): Promise<RepoIdentity | undefined>;
}

/**
 * Strip `user[:password]@` userinfo from a URL-style remote. SCP-style
 * remotes (`git@host:path`) are returned unchanged; their `user@` part is not
 * a credential but a transport hint, and is dropped during canonicalization.
 */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, "$1");
}

interface ParsedRemote {
  /** Lowercased host. */
  host: string;
  /** Path with leading slash, trailing `.git`, and trailing slashes stripped. Original case preserved. */
  path: string;
  /** Best-effort display form, credential-stripped. */
  display: string;
}

function parseRemote(raw: string): ParsedRemote | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // SCP-style: [user@]host:path (no scheme). Reject obvious URLs first.
  if (!trimmed.includes("://")) {
    const scp = /^(?:([\w.-]+)@)?([\w.-]+):([^/].*)$/.exec(trimmed);
    if (scp) {
      const host = scp[2]!.toLowerCase();
      const path = scp[3]!.replace(/\.git\/?$/, "").replace(/\/+$/, "");
      return { host, path, display: `${host}/${path}` };
    }
  }

  const stripped = stripCredentials(trimmed);
  try {
    const u = new URL(stripped);
    const host = u.hostname.toLowerCase();
    const cleanPath = u.pathname.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
    if (!host || !cleanPath) return undefined;
    // Recompose a display URL with credentials stripped, no .git, no trailing slash.
    const port = u.port ? `:${u.port}` : "";
    const display = `${u.protocol}//${host}${port}/${cleanPath}`;
    return { host, path: cleanPath, display };
  } catch {
    return undefined;
  }
}

/**
 * Build a {@link RepoIdentity} from a raw remote URL. Returns undefined when
 * the URL cannot be parsed into a host + path pair (e.g., empty string, local
 * path, malformed input). Credentials are never preserved in aliases or
 * display string.
 */
export function repoIdentityFromUrl(raw: string): RepoIdentity | undefined {
  const parsed = parseRemote(raw);
  if (!parsed) return undefined;
  const aliases = new Set<string>();
  const hostLower = parsed.host;
  const pathLower = parsed.path.toLowerCase();
  aliases.add(`${hostLower}/${pathLower}`);
  const segments = pathLower.split("/").filter(Boolean);
  if (segments.length >= 2) {
    aliases.add(`${segments[0]}/${segments[segments.length - 1]}`);
  }
  aliases.add(parsed.display.toLowerCase());
  // Variant without trailing `.git` (already stripped), and with `.git` appended,
  // so users can match either spelling of the URL they have on hand.
  aliases.add(`${parsed.display.toLowerCase()}.git`);
  return { aliases, display: parsed.display };
}

async function readGitDir(cwd: string): Promise<string | undefined> {
  if (!cwd) return undefined;
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 32; depth++) {
    const candidate = path.join(current, ".git");
    try {
      // Read `.git` directly instead of stat()-then-readFile(), which is a
      // file-system race. A regular `.git` file holds a `gitdir:` pointer
      // (worktrees/submodules); a `.git` directory reads back as EISDIR and
      // is the gitdir itself.
      const text = await fs.readFile(candidate, "utf8");
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (m && m[1]) {
        const gitdir = m[1];
        return path.isAbsolute(gitdir) ? gitdir : path.resolve(current, gitdir);
      }
      // A `.git` file without a gitdir pointer is not a usable git dir here;
      // keep walking upward.
    } catch (error) {
      // EISDIR means `.git` is a directory — the common repo layout — so it
      // is the git dir. ENOENT and other errors mean `.git` is absent or
      // unreadable at this level; keep walking.
      if ((error as NodeJS.ErrnoException).code === "EISDIR") return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Parse the `url = ...` entry from a git `config` file's `[remote "..."]`
 * section. Prefers `origin`, falls back to the first remote with a url.
 * Returns the raw URL string verbatim; credentials are not stripped here.
 */
export function extractRemoteUrlFromGitConfig(config: string): string | undefined {
  let section: string | undefined;
  let subsection: string | undefined;
  let originUrl: string | undefined;
  let anyUrl: string | undefined;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([\w-]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      subsection = header[2];
      continue;
    }
    if (section !== "remote") continue;
    const kv = /^url\s*=\s*(.+?)\s*$/i.exec(line);
    if (!kv) continue;
    const url = kv[1]!;
    if (subsection === "origin" && !originUrl) originUrl = url;
    if (!anyUrl) anyUrl = url;
  }
  return originUrl ?? anyUrl;
}

async function defaultReadRemoteUrl(cwd: string): Promise<string | undefined> {
  const gitdir = await readGitDir(cwd);
  if (!gitdir) return undefined;
  let config: string;
  try {
    config = await fs.readFile(path.join(gitdir, "config"), "utf8");
  } catch {
    return undefined;
  }
  return extractRemoteUrlFromGitConfig(config);
}

export function createGitIdentityResolver(deps: Partial<GitIdentityDeps> = {}): GitIdentityResolver {
  const reader = deps.readRemoteUrl ?? defaultReadRemoteUrl;
  const cache = new Map<string, Promise<RepoIdentity | undefined>>();
  return {
    async resolve(cwd) {
      if (!cwd) return undefined;
      let pending = cache.get(cwd);
      if (!pending) {
        pending = (async () => {
          try {
            const raw = await reader(cwd);
            if (!raw) return undefined;
            return repoIdentityFromUrl(raw);
          } catch {
            return undefined;
          }
        })();
        cache.set(cwd, pending);
      }
      return pending;
    },
  };
}

export function matchesRepoToken(identity: RepoIdentity, token: string): boolean {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return false;
  return identity.aliases.has(normalized);
}
