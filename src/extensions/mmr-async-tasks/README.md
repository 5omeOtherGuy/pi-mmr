# mmr-async-tasks

Background fleet for `pi-mmr`: run subagent workers asynchronously, poll or wait for them, cancel them, and watch a pinned live dashboard while the parent keeps working.

Package overview: [`../../../README.md`](../../../README.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md). Sibling worker extension: [`../mmr-subagents/README.md`](../mmr-subagents/README.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | `start_task`, `task_poll`, `task_wait`, `task_cancel`, fleet dashboard | none | `/mmr-status`, fleet dashboard, tool result `details` |

## When to use it

- You want a worker to run while the parent agent keeps reasoning, instead of blocking on an inline `Task`/`finder`/`librarian` call.
- The user explicitly asks for background, fan-out, parallel, or asynchronous workers.
- You need to launch several workers at once and collect their results later via `task_poll`/`task_wait`.
- You want a glanceable, always-current view of in-flight background work.

Need a result before your next reasoning step? Use the blocking worker tools owned by [`mmr-subagents`](../mmr-subagents/README.md) instead. `oracle` is always blocking and can never run as a background agent.

## Status and enablement

`mmr-async-tasks` ships enabled. It was extracted from `mmr-subagents` and is registered in `package.json` under `pi.extensions`.

- The feature-gate provider reports the `mmr-async-tasks` gate **enabled** with the background-fleet capability list. The compatibility gate name `mmr-subagents.async-tasks` is also exported for callers that referenced the pre-split name.
- `start_task`, `task_poll`, `task_wait`, and `task_cancel` resolve `{ kind: "active" }` and surface as `active` in modes that request them.
- The owned tool names are fixed by `MMR_ASYNC_TASK_TOOLS`; the provider claims only those names and returns `undefined` for everything else.

## Tools / commands / surfaces

| Surface | Kind | Purpose |
| --- | --- | --- |
| `start_task` | tool | Launch one background worker, or a `fleet` of grouped workers, for `agent` ∈ `Task`, `finder`, `librarian`. |
| `task_poll` | tool | Snapshot a `task_id`/`group_id`, or list the whole session board when both are omitted. |
| `task_wait` | tool | Block up to `timeout_ms` for a `task_id`/`group_id` to reach a terminal state. |
| `task_cancel` | tool | Cancel a `task_id`/`group_id` with an optional `reason`. |
| Fleet dashboard | widget | Pinned `aboveEditor` summary of running, finished, and failed background tasks. |

The background `agent` values are fixed by `ASYNC_TASK_AGENT_NAMES` (`Task`, `finder`, `librarian`). `oracle` is intentionally not a background agent.

## Configuration

Background-fleet behavior is on by default and needs no settings. Automatic completion delivery is governed by one environment variable.

```bash
export MMR_SUBAGENTS_ASYNC_PUSH=false   # disable automatic completion notices/idle-wake
```

- The variable name is exported as `MMR_SUBAGENTS_ASYNC_PUSH_ENV`. When delivery is disabled you still get results by calling `task_poll`/`task_wait`.
- Per-call opt-out: `start_task` accepts `notify: false` (single task or top-level fleet) to suppress automatic delivery for that launch while still recording the task.
- Session ceilings are constants, not settings: `DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION` bounds concurrently running tasks and `DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION` bounds automatic notices per session.
- The registry is session-scoped in-memory state; nothing is written into the workspace. Settings/env are sampled at load — restart Pi after changing the delivery variable.

## Behavior

### Launch and grouping

`start_task` runs the selected `agent` as a background worker through the same child-worker primitive used by the blocking tools. Tasks can be launched singly or as a `fleet` of one or more groups; each member carries its own `agent`, `prompt`, and `description`. A launch may target a fresh group (`group_id: "new"` with an optional `group_label`) or an existing `group_<...>` id, so related workers can be polled and waited on together.

### Registry and lifecycle

A session-scoped registry (`createMmrAsyncTaskRegistry`/`getMmrAsyncTaskRegistry`) owns task state, status transitions, and freshness. Tasks move through running and terminal states; terminal records are retained for a bounded TTL (`ASYNC_TASK_TERMINAL_TTL_MS`, `ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS`) so a late `task_poll` still sees the outcome. Long-running and stalled workers are bounded by `ASYNC_TASK_MAX_RUNTIME_MS` and `ASYNC_TASK_STALLED_AFTER_MS`; cancellation is finalized after `ASYNC_TASK_CANCEL_DEAD_AFTER_MS`.

### At-most-once completion delivery

When automatic delivery is enabled, each finished task is announced to the model **at most once** across two paths:

- **In-turn context pull** — while an agent loop is active, finished tasks are surfaced through the context the parent already consumes.
- **Idle-wake push** — when the session is idle, a follow-up wakes the session so the result is not lost.

Delivery state is tracked per task so the two paths cannot both fire for the same completion, and per-session pushes are capped by `DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION`. Tasks launched with `notify: false`, or when `MMR_SUBAGENTS_ASYNC_PUSH` is disabled, are never auto-announced and must be read with `task_poll`/`task_wait`.

### Fleet dashboard

A pinned `aboveEditor` widget renders the current board — running, finished, and failed tasks with their groups — and updates as the registry changes, giving an always-current view without polling. Public snapshots exposed to the dashboard and to `task_poll` are produced by `toPublicAsyncTaskSnapshot`.

## Diagnostics and troubleshooting

- **No completion notice arrived.** Automatic delivery is off (`MMR_SUBAGENTS_ASYNC_PUSH` disabled) or the task was launched with `notify: false`. Read the result with `task_poll`/`task_wait`.
- **Notices stopped mid-session.** The per-session push ceiling (`DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION`) was reached. Remaining results are still available via `task_poll`.
- **`start_task` refused a launch.** The running-task ceiling (`DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION`) was hit, or the `agent` was not one of `Task`/`finder`/`librarian`. Wait for in-flight tasks to finish or correct the `agent`.
- **A task shows as stalled/cancelled.** Runtime exceeded `ASYNC_TASK_MAX_RUNTIME_MS`/`ASYNC_TASK_STALLED_AFTER_MS`, or a cancel was finalized after `ASYNC_TASK_CANCEL_DEAD_AFTER_MS`. Inspect the task `details`.
- **`task_poll` returns nothing for an old id.** The terminal TTL elapsed and the record was reclaimed. Re-launch if you still need the work.

## Public API

Stable re-exports from `pi-mmr`. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

Extension and provider surface:

- `createMmrAsyncTasksExtension(overrides?)`, `MmrAsyncTasksFactoryOverrides`.
- `createMmrAsyncTasksFeatureGateProvider(...)`, `createMmrAsyncTasksToolProvider(...)`, `MmrAsyncTasksCapabilities`.
- `MMR_ASYNC_TASKS_FEATURE_GATE`, `MMR_ASYNC_TASKS_PROVIDER_NAME`, `MMR_ASYNC_TASK_TOOLS`, plus the compatibility aliases `MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE`, `MMR_SUBAGENTS_ASYNC_TASK_TOOLS`.

Tools:

- `START_TASK_TOOL_NAME`, `TASK_POLL_TOOL_NAME`, `TASK_WAIT_TOOL_NAME`, `TASK_CANCEL_TOOL_NAME`, `ASYNC_TASK_TOOL_NAMES`, `ASYNC_TASK_AGENT_NAMES`, `MMR_SUBAGENTS_ASYNC_PUSH_ENV`.
- `createStartTaskTool`, `createTaskPollTool`, `createTaskWaitTool`, `createTaskCancelTool`, `registerAsyncTaskTools`. Types: `AsyncTaskAgentName`, `AsyncTaskToolDeps`, `AsyncTaskToolDetails`.

Registry:

- `createMmrAsyncTaskRegistry`, `getMmrAsyncTaskRegistry`, `toPublicAsyncTaskSnapshot`, `isValidAsyncTaskGroupId`.
- Constants `DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION`, `DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION`, `DEFAULT_TASK_WAIT_TIMEOUT_MS`, `MAX_TASK_WAIT_TIMEOUT_MS`, `ASYNC_TASK_MAX_RUNTIME_MS`, `ASYNC_TASK_STALLED_AFTER_MS`, `ASYNC_TASK_CANCEL_DEAD_AFTER_MS`, `ASYNC_TASK_TERMINAL_TTL_MS`, `ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS`.
- Types `MmrAsyncTaskRegistry`, `MmrAsyncTaskRegistryDeps`, `MmrAsyncTaskSnapshot`, `MmrAsyncTaskInternalSnapshot`, `MmrAsyncTaskGroupSnapshot`, `MmrAsyncTaskGroupStatus`, `MmrAsyncTaskStatus`, `MmrAsyncTaskFreshness`, `MmrAsyncTaskBoard`, `MmrAsyncTaskBoardEntry`, `StartAsyncTaskArgs`, `StartAsyncTaskResult`, `WaitForAsyncTaskResult`.

## Developer notes

- The runtime split between blocking worker tools (owned by `mmr-subagents`) and background orchestration tools (owned here) is intentional. The model-visible guidance for both sides is unified through the shared subagent tool-guidance source of truth so every tool states the same two-sided rule: block when you need the result now, background when independent work should continue.
- The registry is session-scoped and in-memory; no background-task state is written inside the workspace. Durable conventions: [`../../../docs/data-storage-conventions.md`](../../../docs/data-storage-conventions.md).
- The tool provider claims only `MMR_ASYNC_TASK_TOOLS` and returns `undefined` for every other name, so it never shadows `mmr-core`, `mmr-subagents`, or user aliases.
- Background `agent` values stay aligned with the concrete read-only/worker subagents shipped by `mmr-subagents`; keep `ASYNC_TASK_AGENT_NAMES` in sync when that set changes.
