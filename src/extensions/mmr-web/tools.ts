import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import {
  getReader,
  getSearchBackend,
  resolveBackend,
  type ResolvedBackend,
  type SearchClientOverrides,
} from "./backend.js";
import type { BraveClientOptions } from "./brave.js";
import type { MmrWebSettings } from "./config.js";
import {
  applyFinalContentCap,
  EXCERPT_SEPARATOR,
  extractObjectiveRelevantExcerpts,
} from "./excerpts.js";
import type { CustomReaderOptions } from "./reader/direct.js";
import type { AppliedFilter, Recency, SearchResultEntry } from "./search/types.js";

export const DEFAULT_MAX_RESULTS = 5;
export const MAX_MAX_RESULTS = 10;
export const MIN_MAX_RESULTS = 1;
/** Cap on the number of domains accepted per include/exclude list. */
export const MAX_DOMAIN_FILTERS = 20;
export const RECENCY_VALUES = ["day", "week", "month", "year"] as const;

export const WEB_SEARCH_PARAMETERS_SCHEMA = Type.Object({
  objective: Type.String({
    description:
      "A natural-language description of the broader task or research goal, including any source or freshness guidance.",
  }),
  search_queries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional keyword queries to ensure matches for specific terms are prioritized. The first non-empty query is sent to the upstream search engine.",
    }),
  ),
  max_results: Type.Optional(
    Type.Number({
      description: `Soft cap on returned results, clamped to [${MIN_MAX_RESULTS}, ${MAX_MAX_RESULTS}]. Default ${DEFAULT_MAX_RESULTS}.`,
    }),
  ),
  include_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Best-effort allowlist of domains to restrict results to (e.g. [\"example.com\"]). Scheme/`www.`/path are stripped and the host is matched suffix-aware (a domain also matches its subdomains). Enforced natively or by local post-filter depending on the backend; see details.filters.",
    }),
  ),
  exclude_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Best-effort blocklist of domains to drop from results. Same normalization and suffix-aware matching as include_domains. A domain cannot appear in both lists. See details.filters for actual enforcement.",
    }),
  ),
  recency: Type.Optional(
    Type.Union(
      RECENCY_VALUES.map((value) => Type.Literal(value)),
      {
        description:
          "Restrict to results published within this window (day/week/month/year). Honored natively where the backend supports it; backends without reliable result dates (e.g. DuckDuckGo) report it as unsupported in details.filters rather than faking it.",
      },
    ),
  ),
});

export const READ_WEB_PAGE_PARAMETERS_SCHEMA = Type.Object({
  url: Type.String({
    description:
      "Public http(s) URL to fetch and convert to text. Must NOT be used for localhost, private IPs, link-local hosts, or non-Internet URLs.",
  }),
  objective: Type.Optional(
    Type.String({
      description:
        "A natural-language description of the research goal. If set, only relevant excerpts will be returned. If not set, the full Markdown content of the web page will be returned.",
    }),
  ),
  forceRefetch: Type.Optional(
    Type.Boolean({
      description:
        "Force a live fetch of the URL (default: use a cached version that may be a few days old). Set to true when freshness is important or when the user asks for the latest or recent contents.",
    }),
  ),
});

export const webSearchParameters = WEB_SEARCH_PARAMETERS_SCHEMA;
export const readWebPageParameters = READ_WEB_PAGE_PARAMETERS_SCHEMA;

export const WEB_SEARCH_PROMPT_SNIPPET =
  "Search the public web for a research objective";
export const READ_WEB_PAGE_PROMPT_SNIPPET =
  "Fetch a public http(s) page through mmr-web's custom reader and return Markdown text";

export const WEB_SEARCH_PROMPT_GUIDELINES = [
  "Use web_search when you need up-to-date or precise documentation. Use read_web_page for fetching full content from a specific URL.",
  "Use web_search only for public, non-sensitive research; do not include secrets, API keys, or private data in web_search.objective or web_search.search_queries.",
] as const;
export const READ_WEB_PAGE_PROMPT_GUIDELINES = [
  "Use read_web_page to read the contents of a web page at a given URL. When only the url parameter is set, read_web_page returns the contents as Markdown; when an objective is provided, read_web_page returns excerpts relevant to that objective.",
  "Pass forceRefetch: true to read_web_page when the user asks for the latest or recent contents.",
  "Use read_web_page only for public http(s) pages; do not use read_web_page for localhost, private IPs, link-local hosts, or non-Internet URLs.",
] as const;

export const WEB_SEARCH_DESCRIPTION =
  "Search the web for information relevant to a research objective. Use when you need up-to-date or precise documentation. Use `read_web_page` to fetch full content from a specific URL. " +
  "The active backend is one of: SearXNG (user-configured self-hosted instance via MMR_WEB_SEARXNG_URL, no API key required), Brave Search (requires BRAVE_API_KEY; a free `Data for AI` subscription key is sufficient), or DuckDuckGo HTML (built-in no-key fallback, best-effort and may be rate-limited). " +
  "Optional filters are best-effort per backend: `include_domains`/`exclude_domains` restrict or drop results by host (suffix-aware, so a domain also matches its subdomains) and `recency` (day/week/month/year) restricts by publication window. A backend honors each filter natively, via local post-filter, or reports it as unsupported; `details.filters` reports the actual enforcement for every requested filter so nothing is silently ignored. " +
  "Do NOT include secrets, API keys, or private data in the objective or search queries; they are sent to the upstream search engine.";
export const READ_WEB_PAGE_DESCRIPTION =
  "Read the contents of a web page at a given URL. When only the url parameter is set, it returns the contents of the webpage converted to Markdown. When an objective is provided, it returns excerpts relevant to that objective. If the user asks for the latest or recent contents, pass `forceRefetch: true` to ensure the latest content is fetched. " +
  "Do NOT use for localhost, private IPs, link-local hosts, or non-Internet URLs. Content is fetched directly through mmr-web's custom in-process reader, converted to Markdown with Readability + Turndown when available, and falls back to the lightweight built-in extractor when the page is not article-like or the Markdown pipeline cannot load.";

export type WebSearchParams = Static<typeof WEB_SEARCH_PARAMETERS_SCHEMA>;
export type ReadWebPageParams = Static<typeof READ_WEB_PAGE_PARAMETERS_SCHEMA>;

export interface MmrWebToolDeps {
  getSettings: () => MmrWebSettings;
  /**
   * Combined client options shared across the Brave search backend and the
   * custom direct reader. A single hook is kept for back-compat with
   * existing tests; it can be widened to per-backend factories later.
   */
  getBraveOptions?: () => BraveClientOptions;
}

export interface WebSearchDetails {
  backend: ResolvedBackend;
  query: string;
  apiKeyPresent: boolean;
  maxResults: number;
  resultCount: number;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
  /**
   * Truthful per-filter enforcement report for any domain/recency filters
   * the caller requested. Empty when no filters were supplied.
   */
  filters: AppliedFilter[];
}

export interface ReadWebPageDetails {
  backend: ResolvedBackend;
  url: string;
  forceRefetch: boolean;
  truncated: boolean;
  totalBytes: number;
  bytes: number;
  objective?: string;
  objectiveApplied: boolean;
  excerpted: boolean;
  excerptCount: number;
  fallbackReason?: "blank_objective" | "no_relevant_excerpts" | "no_readable_content";
  /**
   * Set when the page was fetched successfully but yielded no readable
   * static content (JavaScript app shell, placeholder-only, or empty). The
   * tool returns an honest diagnostic instead of misleading boilerplate.
   */
  readableContentFound?: boolean;
  extractionReason?: "requires_javascript" | "placeholder_only" | "empty";
}

/**
 * Normalize a user-supplied domain to a bare lowercase host: drop scheme,
 * userinfo, path/query/fragment, port, a leading `www.`, and a trailing dot.
 * Returns "" when nothing usable remains.
 */
export function normalizeDomainInput(value: string): string {
  let host = value.trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/, 1)[0] ?? "";
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  host = host.replace(/:\d+$/, "");
  host = host.replace(/^www\./, "");
  host = host.replace(/\.+$/, "");
  return host;
}

function normalizeDomainList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const host = normalizeDomainInput(entry);
    if (host && !out.includes(host)) out.push(host);
    if (out.length >= MAX_DOMAIN_FILTERS) break;
  }
  return out;
}

function clampMaxResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, Math.floor(value)));
}

function pickQuery(objective: string, searchQueries: unknown): string {
  if (Array.isArray(searchQueries)) {
    const first = searchQueries
      .filter((entry): entry is string => typeof entry === "string")
      .map((query) => query.trim())
      .find((query) => query.length > 0);
    if (first) return first;
  }
  return objective.trim();
}

function coerceWebSearchParams(raw: unknown): WebSearchParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("web_search expects an object with at least an objective field.");
  }
  const params = checkMmrToolParams("web_search", WEB_SEARCH_PARAMETERS_SCHEMA, raw);
  if (params.objective.trim().length === 0) {
    throw new Error("web_search.objective is required and must be a non-empty string.");
  }
  return params;
}

function coerceReadWebPageParams(raw: unknown): ReadWebPageParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("read_web_page expects an object with at least a url field.");
  }
  const params = checkMmrToolParams("read_web_page", READ_WEB_PAGE_PARAMETERS_SCHEMA, raw);
  if (params.url.trim().length === 0) {
    throw new Error("read_web_page.url is required and must be a non-empty string.");
  }
  return params;
}

function getCombinedOptions(deps: MmrWebToolDeps): BraveClientOptions {
  if (deps.getBraveOptions) return deps.getBraveOptions();
  const settings = deps.getSettings();
  return { apiKey: settings.braveApiKey };
}

function splitSearchOverrides(opts: BraveClientOptions & {
  searxngEnsureRunning?: () => Promise<void>;
  searxngNoteUse?: () => void;
}): SearchClientOverrides {
  const out: SearchClientOverrides = {};
  if (opts.fetchImpl !== undefined) out.fetchImpl = opts.fetchImpl;
  if (opts.searchBase !== undefined) out.searchBase = opts.searchBase;
  if (opts.userAgent !== undefined) out.userAgent = opts.userAgent;
  if (opts.searxngEnsureRunning !== undefined) out.searxngEnsureRunning = opts.searxngEnsureRunning;
  if (opts.searxngNoteUse !== undefined) out.searxngNoteUse = opts.searxngNoteUse;
  return out;
}

function splitReaderOptions(opts: BraveClientOptions): CustomReaderOptions {
  const out: CustomReaderOptions = {};
  if (opts.fetchImpl !== undefined) out.fetchImpl = opts.fetchImpl;
  if (opts.userAgent !== undefined) out.userAgent = opts.userAgent;
  if (opts.lookup !== undefined) out.lookup = opts.lookup;
  if (opts.apiKey !== undefined) out.apiKey = opts.apiKey;
  return out;
}

function formatSearchResults(query: string, results: ReadonlyArray<SearchResultEntry>, rawText: string): string {
  if (results.length === 0) {
    return [
      `# Web search results for: ${query}`,
      "",
      "(No structured results parsed from the upstream response; raw response below.)",
      "",
      rawText,
    ].join("\n");
  }
  const lines: string[] = [`# Web search results for: ${query}`, ""];
  results.forEach((entry, index) => {
    lines.push(`## ${index + 1}. ${entry.title ?? "(untitled)"}`);
    if (entry.url) lines.push(entry.url);
    // Brave entries can carry an `age` field (e.g. "2 days ago"). Surface it
    // inline so the model can use the freshness signal when deciding whether
    // to dig further.
    const age = "age" in entry && typeof entry.age === "string" ? entry.age : undefined;
    if (age) lines.push(`Age: ${age}`);
    if (entry.description) {
      lines.push("");
      lines.push(entry.description);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

export function createWebSearchTool(deps: MmrWebToolDeps): ToolDefinition {
  return {
    name: "web_search",
    label: "web_search",
    description: WEB_SEARCH_DESCRIPTION,
    promptSnippet: WEB_SEARCH_PROMPT_SNIPPET,
    promptGuidelines: [...WEB_SEARCH_PROMPT_GUIDELINES],
    parameters: webSearchParameters,
    async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<WebSearchDetails>> {
      const params = coerceWebSearchParams(rawParams);
      const settings = deps.getSettings();
      const maxResults = clampMaxResults(params.max_results);
      const query = pickQuery(params.objective, params.search_queries);
      const includeDomains = normalizeDomainList(params.include_domains);
      const excludeDomains = normalizeDomainList(params.exclude_domains);
      const conflict = includeDomains.find((domain) => excludeDomains.includes(domain));
      if (conflict) {
        throw new Error(
          `web_search: "${conflict}" cannot appear in both include_domains and exclude_domains.`,
        );
      }
      const recency = params.recency as Recency | undefined;
      const combined = getCombinedOptions(deps);
      const backend = getSearchBackend(settings, splitSearchOverrides(combined));
      if (!backend) {
        const decision = resolveBackend("web_search", settings);
        throw new Error(`web_search is unavailable: ${decision.message}`);
      }

      const response = await backend.search({
        query,
        maxResults,
        signal,
        maxResultBytes: settings.maxResultBytes,
        timeoutMs: settings.searchTimeoutMs,
        ...(includeDomains.length > 0 ? { includeDomains } : {}),
        ...(excludeDomains.length > 0 ? { excludeDomains } : {}),
        ...(recency ? { recency } : {}),
      });
      return {
        content: [{ type: "text", text: formatSearchResults(query, response.results, response.rawText) }],
        details: {
          backend: backend.id,
          query,
          apiKeyPresent: Boolean(settings.braveApiKey),
          maxResults,
          resultCount: response.results.length,
          truncated: response.truncated,
          bytes: response.bytes,
          totalBytes: response.totalBytes,
          filters: response.appliedFilters,
        },
      };
    },
  } satisfies ToolDefinition;
}

export function createReadWebPageTool(deps: MmrWebToolDeps): ToolDefinition {
  return {
    name: "read_web_page",
    label: "read_web_page",
    description: READ_WEB_PAGE_DESCRIPTION,
    promptSnippet: READ_WEB_PAGE_PROMPT_SNIPPET,
    promptGuidelines: [...READ_WEB_PAGE_PROMPT_GUIDELINES],
    parameters: readWebPageParameters,
    async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<ReadWebPageDetails>> {
      const params = coerceReadWebPageParams(rawParams);
      const settings = deps.getSettings();
      const forceRefetch = Boolean(params.forceRefetch);
      const combined = getCombinedOptions(deps);
      const reader = getReader(settings, splitReaderOptions(combined));
      if (!reader) {
        const decision = resolveBackend("read_web_page", settings);
        throw new Error(`read_web_page is unavailable: ${decision.message}`);
      }

      const response = await reader.read({
        url: params.url,
        signal,
        maxResultBytes: settings.maxResultBytes,
        timeoutMs: settings.readTimeoutMs,
      });

      const rawObjective = params.objective;
      const trimmedObjective = typeof rawObjective === "string" ? rawObjective.trim() : "";
      const objectiveProvided = typeof rawObjective === "string" && rawObjective.length > 0;
      const objectiveApplied = trimmedObjective.length > 0;

      const baseDetails: ReadWebPageDetails = {
        backend: reader.id,
        url: response.url,
        forceRefetch,
        truncated: response.truncated,
        totalBytes: response.totalBytes,
        bytes: response.bytes,
        objectiveApplied,
        excerpted: false,
        excerptCount: 0,
      };
      if (objectiveProvided && rawObjective !== undefined) baseDetails.objective = rawObjective;

      // A fetched-but-unreadable page (JS app shell, placeholder-only, or
      // empty) carries an honest diagnostic in `content`. Return it as-is
      // and never excerpt it, regardless of any objective.
      if (response.readableContentFound === false) {
        baseDetails.readableContentFound = false;
        if (response.extractionReason) baseDetails.extractionReason = response.extractionReason;
        baseDetails.fallbackReason = "no_readable_content";
        const capped = applyFinalContentCap(response.content);
        return { content: [{ type: "text", text: capped.text }], details: baseDetails };
      }

      if (!objectiveApplied) {
        if (objectiveProvided) baseDetails.fallbackReason = "blank_objective";
        const capped = applyFinalContentCap(response.content);
        return { content: [{ type: "text", text: capped.text }], details: baseDetails };
      }

      const extraction = extractObjectiveRelevantExcerpts({
        markdown: response.content,
        objective: trimmedObjective,
        maxBytes: settings.maxResultBytes,
      });
      if (!extraction.excerpted || extraction.excerpts.length === 0) {
        baseDetails.fallbackReason = "no_relevant_excerpts";
        const capped = applyFinalContentCap(response.content);
        return { content: [{ type: "text", text: capped.text }], details: baseDetails };
      }
      const joined = extraction.excerpts.join(EXCERPT_SEPARATOR);
      const capped = applyFinalContentCap(joined);
      baseDetails.excerpted = true;
      baseDetails.excerptCount = extraction.excerpts.length;
      return { content: [{ type: "text", text: capped.text }], details: baseDetails };
    },
  } satisfies ToolDefinition;
}

export interface RegisterMmrWebToolsResult {
  searchRegistered: boolean;
  readerRegistered: boolean;
}

/**
 * Register the concrete Pi tools for `mmr-web` based on the current settings.
 *
 * - When network access is disabled, no Pi tools are registered. The
 *   `mmr-web` tool provider still emits `gated` decisions so users see why
 *   the tools are unavailable.
 * - When network is enabled, both tools register. `web_search` uses Brave
 *   Search and reports a direct BRAVE_API_KEY setup error if the key is
 *   missing; `read_web_page` uses the custom in-process reader and needs no
 *   provider API key.
 */
export function registerMmrWebTools(pi: ExtensionAPI, deps: MmrWebToolDeps): RegisterMmrWebToolsResult {
  const settings = deps.getSettings();
  if (!settings.enabled) {
    return { searchRegistered: false, readerRegistered: false };
  }

  let searchRegistered = false;
  const searchDecision = resolveBackend("web_search", settings);
  if (searchDecision.backend) {
    registerMmrOwnedTool("web_search");
    pi.registerTool(createWebSearchTool(deps));
    searchRegistered = true;
  }

  let readerRegistered = false;
  const readerDecision = resolveBackend("read_web_page", settings);
  if (readerDecision.backend) {
    registerMmrOwnedTool("read_web_page");
    pi.registerTool(createReadWebPageTool(deps));
    readerRegistered = true;
  }
  return { searchRegistered, readerRegistered };
}
