# mmr-toolbox

Local-utility extension. Ships `apply_patch` and a session-local `task_list` (todo) tool, plus an MMR tool provider that maps the logical `apply_patch` and `task_list` capabilities to those concrete tools.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`ROADMAP.md`](ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | `apply_patch`, `task_list`, `/tasks` slash command, pinned task-list widget | none | `/mmr-status`, tool result `details`, `/tasks` |

## When to use it

- Apply structured multi-file workspace edits via `apply_patch` instead of shell rewrites.
- Track multi-step work for the current Pi session with a deterministic, persistable todo list.
- The pinned UI widget surfaces the current todo list above the input editor.

## Status and enablement

`mmr-core` resolves both names by exact identity against Pi's live tool inventory and credits `mmr-toolbox` through the tool provider (or the exact-name status catalog when Pi loads entrypoints in isolated module instances). Deep mode requests `apply_patch`, `edit`, `write`; the toolbox tool is active only when the concrete `apply_patch` registration exists, while `edit` / `write` remain separately available. Every enforced mode requests `task_list`, so the toolbox todo tool is available whenever this extension is loaded. Other toolbox capabilities remain deferred until their real implementations land; `mmr-core` reports them through its deferred-tool diagnostics.

The previous `task_list` workspace-coordination prototype (leases, dependencies, parent/child, cross-session FS watcher, `/tasks pick` / `release`) is parked — not discarded — on the annotated tag `archive/task-list-coordination-prototype-v1` as candidate material for a future `mmr-subagents` Task agent. The active session-local tool stays in enforced modes until a mode explicitly adopts that future replacement. See the *Archived task-list coordination prototype* block in [`ROADMAP.md`](ROADMAP.md).

## Tools

| Tool | Purpose | Result shape |
| --- | --- | --- |
| `apply_patch` | Apply a Codex-format patch to workspace files | `content` (status line + diff body); `details` (per-file summary + structured diff) |
| `task_list` | Manage a session-local todo list with whole-list replacement | `content` (human summary); `details` (`oldTasks`, `newTasks`, `allCompleted`) |

## Behavior

### `apply_patch`

Custom Pi tool that accepts a structured Codex-format patch and applies it to workspace files.

- **Schema**: `{ patchText: string }`. The patch must wrap in `*** Begin Patch` / `*** End Patch` markers.
- **Tool description (model-visible)**: self-contained — carries the full grammar, rules, examples, and `pi-mmr`-specific behaviors so deep-mode models can use the tool from the description alone. Includes the formal grammar block, context rules (3-line default; 5-10 lines for repetitive/large files; no duplicated context between adjacent changes), additional rules (conflict-marker length, no `apply_patch` for linter/formatter-only edits), reliability tips (read more before guessing, preserve indentation, avoid unanchored insert-only hunks, keep CRLF consistent), and worked examples for add, simple update, scoped update, repetitive file, multi-`@@` narrowing, end-of-file anchor, conflict markers, delete, and move/rename. Two `pi-mmr`-specific behaviors documented inline: ambiguous matches are rejected rather than first-match-wins, and path safety is the `pi-mmr` workspace + sibling-worktree behavior below.
- **`promptGuidelines` (system-prompt-visible)**: short high-signal cues — prefer `apply_patch` for single-file edits and patch-style add/delete/rename/multi-file changes; do not use Python or shell rewrites when a simple `apply_patch` would suffice; read enough context first; use 5-10 lines or an `@@` anchor for repetitive/ambiguous locations; avoid unanchored insert-only hunks.
- **Result shape**: `content[0].text` begins with one `Applied patch: …` status line, a blank line, then the structured diff body (context plus `-`/`+` lines; no unified-diff metadata). Single-file: `Applied patch: <path> (+a/-d)`. Multi-file: `Applied patch: N files` followed by labeled per-file sections each headed by `<path> (+a/-d)`. The status line gives surfaces that only render `content` an unambiguous success marker and is a single prefix line + blank line, trivially stripped. `details` carries `{ summary, files }` with compact per-file summary and structured metadata (`type`, `path`, optional `oldPath` for moves, `uri`, `additions`, `deletions`, unified `diff`). The interactive TUI `renderResult` path renders from `details` and suppresses the status line.
- **Operations**: `*** Add File: <path>`, `*** Delete File: <path>`, `*** Update File: <path>` (optionally followed by `*** Move to: <newPath>`). Multiple operations in a single patch.
- **Hunks**: `@@` headers with optional scope hints (`@@ class Foo`), body lines prefixed with ` ` (context), `-` (remove), or `+` (add), and the optional `*** End of File` anchor. Hunks match by surrounding context, not line numbers. Multiple consecutive `@@` headers progressively narrow scope; each hint is a plain substring search; matching continues *after* the matched anchor line. A missing anchor does not fail the hunk — the matcher falls back to body-only context matching from the carry-in cursor.
- **Strict ambiguity rejection**: when more than one body location passes, the patch is rejected with a request for more context or an `@@` anchor rather than silently choosing one match. Documented in the description.
- **Errors**: malformed envelopes, unknown headers, ambiguous matches, missing context, missing/colliding files, and unsafe paths all throw `ApplyPatchError`. Pi marks the tool result as an error so the model observes the failure.

### `task_list`

A session-local todo list. Plan and track multi-step work within the current Pi session.

- **Schema**: strict `{ tasks: TaskListItem[] }`. Each item `{ content, activeForm, status, subtasks? }`:
  - `content` — imperative (e.g. `"Run the gate"`).
  - `activeForm` — present-continuous shown while `in_progress` (e.g. `"Running the gate"`).
  - `status` — `pending | in_progress | completed`.
  - `subtasks` — optional `{ content, activeForm?, status }` children. Use this for real child work, not parent text like `"parent — subtask: child"`.
  - `additionalProperties: false` at both levels. A defense-in-depth `validateTodoParams` runs inside `execute` so hosts that skip Pi's TypeBox validator still reject malformed input.
- **Whole-list replacement**: every call submits the complete list. Omitted items disappear; never merged into a previous state. `tasks: []` is a valid explicit clear; prompt guidance tells models not to send it unless the user explicitly asks.
- **All-completed sweep**: when every submitted item is `completed`, the *stored* list is cleared to `[]` immediately. The result still echoes the submitted list and surfaces `details.allCompleted: true`.
- **One `in_progress`** (documented contract): callers should keep at most one item `in_progress`. Not enforced.
- **Subtask status advancement** (documented contract): models should advance each subtask's `status` through `pending` → `in_progress` → `completed` like top-level items. The pinned widget shows which child step is being worked on. Prompt guidance reminds the model; not enforced per-subtask.
- **Persistence**: each accepted call appends one `CustomEntry` of type `mmr-toolbox.todo-state` via `pi.appendEntry(...)`. Reads use `findLatestPersistedTodoState(...)` which walks newest-first and returns the first payload that parses cleanly (future-version or invalid entries are skipped). The format mirrors `mmr-core.mode-state`. **No workspace store, no on-disk JSON file, no claim/lease, no cross-session coordination.**
- **Session scope**: per-session. Two Pi sessions in the same workspace do not see each other's lists; a fresh session starts empty.
- **Model recollection after compaction**: `before_agent_start` injects a bounded snapshot of the latest non-empty list (first 12 rows, 120 chars per label, plus an overflow count). The session log remains the source of truth; the prompt block exists only so compaction cannot make the model forget active todos.
- **Result shape**: `content[0].text` is a short human-readable summary of the new list plus a capped previous-list summary when one existed. `details` is `{ oldTasks, newTasks, allCompleted }` on success or `{ error }` with `isError: true` on validation failure.
- **Errors**: validation failures (missing fields, empty `content` / `activeForm`, unknown status, unknown field) return `{ isError: true, details: { error } }` so the model reacts. Persistence failures propagate as unexpected errors so Pi surfaces them as tool crashes.

### Execution mode (capability-aware parallelism)

Both `apply_patch` and `task_list` declare `executionMode: "sequential"`. Pi's agent loop runs the entire assistant tool-call batch sequentially, in model order, whenever any called tool is sequential, so a turn that mixes `apply_patch` (workspace mutation) or `task_list` (whole-list session-state replacement) with other tool calls can no longer race itself. Read-only tools keep Pi's default parallel scheduling.

This is the limit of what an extension can enforce: Pi exposes no API to set `executionMode` on its built-in `bash` / `edit` / `write` tools or to change the agent-level default, so those remain parallel-eligible. `mmr-core`'s built-in `bash` guidance instead steers the model away from emitting dependent/stateful `bash` calls as parallel siblings.

### Pinned UI widget and `/tasks`

`task_list` projects the current session's list onto Pi's persistent widget above the input editor (widget id `pi-mmr-task-list`). The session log entry is the source of truth; the widget is a UI mirror. Refresh fires after every successful tool call and after Pi emits `session_compact`, so the display is reprojected from persisted state after compaction reloads context.

The widget is registered in the factory form (`(tui, theme) => ({ render, invalidate })`) so Pi re-invokes it on theme changes. Subtasks render directly below their parent with branch markers (`├─` / `└─`) so child work is visually distinct from the flat top-level list. Projection is best-effort: `refreshTodoWidget` swallows render/UI errors so a transient failure can never demote a successful tool call into an `isError` result. Headless surfaces (`ctx.hasUI === false`) are skipped entirely.

There is **no `session_start` hydration and no cross-session FS watcher**. The widget appears the first time the model calls `task_list` (or the user runs `/tasks show`) within the session, not at session start. Two concurrent Pi sessions on the same workspace do not share widget state.

`/tasks` slash command: `/tasks` (status), `/tasks show`, `/tasks hide`, `/tasks list`. Status reports current visibility and the bound toggle shortcut. The toggle shortcut defaults to `alt+t` (override via `--task-widget-toggle-key`; empty string disables). The legacy `/tasks pick` and `/tasks release` were removed alongside the coordination prototype.

### MMR tool provider

`mmr-toolbox` registers a provider named `mmr-toolbox` claiming the logical `apply_patch` and `task_list` names. `mmr-core`'s exact-name catalog also credits these names when the provider is not visible across Pi loader module caches. No alias or one-of fallback: `apply_patch` is active only when Pi has a concrete tool named `apply_patch`; `edit` / `write` are independent. `task_list` is deferred until this extension registers the concrete tool, then activates by identity match.

Also exported as `registerMmrToolboxProviders(registry)` for tests and isolated registries.

## Safety and privacy

- **What leaves the process.** Nothing. `apply_patch` reads/writes the workspace and same-repo worktrees only; `task_list` appends to the Pi session log.
- **What is rejected.** `apply_patch` validates every path against `ctx.cwd` and sibling worktrees of the same git repo before writing anything; absolute paths into unrelated directories, paths escaping via `..`, and symlink traversal escaping every allowed root are rejected.
- **What is persisted.** `task_list` appends `mmr-toolbox.todo-state` custom entries to the Pi session log; no workspace or on-disk JSON file. `apply_patch` writes only the files in the patch.
- **Intentionally not supported.** Cross-session task coordination, leases, claims, dependencies, on-disk task store, workspace shell.

### `apply_patch` path safety

- Paths resolve relative to `ctx.cwd`. The workspace root is canonicalized once per patch via `realpath`, so a symlinked `cwd` (e.g. macOS `/tmp` → `/private/tmp`) is handled in one namespace by the boundary check, topology check, and lock keys.
- **Allowed roots** = `ctx.cwd` + every sibling worktree of the same git repo, discovered once per patch via `git -C <cwd> rev-parse --git-common-dir` and `git -C <cwd> worktree list --porcelain`. Each listed worktree is canonicalized; only worktrees whose canonical common dir matches the current repo are kept. If `ctx.cwd` is not in a git repo (or git is unavailable) the only allowed root is `ctx.cwd`.
- Relative paths resolve from `ctx.cwd`; absolute paths land inside any allowed root. Absolute paths into unrelated directories, paths escaping via `..` past every allowed root, and symlink traversal escaping every allowed root are all rejected before any hunk applies.
- The boundary error includes the current workspace, discovered worktree roots, and the rejected target so it is obvious why a path was refused and which roots would have been accepted.
- Topology checks walk parent directories up to the matched root for each file, not always `ctx.cwd`, so cross-worktree patches get full ancestor validation.
- Caveat (TOCTOU): the boundary check runs at path resolution, before the per-file mutation lock is acquired. In the single-user CLI context this tool is designed for, that is sufficient. A hostile concurrent process that swaps a symlink between resolution and read could still race the boundary check; the boundary is not re-validated inside the lock window.

### `apply_patch` concurrency and atomicity

- Every file referenced is locked through Pi's per-file mutation queue (`withFileMutationQueue`) for the full read-validate-write window. Locks key on canonical realpath (with the unresolved suffix for files that don't yet exist) so symlink aliases collapse onto the same lock; the lock set is sorted before acquisition so concurrent patches touching overlapping files cannot deadlock.
- Repeated operations on the same file within a patch run against an in-memory virtual file state. Later ops see earlier ops' changes; the file is read once per patch.
- All hunks validate against the in-lock virtual state before any write, so a single failing hunk leaves the workspace untouched.
- A pre-flush topology check rejects any patch that would write a file beneath an ancestor that is not (and will not be) a directory — catching in-patch conflicts (`Add File: a` + `Add File: a/b`) and on-disk conflicts (`Add File: place/inside` where `place` already exists as a regular file). For each write path, every ancestor up to `cwd` must already be a directory, not exist on disk, or be deleted by the same patch.
- Flush processes deletes before writes so replace-file-with-directory patterns succeed.
- Caveat: beyond the topology check, the final flush writes each affected file sequentially inside the held locks. A non-deterministic filesystem failure mid-flush may still leave partial state; there is no cross-file rollback log.

## Diagnostics and troubleshooting

- **`apply_patch` rejected an ambiguous match.** Add more context lines (5–10) or an `@@` scope hint to anchor the hunk; `apply_patch` will not silently choose between multiple matches.
- **`apply_patch` rejected a path.** Boundary error names the workspace, discovered worktree roots, and the rejected target. The target must resolve inside `ctx.cwd` or a sibling worktree of the same git repo.
- **`task_list` widget did not appear.** Widget appears the first time the model calls `task_list` (or `/tasks show`) in the session — there is no `session_start` hydration. Headless surfaces (`ctx.hasUI === false`) skip the widget entirely.
- **`task_list` did not survive across sessions.** By design: lists are session-scoped. A resumed session reads its own latest `mmr-toolbox.todo-state` entry; new and forked sessions start empty.

## Public API

Re-exported from `pi-mmr`:

- `createTodoListTool({ pi, getIsHidden })` — `task_list` tool definition.
- `findLatestPersistedTodoState`, `toPersistedTodoState`, `parsePersistedTodoState`, `TODO_STATE_ENTRY`, `TODO_STATE_VERSION`.
- `refreshTodoWidget(ctx, tasks, { isHidden? })`, `TASK_LIST_WIDGET_ID`.
- `registerMmrToolboxProviders(registry)`.
- Types: `TaskListItem`, `TaskListSubtask`, `TodoStatus`, `PersistedTodoState`.

Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

### Design pattern for new toolbox tools

`apply_patch` is the reference. Every toolbox tool exposes three model-visible surfaces plus this README:

1. **`description` (tool schema).** Self-contained: purpose + highest-signal usage cue ("prefer this tool over X / Y"); hard preconditions; format/grammar block; context/matching rules; additional rules / "do not use this for…"; reliability tips for the hard cases models miss most; worked examples for every distinct operation and every non-obvious feature; notable behaviors a model could misread (e.g. ambiguous matches are rejected, not first-match-wins); safety/path/boundary contract. The model must be able to use the tool correctly from the description alone.
2. **`promptGuidelines` (system prompt).** ≤4 entries, each 1–2 short sentences: when to prefer this tool, the single biggest format reminder at planning time, the top 1–2 pitfalls. Verbatim duplication of a description sentence is fine when needed at both surfaces.
3. **`promptSnippet` (one-line tool summary).** A short clause Pi uses in the prompt's tool-list. Fragment, not a sentence. `apply_patch` uses `"Apply a Codex-format patch to workspace files"`.
4. **This README.** Schema (`content` + `details`); model-visible surfaces; behavioral choices with rationale; safety / concurrency / atomicity invariants; TOCTOU / failure-mode caveats the description should not surface to the model. Also the registry for notable behaviors a model could reasonably misread — every future toolbox tool must keep an equivalent invariant.

Pin the surfaces with tests. `tests/mmr-toolbox-apply-patch-registration.test.mjs` asserts the description contains the grammar block, context-rule numbers, multi-file capability, key additional rules, key reliability tips, the prefer-over-X cue, each worked example heading, and every `promptGuidelines` entry.

### Deferred capabilities

`mmr-core`'s default deferred-tool diagnostics cover this until a real implementation ships:

- `chart` — chart rendering.

Diagnostics are intentionally not a planned `mmr-toolbox` tool. Pi-mmr is CLI-only with no native IDE/LSP bridge, so IDE diagnostics belong to whatever MCP/IDE integration a user chooses under that integration's own tool name. `mmr-core`'s mode prompts already direct the model to verify changes via bash typecheck/lint/build commands.

### Non-goals

- No subagents / model-worker orchestration (`mmr-subagents`).
- No session/thread history (`mmr-history`).
- No web/network access (`mmr-web`).
- No MCP discovery or MCP resource reads (`mmr-toolbox-mcp`).
- No review workflow/runner; review orchestration is user-owned.
- No provider payload rewrites (`mmr-provider-parity`).

### Invariants

- Only register tools the extension has actually implemented; deferred toolbox capabilities keep coming from `mmr-core`'s registry defaults so users see a consistent `/mmr-status`.
- `apply_patch` validates every path against `ctx.cwd` (and same-repo worktrees) before writing anything; no plan touching outside the workspace may reach the file mutation queue.
- `apply_patch` keeps the `{ patchText: string }` schema and Codex-format grammar so deep-mode models can call it unchanged. Future format extensions must be additive.
- The deliberate ambiguity rejection is the only documented notable behavior of `apply_patch` that a model could reasonably misread. Further notable behaviors must be called out explicitly here.

Tests: `tests/mmr-toolbox*.test.mjs`.
