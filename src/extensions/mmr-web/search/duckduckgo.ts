import {
  combineSignal,
  readErrorPreview,
} from "../http-utils.js";
import { readSearchResponseBody } from "./body.js";
import { applyDomainFilter } from "./filters.js";
import { validateExternalHttpUrl } from "../url-policy.js";
import type {
  AppliedFilter,
  SearchArgs,
  SearchBackend,
  SearchResponse,
  SearchResultEntry,
} from "./types.js";

/**
 * Candidate ceiling parsed from a DuckDuckGo page when a domain post-filter
 * is active, so we narrow a wider pool down to `maxResults`.
 */
const DOMAIN_FILTER_CANDIDATE_COUNT = 50;

/**
 * DuckDuckGo HTML fallback search backend for `mmr-web`.
 *
 * Calls the public `https://html.duckduckgo.com/html/` endpoint and parses
 * the rendered result blocks. No API key is required. This is the
 * built-in no-key default that ships when the user has not configured
 * SearXNG and has not set `BRAVE_API_KEY`.
 *
 * Best-effort caveats (surfaced to users via descriptions and diagnostics):
 *
 * - DuckDuckGo aggressively rate-limits / bot-blocks HTML-endpoint scraping.
 *   When the response looks like a bot challenge or empty challenge page,
 *   the backend throws an actionable error pointing at SearXNG/Brave as a
 *   more reliable option.
 * - Result URLs are wrapped through a `/l/?uddg=<encoded>` redirect; we
 *   decode them locally so callers receive canonical URLs.
 * - We never follow the redirect server-side, so DuckDuckGo's click-tracker
 *   is not exercised and the model never receives the tracker URL itself.
 * - Every decoded URL is filtered through {@link validateExternalHttpUrl}
 *   so a tampered/proxied result row cannot inject loopback/private hosts.
 *
 * Bounded resource use:
 *
 * - In-memory LRU-ish query cache (TTL 2 min, max 32 entries) so repeated
 *   `web_search` calls for the same query do not hammer DuckDuckGo.
 * - Per-process backoff window (60 s) opened on the first detected
 *   bot/empty page; subsequent calls fail fast with the actionable error
 *   instead of issuing more requests during the cool-down.
 */
export const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;
const BLOCK_BACKOFF_MS = 60 * 1000;

const BLOCK_HINT = "DuckDuckGo no-key search is rate-limited or blocked. Configure MMR_WEB_SEARXNG_URL or BRAVE_API_KEY for higher reliability.";

interface CacheEntry {
  expiresAt: number;
  response: DuckDuckGoSearchResponse;
}

interface DuckDuckGoState {
  cache: Map<string, CacheEntry>;
  blockedUntil: number;
}

function createState(): DuckDuckGoState {
  return { cache: new Map(), blockedUntil: 0 };
}

const moduleState: DuckDuckGoState = createState();

export interface DuckDuckGoSearchArgs extends SearchArgs {}

export interface DuckDuckGoSearchResultEntry extends SearchResultEntry {}

export interface DuckDuckGoSearchResponse extends SearchResponse {
  results: DuckDuckGoSearchResultEntry[];
}

export interface DuckDuckGoSearchOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  endpoint?: string;
  /**
   * Override the wall clock used for cache TTL / backoff bookkeeping.
   * Tests inject a deterministic clock so suites stay deterministic.
   */
  now?: () => number;
  /**
   * Inject a private state container so tests can exercise cache hits and
   * backoff windows without leaking state across test cases. When omitted,
   * the module-level singleton is used (process lifetime).
   */
  state?: DuckDuckGoState;
}

/** Test-only: reset the module-level cache/backoff. */
export function __resetDuckDuckGoStateForTests(): void {
  moduleState.cache.clear();
  moduleState.blockedUntil = 0;
}

function cacheKey(query: string, maxResults: number, args: DuckDuckGoSearchArgs): string {
  const include = (args.includeDomains ?? []).join(",");
  const exclude = (args.excludeDomains ?? []).join(",");
  const recency = args.recency ?? "";
  return [query, maxResults, include, exclude, recency].join("\u0000");
}

function readCache(state: DuckDuckGoState, key: string, now: number): DuckDuckGoSearchResponse | undefined {
  const entry = state.cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    state.cache.delete(key);
    return undefined;
  }
  // Refresh recency (LRU-ish).
  state.cache.delete(key);
  state.cache.set(key, entry);
  return entry.response;
}

function writeCache(state: DuckDuckGoState, key: string, response: DuckDuckGoSearchResponse, now: number): void {
  state.cache.set(key, { expiresAt: now + CACHE_TTL_MS, response });
  while (state.cache.size > CACHE_MAX_ENTRIES) {
    const oldest = state.cache.keys().next().value;
    if (oldest === undefined) break;
    state.cache.delete(oldest);
  }
}

function decodeHtmlEntities(text: string): string {
  // The `&amp;` -> `&` step must run LAST so a double-encoded sequence such as
  // `&amp;lt;` decodes to the literal text `&lt;` rather than being unescaped
  // twice into `<`.
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&");
}

function stripTags(text: string): string {
  // Repeat until stable so a tag that only appears after an inner match is
  // removed (e.g. `<scr<script>ipt>`) cannot survive a single pass.
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return out;
}

/**
 * Decode the canonical URL out of DuckDuckGo's click-tracker wrapper:
 * `https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=...`
 * \u2192 `https://example.com/`. Returns the input unchanged when it does not
 * look like the click tracker.
 */
export function decodeDuckDuckGoRedirect(rawHref: string): string {
  if (!rawHref) return rawHref;
  // DDG emits protocol-relative URLs (`//duckduckgo.com/...`); normalize so
  // we can parse with URL().
  const trimmed = rawHref.trim();
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return rawHref;
  }
  if (!/duckduckgo\.com$/i.test(parsed.hostname) || !parsed.pathname.startsWith("/l/")) {
    return rawHref;
  }
  const uddg = parsed.searchParams.get("uddg");
  // URLSearchParams.get() already decodes percent escapes exactly once.
  // Decoding again would corrupt target URLs that intentionally contain
  // encoded percent bytes (for example `%2520` must remain `%2520`).
  return uddg || rawHref;
}

function detectBlockedPage(text: string): boolean {
  const head = text.slice(0, 4096).toLowerCase();
  if (head.includes("anomaly") || head.includes("unable to process your request")) return true;
  // DuckDuckGo's bot challenge page is mostly empty of result blocks and
  // contains the captcha form.
  if (head.includes("verify you are a human") || head.includes("captcha")) return true;
  return false;
}

/**
 * Parse the rendered result rows out of DuckDuckGo's HTML response.
 *
 * The structure (stable as of late 2025) is:
 *   <div class="result results_links results_links_deep web-result">
 *     <h2 class="result__title">
 *       <a class="result__a" href="//duckduckgo.com/l/?uddg=...">Title</a>
 *     </h2>
 *     <a class="result__snippet" href="...">Snippet text</a>
 *   </div>
 */
function parseResultRows(html: string, maxResults: number): DuckDuckGoSearchResultEntry[] {
  const out: DuckDuckGoSearchResultEntry[] = [];
  const rowRe = /<div\s+class="result\s+results_links[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    if (out.length >= maxResults) break;
    const block = match[1] ?? "";
    const titleAnchorRe = /<a\s+[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
    const titleMatch = titleAnchorRe.exec(block);
    if (!titleMatch) continue;
    const rawHref = decodeHtmlEntities(titleMatch[1] ?? "");
    const decodedUrl = decodeDuckDuckGoRedirect(rawHref);
    const validated = validateExternalHttpUrl(decodedUrl);
    if (!validated.ok) continue;

    const title = decodeHtmlEntities(stripTags(titleMatch[2] ?? "")).trim();

    const snippetRe = /<a\s+[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
    const snippetMatch = snippetRe.exec(block);
    const description = snippetMatch
      ? decodeHtmlEntities(stripTags(snippetMatch[1] ?? "")).trim()
      : undefined;

    const entry: DuckDuckGoSearchResultEntry = {
      title: title || undefined,
      url: decodedUrl,
      description,
    };
    out.push(entry);
  }
  return out;
}

export async function duckduckgoSearch(
  args: DuckDuckGoSearchArgs,
  options: DuckDuckGoSearchOptions = {},
): Promise<DuckDuckGoSearchResponse> {
  const query = args.query.trim();
  if (!query) {
    throw new Error("web_search requires a non-empty query (objective or search_queries[0]).");
  }
  const state = options.state ?? moduleState;
  const now = options.now ?? Date.now;
  const ts = now();

  // Backoff: if we recently hit a bot challenge, fail fast.
  if (ts < state.blockedUntil) {
    throw new Error(`${BLOCK_HINT} (Backoff active for ${Math.ceil((state.blockedUntil - ts) / 1000)}s.)`);
  }

  const key = cacheKey(query, args.maxResults, args);
  const cached = readCache(state, key, ts);
  if (cached) return cached;

  const hasDomainFilter =
    (args.includeDomains?.length ?? 0) > 0 || (args.excludeDomains?.length ?? 0) > 0;

  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? DUCKDUCKGO_HTML_ENDPOINT;
  const url = new URL(endpoint);
  url.searchParams.set("q", query);

  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": options.userAgent ?? BROWSER_USER_AGENT,
  };

  // DuckDuckGo prefers POST for the HTML endpoint; both verbs work, but POST
  // matches the form the browser submits and is less likely to trip the bot
  // heuristic on the GET-with-querystring path.
  const body = new URLSearchParams();
  body.set("q", query);
  body.set("b", "");
  body.set("kl", "us-en");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: combineSignal(args.signal, args.timeoutMs),
  });
  if (!response.ok) {
    const preview = await readErrorPreview(response);
    // Treat 403/429 as a block signal so subsequent calls back off.
    if (response.status === 403 || response.status === 429) {
      state.blockedUntil = ts + BLOCK_BACKOFF_MS;
      throw new Error(`${BLOCK_HINT} (HTTP ${response.status})`);
    }
    throw new Error(
      `DuckDuckGo HTML search failed: HTTP ${response.status} ${response.statusText}${preview ? ` \u2014 ${preview}` : ""}`,
    );
  }
  const { text, body: responseBody } = await readSearchResponseBody(
    response,
    args.maxResultBytes,
    "DuckDuckGo HTML search",
  );
  if (detectBlockedPage(text)) {
    state.blockedUntil = ts + BLOCK_BACKOFF_MS;
    throw new Error(BLOCK_HINT);
  }
  const candidates = parseResultRows(
    text,
    hasDomainFilter ? DOMAIN_FILTER_CANDIDATE_COUNT : args.maxResults,
  );

  // Empty-result page with no matching markers is a softer block signal:
  // surface the same hint but do not open the backoff window (the user may
  // legitimately have an obscure query). This is evaluated on the parsed
  // page, before domain filtering: a domain filter legitimately yielding
  // zero matches is not a block signal.
  if (candidates.length === 0 && !text.toLowerCase().includes("no results")) {
    throw new Error(
      `DuckDuckGo HTML search returned no parseable result rows. ${BLOCK_HINT}`,
    );
  }

  const domainFiltered = applyDomainFilter(candidates, {
    includeDomains: args.includeDomains,
    excludeDomains: args.excludeDomains,
  });
  const results = domainFiltered.results.slice(0, args.maxResults);
  const appliedFilters: AppliedFilter[] = [...domainFiltered.applied];
  if (args.recency) {
    // DuckDuckGo's HTML results do not expose reliable publication dates, so
    // recency cannot be honored without faking it. Report it truthfully.
    appliedFilters.push({
      filter: "recency",
      support: "unsupported",
      honored: "none",
      reason:
        "DuckDuckGo HTML results do not expose reliable publication dates; configure SearXNG or Brave to filter by recency.",
    });
  }

  const out: DuckDuckGoSearchResponse = { results, appliedFilters, ...responseBody };
  writeCache(state, key, out, ts);
  return out;
}

/**
 * Build a {@link SearchBackend} that scrapes the DuckDuckGo HTML endpoint.
 * Best-effort; the surrounding `mmr-web` diagnostics label this backend so
 * users know they can configure SearXNG/Brave for higher reliability.
 */
export function createDuckDuckGoSearchBackend(options: DuckDuckGoSearchOptions = {}): SearchBackend {
  return {
    id: "duckduckgo",
    search: (args) => duckduckgoSearch(args, options),
  };
}
