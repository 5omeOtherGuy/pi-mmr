import {
  combineSignal,
  readErrorPreview,
  redactApiKey,
} from "../http-utils.js";
import { readSearchResponseBody } from "./body.js";
import {
  applyDomainFilter,
  BRAVE_FRESHNESS_BY_RECENCY,
} from "./filters.js";
import type {
  AppliedFilter,
  SearchArgs,
  SearchBackend,
  SearchResponse,
  SearchResultEntry,
} from "./types.js";

/**
 * Upstream candidate ceiling used when a domain post-filter is active, so we
 * retrieve a wider pool before narrowing to `maxResults`. Brave caps `count`
 * at 20.
 */
const DOMAIN_FILTER_CANDIDATE_COUNT = 20;

/**
 * Brave Search backend for `mmr-web`.
 *
 * Calls `https://api.search.brave.com/res/v1/web/search` with the
 * `X-Subscription-Token` header. Requires a `BRAVE_API_KEY`; the free
 * `Data for AI` subscription tier is sufficient.
 *
 * Re-exported through `../brave.ts` so existing callers/tests that still
 * import `braveSearch` from that path keep working.
 */
export const BRAVE_SEARCH_BASE = "https://api.search.brave.com/res/v1/web/search";

const DEFAULT_USER_AGENT = "pi-mmr-web/0.0.0";

export interface BraveSearchArgs extends SearchArgs {}

export interface BraveSearchResultEntry extends SearchResultEntry {}

export interface BraveSearchResponse extends SearchResponse {
  results: BraveSearchResultEntry[];
}

export interface BraveSearchOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  searchBase?: string;
  userAgent?: string;
}

function parseStructuredResults(rawText: string, maxResults: number): BraveSearchResultEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const web = (parsed as { web?: unknown }).web;
  if (!web || typeof web !== "object") return [];
  const results = (web as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : undefined;
      const url = typeof entry.url === "string" ? entry.url : undefined;
      const description = typeof entry.description === "string" ? entry.description : undefined;
      const ageSource = typeof entry.age === "string"
        ? entry.age
        : (typeof entry.page_age === "string" ? entry.page_age : undefined);
      const age = ageSource;
      const out: BraveSearchResultEntry = { title, url, description };
      if (age) out.age = age;
      return out;
    })
    .slice(0, maxResults);
}

export async function braveSearch(
  args: BraveSearchArgs,
  options: BraveSearchOptions = {},
): Promise<BraveSearchResponse> {
  if (!options.apiKey) {
    throw new Error(
      "web_search via Brave requires a BRAVE_API_KEY. Set the BRAVE_API_KEY environment variable (a free `Data for AI` subscription key is sufficient).",
    );
  }
  const query = args.query.trim();
  if (!query) {
    throw new Error("web_search requires a non-empty query (objective or search_queries[0]).");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(options.searchBase ?? BRAVE_SEARCH_BASE);
  url.searchParams.set("q", query);
  // Brave caps `count` at 20; mmr-web's MAX_MAX_RESULTS is already 10, but
  // clamp defensively in case callers pass a larger value through `maxResults`.
  const hasDomainFilter =
    (args.includeDomains?.length ?? 0) > 0 || (args.excludeDomains?.length ?? 0) > 0;
  const requestedCount = hasDomainFilter
    ? DOMAIN_FILTER_CANDIDATE_COUNT
    : Math.min(Math.max(args.maxResults, 1), 20);
  url.searchParams.set("count", String(requestedCount));
  if (args.country) url.searchParams.set("country", args.country.toUpperCase());
  // Recency maps natively to Brave's `freshness` parameter.
  if (args.recency) url.searchParams.set("freshness", BRAVE_FRESHNESS_BY_RECENCY[args.recency]);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Encoding": "gzip",
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    "X-Subscription-Token": options.apiKey,
  };

  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: combineSignal(args.signal, args.timeoutMs),
  });
  if (!response.ok) {
    const body = redactApiKey(await readErrorPreview(response), options.apiKey);
    throw new Error(
      `Brave search failed: HTTP ${response.status} ${response.statusText}${body ? ` \u2014 ${body}` : ""}`,
    );
  }
  const { text, body } = await readSearchResponseBody(
    response,
    args.maxResultBytes,
    "Brave search",
  );
  const candidates = parseStructuredResults(text, hasDomainFilter ? requestedCount : args.maxResults);
  const domainFiltered = applyDomainFilter(candidates, {
    includeDomains: args.includeDomains,
    excludeDomains: args.excludeDomains,
  });
  const results = domainFiltered.results.slice(0, args.maxResults);
  const appliedFilters: AppliedFilter[] = [...domainFiltered.applied];
  if (args.recency) {
    appliedFilters.push({ filter: "recency", support: "native", honored: "full" });
  }

  return { results, appliedFilters, ...body };
}

/**
 * Build a {@link SearchBackend} that calls Brave Search. The returned
 * object captures the `BraveSearchOptions` and exposes only the neutral
 * `search(args)` surface so `tools.ts` can swap in a different backend
 * without changes.
 */
export function createBraveSearchBackend(options: BraveSearchOptions): SearchBackend {
  return {
    id: "brave",
    search: (args) => braveSearch(args, options),
  };
}
