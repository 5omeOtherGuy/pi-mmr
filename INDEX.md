# pi-mmr index

Quick links for navigating the repository.

## Start here

- [`README.md`](README.md) — user-facing overview, quick start, mode chooser, tool chooser, safety summary, and troubleshooting.
- [`docs/README.md`](docs/README.md) — documentation homepage for users and contributors.
- [`docs/quick-reference.md`](docs/quick-reference.md) — compact mode/tool/gate lookup.
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes and release notes.
- [`ROADMAP.md`](ROADMAP.md) — package-level roadmap and release plan.
- [`REPOMAP.md`](REPOMAP.md) — repository structure and source ownership map.

## Extension docs

- [`src/extensions/mmr-core/README.md`](src/extensions/mmr-core/README.md) — locked modes, routing, prompt assembly, diagnostics, and public API.
- [`src/extensions/mmr-toolbox/README.md`](src/extensions/mmr-toolbox/README.md) — `apply_patch`, `task_list`, widget behavior, safety, and public API.
- [`src/extensions/mmr-subagents/README.md`](src/extensions/mmr-subagents/README.md) — `finder`, `oracle`, `Task`, `librarian`, custom subagents, worker behavior, and public API.
- [`src/extensions/mmr-session-fallback/README.md`](src/extensions/mmr-session-fallback/README.md) — quota/rate-limit fallback trigger, picker flow, persisted override, and lifecycle.
- [`src/extensions/mmr-web/README.md`](src/extensions/mmr-web/README.md) — `web_search`, `read_web_page`, backend configuration, and safety policy.
- [`src/extensions/mmr-history/README.md`](src/extensions/mmr-history/README.md) — opt-in local session lookup, query DSL, redaction, and worker-backed reading.
- [`src/extensions/mmr-github/README.md`](src/extensions/mmr-github/README.md) — opt-in read-only GitHub repository tools and librarian gating.

## Per-extension roadmaps

- [`src/extensions/mmr-core/ROADMAP.md`](src/extensions/mmr-core/ROADMAP.md)
- [`src/extensions/mmr-session-fallback/ROADMAP.md`](src/extensions/mmr-session-fallback/ROADMAP.md)
- [`src/extensions/mmr-toolbox/ROADMAP.md`](src/extensions/mmr-toolbox/ROADMAP.md)
- [`src/extensions/mmr-web/ROADMAP.md`](src/extensions/mmr-web/ROADMAP.md)
- [`src/extensions/mmr-subagents/ROADMAP.md`](src/extensions/mmr-subagents/ROADMAP.md)
- [`src/extensions/mmr-history/ROADMAP.md`](src/extensions/mmr-history/ROADMAP.md)

## Architecture and contracts

- [`docs/reference-architecture.md`](docs/reference-architecture.md) — implementation-facing module boundaries and dependency direction.
- [`docs/mmr-core-api.md`](docs/mmr-core-api.md) — stable public API exported by `mmr-core` / package root.
- [`docs/public-api.md`](docs/public-api.md) — stable package-root API exported by non-core extensions.
- [`docs/extension-compatibility.md`](docs/extension-compatibility.md) — how `pi-mmr` composes with other Pi extensions.
- [`docs/subagent-framework.md`](docs/subagent-framework.md) — subagent framework and worker prompt contracts.
- [`docs/data-storage-conventions.md`](docs/data-storage-conventions.md) — per-user data storage convention.
- [`docs/prompt-provenance.md`](docs/prompt-provenance.md) — prompt-source notes and provenance boundaries.
- [`docs/documentation-style-guide.md`](docs/documentation-style-guide.md) — documentation structure and wording rules.

## Source entry points

- [`package.json`](package.json) — package metadata, Pi extension registration, exports, and scripts.
- [`src/index.ts`](src/index.ts) — package-level public exports.
- [`src/extensions/mmr-core/index.ts`](src/extensions/mmr-core/index.ts) — `mmr-core` Pi extension entry point.
- [`src/extensions/mmr-session-fallback/index.ts`](src/extensions/mmr-session-fallback/index.ts) — `mmr-session-fallback` Pi extension entry point.
- [`src/extensions/mmr-toolbox/index.ts`](src/extensions/mmr-toolbox/index.ts) — `mmr-toolbox` Pi extension entry point.
- [`src/extensions/mmr-web/index.ts`](src/extensions/mmr-web/index.ts) — `mmr-web` Pi extension entry point.
- [`src/extensions/mmr-github/index.ts`](src/extensions/mmr-github/index.ts) — `mmr-github` Pi extension entry point.
- [`src/extensions/mmr-subagents/index.ts`](src/extensions/mmr-subagents/index.ts) — `mmr-subagents` Pi extension entry point.
- [`src/extensions/mmr-history/index.ts`](src/extensions/mmr-history/index.ts) — `mmr-history` Pi extension entry point.

## Tests and contributor guidance

- [`tests/README.md`](tests/README.md) — test-suite overview.
- [`tests/`](tests/) — deterministic `node:test` suites and fixtures.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — human contributor workflow.
