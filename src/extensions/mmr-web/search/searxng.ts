import {
  combineSignal,
  readErrorPreview,
} from "../http-utils.js";
import { readSearchResponseBody } from "./body.js";
import {
  applyDomainFilter,
  SEARXNG_TIME_RANGE_BY_RECENCY,
} from "./filters.js";
import { validateExternalHttpUrl, validateSearXNGUrl } from "../url-policy.js";
import type {
  AppliedFilter,
  SearchArgs,
  SearchBackend,
  SearchResponse,
  SearchResultEntry,
} from "./types.js";

/**
 * Candidate ceiling parsed from a SearXNG page when a domain post-filter is
 * active, so we narrow a wider pool down to `maxResults`.
 */
const DOMAIN_FILTER_CANDIDATE_COUNT = 50;

/**
 * SearXNG search backend for `mmr-web`.
 *
 * Calls a user-configured SearXNG instance over its JSON API:
 *
 *   GET ${url}/search?q=...&format=json&safesearch=1&language=en
 *
 * SearXNG is a self-hosted meta-search engine that aggregates results from
 * multiple upstream engines (DuckDuckGo, Bing, Brave, Google, etc.) without
 * requiring an API key. The user must run their own instance (typically at
 * `http://127.0.0.1:8080` via Docker or `searxng/searxng`) and configure
 * the URL through `MMR_WEB_SEARXNG_URL` or `mmrWeb.searxngUrl`.
 *
 * Important deployment note: SearXNG's default `settings.yml` ships with
 * `formats: [html]` only. The instance owner must enable JSON output:
 *
 *   search:
 *     formats:
 *       - html\n   *       - json
 *
 * This backend detects an HTML response (JSON disabled) and throws an
 * actionable error pointing at that setting.
 *
 * Result URL safety: every `url` returned by SearXNG is filtered through
 * {@link validateExternalHttpUrl} before being surfaced to the model, so a\n * misconfigured upstream engine that returns loopback/private URLs cannot\n * leak them into the agent context.
 */
export const SEARXNG_DEFAULT_PATH = "/search";

const DEFAULT_USER_AGENT = "pi-mmr-web/0.0.0";

export interface SearXNGSearchArgs extends SearchArgs {}

export interface SearXNGSearchResultEntry extends SearchResultEntry {}

export interface SearXNGSearchResponse extends SearchResponse {
  results: SearXNGSearchResultEntry[];
}

export interface SearXNGSearchOptions {
  /** Base URL of the SearXNG instance, e.g. `http://127.0.0.1:8080`. */
  url: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /**
   * Optional pre-search hook used by the managed-sidecar wiring to spawn
   * a local SearXNG instance on demand and reset its idle timer. The
   * default `createSearXNGSearchBackend` factory leaves this unset; the
   * `getSearchBackend` factory in `backend.ts` plugs it in when
   * `mmrWeb.searxngManaged=true`.
   */
  ensureRunning?: () => Promise<void>;
  /** Optional post-search hook used by the managed-sidecar wiring to reset the idle timer. */
  noteUse?: () => void;
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 256).trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}

function parseStructuredResults(rawText: string, maxResults: number): SearXNGSearchResultEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const out: SearXNGSearchResultEntry[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : undefined;
    const rawUrl = typeof record.url === "string" ? record.url : undefined;
    const description = typeof record.content === "string"
      ? record.content
      : (typeof record.description === "string" ? record.description : undefined);
    const publishedDate = typeof record.publishedDate === "string"
      ? record.publishedDate
      : (typeof record.pubdate === "string" ? record.pubdate : undefined);

    // Reject any result URL that fails the public-web policy. This protects
    // against a misconfigured upstream engine surfacing loopback/private
    // hosts, file:// URLs, javascript:..., etc.
    if (rawUrl !== undefined) {
      const validated = validateExternalHttpUrl(rawUrl);
      if (!validated.ok) continue;
    }

    const item: SearXNGSearchResultEntry = { title, url: rawUrl, description };
    if (publishedDate) item.age = publishedDate;
    out.push(item);
    if (out.length >= maxResults) break;
  }
  return out;
}

export async function searxngSearch(
  args: SearXNGSearchArgs,
  options: SearXNGSearchOptions,
): Promise<SearXNGSearchResponse> {
  const validated = validateSearXNGUrl(options.url);
  if (!validated.ok) {
    throw new Error(`SearXNG URL invalid: ${validated.reason}`);
  }
  const query = args.query.trim();
  if (!query) {
    throw new Error("web_search requires a non-empty query (objective or search_queries[0]).");
  }
  if (options.ensureRunning) {
    await options.ensureRunning();
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  const base = validated.url;
  // Ensure exactly one `/search` path segment, honoring any base path the\n  // user already included (some deployments serve SearXNG under a prefix\n  // like `/searx/`).
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const url = new URL(base.toString());
  url.pathname = `${basePath}${SEARXNG_DEFAULT_PATH}`;
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "1");
  url.searchParams.set("language", "en");
  if (args.country) url.searchParams.set("country", args.country.toLowerCase());
  // Recency maps natively to SearXNG's `time_range` parameter.
  if (args.recency) url.searchParams.set("time_range", SEARXNG_TIME_RANGE_BY_RECENCY[args.recency]);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
  };

  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: combineSignal(args.signal, args.timeoutMs),
  });
  if (!response.ok) {
    const body = await readErrorPreview(response);
    throw new Error(
      `SearXNG search failed: HTTP ${response.status} ${response.statusText}${body ? ` \u2014 ${body}` : ""}`,
    );
  }
  const { text, body } = await readSearchResponseBody(
    response,
    args.maxResultBytes,
    "SearXNG search",
  );
  if (looksLikeHtml(text)) {
    throw new Error(
      `SearXNG search failed: instance at ${options.url} returned HTML instead of JSON. Enable JSON output in your SearXNG settings.yml under \`search.formats\` (add \`- json\`) and reload the instance.`,
    );
  }
  const hasDomainFilter =
    (args.includeDomains?.length ?? 0) > 0 || (args.excludeDomains?.length ?? 0) > 0;
  const candidates = parseStructuredResults(
    text,
    hasDomainFilter ? DOMAIN_FILTER_CANDIDATE_COUNT : args.maxResults,
  );
  const domainFiltered = applyDomainFilter(candidates, {
    includeDomains: args.includeDomains,
    excludeDomains: args.excludeDomains,
  });
  const results = domainFiltered.results.slice(0, args.maxResults);
  const appliedFilters: AppliedFilter[] = [...domainFiltered.applied];
  if (args.recency) {
    appliedFilters.push({ filter: "recency", support: "native", honored: "full" });
  }

  if (options.noteUse) options.noteUse();

  return { results, appliedFilters, ...body };
}

/**
 * Build a {@link SearchBackend} that calls a user-configured SearXNG
 * instance. The instance URL is validated up front so a missing/garbled
 * URL fails fast rather than producing a confusing fetch error.
 */
export function createSearXNGSearchBackend(options: SearXNGSearchOptions): SearchBackend {
  return {
    id: "searxng",
    search: (args) => searxngSearch(args, options),
  };
}
