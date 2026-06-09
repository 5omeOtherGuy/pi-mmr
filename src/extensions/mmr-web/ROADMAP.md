# mmr-web roadmap

This roadmap covers the `mmr-web` extension: network-backed tools (off by
default). Cross-cutting concerns live in the top-level
[`../../../ROADMAP.md`](../../../ROADMAP.md). For configuration, environment
variables, safety policy, sidecar lifecycle, and `read_web_page` objective
handling see [`README.md`](README.md).

Sibling extension roadmaps:

- [`../mmr-core/ROADMAP.md`](../mmr-core/ROADMAP.md)
- [`../mmr-toolbox/ROADMAP.md`](../mmr-toolbox/ROADMAP.md)
- [`../mmr-subagents/ROADMAP.md`](../mmr-subagents/ROADMAP.md)

## Current status

Shipped, disabled by default; opt-in via `MMR_WEB_ENABLE=true`.

### Search backends (pluggable)

- ✅ Pluggable `SearchBackend` interface under `src/extensions/mmr-web/search/`
  with a factory in `backend.ts` (Phase 1).
- ✅ **Brave Search** backend (`search/brave.ts`) — `api.search.brave.com`,
  requires `BRAVE_API_KEY` in the environment. Requests set
  `text_decorations=false` (snippets without highlight markers) and
  `result_filter=web` (only the result block the parser consumes), and map an
  optional `country` (ISO 3166-1 alpha-2) to Brave's native `country` param.
- ✅ **SearXNG** backend (`search/searxng.ts`) — user-controlled instance,
  no upstream key. URL via `mmrWeb.searxngUrl` or `MMR_WEB_SEARXNG_URL`.
  Detects HTML responses (JSON output disabled in `settings.yml`) and
  surfaces an actionable error.
- ✅ **DuckDuckGo HTML** built-in no-key fallback (`search/duckduckgo.ts`).
  `uddg=` click-tracker decoded locally; 2-min query cache; per-process
  60-second backoff on 403/429/bot pages. Best-effort by design.
- ✅ `auto` mode precedence: `searxng` → `brave` → `duckduckgo`.
- ✅ Optional `country` filter (ISO 3166-1 alpha-2): native on Brave, reported
  `unsupported` on SearXNG (no `country` param on its search API) and
  DuckDuckGo, so it is never silently dropped.
- ✅ Explicit per-tool overrides via `mmrWeb.searchBackend` /
  `MMR_WEB_SEARCH_BACKEND`.

### Reader (`read_web_page`)

- ✅ Pluggable `ReaderBackend` interface (`reader/types.ts`,
  `reader/direct.ts`, `reader/extract.ts`).
- ✅ Custom in-process direct reader with SSRF, manual redirect walk,
  per-hop DNS re-resolution, content-type allowlist, byte-cap streaming.
- ✅ High-fidelity Markdown via Readability + Turndown + GFM
  (`reader/markdown.ts`). Lazy-imported; cached after first load. Falls back
  to the zero-dep extractor in `reader/extract.ts` when the toolchain
  cannot be loaded, the page is not an article, or output is too short.
- ✅ Fenced code blocks preserve `class="language-XYZ"` hints.
- ✅ GFM tables, strikethrough, task lists.

### Managed SearXNG sidecar (opt-in, Phase 5)

- ✅ `search/searxng-sidecar.ts` exposes `ensureSearxngSidecarRunning`,
  `noteSearxngSidecarUse`, `shutdownSearxngSidecar`.
- ✅ Opt-in via `mmrWeb.searxngManaged=true` AND a non-empty
  `mmrWeb.searxngStartCommand`.
- ✅ Start/stop commands settings-file only (never env, never model).
- ✅ Spawned with `shell: false`; per-process Promise singleton coalesces
  concurrent spawn attempts.
- ✅ Health-poll with backoff up to `searxngStartTimeoutMs`.
- ✅ Idle-stop after `searxngIdleTimeoutMs` (default 15 min; `0` disables).
- ✅ `pi.on('session_shutdown')` triggers stop so sessions do not leak the
  daemon. On Pi 0.77.0+ this handler also runs on `SIGTERM`/`SIGHUP` signal
  exits, so signal-terminated sessions release the sidecar too.
- ✅ Best-effort stop: user `stopCommand` first (bounded by real unref'd
  10-s cap), then `SIGTERM` to the start child only when that process is
  still alive. Detached start commands such as `docker compose up -d` keep
  sidecar ownership after the start child exits so the configured stop
  command still runs on idle/shutdown.

### Cross-cutting

- ✅ URL/SSRF validation: only `http(s)`; no userinfo credentials; loopback,
  link-local, private, multicast, and reserved IPv4 and IPv6 ranges
  rejected, plus `.local`, `.localhost`, `.internal`. A separate
  `validateSearXNGUrl` permits loopback/private hosts only for the
  user-trusted service URL.
- ✅ Per-call timeouts (`searchTimeoutMs` / `readTimeoutMs`, default 30 s)
  and byte-budget truncation (`maxResultBytes`, default ~200 KB).
- ✅ `BRAVE_API_KEY` is loaded from the environment only; settings-file key
  values are ignored with warnings.
- ✅ MMR tool provider and `mmr-web` feature-gate provider that report
  gated/active state in `/mmr-status`.
- ✅ Curated excerpt selection: at most `MAX_EXCERPTS` (10) passages;
  passages below 30% of the top match are dropped. Final emitted content
  capped at `FINAL_CONTENT_CAP_BYTES` (256 KiB) on a UTF-8 boundary with
  `[Content truncated at 256KB for context window]` appended.

### Interactive editor

- ✅ `/mmr-config web` lets users edit `enabled`, backend pins,
  `searxngUrl`, timeouts, and `maxResultBytes`. API keys are env-only and
  surfaced only as a presence indicator in the "show current config" view.

Dependencies satisfied:

- `mmr-core` tool registry, feature gates, network/privacy policy.

Runtime dependencies (added Phase 4):

- `@mozilla/readability`, `linkedom`, `turndown`, `turndown-plugin-gfm`.
  Total install footprint ~2 MB; lazy-imported on first reader use.

## Configuration reload

Settings are sampled once when the extension loads. Pi's tool registry is
append-only, so reloading mid-process would desync the live provider gate
from the registered Pi tools. To flip `enabled` or rotate `BRAVE_API_KEY`,
restart the Pi process.

## Future considerations

These are candidate follow-ups, not committed work. Each would need its own
first-slice plan, deterministic tests, and an updated entry under the
public-safety pre-publication check.

- **Cross-process sidecar coordination.** Today the managed SearXNG sidecar
  is per-process: two Pi processes against the same project may each spawn
  their own instance. A small on-disk lock file at
  `<cwd>/.pi/data/mmr-web/searxng.lock` recording `{pid, startedAt, url}`
  would let one process win the spawn and the others use the running
  instance, with idle-timer ownership transferring on PID-liveness checks.
- **Sidecar manifest verification.** Add an optional `manifestHash` field to
  let users pin a SHA-256 of the compose file or start-command array; the
  loader could refuse to spawn if the manifest changed since last
  approval. Defends against settings-file tampering.
- **Excerpt-selection heuristic tuning.** Review thresholds (currently 30 %
  of top match, 10 passages, 256 KiB cap) against real-traffic samples.
- **Optional `robots.txt` handling** for the custom reader.
- **Per-call telemetry / diagnostics** surfaced through `/mmr-status`
  rather than tool-result `details`.
- **Reader pipeline tuning.** Per-domain Readability options, optional
  table-of-contents stripping, code-fence language inference from CDN
  hints, image-alt-text inclusion behind a flag.

## Acceptance criteria for any new network-backed tool

- Off by default; explicit opt-in via `MMR_WEB_ENABLE` (or a new gate,
  documented in `README.md`).
- URL/SSRF validation matches or extends the existing policy.
- Per-call timeouts, byte-budget truncation, and key-via-env-only policy
  preserved.
- Deterministic tests with an injected `fetchImpl`; no live network.
- Participates in the prompt/tool assembly active-manifest invariants while
  enabled and in the negative-injection invariant while gated.
