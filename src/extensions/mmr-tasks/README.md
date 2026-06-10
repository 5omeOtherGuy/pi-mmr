# mmr-tasks

Ships the session-local `task_list` todo tool and its pinned task-list widget for tracking multi-step work within a Pi session.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../mmr-toolbox/ROADMAP.md`](../mmr-toolbox/ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | `task_list`, `/tasks` command, pinned widget | none | `/mmr-status`, tool result `details`, `/tasks` |

## When to use it

- Track multi-step work for the current Pi session with a deterministic, persistable todo list.
- Keep the model's plan visible after compaction drops older tool calls.
- Surface current progress in the pinned UI widget above the input editor.

## Status and enablement

Default: on. `mmr-tasks` is registered in `package.json` `pi.extensions` and loads without opt-in config.

The extension registers a concrete Pi tool named `task_list` and claims ownership through an `mmr-tasks` tool provider. `mmr-core` resolves the name by exact identity against Pi's live tool inventory; its exact-name status catalog also credits `mmr-tasks` for the name when Pi loads entrypoints in isolated module caches and the provider call cannot reach the central registry. The tool is available whenever this extension is loaded.

## Tools / commands / surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| `task_list` | Tool | Manage a session-local todo list with whole-list replacement |
| `/tasks` | Command | Inspect/show/hide/list the pinned task-list widget |
| Pinned widget | Widget | Project the current list above the input editor (`TASK_LIST_WIDGET_ID`) |
| Toggle shortcut | Shortcut | Show/hide the widget (defaults to `alt+t`) |

Result shape: `content[0].text` is a short human-readable summary of the new list plus a capped previous-list summary when one existed; `details` is `{ oldTasks, newTasks, allCompleted }` on success, or `{ error }` with `isError: true` on validation failure.

## Configuration

One CLI flag controls the widget toggle key; there are no settings keys or secrets.

```bash
--task-widget-toggle-key alt+t   # empty string disables the shortcut
```

The default toggle key is `alt+t` (Pi reserves `ctrl+t`); if `alt+t` is taken the fallback `ctrl+shift+t` is tried. The chosen binding is reported by `/tasks`. The flag is sampled once at extension load; restart Pi after changing it.

## Behavior

A session-local todo list to plan and track multi-step work within the current Pi session.

### Schema

Strict `{ tasks: TaskListItem[] }` with `additionalProperties: false` at both levels. Each item `{ content, activeForm, status, subtasks? }`:

- `content` — imperative form (e.g. `"Run the gate"`).
- `activeForm` — present-continuous form shown while `in_progress` (e.g. `"Running the gate"`).
- `status` — `pending | in_progress | completed`.
- `subtasks` — optional `{ content, activeForm?, status }` children. Use this for real child work, not parent text like `"parent — subtask: child"`.

A defense-in-depth validation pass runs inside `execute` so hosts that skip Pi's TypeBox validator still reject malformed input; rejections surface as `TodoValidationError`.

### Whole-list replacement and sweeps

- **Whole-list replacement**: every call submits the complete list. Omitted items disappear; lists are never merged into a previous state. `tasks: []` is a valid explicit clear; prompt guidance tells models not to send it unless the user explicitly asks.
- **All-completed sweep**: when every submitted item is `completed`, the *stored* list is cleared to `[]` immediately. The result still echoes the submitted list and surfaces `details.allCompleted: true`.
- **One `in_progress`** (advisory contract): callers should keep at most one item `in_progress`. Not enforced.
- **Subtask status advancement** (advisory contract): models should advance each subtask's `status` through `pending` → `in_progress` → `completed` like top-level items. Prompt guidance reminds the model; not enforced per-subtask.

### Persistence and session scope

- Each accepted call appends one Pi custom session-log entry of type `mmr-tasks.todo-state` via `pi.appendEntry(...)`. Reads use `findLatestPersistedTodoState(...)`, which walks the session log newest-first and returns the first payload that parses cleanly; future-version or invalid entries are skipped. There is **no workspace store, no on-disk JSON file, no claim/lease, and no cross-session coordination.**
- **Session scope**: per-session. Two Pi sessions in the same workspace do not see each other's lists; a fresh session starts empty.
- **Model recollection after compaction**: `before_agent_start` injects a bounded snapshot of the latest non-empty list (first 12 rows, 120 chars per label, plus an overflow count). A `context` hook also emits a bounded ephemeral reminder when the model works many turns without refreshing `task_list`. The session log remains the source of truth; these blocks only keep compaction from making the model forget active todos.

### Pinned widget and `/tasks`

- `task_list` projects the current session's list onto Pi's persistent widget above the input editor (widget id `TASK_LIST_WIDGET_ID`, value `pi-mmr-task-list`). The session log entry is the source of truth; the widget is a UI mirror. Refresh fires after every successful tool call and after Pi emits `session_compact`.
- The widget is registered in factory form so Pi re-invokes it on theme changes. Subtasks render directly below their parent with branch markers (`├─` / `└─`). Projection is best-effort: `refreshTodoWidget` swallows render/UI errors so a transient failure can never demote a successful tool call into an `isError` result. Headless surfaces (`ctx.hasUI === false`) are skipped.
- There is **no `session_start` hydration and no cross-session FS watcher**. The widget appears the first time the model calls `task_list` (or the user runs `/tasks show`) within the session.
- `/tasks` slash command: `/tasks` (status), `/tasks show`, `/tasks hide`, `/tasks list`. Status reports current visibility and the bound toggle shortcut.

### Execution mode

`task_list` declares `executionMode: "sequential"`. Pi runs the entire assistant tool-call batch sequentially in model order whenever any called tool is sequential, so two `task_list` calls in one turn cannot race the whole-list session-state replacement.

## Diagnostics and troubleshooting

- **`task_list` was rejected.** Validation failures (missing fields, empty `content` / `activeForm`, unknown status, unknown field) return `{ isError: true, details: { error } }` so the model reacts; persistence failures propagate as tool crashes.
- **Widget did not appear.** The widget appears the first time the model calls `task_list` (or `/tasks show`) in the session — there is no `session_start` hydration. Headless surfaces (`ctx.hasUI === false`) skip the widget entirely.
- **List did not survive across sessions.** By design: lists are session-scoped. A resumed session reads its own latest `mmr-tasks.todo-state` entry; new and forked sessions start empty.
- **Toggle shortcut does nothing.** The bound key may be taken or disabled. Run `/tasks` to see the live binding (or `disabled`), or set `--task-widget-toggle-key`.

## Public API

Stable re-exports from `pi-mmr`: `registerMmrTasksProviders`, `createTodoListTool`, `refreshTodoWidget`, `TASK_LIST_WIDGET_ID`, `TodoValidationError`, `findLatestPersistedTodoState`, `parsePersistedTodoState`, `toPersistedTodoState`, `TODO_STATE_ENTRY`, `TODO_STATE_VERSION`, and the types `PersistedTodoState`, `TaskListItem`, `TaskListSubtask`, `TodoStatus`, `CreateTodoListToolOptions`, `RefreshTodoWidgetOptions`, `TodoListDetails`, `TodoListErrorDetails`. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- `mmr-tasks` was split out of the former `mmr-toolbox`, which is now a deprecated compatibility shim that re-exports this extension (and `mmr-patch`).
- Persistence mirrors `mmr-core.mode-state`: allowlist validation, version pinning, and a newest-first scan. The persisted entry type is `mmr-tasks.todo-state`.
- The previous workspace-coordination prototype (leases, dependencies, parent/child, cross-session FS watcher, `/tasks pick` / `release`) is parked — not discarded — on the annotated tag `archive/task-list-coordination-prototype-v1` as candidate material for a future Task agent. See the *Archived task-list coordination prototype* block in [`../mmr-toolbox/ROADMAP.md`](../mmr-toolbox/ROADMAP.md).
- Intentionally not supported: cross-session task coordination, leases, claims, dependencies, an on-disk task store, and workspace shell.
