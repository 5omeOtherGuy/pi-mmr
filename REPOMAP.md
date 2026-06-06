# pi-mmr repository map

`pi-mmr` is a Pi package containing modular multi-model-routing extensions. The package registers seven extensions: `mmr-core`, `mmr-session-fallback`, `mmr-toolbox`, `mmr-web`, `mmr-github`, `mmr-subagents`, and `mmr-history`.

## Top-level files

| Path | Purpose |
| --- | --- |
| [`README.md`](README.md) | User-facing landing page, quick start, mode/tool chooser, safety, troubleshooting, docs links. |
| [`docs/README.md`](docs/README.md) | User-facing documentation homepage. |
| [`docs/quick-reference.md`](docs/quick-reference.md) | Compact mode, tool, gate, and troubleshooting reference. |
| [`INDEX.md`](INDEX.md) | Quick navigation index for docs, source entry points, tests, and contributor guidance. |
| [`CHANGELOG.md`](CHANGELOG.md) | Notable changes and release notes. |
| [`ROADMAP.md`](ROADMAP.md) | Package-level roadmap and release checklist. |
| [`REPOMAP.md`](REPOMAP.md) | This repository structure and ownership map. |
| [`package.json`](package.json) | Package metadata, Pi extension registration, export map, and npm scripts. |
| [`package-lock.json`](package-lock.json) | Locked dependency graph. |
| [`tsconfig.json`](tsconfig.json) | TypeScript strict-mode configuration. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Human contributor workflow. |

## Package registration

`package.json` declares Pi extensions under `pi.extensions`:

```json
[
  "./src/extensions/mmr-core/index.ts",
  "./src/extensions/mmr-session-fallback/index.ts",
  "./src/extensions/mmr-toolbox/index.ts",
  "./src/extensions/mmr-web/index.ts",
  "./src/extensions/mmr-github/index.ts",
  "./src/extensions/mmr-subagents/index.ts",
  "./src/extensions/mmr-history/index.ts"
]
```

Public consumers should import from the package root (`pi-mmr`) unless they are wiring a specific extension subpath declared in `exports`.

## Source tree

```text
src/
  index.ts
  extensions/
    mmr-core/
    mmr-session-fallback/
    mmr-toolbox/
    mmr-web/
    mmr-github/
    mmr-subagents/
    mmr-history/
```

### `src/index.ts`

Package-level public API. It re-exports stable helpers, types, extension factories, tool factories, settings loaders, and constants from shipped extensions. Canonical API catalogs live in [`docs/mmr-core-api.md`](docs/mmr-core-api.md) and [`docs/public-api.md`](docs/public-api.md).

### `src/extensions/mmr-core/`

Foundation routing extension. It owns mode consistency across model choice, thinking level, tool allowlist, prompt route, diagnostics, persisted state, feature gates, and subagent profiles.

Important files:

- `index.ts` — Pi extension entry point.
- `modes.ts` — mode table and mode lookup helpers.
- `model-resolver.ts` — provider-neutral preference expansion and route selection.
- `tool-registry.ts` — exact-name tool provider registry and status decisions.
- `feature-gates.ts` — feature-gate provider registry.
- `prompt.ts`, `prompt-templates.ts` — prompt-head rewrite and MMR-authored mode prompts.
- `request-policy.ts` — per-mode provider-request policy.
- `status.ts`, `diagnostics.ts` — `/mmr-status` formatting and structured diagnostics.
- `README.md`, `ROADMAP.md` — extension docs and milestones.

### `src/extensions/mmr-session-fallback/`

Session-scoped quota/rate-limit fallback. When a subscription-backed route fails with a classified quota or rate-limit error, it prompts for a fallback model/thinking level, applies the override through `mmr-core`, persists it for the session, and lets Pi retry the turn.

Important files:

- `index.ts` — Pi extension entry point.
- `classifier.ts` — quota/rate-limit classifier.
- `candidates.ts`, `thinking.ts`, `ui.ts` — fallback candidate and picker flow.
- `retry-message.ts` — retry payload rewrite.
- `state.ts`, `runtime.ts` — persisted override and in-process guards.

### `src/extensions/mmr-toolbox/`

Local utility tools. Ships `apply_patch` and session-local `task_list`.

Important files:

- `index.ts` — Pi extension entry point and tool/widget registration.
- `apply-patch.ts` — patch parser, path safety, and atomic application behavior.
- `task-list.ts` — task-list schema, storage, and rendering helpers.
- `README.md`, `ROADMAP.md` — tool behavior, safety, and deferred capabilities.

### `src/extensions/mmr-web/`

Network-backed web extension. Disabled by default; registers `web_search` and `read_web_page` when enabled. Search supports SearXNG, Brave, and DuckDuckGo; page reads use an in-process reader with Readability/Turndown and a fallback extractor.

Important files:

- `index.ts` — Pi extension entry point and provider registration.
- `config.ts`, `backend.ts` — settings/env parsing and backend selection.
- `tools.ts` — Pi tool definitions and schemas.
- `reader.ts`, `search/` — page-reader and search-backend implementations.
- `README.md`, `ROADMAP.md` — configuration, safety, diagnostics, and roadmap.

### `src/extensions/mmr-github/`

Opt-in read-only GitHub provider. Registers repository tools used directly by callers and by the `librarian` worker gate.

Important files:

- `index.ts` — Pi extension entry point.
- `config.ts` — settings/env parsing; tokens are env-only.
- `client.ts` — GitHub API client and response bounds.
- `tools.ts` — read-only Pi tool definitions.
- `provider.ts`, `tool-ownership.ts` — feature-gate/tool-provider ownership checks.
- `README.md` — tool reference, configuration, safety, and public API.

### `src/extensions/mmr-subagents/`

Worker/subagent extension. Owns `finder`, `oracle`, `Task`, `librarian`, custom Markdown subagents, and the `mmr-subagents` feature gate. The child CLI runner resolves model/tool/prompt policy through `mmr-core` profiles.

Important files:

- `index.ts` — Pi extension entry point.
- `finder.ts`, `oracle.ts`, `task.ts`, `librarian.ts` — concrete worker tools.
- `runner.ts` — child-CLI subagent runner.
- `prompts.ts` — worker prompt builders.
- `custom-*.ts` — custom Markdown subagent discovery, setup, config, and execution.
- `provider.ts` — tool-provider and feature-gate-provider factories.
- `README.md`, `ROADMAP.md` — behavior, public API, and milestones.

### `src/extensions/mmr-history/`

Opt-in global local Pi session lookup. Registers `find_session` and `read_session` behind `MMR_HISTORY_ENABLE=true`; `read_session` uses the in-process `history-reader` worker first and falls back to deterministic lexical extraction. Redaction and opaque project references prevent raw session paths from surfacing.

Important files:

- `index.ts`, `tools.ts` — extension entry point and Pi tool definitions.
- `session-catalog.ts`, `session-index.ts`, `query.ts` — session listing/search and query diagnostics.
- `read-session.ts`, `analysis-worker.ts` — lexical extraction and optional worker analysis.
- `redaction.ts` — deterministic sanitizer.
- `README.md`, `ROADMAP.md` — behavior, privacy boundaries, and next milestones.

## Documentation tree

| Path | Purpose |
| --- | --- |
| [`docs/README.md`](docs/README.md) | User-facing docs homepage. |
| [`docs/quick-reference.md`](docs/quick-reference.md) | Quick mode/tool/gate lookup. |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Symptom-first troubleshooting and provider/tool-call procedures. |
| [`docs/reference-architecture.md`](docs/reference-architecture.md) | Extension ownership, dependency direction, core contracts, and implementation state. |
| [`docs/mmr-core-api.md`](docs/mmr-core-api.md) | Stable core public API contract and import guidance. |
| [`docs/public-api.md`](docs/public-api.md) | Stable non-core extension public API contract and import guidance. |
| [`docs/extension-compatibility.md`](docs/extension-compatibility.md) | Composition with other Pi extensions. |
| [`docs/subagent-framework.md`](docs/subagent-framework.md) | Subagent framework contracts and worker behavior. |
| [`docs/data-storage-conventions.md`](docs/data-storage-conventions.md) | Per-user data storage convention. |
| [`docs/prompt-provenance.md`](docs/prompt-provenance.md) | Prompt provenance boundaries and source notes. |
| [`docs/documentation-style-guide.md`](docs/documentation-style-guide.md) | User-facing documentation structure and wording rules. |

## Test tree

```text
tests/
  *.test.mjs
  fixtures/
  helpers/
  README.md
```

Tests use Node's built-in `node:test` runner and deterministic fixtures. They do not make live provider/API calls.

## Runtime ownership summary

```diagram
   ╭──────────╮     ╭──────────────╮     ╭──────────────╮
   │ /mode or │────▶│ mmr-core     │────▶│ Pi runtime   │
   │ settings │     │ resolution   │     │ model/tools  │
   ╰──────────╯     ╰──────┬───────╯     ╰──────┬───────╯
                            │                    │
                            ▼                    ▼
                    ╭──────────────╮     ╭──────────────╮
                    │ mode state & │────▶│ prompt/status│
                    │ diagnostics  │     │ integration  │
                    ╰──────────────╯     ╰──────────────╯
```

`mmr-core` is the source of truth for locked routing state. Sibling extensions plug in through provider APIs, feature gates, and MMR-owned tool registrations rather than mutating core state directly.
