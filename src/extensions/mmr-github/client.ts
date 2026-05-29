import { isRecord } from "../mmr-core/internal/json.js";
import {
  combineSignal,
  enforceContentLengthBudget,
  readErrorPreview,
  readTextWithByteLimit,
} from "../mmr-web/http-utils.js";

/**
 * Minimal, read-only GitHub REST client used by the `mmr-github` tools.
 *
 * The client only ever issues `GET` requests. It bounds memory and runtime
 * per call (timeout + byte caps via the shared `mmr-web` HTTP helpers) and
 * normalizes GitHub error responses into {@link GithubApiError} with a
 * stable, model-readable message. It deliberately exposes no mutation
 * surface (no issue/PR/branch/write endpoints).
 */

export const GITHUB_API_VERSION = "2022-11-28";
export const DEFAULT_GITHUB_USER_AGENT = "pi-mmr-github";

/**
 * Read budget for the contents endpoint. GitHub's contents API itself only
 * returns inline content for files up to 1 MB (larger files yield a 403 or
 * `encoding: "none"`), so a ~1.5 MB ceiling is enough to JSON-parse the
 * base64 envelope of any readable file. Using a dedicated ceiling (instead of
 * the shared per-call cap) lets a large file be fetched in full so the
 * read_github tool can apply read_range before enforcing its own line-range
 * size gate, rather than failing to parse a transport-truncated body.
 */
export const GITHUB_CONTENTS_READ_BYTE_CEILING = 1_500_000;

/** A single owner/repo coordinate parsed from user/model input. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export class GithubApiError extends Error {
  readonly status: number;
  readonly rateLimited: boolean;
  constructor(message: string, status: number, rateLimited = false) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
    this.rateLimited = rateLimited;
    Object.setPrototypeOf(this, GithubApiError.prototype);
  }
}

export class GithubRepoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubRepoParseError";
    Object.setPrototypeOf(this, GithubRepoParseError.prototype);
  }
}

const OWNER_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const RESERVED_OWNER_SEGMENTS = new Set([
  "search",
  "marketplace",
  "explore",
  "topics",
  "trending",
  "settings",
  "notifications",
  "sponsors",
  "orgs",
  "users",
  "apps",
  "about",
  "pricing",
  "features",
]);

function isValidSegment(segment: string): boolean {
  return segment.length > 0 && segment.length <= 100 && OWNER_REPO_SEGMENT.test(segment);
}

/**
 * Parse a single GitHub repository reference from `owner/repo` or
 * `https://github.com/owner/repo[...]`. Rejects search pages, organization
 * pages, profile pages, and anything that does not resolve to exactly one
 * `owner/repo` pair. Throws {@link GithubRepoParseError} on bad input.
 */
export function parseGithubRepository(input: string): GithubRepoRef {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (trimmed.length === 0) {
    throw new GithubRepoParseError("repository is required (use \"owner/repo\" or \"https://github.com/owner/repo\").");
  }

  let owner: string;
  let repo: string;

  if (/^https?:\/\//i.test(trimmed) || trimmed.toLowerCase().startsWith("github.com/")) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
      throw new GithubRepoParseError(`Could not parse repository URL "${input}".`);
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      throw new GithubRepoParseError(
        `Unsupported repository host "${url.hostname}". Only github.com repositories are supported (use "owner/repo" or "https://github.com/owner/repo").`,
      );
    }
    const segments = url.pathname.split("/").filter((part) => part.length > 0);
    if (segments.length < 2) {
      throw new GithubRepoParseError(
        `"${input}" does not point at a single repository. Pass a repository URL such as "https://github.com/owner/repo", not a search, organization, or profile page.`,
      );
    }
    owner = segments[0]!;
    repo = segments[1]!.replace(/\.git$/i, "");
  } else {
    const segments = trimmed.split("/").filter((part) => part.length > 0);
    if (segments.length !== 2) {
      throw new GithubRepoParseError(
        `"${input}" is not a valid "owner/repo" reference. Pass exactly one owner and one repository, e.g. "facebook/react".`,
      );
    }
    owner = segments[0]!;
    repo = segments[1]!.replace(/\.git$/i, "");
  }

  if (!isValidSegment(owner) || !isValidSegment(repo)) {
    throw new GithubRepoParseError(`"${input}" is not a valid "owner/repo" reference.`);
  }
  if (RESERVED_OWNER_SEGMENTS.has(owner.toLowerCase())) {
    throw new GithubRepoParseError(
      `"${input}" looks like a GitHub site page (owner "${owner}"), not a repository. Pass a real "owner/repo".`,
    );
  }
  return { owner, repo };
}

export interface GithubClientOptions {
  token?: string;
  apiBaseUrl: string;
  requestTimeoutMs: number;
  maxResultBytes: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface GithubRequestInit {
  path: string;
  query?: Record<string, string | number | undefined>;
  accept?: string;
  signal?: AbortSignal;
  /** Per-request body byte ceiling. Defaults to `options.maxResultBytes`. */
  maxBytes?: number;
}

/** Normalized GitHub file content. */
export interface GithubFileContent {
  kind: "file";
  path: string;
  size: number;
  encoding: string;
  /** Decoded UTF-8 text content. */
  text: string;
  truncated: boolean;
}

export interface GithubDirEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
}

export interface GithubDirectoryContent {
  kind: "directory";
  path: string;
  entries: GithubDirEntry[];
}

export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

export interface GithubTree {
  ref: string;
  entries: GithubTreeEntry[];
  truncated: boolean;
}

export interface GithubCodeMatch {
  path: string;
  repository: string;
  htmlUrl: string;
  fragments: string[];
}

export interface GithubCodeSearchResult {
  totalCount: number;
  incompleteResults: boolean;
  items: GithubCodeMatch[];
}

export interface GithubCommitSummary {
  sha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  htmlUrl: string;
}

export interface GithubDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GithubComparison {
  base: string;
  head: string;
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  files: GithubDiffFile[];
}

export interface GithubRepoSummary {
  fullName: string;
  description: string;
  htmlUrl: string;
  defaultBranch: string;
  language: string;
  stars: number;
  forks: number;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  pushedAt: string;
}

export interface GithubClient {
  getRepo(ref: GithubRepoRef, signal?: AbortSignal): Promise<GithubRepoSummary>;
  getContents(
    ref: GithubRepoRef,
    path: string,
    revision: string | undefined,
    signal?: AbortSignal,
  ): Promise<GithubFileContent | GithubDirectoryContent>;
  getTree(
    ref: GithubRepoRef,
    revision: string | undefined,
    signal?: AbortSignal,
  ): Promise<GithubTree>;
  searchCode(
    query: string,
    options: { perPage: number; page: number },
    signal?: AbortSignal,
  ): Promise<GithubCodeSearchResult>;
  searchCommits(
    query: string,
    options: { perPage: number; page: number },
    signal?: AbortSignal,
  ): Promise<{ totalCount: number; items: GithubCommitSummary[] }>;
  listCommits(
    ref: GithubRepoRef,
    options: { path?: string; author?: string; since?: string; until?: string; perPage: number },
    signal?: AbortSignal,
  ): Promise<GithubCommitSummary[]>;
  listAccessibleRepositories(
    options: { perPage: number; page: number },
    signal?: AbortSignal,
  ): Promise<GithubRepoSummary[]>;
  compare(
    ref: GithubRepoRef,
    base: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<GithubComparison>;
  searchRepositories(
    query: string,
    options: { perPage: number; page: number },
    signal?: AbortSignal,
  ): Promise<{ totalCount: number; items: GithubRepoSummary[] }>;
}

function encodeContentsPath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toRepoSummary(value: Record<string, unknown>): GithubRepoSummary {
  const owner = isRecord(value.owner) && typeof value.owner.login === "string" ? value.owner.login : "";
  const name = typeof value.name === "string" ? value.name : "";
  const fullName = typeof value.full_name === "string" && value.full_name.length > 0
    ? value.full_name
    : `${owner}/${name}`;
  return {
    fullName,
    description: typeof value.description === "string" ? value.description : "",
    htmlUrl: typeof value.html_url === "string" ? value.html_url : "",
    defaultBranch: typeof value.default_branch === "string" ? value.default_branch : "",
    language: typeof value.language === "string" ? value.language : "",
    stars: typeof value.stargazers_count === "number" ? value.stargazers_count : 0,
    forks: typeof value.forks_count === "number" ? value.forks_count : 0,
    isPrivate: value.private === true,
    isFork: value.fork === true,
    isArchived: value.archived === true,
    pushedAt: typeof value.pushed_at === "string" ? value.pushed_at : "",
  };
}

function commitFromSearchOrRest(value: Record<string, unknown>): GithubCommitSummary {
  const sha = typeof value.sha === "string" ? value.sha : "";
  const commit = isRecord(value.commit) ? value.commit : {};
  const message = typeof commit.message === "string" ? commit.message : "";
  const author = isRecord(commit.author) ? commit.author : {};
  const authorName = typeof author.name === "string" ? author.name : "";
  const authorEmail = typeof author.email === "string" ? author.email : "";
  const authorDate = typeof author.date === "string" ? author.date : "";
  const htmlUrl = typeof value.html_url === "string" ? value.html_url : "";
  return { sha, message, author: authorName, authorEmail, date: authorDate, htmlUrl };
}

/** Remove trailing `/` characters without an unanchored-quantifier regex. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("mmr-github: no fetch implementation available in this runtime.");
  }
  const userAgent = options.userAgent ?? DEFAULT_GITHUB_USER_AGENT;
  const apiBaseUrl = stripTrailingSlashes(options.apiBaseUrl);

  async function request<T>(init: GithubRequestInit, parse: (json: unknown) => T): Promise<T> {
    const url = new URL(`${apiBaseUrl}${init.path}`);
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      Accept: init.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": userAgent,
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const signal = combineSignal(init.signal, options.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new GithubApiError(`GitHub request to ${init.path} timed out or was aborted.`, 0);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GithubApiError(`GitHub request to ${init.path} failed: ${message}`, 0);
    }

    if (!response.ok) {
      const preview = await readErrorPreview(response);
      throw mapErrorResponse(response, init.path, preview, Boolean(options.token));
    }

    const byteCap = init.maxBytes ?? options.maxResultBytes;
    enforceContentLengthBudget(response, byteCap, `GitHub ${init.path}`);
    const { text } = await readTextWithByteLimit(response, byteCap, `GitHub ${init.path}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new GithubApiError(`GitHub ${init.path} returned a non-JSON or truncated response.`, response.status);
    }
    return parse(json);
  }

  return {
    async getRepo(ref, signal) {
      return request({ path: `/repos/${ref.owner}/${ref.repo}`, ...(signal ? { signal } : {}) }, (json) => {
        if (!isRecord(json)) throw new GithubApiError("Unexpected repository response shape.", 200);
        return toRepoSummary(json);
      });
    },

    async getContents(ref, path, revision, signal) {
      const encoded = encodeContentsPath(path);
      return request<GithubFileContent | GithubDirectoryContent>(
        {
          path: `/repos/${ref.owner}/${ref.repo}/contents/${encoded}`,
          ...(revision ? { query: { ref: revision } } : {}),
          maxBytes: Math.max(options.maxResultBytes, GITHUB_CONTENTS_READ_BYTE_CEILING),
          ...(signal ? { signal } : {}),
        },
        (json) => {
          if (Array.isArray(json)) {
            const entries: GithubDirEntry[] = json.flatMap((entry) => {
              if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.path !== "string") return [];
              const type = typeof entry.type === "string" ? entry.type : "file";
              return [{
                name: entry.name,
                path: entry.path,
                type: (type === "dir" || type === "symlink" || type === "submodule" ? type : "file") as GithubDirEntry["type"],
                size: typeof entry.size === "number" ? entry.size : 0,
              }];
            });
            return { kind: "directory", path: path.replace(/^\/+|\/+$/g, ""), entries };
          }
          if (!isRecord(json)) throw new GithubApiError("Unexpected contents response shape.", 200);
          if (json.type === "dir") {
            return { kind: "directory", path: path.replace(/^\/+|\/+$/g, ""), entries: [] };
          }
          const encoding = typeof json.encoding === "string" ? json.encoding : "";
          const size = typeof json.size === "number" ? json.size : 0;
          const rawContent = typeof json.content === "string" ? json.content : "";
          let text = "";
          let truncated = false;
          if (encoding === "base64" && rawContent.length > 0) {
            // The contents fetch uses GITHUB_CONTENTS_READ_BYTE_CEILING, large
            // enough to JSON-parse any file GitHub returns inline (<=1 MB), so
            // the full file is decoded here. The read_github tool applies
            // read_range and then enforces its own line-range size gate.
            text = Buffer.from(rawContent.replace(/\n/g, ""), "base64").toString("utf8");
          } else if (encoding === "none") {
            // GitHub omits inline content for files larger than 1MB.
            truncated = true;
          }
          return {
            kind: "file",
            path: typeof json.path === "string" ? json.path : path.replace(/^\/+/, ""),
            size,
            encoding,
            text,
            truncated,
          };
        },
      );
    },

    async getTree(ref, revision, signal) {
      const treeIsh = revision && revision.length > 0 ? revision : (await this.getRepo(ref, signal)).defaultBranch || "HEAD";
      return request(
        {
          path: `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(treeIsh)}`,
          query: { recursive: "1" },
          ...(signal ? { signal } : {}),
        },
        (json) => {
          if (!isRecord(json) || !Array.isArray(json.tree)) {
            throw new GithubApiError("Unexpected git tree response shape.", 200);
          }
          const entries: GithubTreeEntry[] = json.tree.flatMap((entry) => {
            if (!isRecord(entry) || typeof entry.path !== "string") return [];
            const type = entry.type === "tree" || entry.type === "commit" ? entry.type : "blob";
            return [{
              path: entry.path,
              type: type as GithubTreeEntry["type"],
              ...(typeof entry.size === "number" ? { size: entry.size } : {}),
            }];
          });
          return { ref: treeIsh, entries, truncated: json.truncated === true };
        },
      );
    },

    async searchCode(query, opts, signal) {
      return request(
        {
          path: `/search/code`,
          query: { q: query, per_page: opts.perPage, page: opts.page },
          accept: "application/vnd.github.text-match+json",
          ...(signal ? { signal } : {}),
        },
        (json) => {
          if (!isRecord(json)) throw new GithubApiError("Unexpected code search response shape.", 200);
          const items: GithubCodeMatch[] = Array.isArray(json.items)
            ? json.items.flatMap((item) => {
                if (!isRecord(item) || typeof item.path !== "string") return [];
                const repository = isRecord(item.repository) && typeof item.repository.full_name === "string"
                  ? item.repository.full_name
                  : "";
                const fragments = Array.isArray(item.text_matches)
                  ? item.text_matches.flatMap((m) =>
                      isRecord(m) && typeof m.fragment === "string" ? [m.fragment] : [])
                  : [];
                return [{
                  path: item.path,
                  repository,
                  htmlUrl: typeof item.html_url === "string" ? item.html_url : "",
                  fragments,
                }];
              })
            : [];
          return {
            totalCount: typeof json.total_count === "number" ? json.total_count : items.length,
            incompleteResults: json.incomplete_results === true,
            items,
          };
        },
      );
    },

    async searchCommits(query, opts, signal) {
      return request(
        {
          path: `/search/commits`,
          query: { q: query, per_page: opts.perPage, page: opts.page, sort: "author-date", order: "desc" },
          ...(signal ? { signal } : {}),
        },
        (json) => {
          if (!isRecord(json)) throw new GithubApiError("Unexpected commit search response shape.", 200);
          const items: GithubCommitSummary[] = Array.isArray(json.items)
            ? json.items.flatMap((item) => (isRecord(item) ? [commitFromSearchOrRest(item)] : []))
            : [];
          return { totalCount: typeof json.total_count === "number" ? json.total_count : items.length, items };
        },
      );
    },

    async listCommits(ref, opts, signal) {
      return request(
        {
          path: `/repos/${ref.owner}/${ref.repo}/commits`,
          query: {
            per_page: opts.perPage,
            ...(opts.path ? { path: opts.path } : {}),
            ...(opts.author ? { author: opts.author } : {}),
            ...(opts.since ? { since: opts.since } : {}),
            ...(opts.until ? { until: opts.until } : {}),
          },
          ...(signal ? { signal } : {}),
        },
        (json) => {
          if (!Array.isArray(json)) throw new GithubApiError("Unexpected commits response shape.", 200);
          return json.flatMap((item) => (isRecord(item) ? [commitFromSearchOrRest(item)] : []));
        },
      );
    },

    async compare(ref, base, head, signal) {
      const basehead = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      return request(
        { path: `/repos/${ref.owner}/${ref.repo}/compare/${basehead}`, ...(signal ? { signal } : {}) },
        (json) => {
          if (!isRecord(json)) throw new GithubApiError("Unexpected compare response shape.", 200);
          const files: GithubDiffFile[] = Array.isArray(json.files)
            ? json.files.flatMap((file) => {
                if (!isRecord(file) || typeof file.filename !== "string") return [];
                return [{
                  filename: file.filename,
                  status: typeof file.status === "string" ? file.status : "",
                  additions: typeof file.additions === "number" ? file.additions : 0,
                  deletions: typeof file.deletions === "number" ? file.deletions : 0,
                  changes: typeof file.changes === "number" ? file.changes : 0,
                  ...(typeof file.patch === "string" ? { patch: file.patch } : {}),
                }];
              })
            : [];
          return {
            base,
            head,
            status: typeof json.status === "string" ? json.status : "",
            aheadBy: typeof json.ahead_by === "number" ? json.ahead_by : 0,
            behindBy: typeof json.behind_by === "number" ? json.behind_by : 0,
            totalCommits: typeof json.total_commits === "number" ? json.total_commits : 0,
            files,
          };
        },
      );
    },

    async searchRepositories(query, opts, signal) {
      return request(
        {
          path: `/search/repositories`,
          query: { q: query, per_page: opts.perPage, page: opts.page },
          ...(signal ? { signal } : {}),
        },
        (json) => {
          if (!isRecord(json)) throw new GithubApiError("Unexpected repository search response shape.", 200);
          const items: GithubRepoSummary[] = Array.isArray(json.items)
            ? json.items.flatMap((item) => (isRecord(item) ? [toRepoSummary(item)] : []))
            : [];
          return { totalCount: typeof json.total_count === "number" ? json.total_count : items.length, items };
        },
      );
    },

    async listAccessibleRepositories(opts, signal) {
      return request(
        {
          path: `/user/repos`,
          query: {
            per_page: opts.perPage,
            page: opts.page,
            sort: "updated",
            affiliation: "owner,collaborator,organization_member",
          },
          ...(signal ? { signal } : {}),
        },
        (json) => {
          if (!Array.isArray(json)) throw new GithubApiError("Unexpected user repositories response shape.", 200);
          return json.flatMap((item) => (isRecord(item) ? [toRepoSummary(item)] : []));
        },
      );
    },
  };
}

function mapErrorResponse(response: Response, path: string, preview: string, hasToken: boolean): GithubApiError {
  const status = response.status;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const detail = preview.trim().length > 0 ? ` Response: ${preview.trim()}` : "";

  if (status === 401) {
    return new GithubApiError(
      `GitHub authentication failed (401) for ${path}. The configured GitHub token is missing or invalid; set MMR_GITHUB_TOKEN.${detail}`,
      status,
    );
  }
  if (status === 403 && remaining === "0") {
    const advice = hasToken
      ? "The authenticated rate limit is exhausted; wait for it to reset."
      : "The anonymous rate limit is exhausted; set MMR_GITHUB_TOKEN to raise the limit.";
    return new GithubApiError(`GitHub rate limit reached (403) for ${path}. ${advice}${detail}`, status, true);
  }
  if (status === 403) {
    const advice = hasToken ? "" : " This endpoint may require authentication; set MMR_GITHUB_TOKEN.";
    return new GithubApiError(`GitHub denied access (403) to ${path}.${advice}${detail}`, status);
  }
  if (status === 404) {
    return new GithubApiError(
      `GitHub resource not found (404) for ${path}. Check the repository, path, branch, or revision. Private repositories require a token with access.${detail}`,
      status,
    );
  }
  if (status === 422) {
    return new GithubApiError(`GitHub rejected the request (422) for ${path}; the query or parameters are invalid.${detail}`, status);
  }
  return new GithubApiError(`GitHub request to ${path} failed with status ${status}.${detail}`, status);
}
