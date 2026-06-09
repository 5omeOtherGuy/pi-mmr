/**
 * Backend-neutral types for `mmr-web` search providers.
 *
 * Every search backend (Brave, SearXNG, DuckDuckGo) returns the same
 * normalized {@link SearchResponse} shape so `tools.ts` can format results
 * uniformly without knowing which backend served the call.
 */

/**
 * Stable id for the backend that produced a given result. Used in
 * `WebSearchDetails.backend`, `/mmr-status` rows, and provider diagnostics
 * so users can see which path actually serviced a call.
 */
export type SearchBackendId = "brave" | "searxng" | "duckduckgo";

export interface SearchResultEntry {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

/**
 * One user-requested search filter and how honestly the active backend was
 * able to apply it. `mmr-web` never silently drops a filter: every requested
 * filter produces exactly one {@link AppliedFilter} so the tool result can
 * report whether it was enforced natively, post-filtered locally, or could
 * not be honored at all.
 */
export type FilterName = "include_domains" | "exclude_domains" | "recency" | "country";

/** How a backend applied a given filter. */
export type FilterSupport = "native" | "post_filter" | "unsupported";

export interface AppliedFilter {
  filter: FilterName;
  support: FilterSupport;
  honored: "full" | "partial" | "none";
  /** Optional human-readable note, set when a filter is partial/unsupported. */
  reason?: string;
}

/** Recency window requested by the caller. */
export type Recency = "day" | "week" | "month" | "year";

export interface SearchResponse {
  results: SearchResultEntry[];
  rawText: string;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
  /**
   * Truthful per-filter enforcement report for the filters the caller
   * requested. Empty when no domain/recency filters were supplied.
   */
  appliedFilters: AppliedFilter[];
}

export interface SearchArgs {
  query: string;
  maxResults: number;
  signal?: AbortSignal;
  maxResultBytes: number;
  timeoutMs?: number;
  /**
   * Optional ISO 3166-1 alpha-2 country code for region targeting. Only the
   * Brave backend honors it natively; SearXNG and DuckDuckGo report it as an
   * unsupported filter (via {@link AppliedFilter}) rather than silently
   * dropping it.
   */
  country?: string;
  /** Keep only results whose hostname matches one of these domains (suffix-aware). */
  includeDomains?: string[];
  /** Drop results whose hostname matches one of these domains (suffix-aware). */
  excludeDomains?: string[];
  /** Restrict to results within this recency window when the backend supports it. */
  recency?: Recency;
}

export interface SearchBackend {
  /** Stable id returned in `WebSearchDetails.backend`. */
  readonly id: SearchBackendId;
  /** Execute one search call. */
  search(args: SearchArgs): Promise<SearchResponse>;
}
