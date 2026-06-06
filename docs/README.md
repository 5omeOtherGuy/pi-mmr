# pi-mmr documentation

Use this page as the user-facing map for `pi-mmr`. The root [`README.md`](../README.md) explains the product and first-run flow; this page points you to the right reference after that.

## Start here

| Need | Read |
| --- | --- |
| Learn the core commands and tools | [`quick-reference.md`](quick-reference.md) |
| Install and verify the package | [`../README.md#quick-start`](../README.md#quick-start) |
| Pick the right mode | [`../README.md#choose-a-mode`](../README.md#choose-a-mode) |
| Pick the right tool | [`../README.md#choose-a-tool`](../README.md#choose-a-tool) |
| Diagnose routing | [`troubleshooting.md`](troubleshooting.md) |

## User guides by job

| I want to... | Start with | Then read |
| --- | --- | --- |
| Switch model/tool posture for a task | [`quick-reference.md#modes`](quick-reference.md#modes) | [`../src/extensions/mmr-core/README.md`](../src/extensions/mmr-core/README.md) |
| Patch files or track todos | [`quick-reference.md#toolbox`](quick-reference.md#toolbox) | [`../src/extensions/mmr-toolbox/README.md`](../src/extensions/mmr-toolbox/README.md) |
| Delegate bounded work or code search | [`quick-reference.md#workers`](quick-reference.md#workers) | [`../src/extensions/mmr-subagents/README.md`](../src/extensions/mmr-subagents/README.md) |
| Search the web or read a public page | [`quick-reference.md#optional-reach`](quick-reference.md#optional-reach) | [`../src/extensions/mmr-web/README.md`](../src/extensions/mmr-web/README.md) |
| Research a GitHub repository | [`quick-reference.md#optional-reach`](quick-reference.md#optional-reach) | [`../src/extensions/mmr-github/README.md`](../src/extensions/mmr-github/README.md) |
| Reuse a prior Pi session | [`quick-reference.md#optional-reach`](quick-reference.md#optional-reach) | [`../src/extensions/mmr-history/README.md`](../src/extensions/mmr-history/README.md) |
| Understand quota fallback | [`../README.md#feature-map`](../README.md#feature-map) | [`../src/extensions/mmr-session-fallback/README.md`](../src/extensions/mmr-session-fallback/README.md) |

## Extension reference

| Extension | Purpose | Default |
| --- | --- | --- |
| [`mmr-core`](../src/extensions/mmr-core/README.md) | Locked modes, model routing, prompt rewrite, diagnostics | On |
| [`mmr-toolbox`](../src/extensions/mmr-toolbox/README.md) | `apply_patch`, `task_list` | On |
| [`mmr-subagents`](../src/extensions/mmr-subagents/README.md) | `finder`, `oracle`, `Task`, `librarian` | On (`librarian` gated) |
| [`mmr-session-fallback`](../src/extensions/mmr-session-fallback/README.md) | Interactive quota/rate-limit fallback | On |
| [`mmr-web`](../src/extensions/mmr-web/README.md) | `web_search`, `read_web_page` | Off |
| [`mmr-history`](../src/extensions/mmr-history/README.md) | `find_session`, `read_session` | Off |
| [`mmr-github`](../src/extensions/mmr-github/README.md) | Read-only GitHub repository tools | Off |

## Reference docs

| Topic | Read |
| --- | --- |
| Public package API | [`public-api.md`](public-api.md) |
| Core public API | [`mmr-core-api.md`](mmr-core-api.md) |
| Reference architecture | [`reference-architecture.md`](reference-architecture.md) |
| Extension compatibility | [`extension-compatibility.md`](extension-compatibility.md) |
| Subagent framework | [`subagent-framework.md`](subagent-framework.md) |
| Data storage conventions | [`data-storage-conventions.md`](data-storage-conventions.md) |
| Prompt provenance | [`prompt-provenance.md`](prompt-provenance.md) |
| Documentation style | [`documentation-style-guide.md`](documentation-style-guide.md) |

## Contributor navigation

- [`../INDEX.md`](../INDEX.md) — quick repository index.
- [`../REPOMAP.md`](../REPOMAP.md) — source ownership map.
- [`../ROADMAP.md`](../ROADMAP.md) — release and extension roadmap.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — contribution workflow.
- [`../tests/README.md`](../tests/README.md) — test-suite overview.
