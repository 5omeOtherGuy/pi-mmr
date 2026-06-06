# mmr-web

Network-backed extension. Owns the `web_search` and `read_web_page` logical tools and registers concrete Pi tools when network access is enabled.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`ROADMAP.md`](ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off | `web_search`, `read_web_page` | `MMR_WEB_ENABLE=true` or `mmrWeb.enabled=true` | `/mmr-status`, tool result `details` |

## When to use it

- The agent needs to look up public information that isn't already in the workspace.
- You want a Markdown-friendly fetch of a specific public page for the model to read.
- You want safe, opt-in network access — no key required for the DuckDuckGo fallback.

## Status and enablement

Disabled by default. All locked modes report `web_search` and `read_web_page` as `gated` until you opt in with `MMR_WEB_ENABLE=true` or `mmrWeb.enabled=true`. Once enabled, `web_search` is always **active** — with no SearXNG URL and no Brave key, it falls back to a best-effort no-key DuckDuckGo HTML scraper so the tool works with zero configuration.

`mmr-web` registers an MMR tool provider and a feature-gate provider; `mmr-core`'s runtime singleton on `globalThis` keeps these visible across Pi loader caches. Tool details report the concrete path used: `WebSearchDetails.backend` is `searxng` / `brave` / `duckduckgo`; `ReadWebPageDetails.backend` is `custom`.

## Tools

| Tool             | Purpose                                          | Backend                     |
| ---------------- | ------------------------------------------------ | --------------------------- |
| `web_search`     | Search via SearXNG / Brave / DuckDuckGo          | Backend-selected once at load |
| `read_web_page`  | Fetch a public http(s) page and return Markdown   | Custom in-process reader     |

Schemas: `web_search` requires `objective`; optional `search_queries`, `max_results`, `include_domains`, `exclude_domains`, `recency`. `read_web_page` requires `url`; optional `objective`, `forceRefetch` (accepted for compatibility — the custom reader already performs a live fetch).

Filters are best-effort per backend and never silently dropped. `include_domains`/`exclude_domains` are normalized to bare hosts (scheme/`www.`/path/port stripped, lowercased, deduped, capped at 20) and matched suffix-aware, so a domain also matches its subdomains; a domain may not appear in both lists. `recency` (`day`/`week`/`month`/`year`) maps natively to Brave `freshness` and SearXNG `time_range`; domains are post-filtered on result hostnames over a widened candidate pool. DuckDuckGo post-filters domains but reports `recency` as unsupported because its HTML results carry no reliable dates. Every requested filter is reported in the tool result `details.filters[]` as `native` / `post_filter` / `unsupported` with `full` / `partial` / `none` enforcement.

### `web_search` backend `auto` precedence

1. **SearXNG** when `mmrWeb.searxngUrl` / `MMR_WEB_SEARXNG_URL` is set. JSON API call to the user's own instance; no upstream key. See [SearXNG setup](#searxng-setup).
2. **Brave** when `BRAVE_API_KEY` is set. Free `Data for AI` tier suffices for typical usage.
3. **DuckDuckGo HTML** built-in no-key fallback. POSTs to `https://html.duckduckgo.com/html/` with a browser-ish UA, parses `.result__a` / `.result__snippet` rows, decodes `uddg=` click-tracker redirects, filters every URL through the public-web SSRF policy, and caches results for 2 min per query. On bot pages / HTTP 403 / 429 it opens a 60 s per-process backoff and returns a clear remediation hint.

Pin a backend with `mmrWeb.searchBackend` / `MMR_WEB_SEARCH_BACKEND`: `searxng`, `brave`, or `duckduckgo`. `read_web_page` always uses the custom reader.

## Configuration

Non-secret toggles live in Pi settings files; API keys live in the environment. Settings files are read in order: global, then project. Env vars override file settings. Settings are sampled once at extension load; restart Pi after changing anything.

```json
{
  "mmrWeb": {
    "enabled": true,
    "searxngUrl": "http://127.0.0.1:8080"
  }
}
```

```bash
export BRAVE_API_KEY="brv_xxx"   # env-only; never put in settings.json
```

Inside Pi, `/mmr-config` + the **web** branch is an interactive editor for safe runtime fields (`enabled`, `backend`, `searchBackend`, `searxngUrl`, sidecar booleans/URLs/timers, search/read timeouts, `maxResultBytes`). API keys are env-only; `searxngStartCommand` / `searxngStopCommand` are settings-file only because they spawn arbitrary processes. The "show current config" view reports whether `BRAVE_API_KEY` is set and shows sidecar command-array shape (arg counts), not literal commands.

### Environment variables

| Variable                                                  | Effect                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `MMR_WEB_ENABLE`                                          | `true`/`false` master switch.                                                                                     |
| `MMR_WEB_BACKEND`                                         | Compatibility pin; for `web_search` accepts `auto`/`searxng`/`brave`/`duckduckgo`. `read_web_page` ignores.       |
| `MMR_WEB_SEARCH_BACKEND` / `MMR_WEB_READER_BACKEND`       | Per-tool override; reader stays on the custom in-process pipeline when network is enabled.                        |
| `MMR_WEB_SEARXNG_URL` / `MMR_WEB_SEARXNG_HEALTH_URL`      | SearXNG URL / explicit health-poll URL (default `${searxngUrl}/search?q=ping&format=json`).                       |
| `BRAVE_API_KEY`                                           | Brave Search API key. **Env only.**                                                                               |
| `MMR_WEB_SEARCH_TIMEOUT_MS` / `MMR_WEB_READ_TIMEOUT_MS`   | Per-call timeouts (default 30 s).                                                                                 |
| `MMR_WEB_MAX_RESULT_BYTES`                                | Truncation budget (default 200 KB).                                                                               |
| `MMR_WEB_SEARXNG_MANAGED`                                 | Opt-in managed sidecar lifecycle.                                                                                 |
| `MMR_WEB_SEARXNG_IDLE_TIMEOUT_MS` / `…_START_TIMEOUT_MS`  | Sidecar idle stop (default 900 000; `0` disables) / max wait for health pass (default 30 000).                    |

`MMR_WEB_SEARXNG_START_COMMAND` / `MMR_WEB_SEARXNG_STOP_COMMAND` are **never** read from the environment — settings-file only — and env versions are rejected with a warning.

API keys are not read from settings files. Key-shaped fields such as `mmrWeb.braveApiKey` are ignored and warned about. Set `BRAVE_API_KEY` in env for the Brave backend.

## Behavior

### SearXNG setup

[SearXNG](https://docs.searxng.org/) is a self-hosted meta-search engine. `mmr-web` calls an instance you control; upstream engines never see your queries directly.

```bash
docker run --rm -d --name searxng -p 127.0.0.1:8080:8080 \
  -v ./searxng:/etc/searxng docker.io/searxng/searxng:latest
```

SearXNG ships `formats: [html]` by default. `mmr-web` calls the JSON API, so enable JSON in `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

Reload, then `export MMR_WEB_SEARXNG_URL=http://127.0.0.1:8080`. If the instance returns HTML, `mmr-web` raises an actionable error explaining which knob to flip.

### Managed SearXNG sidecar (opt-in)

`mmr-web` can spawn a local instance on demand and stop it when idle:

```json
{
  "mmrWeb": {
    "enabled": true,
    "searxngUrl": "http://127.0.0.1:8080",
    "searxngManaged": true,
    "searxngStartCommand": ["docker", "compose", "-f", "./searxng.yml", "up", "-d"],
    "searxngStopCommand":  ["docker", "compose", "-f", "./searxng.yml", "down"]
  }
}
```

First `web_search` spawns the start command (no shell, args literal); `mmr-web` polls the health URL until 200, capped at `searxngStartTimeoutMs`. Each successful call re-arms the idle timer (`searxngIdleTimeoutMs`, default 15 min; `0` disables). When it fires, the stop command runs; with no stop command, `mmr-web` can only send `SIGTERM` to a still-alive start process. `pi.on('session_shutdown')` also triggers stop. On Pi 0.77.0+ this `session_shutdown` cleanup also runs on `SIGTERM`/`SIGHUP` signal exits (not just clean session swaps or quit), so signal-terminated sessions no longer leak the sidecar.

Sidecar is per-process; cross-process coordination is tracked as a follow-up in [`ROADMAP.md`](ROADMAP.md).

### `read_web_page` output

Lazy-imported reader pipeline:

- `@mozilla/readability` — article extraction.
- `linkedom` — lightweight DOM (~2 MB install footprint vs `jsdom`'s ~30 MB; smaller CVE surface, faster cold start).
- `turndown` + `turndown-plugin-gfm` — HTML→Markdown with GFM tables, strikethrough, task lists, fenced code blocks with language hints.

`web_search` returns title / URL / description / `Age:` (when backend provides it). `read_web_page` preserves `text/plain` verbatim; for HTML/XML uses Readability + Turndown (headings, paragraphs, lists, emphasis, links, inline code, fenced code blocks with `class="language-XYZ"` hints, GFM tables, strikethrough, task lists, blockquotes). Strips obvious chrome (`script`, `style`, `nav`, `header`, `footer`, `aside`) and prefers `<main>` / `<article>`. Falls back to a zero-dep extractor when the toolchain cannot load, parsing fails, the page is not an article, or output is too small.

Before Readability scores the DOM, the reader removes structurally-identifiable UI chrome so the extractor does not latch onto it: hidden / `aria-hidden` nodes, `role="dialog"` / `role="alertdialog"` / `aria-modal` chrome, and short cookie/consent/GDPR containers detected by `id` / `class` / `data-*` attribute values. Detection is attribute-based, never text-based, so a legitimate article *about* cookies or privacy is preserved while a `data-testid="consent-banner"` toast is dropped.

#### No-readable-content diagnostic

The reader cannot execute JavaScript, so a client-rendered page (SPA / SSR-hydrated / RSC app shell) often returns only a script-driven skeleton in its static HTML. Rather than return misleading boilerplate (a cookie banner, repeated `Loading…` placeholders, or an empty body), the reader assesses the produced Markdown and, when no readable static content is found, returns an honest `# No readable content found` diagnostic. In that case `details.readableContentFound` is `false`, `details.fallbackReason` is `"no_readable_content"`, and `details.extractionReason` is one of:

| `extractionReason`     | Meaning                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `requires_javascript`  | App-shell markers (`__next`, `__NEXT_DATA__`, `self.__next_f`, `data-reactroot`, Angular, `<noscript>enable JavaScript`) plus little/no static text. |
| `placeholder_only`     | Static HTML held only repeated placeholder lines (for example loading indicators). |
| `empty`                | The page produced no extractable content.                                      |

The diagnostic is returned as-is and is never excerpted, regardless of any `objective`. Small-but-legitimate pages and `text/plain` bodies are unaffected. This surfaces the no-JavaScript limitation honestly; recovering hydrated content would require a headless-browser backend, which is out of scope for the in-process reader.

### `read_web_page.objective` handling

Local, deterministic excerpt selection. No LLM summarization; every returned excerpt is verbatim source text with surrounding Markdown headings carried in for context.

- No `objective` (or blank): full Markdown/text returned truncated to the byte budget. `details.objectiveApplied: false`; blank objective sets `details.fallbackReason = "blank_objective"`.
- With `objective`: page split into Markdown-aware passages, highest-scoring relevant passages within the budget joined in document order separated by `\n\n---\n\n`.
- If nothing clears the relevance threshold: falls back to the full page, `details.fallbackReason = "no_relevant_excerpts"`.
- Final cap `FINAL_CONTENT_CAP_BYTES` (256 KiB). When the cap fires, `[Content truncated at 256KB for context window]` is appended.

## Safety and privacy

- **What leaves the process.** Outbound HTTP(S) calls to the resolved backend URL or the explicitly requested `url`. No other network traffic.
- **What is redacted before it leaves.** `BRAVE_API_KEY` is redacted from error previews. The model never receives raw network capabilities.
- **What is rejected.** Reader URLs are validated before any network call: `http(s)` only; no userinfo; no non-default ports; reject localhost, link-local, private, multicast, reserved IPv4/IPv6 ranges, and `.local` / `.localhost` / `.internal` hostnames. The custom reader applies six per-request controls:
  1. URL text validation before fetch (including IPv4-mapped/NAT64/6to4 private addresses).
  2. DNS pre-resolution before initial fetch and every redirect hop; private/reserved/link-local results are refused.
  3. Manual redirect handling (`redirect: "manual"`) with validation per `Location`, capped at five hops.
  4. Redirect bodies are cancelled, not buffered.
  5. `Content-Disposition: attachment` refused; content type limited to text/HTML/XML.
  6. Bodies and error previews are streamed with byte caps.
- **What is persisted.** Tool result `details` are echoed back to Pi and may be persisted in its session log. Do not include secrets in `objective`, `search_queries`, or `url`.
- **Intentionally not supported.** JavaScript execution in fetched pages; cross-process sidecar coordination; secrets in settings files.

The user-trusted `searxngUrl` accepts loopback/private hosts; result URLs returned by SearXNG still pass the public-web filter. DuckDuckGo `uddg=` redirects are decoded locally and never followed server-side; the model only sees canonical target URLs.

Residual TOCTOU: DNS pre-resolution validates addresses returned by Node's default resolver, then `fetch` performs its own connection. A hostile authoritative DNS server could return different addresses to those two lookups. Closing the gap would require pinning the socket to the resolved IP and handling TLS SNI, out of scope for the in-process reader.

## Diagnostics and troubleshooting

- **Tools stay `gated` in `/mmr-status`.** `MMR_WEB_ENABLE=true` (or `mmrWeb.enabled=true`) was not set, or the extension did not reload. Restart Pi.
- **SearXNG returns HTML.** The instance needs `formats: [html, json]` in `settings.yml`. The reported error includes which knob to flip.
- **`web_search` is rate-limited.** DuckDuckGo opened the per-process 60 s backoff. Configure SearXNG or Brave for reliability.
- **Sidecar would not start.** Inspect the spawn-mode log line for the start command shape (no shell), check `searxngStartTimeoutMs`, ensure the start command actually opens the configured `searxngUrl`.
- **`BRAVE_API_KEY` in settings.json is ignored.** Key-shaped fields are intentionally rejected; export the key in env instead.

## Public API

Re-exported from `pi-mmr`: `createMmrWebExtension`, `MMR_WEB_OWNED_TOOLS`, plus the web tool / details types. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- Settings sampled once at load. Pi's tool registry is append-only — there is no public `unregisterTool`. To flip `enabled` or rotate `BRAVE_API_KEY`, restart Pi.
- Backend search modules and the sidecar add no extra runtime dependencies beyond the Readability + Turndown set listed above.
- Tests: `tests/mmr-web*.test.mjs`.
