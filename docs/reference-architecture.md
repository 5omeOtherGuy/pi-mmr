# pi-mmr reference architecture

**Audience.** Maintainers and reviewers who need the architectural shape of `pi-mmr`: module ownership, dependency direction, and the shared contracts that bind core to its sibling extensions.

**Related.** Package overview: [`../README.md`](../README.md). Public API: [`public-api.md`](./public-api.md), [`mmr-core-api.md`](./mmr-core-api.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

## Current implementation state

`pi-mmr` is one installable Pi package containing modular extensions. Today the package registers ten extensions:

- `mmr-core` — implemented;
- `mmr-session-fallback` — implemented; interactive session-scoped fallback on subscription quota/rate-limit errors;
- `mmr-patch` — implemented (`apply_patch`);
- `mmr-tasks` — implemented (`task_list` plus the pinned task-list widget);
- `mmr-web` — implemented; opt-in via `MMR_WEB_ENABLE`; `web_search` works no-key out of the box (DuckDuckGo HTML fallback) and prefers SearXNG (user-controlled URL) or Brave (with `BRAVE_API_KEY`) when configured; an opt-in managed SearXNG sidecar can spawn/stop a local instance on demand;
- `mmr-github` — implemented; opt-in read-only GitHub repository tools used directly and by the `librarian` worker gate;
- `mmr-subagents` — concrete workers shipped (`finder`, `oracle`, `Task`, `librarian`); owns `Task`/`finder`/`oracle`/`librarian` logical names and the `mmr-subagents` feature gate. Shipped workers use the `mmr-core` subagent execution route (`--mmr-subagent <name>`) so the child Pi process applies a profile-resolved model/thinking/tool allowlist verbatim; `librarian` remains `gated` until the required read-only GitHub tools are registered and source-owned by `mmr-github`; the feature gate reports `enabled` with the active capability list.
- `mmr-async-tasks` — implemented; owns the background fleet tools `start_task`, `task_poll`, `task_wait`, and `task_cancel`.
- `mmr-custom-subagents` — implemented; owns custom Markdown subagents (discovery and registration).
- `mmr-history` — opt-in global local Pi session lookup; registers `find_session` and `read_session` when enabled. `read_session` runs through the in-process `history-reader` subagent with a deterministically redacted packet, falling back to lexical extraction on worker failure.

Implemented in `mmr-core`:

- locked modes: `smart`, `smartGPT`, `smartSonnet`, `rush`, `test`, `large`, and `deep`; native-control modes: `open` and `free`;
- mode selection via `--mmr-mode`, `/mode`, persisted session state, settings, or default;
- provider-neutral model preference resolution with subscription-first preference ordering;
- thinking-level application for the selected model;
- per-mode `before_provider_request` policy that rewrites only allowed token/reasoning fields;
- logical tool resolution, active-tool allowlists, and `tool_call` blocking;
- deferred/gated/disabled tool diagnostics;
- feature-gate registry for future modules;
- prompt-head rewrite for prompted locked modes (see [`prompt-provenance.md`](prompt-provenance.md));
- persisted `mmr-core.mode-state` entries;
- session-identity primitive (`MmrSessionIdentity`) for downstream extensions;
- public helper exports for future extensions ([`mmr-core-api.md`](mmr-core-api.md)).

Implemented in `mmr-patch`:

- `apply_patch` custom Pi tool with `{ patchText: string }` schema accepting a structured patch envelope (`*** Begin Patch` / `*** Add|Delete|Update File:` / `*** Move to:` / `@@` hunks matched by context, with consecutive `@@` lines for scope narrowing). Repeated ops on the same file compose against an in-memory virtual state. Absolute paths inside `ctx.cwd` *or* inside any sibling worktree of the same git repository (discovered via `git worktree list --porcelain`) are accepted; paths outside the active workspace and the discovered same-repo worktree roots are rejected. The entire read-validate-write window is held under Pi's per-file mutation queue keyed by canonical realpath. Ambiguous body matches are rejected (the model must add context or an `@@` anchor) rather than first-match-wins.
- MMR tool provider that maps the logical `apply_patch` name to the concrete patch tool. `mmr-core` also prefers exact concrete tools over fallbacks when Pi exposes them.

Implemented in `mmr-tasks`:

- `task_list` custom Pi tool: a session-local todo list with strict `{ tasks: [{ content, activeForm, status, subtasks? }] }` whole-list replacement, persisted as `mmr-tasks.todo-state` `CustomEntry` records in the current Pi session log.
- MMR tool provider that maps the logical `task_list` name to the concrete tasks tool, plus the pinned task-list widget.

Implemented in `mmr-web`:

- pluggable `web_search` backend with three concrete clients (SearXNG, Brave, DuckDuckGo) behind a `SearchBackend` interface; `auto` mode selects in order SearXNG (when `MMR_WEB_SEARXNG_URL` is set) → Brave (when `BRAVE_API_KEY` is set) → DuckDuckGo HTML (built-in no-key fallback);
- `read_web_page` backed by the custom in-process reader with a high-fidelity Readability + Turndown Markdown pipeline (lazy-imported via `linkedom`) and a zero-dep fallback when the toolchain cannot be loaded or the page is not an article;
- opt-in managed SearXNG sidecar (`mmrWeb.searxngManaged=true` + `searxngStartCommand`) that spawns a local SearXNG on demand, polls health, idle-stops, and tears down on `session_shutdown`. Start/stop commands are settings-file only; `child_process.spawn` runs with `shell: false`;
- URL/SSRF validation, per-call timeouts, byte-budget truncation;
- MMR tool provider and `mmr-web` feature-gate provider that report gated/active state in `/mmr-status`.

Not implemented yet:

- non-GitHub repository-provider variants for `librarian`;
- handoff support and richer session indexing (`mmr-history`);
- callable skill loading (`mmr-skills`);
- remaining toolbox tool: `chart`;
- MCP bridging (`mmr-toolbox-mcp`);
- provider payload rewrites beyond the current mode-owned request policy (`mmr-provider-parity`).

## Architecture principle

One Pi package containing multiple narrow extensions.

`mmr-core` owns locked-mode consistency:

```text
selected mode -> resolved model/thinking -> tools -> prompt -> persisted state
```

Other extensions own higher-risk or higher-variance capabilities and plug into core through exported helpers, tool providers, feature-gate providers, and current mode state. Core knows that a logical capability exists but does not implement session history, subagent execution, web access, MCP, provider mutation, or toolbox behavior.

## Extension ownership

| Extension | Owns | Status |
|---|---|---|
| `mmr-core` | Mode registry, mode commands/flags, model and thinking resolution, request-policy hook, tool allowlist enforcement, mode prompt rewrite, mode state, session-identity primitive, shared contracts. | Implemented. |
| `mmr-session-fallback` | Session-scoped quota/rate-limit fallback picker, managed model update, persisted override, retry-message rewrite. | Implemented. |
| `mmr-patch` | Safe file patching: the `apply_patch` local utility tool and its structured patch engine. | Implemented. |
| `mmr-tasks` | Session-local todo tracking: the `task_list` tool and its pinned task-list widget. | Implemented. |
| `mmr-web` | `web_search`, `read_web_page`, web/network policy, pluggable SearXNG/Brave/DuckDuckGo backends, custom reader with Readability + Turndown, and the opt-in managed SearXNG sidecar. | Implemented (opt-in). |
| `mmr-github` | Read-only GitHub repository tools, token/env handling, response bounds, source-owned tool registration for `librarian`. | Implemented (opt-in). |
| `mmr-subagents` | `Task`, `finder`, `oracle`, `librarian`, worker runner. Non-GitHub repository-provider variants remain deferred. | Implemented with gated `librarian`. |
| `mmr-async-tasks` | Background fleet tools: `start_task`, `task_poll`, `task_wait`, `task_cancel`. | Implemented. |
| `mmr-custom-subagents` | Custom Markdown subagent discovery and registration. | Implemented. |
| `mmr-history` | `find_session`, `read_session`, future `handoff`, local session indexing, privacy gates. | Initial gated session lookup slice implemented. |
| `mmr-skills` | Callable `skill` tool that loads and applies skill bodies through Pi-compatible skill discovery. | Planned. |
| `mmr-toolbox-mcp` | MCP resource/tool discovery and `read_mcp_resource`. Diagnostics belong to user-configured MCP/IDE tools, not a canonical pi-mmr logical tool. | Planned. |
| `mmr-review` | No pi-mmr-owned surface. Review orchestration is user-owned and out of scope. | Deferred/out of scope. |
| `mmr-provider-parity` | Model aliases beyond core model resolution, provider diagnostics, optional provider payload rewrites, payload snapshots. | Planned. |
| Future `mmr-prompt` | Prompt profiles or provider-specific prompt block serialization if prompt behavior becomes independently configurable. | Do not split yet. |

## Dependency direction

Preferred direction:

```text
mmr-core
  <- mmr-session-fallback
  <- mmr-patch
  <- mmr-tasks
  <- mmr-web
  <- mmr-github
  <- mmr-subagents
  <- mmr-async-tasks
  <- mmr-custom-subagents
  <- mmr-history
  <- mmr-skills
  <- mmr-toolbox-mcp
  <- mmr-provider-parity
```

Rules:

- Later modules may import `mmr-core` public helpers and types.
- `mmr-core` must not import later modules.
- Later modules register tool providers and feature-gate providers rather than editing core state directly.
- `mmr-toolbox-mcp` may depend on `mmr-toolbox` concepts, but MCP-specific behavior must remain separable from local utility tools.

## Core contracts

### Mode state

`MmrModeState` is the normalized runtime contract. Future modules should use `getMmrModeStateSnapshot()` rather than reading session entries directly or holding the live read-only runtime object.

It records:

- active mode and selection source;
- model preference order and resolved provider/model;
- selected thinking level;
- prompt surface;
- requested, active, missing, deferred, gated, and disabled tools;
- feature gates and their provider-attributed statuses;
- model/tool resolution diagnostics;
- persisted state version and application time.

### Tool providers

Extensions claim ownership of canonical Pi tool names through `registerMmrToolProvider(...)`.

Tool rules:

- `active`: provider claims ownership; the registry confirms by identity match against Pi's live tool inventory;
- `deferred`: known but not implemented or not yet registered with Pi;
- `gated`: implemented or known, but unavailable because a feature gate is off;
- `disabled`: administratively disabled.

Resolution is identity-only: a requested name activates when Pi has registered a tool with exactly that name. `mmr-core` maintains an exact-name status catalog (`DEFAULT_TOOL_CATALOG`) so deferred tools owned by extensions that have not shipped (or whose `registerMmrToolProvider` call landed on a sibling singleton under isolated module caches) still credit the right owning extension in `/mmr-status`.

### Feature gates

Future extensions claim gates through `registerMmrFeatureGateProvider(...)`.

Core's built-in reserved gate provider reports known future gates as `missing` until their owning extension registers a higher-priority provider.

### Prompt boundary

Prompt assembly stays in `mmr-core` for now because the selected mode, resolved model, thinking level, active tools, and prompt surface must stay consistent.

A future `mmr-prompt` split is allowed only when prompt profiles or provider-specific prompt block serialization become independent product surfaces.

## Canonical tool ownership matrix

All tool names below are concrete Pi tool names. Modes, subagent profiles, custom subagent allowlists, and user tool lists must use these exact names; there are no aliases.

| Tool | Owner | Current behavior |
|---|---|---|
| `read` | Pi (core) | Identity-resolved; always active when Pi exposes it. |
| `bash` | Pi (core) | Identity-resolved. |
| `write` | Pi (core) | Identity-resolved. |
| `edit` | Pi (core) | Identity-resolved. |
| `grep` | Pi (core) | Identity-resolved. |
| `find` | Pi (core) | Identity-resolved. |
| `ls` | Pi (core) | Identity-resolved. |
| `apply_patch` | `mmr-patch` | Real tool in `mmr-patch`; deferred when the extension is not loaded. Deep mode requests `apply_patch`, `edit`, and `write` independently. |
| `task_list` | `mmr-tasks` | Real tool in `mmr-tasks` (session-local todo); kept available in every enforced mode until each mode explicitly adopts a future `Task` subagent replacement. |
| `chart` | `mmr-toolbox` | Deferred. |
| `web_search` | `mmr-web` | Active when network is enabled. Uses SearXNG when configured, Brave when keyed, and DuckDuckGo HTML as a no-key fallback. `WebSearchDetails.backend` reports the concrete path. |
| `read_web_page` | `mmr-web` | Active when network is enabled; uses the custom in-process reader and needs no provider key. |
| `Task` | `mmr-subagents` | Active in `smart`/`smartGPT`/`smartSonnet`/`rush`/`test`/`large`/`deep` and `open` modes. Mode-derived bounded worker uses `mmr-core`'s `task-subagent` profile. |
| `finder` | `mmr-subagents` | Active in `smart`/`smartGPT`/`smartSonnet`/`rush`/`test`/`large`/`deep` and `open` modes. Read-only worker (`--tools grep,find,read`) uses `mmr-core`'s subagent execution profile. |
| `oracle` | `mmr-subagents` | Active in `smart`/`smartGPT`/`smartSonnet`/`rush`/`test`/`large`/`deep` and `open` modes. Advisory worker uses `mmr-core`'s `oracle` profile. |
| `librarian` | `mmr-subagents` | Gated behind source-owned read-only `mmr-github` tools; remote repository research uses the `librarian` profile. |
| `read_github` | `mmr-github` | Active when GitHub access is enabled; reads files or lists directories. |
| `list_directory_github` | `mmr-github` | Active when GitHub access is enabled; lists directory entries. |
| `glob_github` | `mmr-github` | Active when GitHub access is enabled; matches repository paths. |
| `search_github` | `mmr-github` | Active when GitHub access is enabled and a token is available; searches code in one repository. |
| `commit_search` | `mmr-github` | Active when GitHub access is enabled; searches/lists commits. |
| `diff_github` | `mmr-github` | Active when GitHub access is enabled; compares refs and optional bounded patches. |
| `list_repositories` | `mmr-github` | Active when GitHub access is enabled; discovers token-accessible and public repositories. |
| `handoff` | `mmr-history` | Deferred. |
| `read_session` | `mmr-history` | Active when `MMR_HISTORY_ENABLE=true`; resolves any local Pi session by id; always tries the `history-reader` worker first with a redacted packet, falls back to redacted lexical extraction. |
| `find_session` | `mmr-history` | Active when `MMR_HISTORY_ENABLE=true`; enumerates every local Pi session on disk; returns matches with an opaque `projectRef` per session and never raw cwd / file paths. |
| `skill` | `mmr-skills` | Deferred. |
| `read_mcp_resource` | `mmr-toolbox-mcp` | Deferred. |

## `apply_patch` ownership

`apply_patch` is a patch/diff-style file editing primitive, especially useful for single-file edits. Its long-term owner is `mmr-patch`, not `mmr-core`, because a real implementation is a local utility tool with safety and file-mutation semantics separate from locked-mode resolution. The `mmr-patch` implementation:

- accepts a structured patch payload rather than arbitrary shell text;
- validates target paths against the current workspace (plus sibling worktrees of the same git repository) and Pi safety rules;
- applies the patch atomically where practical;
- reports clear hunks/failures without partially hiding edits;
- avoids network access and provider payload mutation;
- registers itself through `registerMmrToolProvider(...)`. The exact-name status catalog in `mmr-core` credits `mmr-patch` as the owner of `apply_patch` even when extension module caches are isolated, so `/mmr-status` always names the right owning extension.

When `mmr-patch` is not loaded, deep mode's `apply_patch` request resolves as `deferred`. Deep mode also requests `edit` and `write` directly, so narrow edit/write capability is preserved by request structure (not by registry fallback).

## Module notes

### `mmr-web`

Owns network reads/searches. Network policy, provider selection, rate limits, and privacy prompts live here, not in core. The extension registers `web_search` and `read_web_page` only when configured and safe to use.

### `mmr-github`

Owns read-only GitHub repository access. Token handling, response bounds, repository input parsing, and source-owned tool registration live here, not in `mmr-subagents`. `librarian` depends on this provider rather than owning GitHub API behavior itself.

### `mmr-skills`

Owns callable skill loading. Pi already has native skill resources; this module should bridge `skill` tool calls to Pi-compatible skill discovery without duplicating the whole skill system.

### `mmr-patch`

Owns the `apply_patch` local utility tool and its structured patch engine — a file-mutation primitive that is neither a model worker nor history/web/provider behavior. See [`src/extensions/mmr-patch/README.md`](../src/extensions/mmr-patch/README.md).

New local utility tools must follow the multi-surface design pattern: full guidance (grammar, rules, reliability tips, worked examples, and inline departure notes) belongs in the tool `description`; short high-signal cues belong in `promptGuidelines`; the one-line `promptSnippet` belongs in the tool list; and human/implementer context belongs in the owning extension's README. Behavioral notes that matter to the model must be called out inline in the model-visible description, not only in docs.

### `mmr-tasks`

Owns the session-local `task_list` tool and its pinned task-list widget. State is persisted as `mmr-tasks.todo-state` `CustomEntry` records in the current Pi session log. See [`src/extensions/mmr-tasks/README.md`](../src/extensions/mmr-tasks/README.md).

> The deferred image/artifact inspection and `chart` rendering surfaces remain unbuilt local utilities; diagnostics belong to user-configured MCP/IDE tools rather than a canonical pi-mmr tool. The former combined `mmr-toolbox` extension is now an unregistered, deprecated compatibility shim that only re-exports `mmr-patch` and `mmr-tasks`.

### `mmr-toolbox-mcp`

Owns MCP-specific discovery and resource reads. Keep this separate from `mmr-toolbox` so local utility tools do not imply MCP server access.

### Review workflow

`pi-mmr` does not include a `code_review` tool in mode definitions and does not plan a core-owned review runner at this time. Review orchestration is user-owned/out of scope.

## Implementation order

1. Keep hardening `mmr-core` public contracts and docs.
2. Continue hardening implemented local utility tools `apply_patch` (`mmr-patch`) and `task_list` (`mmr-tasks`) and add deferred local utilities only when needed.
3. Continue `mmr-github`/`mmr-subagents` by hardening source-owned librarian gating and designing deferred non-GitHub repository-provider variants behind explicit gates.
4. Continue `mmr-history` with handoff support and richer local or remote session indexing behind explicit privacy gates.
5. Implement `mmr-skills` as an opt-in capability module.
6. Implement `mmr-toolbox-mcp` only after deciding Pi-native MCP versus package-owned MCP bridge.
7. Implement `mmr-provider-parity` last, after mode/tool/prompt contracts are stable.
