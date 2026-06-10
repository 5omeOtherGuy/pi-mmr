# pi-mmr repository map

`pi-mmr` is a Pi package containing modular multi-model-routing extensions. The package registers ten extensions: `mmr-core`, `mmr-session-fallback`, `mmr-patch`, `mmr-tasks`, `mmr-web`, `mmr-github`, `mmr-subagents`, `mmr-async-tasks`, `mmr-custom-subagents`, and `mmr-history`. Two further directories ship in source but are not registered in `pi.extensions`: `mmr-toolbox` (a deprecated compatibility shim) and `mmr-debug` (a developer-only capture extension excluded from the published package).

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

`package.json` declares Pi extensions under `pi.extensions`, in load order:

```json
[
  "./src/extensions/mmr-core/index.ts",
  "./src/extensions/mmr-session-fallback/index.ts",
  "./src/extensions/mmr-patch/index.ts",
  "./src/extensions/mmr-tasks/index.ts",
  "./src/extensions/mmr-web/index.ts",
  "./src/extensions/mmr-github/index.ts",
  "./src/extensions/mmr-subagents/index.ts",
  "./src/extensions/mmr-async-tasks/index.ts",
  "./src/extensions/mmr-custom-subagents/index.ts",
  "./src/extensions/mmr-history/index.ts"
]
```

`mmr-toolbox` and `mmr-debug` are intentionally absent from this list. `mmr-toolbox` remains importable through the `exports` map as a deprecated re-export of `mmr-patch` and `mmr-tasks`; `mmr-debug` is loaded explicitly with Pi's `-e` flag and is excluded from the published package via `.npmignore`.

Public consumers should import from the package root (`pi-mmr`) unless they are wiring a specific extension subpath declared in `exports`.

## Source tree

```text
src/
  index.ts
  extensions/
    manifest.ts
    mmr-core/
    mmr-session-fallback/
    mmr-patch/
    mmr-tasks/
    mmr-web/
    mmr-github/
    mmr-subagents/
    mmr-async-tasks/
    mmr-custom-subagents/
    mmr-history/
    mmr-toolbox/     # deprecated shim, unregistered
    mmr-debug/       # developer-only capture, unregistered
```

### `src/index.ts`

Package-level public API. It re-exports stable helpers, types, extension factories, tool factories, settings loaders, and constants from shipped extensions. Canonical API catalogs live in [`docs/mmr-core-api.md`](docs/mmr-core-api.md) and [`docs/public-api.md`](docs/public-api.md).

### `src/extensions/manifest.ts`

Single source of truth for the registered extension list consumed by `package.json` generation and tests.

### `src/extensions/mmr-core/`

Foundation routing extension. It owns mode consistency across model choice, thinking level, tool allowlist, prompt route, diagnostics, persisted state, feature gates, and subagent profiles. Sibling extensions plug into its runtime registries rather than mutating core state.

Important files:

- `index.ts` — Pi extension entry point.
- `modes.ts` — locked-mode table (`smart`, `smartGPT`, `rush`, `large`, `deep`, `free`) and metadata.
- `mode-controller.ts` — shared state manager for mode transitions and UI updates.
- `model-resolver.ts` — provider-neutral preference expansion and route selection.
- `routing.ts` — resolves the active mode from settings and flags.
- `tool-registry.ts` — exact-name tool provider registry, allowlists, and deferred registrations.
- `feature-gates.ts` — feature-gate provider registry for opt-in siblings.
- `request-policy.ts` — per-mode provider-request and thinking-level policy.
- `prompt-assembly.ts` — prompt-head rewrite and MMR-authored mode prompts.
- `subagent-profiles.ts`, `subagent-resolver.ts`, `subagent-prompt-assembly.ts` — worker model/tool/prompt policy for subagents.
- `status.ts`, `diagnostics.ts` — `/mmr-status` formatting and structured diagnostics.
- `command-registration.ts` — slash commands, shortcuts, and thinking toggles.
- `above-editor-dashboard.ts` — split-pane dashboard widget coordination.
- `lifecycle-hooks.ts`, `runtime.ts` — session/request lifecycle wiring and the live registry singleton.
- `internal/` — low-level env, JSON, and settings-file utilities.
- `README.md`, `ROADMAP.md` — extension docs and milestones.

Registered surface: slash commands (`/mode`, `/mmr-status`, `/mmr-changelog`, `/mmr-config`), mode shortcuts, the `pi-mmr-above-editor-dashboard` widget, and the feature gates for `mmr-subagents`, `mmr-async-tasks`, `mmr-history`, `mmr-web`, `mmr-patch`, and `mmr-tasks`.

### `src/extensions/mmr-session-fallback/`

Session-scoped quota/rate-limit fallback. When a subscription-backed route fails with a classified quota or rate-limit error, it prompts for a fallback model/thinking level, applies the override through `mmr-core`, persists it for the session, and lets Pi retry the turn. It registers no model-invokable tools and is driven by message-lifecycle events.

Important files:

- `index.ts` — Pi extension entry point; coordinates session-start restore and message-end handling.
- `classifier.ts` — quota/rate-limit/overload error classifier.
- `candidates.ts`, `thinking.ts`, `ui.ts` — fallback candidate ranking, thinking-level resolution, and the picker UI.
- `retry-message.ts` — retry payload rewrite.
- `state.ts`, `runtime.ts` — persisted override schema and in-process guards.
- `README.md`, `ROADMAP.md` — behavior and milestones.

### `src/extensions/mmr-patch/`

Owns `apply_patch`. Provides context-matched, multi-file workspace edits using a Codex-format patch parser with path safety and atomic application. Split out of the former `mmr-toolbox`.

Important files:

- `index.ts` — Pi extension entry point and provider registration.
- `apply-patch-tool.ts` — `apply_patch` tool definition, schema, and prompt guidance.
- `apply-patch.ts` — Codex patch parser and hunk-matching engine.
- `apply-patch-plan.ts` — path safety, per-file mutation locking, and flush phase.

### `src/extensions/mmr-tasks/`

Owns the session-local `task_list`. Persists a todo list in the current Pi session log and renders it as a pinned TUI widget. Split out of the former `mmr-toolbox`.

Important files:

- `index.ts` — Pi extension entry point and provider registration.
- `todo-list-tool.ts` — `task_list` tool definition, whole-list validation, and verification nudges.
- `todo-list-widget.ts` — pinned `aboveEditor` widget (`pi-mmr-task-list`) with Pi-native progress spinners.
- `task-list-wiring.ts` — `/tasks` slash command, shortcuts, and compaction hooks.

### `src/extensions/mmr-web/`

Network-backed web extension. Disabled by default; registers `web_search` and `read_web_page` when enabled (`MMR_WEB_ENABLE` or settings). Search supports SearXNG (managed sidecar or remote), Brave, and DuckDuckGo; page reads use an in-process Readability/Turndown reader with a fallback extractor.

Important files:

- `index.ts` — Pi extension entry point, provider, and `/mmr-config` flow registration.
- `config.ts`, `backend.ts` — settings/env parsing and backend selection.
- `tools.ts` — `web_search` and `read_web_page` tool definitions.
- `url-policy.ts` — SSRF protection and external-URL validation.
- `reader/`, `search/` — page-reader and pluggable search-backend implementations (including the SearXNG sidecar).
- `README.md`, `ROADMAP.md` — configuration, safety, diagnostics, and roadmap.

### `src/extensions/mmr-github/`

Opt-in read-only GitHub provider (`MMR_GITHUB_ENABLE`). Registers repository tools used directly by callers and gates the `librarian` worker until the GitHub tool surface is owned by this extension.

Important files:

- `index.ts` — Pi extension entry point.
- `config.ts` — settings/env parsing; tokens are env-only.
- `client.ts` — read-only GitHub REST client and response bounds.
- `glob.ts` — glob matching over repository file trees.
- `tools.ts`, `tool-schemas.ts`, `tool-format.ts` — read-only tool implementations, schemas, and response formatting.
- `provider.ts`, `tool-ownership.ts` — feature-gate/tool-provider ownership checks and `librarian` gating.
- `README.md` — tool reference, configuration, safety, and public API.

### `src/extensions/mmr-subagents/`

Worker/subagent extension. Owns the `finder`, `oracle`, `Task`, and `librarian` workers, the child-CLI runner, and the `mmr-subagents` feature gate. Worker model/tool/prompt policy is resolved through `mmr-core` profiles. Background fleet tooling and custom Markdown subagents were extracted into `mmr-async-tasks` and `mmr-custom-subagents`.

Important files:

- `index.ts` — Pi extension entry point.
- `finder.ts`, `oracle.ts`, `task.ts`, `librarian.ts` — concrete worker tools.
- `runner.ts` — child-CLI subagent runner and worker lifecycle.
- `provider.ts` — tool-provider and feature-gate-provider factories.
- `prompts.ts` — worker prompt builders.
- `README.md`, `ROADMAP.md` — behavior, public API, and milestones.

### `src/extensions/mmr-async-tasks/`

Background fleet extension extracted from `mmr-subagents`. Runs independent subagent workers (`finder`, `librarian`, `Task`) in the background with a session-scoped registry, automated completion delivery, and a live TUI dashboard.

Important files:

- `index.ts` — Pi extension entry point and provider registration.
- `async-task-tools.ts` — `start_task`, `task_poll`, `task_wait`, and `task_cancel` implementations.
- `async-task-registry.ts` — in-memory, session-scoped registry of worker lifecycles and concurrency caps.
- `async-task-delivery.ts` — at-most-once completion notices and idle-wake pushes.
- `background-task-widget.ts` — pinned `aboveEditor` fleet dashboard (`pi-mmr-background-tasks`).
- `async-task-tool-format.ts` — tool-result, board-snapshot, and fleet-status formatting.

### `src/extensions/mmr-custom-subagents/`

Custom Markdown subagent extension extracted from `mmr-subagents`. Discovers project-local Markdown subagent definitions, manages enable/import config flows, and registers `subagent-<name>` worker tools behind a feature gate.

Important files:

- `index.ts` — Pi extension entry point.
- `custom-loader.ts` — scans project directories and parses Markdown subagent definitions.
- `custom-runtime.ts` — tool registration and worker execution wiring.
- `custom-config.ts`, `custom-import.ts` — enabled-subagent persistence and legacy-definition import.
- `config-flow.ts` — interactive `/mmr-config` discovery/enable UI.
- `provider.ts` — tool-provider and feature-gate-provider factories.

### `src/extensions/mmr-history/`

Opt-in global local Pi session lookup (`MMR_HISTORY_ENABLE=true`). Registers `find_session` and `read_session`; `read_session` uses the in-process `history-reader` worker first and falls back to deterministic lexical extraction. Redaction and opaque project references prevent raw session paths from surfacing.

Important files:

- `index.ts`, `tools.ts` — extension entry point and Pi tool definitions.
- `session-catalog.ts`, `session-index.ts`, `query.ts` — session listing/search, evidence index, and query parsing/diagnostics.
- `read-session.ts`, `analysis-worker.ts` — lexical extraction and optional `history-reader` worker analysis.
- `prompts.ts` — `history-reader` worker prompts.
- `redaction.ts` — deterministic sanitizer.
- `config.ts` — settings and the `MMR_HISTORY_ENABLE` gate.
- `README.md`, `ROADMAP.md` — behavior, privacy boundaries, and next milestones.

### `src/extensions/mmr-toolbox/` (deprecated shim)

Not registered in `pi.extensions` and registers no tools. `index.ts` re-exports the former `mmr-toolbox` public surface from `mmr-patch` and `mmr-tasks` (including `registerMmrToolboxProviders`) so existing imports keep working. New code should import from `mmr-patch` and `mmr-tasks` directly. `README.md` and `ROADMAP.md` are retained for historical context.

### `src/extensions/mmr-debug/` (developer-only)

Not registered in `pi.extensions` and excluded from the published package via `.npmignore`. Loaded explicitly with `pi -e "$PWD/src/extensions/mmr-debug/index.ts"` and inert unless `MMR_DEBUG_CAPTURE_FILE` is set. A pure hook-based observer (`index.ts`, `capture.ts`) that records system-prompt source/text, advertised tool names, response status/headers, and message end metadata for ground-truth review. See its `README.md` for usage.

## Documentation tree

| Path | Purpose |
| --- | --- |
| [`docs/README.md`](docs/README.md) | User-facing docs homepage. |
| [`docs/quick-reference.md`](docs/quick-reference.md) | Quick mode/tool/gate lookup. |
| [`docs/whats-new.md`](docs/whats-new.md) | Recent user- and developer-visible changes. |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Symptom-first troubleshooting and provider/tool-call procedures. |
| [`docs/reference-architecture.md`](docs/reference-architecture.md) | Extension ownership, dependency direction, core contracts, and implementation state. |
| [`docs/mmr-core-api.md`](docs/mmr-core-api.md) | Stable core public API contract and import guidance. |
| [`docs/public-api.md`](docs/public-api.md) | Stable non-core extension public API contract and import guidance. |
| [`docs/public-api-surface.md`](docs/public-api-surface.md) | Generated package-root export surface reference. |
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
