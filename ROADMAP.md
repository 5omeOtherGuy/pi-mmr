# pi-mmr roadmap

This roadmap tracks package-level direction. Each shipped extension owns detailed milestones in its own `ROADMAP.md` file.

## Current baseline

`pi-mmr` ships as one installable Pi package with seven extensions:

| Extension | Status | Surface |
| --- | --- | --- |
| [`mmr-core`](src/extensions/mmr-core/README.md) | Shipped, default on | Locked modes, model resolution, tool registry, feature gates, prompt assembly, diagnostics |
| [`mmr-toolbox`](src/extensions/mmr-toolbox/README.md) | Shipped, default on | `apply_patch`, session-local `task_list` |
| [`mmr-subagents`](src/extensions/mmr-subagents/README.md) | Shipped, default on | `finder`, `oracle`, `Task`, `librarian`, custom Markdown subagents |
| [`mmr-session-fallback`](src/extensions/mmr-session-fallback/README.md) | Shipped, default on | Interactive session-scoped fallback model + thinking picker for subscription quota/rate-limit errors |
| [`mmr-web`](src/extensions/mmr-web/README.md) | Shipped, default off | `web_search`, `read_web_page` via SearXNG / Brave / DuckDuckGo |
| [`mmr-history`](src/extensions/mmr-history/README.md) | Shipped, default off | `find_session`, `read_session` over local Pi sessions with redaction |
| [`mmr-github`](src/extensions/mmr-github/README.md) | Shipped, default off | Read-only GitHub repository reads, listings, search, commits, diffs, repository discovery |

Routing spine owned by `mmr-core`:

```text
mode → model/thinking → active tools → prompt route → diagnostics
```

## Per-extension roadmaps

- [`src/extensions/mmr-core/ROADMAP.md`](src/extensions/mmr-core/ROADMAP.md)
- [`src/extensions/mmr-session-fallback/ROADMAP.md`](src/extensions/mmr-session-fallback/ROADMAP.md)
- [`src/extensions/mmr-toolbox/ROADMAP.md`](src/extensions/mmr-toolbox/ROADMAP.md)
- [`src/extensions/mmr-web/ROADMAP.md`](src/extensions/mmr-web/ROADMAP.md)
- [`src/extensions/mmr-subagents/ROADMAP.md`](src/extensions/mmr-subagents/ROADMAP.md)
- [`src/extensions/mmr-history/ROADMAP.md`](src/extensions/mmr-history/ROADMAP.md)

`mmr-github` currently ships without a separate roadmap; track new GitHub-provider milestones either here or in `src/extensions/mmr-github/ROADMAP.md` when the scope grows beyond maintenance.

## Near-term priorities

1. **User-facing documentation polish.** Keep the root README, [`docs/README.md`](docs/README.md), and [`docs/quick-reference.md`](docs/quick-reference.md) aligned with the shipped tool surface.
2. **GitHub/librarian clarity.** Keep `librarian` gating, worker docs, and `mmr-github` reference docs synchronized as repository-provider behavior evolves.
3. **Custom subagent setup hardening.** Continue tightening `/mmr-config` import/setup diagnostics, safe defaults, and fixtures for `sa__*` tools.
4. **Session-history handoff design.** Extend `mmr-history` beyond lookup/reading only after privacy, storage, and redaction contracts are explicit.
5. **Provider-policy boundaries.** Keep broad provider-specific payload/header/retry behavior out of `mmr-core` unless it is part of the mode contract.

## Planned or deferred capabilities

### `mmr-skills`

Potential callable skill-loading extension.

Would provide:

- `skill` tool registration and routing.
- Pi skill discovery integration.
- Feature-gate and tool-provider ownership through `mmr-core`.

Status: deferred until the Pi skill surface and least-privilege behavior are stable enough for a public contract.

### `mmr-toolbox-mcp`

Potential MCP discovery and routing extension separate from local toolbox utilities.

Would provide:

- MCP resource discovery, read-only resource access, and diagnostics.
- Feature-gate and tool-provider ownership through `mmr-core`.

Status: deferred. Local tools remain in `mmr-toolbox`; network/provider surfaces stay in their owning extensions.

### `mmr-provider-parity`

Potential provider-specific request behavior beyond the narrow per-mode request policy already in `mmr-core`.

Would provide:

- Broader provider-specific payload shaping.
- Provider-specific headers or retry policies when they become part of a public contract.

Status: deferred. `mmr-core/request-policy.ts` keeps the current minimal mode-owned token/reasoning behavior.

### `mmr-review`

Potential review orchestration extension.

Status: out of scope for now. `pi-mmr` does not include a core-owned `code_review` tool; users can use `oracle`, `Task`, custom subagents, or their own workflows.

## Release checklist

Before a release, run:

```bash
npm test
npm run check
npm run pack:dry-run
```

Add the Pi smoke test when extension loading or package metadata changes:

```bash
pi -e "$PWD" --list-models
```

Release work should also:

- Update `CHANGELOG.md` under `Unreleased` and cut a versioned section when tagging.
- Review all public text for repo-owned wording and no secrets/local-only provenance.
- Confirm `npm run pack:dry-run` contains only intended files.
- Keep package metadata, changelog, tag, and GitHub Release notes aligned.

## Public-safety checklist

Public text includes docs, code comments, test names, fixtures, snapshots, package metadata, prompt text, tool descriptions, and schema descriptions. Before publishing or broadening visibility:

- Describe behavior only in `pi-mmr` terms.
- Do not include credentials, raw provider payloads, local session data, private analysis, exact local paths, or non-public provenance.
- Keep model-visible prompt/tool metadata aligned with the implementation and the active tool surface.
- Keep mode keys (`smart`, `smartGPT`, `rush`, `large`, `deep`, `free`) and subagent names (`finder`, `oracle`, `librarian`, `history-reader`, `task-subagent`, `Task`) stable unless a coordinated migration plan exists.
