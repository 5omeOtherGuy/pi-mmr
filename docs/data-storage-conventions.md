# Per-user data storage conventions for `pi-mmr` extensions

**Audience.** Extension authors who need to **persist per-user data on disk** (handoff thread caches, subagent state, review caches, future shared coordination state, etc.). Session-scoped state should prefer Pi `CustomEntry` persistence instead of adding files here.

**Related.** Package overview: [`../README.md`](../README.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

It is **not** for:

- Provider API keys, OAuth tokens, or credentials — those belong in environment variables or Pi's settings layer; never persist them in MMR-owned files.
- Pi session transcripts, message history, or the interactive UI's own state — Pi owns those locations.
- Per-workspace generated artifacts that the user might commit (build outputs, generated docs) — those belong in the workspace, gated by the user's normal `.gitignore`.
- Test fixtures or development snapshots checked into the repo.

## The convention

Persist per-user data at:

```text
<getAgentDir()>/data/pi-mmr/<feature>/<scope-key>...
```

Where:

- `getAgentDir()` is imported from `@earendil-works/pi-coding-agent`. It returns Pi's agent data directory — `~/.pi/agent` by default, or the value of the `PI_CODING_AGENT_DIR` env var (with leading-`~` expansion). Do **not** re-implement either of those rules; call `getAgentDir()` and pass it through `path.join(...)`.
- `data/pi-mmr/` is the fixed root for all `pi-mmr` package state. Keeping the package name in the path means an unrelated extension installed under the same Pi agent dir cannot collide with us, and a future package rename can grep for one directory.
- `<feature>` is a short kebab-case directory unique per feature surface (`handoff`, `subagents`, `review-cache`, future `task-coordination`, …). One feature → one subdirectory; do not pile multiple unrelated features into one JSON.
- `<scope-key>` is a deterministic, filesystem-safe key that scopes data inside `<feature>`. Most commonly the sha256 hash of an identity string such as the absolute workspace root path or a thread ID. Truncating to ~32 hex chars is fine; full 64-char hashes are also fine. Do not embed user-visible paths or PII in the filename.

The previous workspace-scoped `task_list` coordination prototype was the first implementation of these conventions. It is no longer active code; the frozen reference lives on the annotated tag `archive/task-list-coordination-prototype-v1` if a future Task-agent/team-coordination layer needs to recover its store/path helpers.

## Mandatory invariants

Any extension that persists per-user data must satisfy all of the following:

1. **Outside the worktree.** Never write user state into the workspace. Most repos do not gitignore `.pi/`, so a stray write risks accidentally committing private content. The agent dir is always outside the workspace.
2. **Atomic writes.** Write to a temp file with a unique suffix (pid + random bytes), then `rename(2)` it into place. No in-place truncation; no partial writes visible to a concurrent reader.
3. **Tolerate a missing file as empty.** First call in a fresh install should not crash — `ENOENT` means "no state yet".
4. **Refuse to overwrite corrupt or unrecognized state.** Surface a typed error (e.g. an extension-specific `*StoreError`) so the caller can present a clean message instead of silently truncating the user's data. Inspecting the file by hand must always be an option.
5. **Versioned on-disk shape.** Persist `{ version: N, ... }` (or equivalent) and reject unknown versions explicitly. If the schema later changes incompatibly, bump the version and ship a one-shot migration; never silently overwrite.
6. **In-process serialization per store path.** A per-path mutex keyed by the absolute store path. Two operations in the same Pi process targeting the same file must not interleave; operations against different paths may run in parallel. The cleanup `finally` must remove the entry from the inflight map so the map does not leak.
7. **State cross-process mutation semantics explicitly.** If a feature can be mutated from multiple Pi processes or subagents, guard the full read-modify-write window with a cross-process lock (for example an `O_EXCL` lockfile with stale-lock recovery). If a feature deliberately omits cross-process locking, document the exact last-writer-wins behavior in the model-facing description so the model does not over-trust concurrent safety.
8. **Injectable base directory.** The store factory must accept a `baseDir` (or equivalent) override so tests and future subagent runners can isolate state without monkey-patching `process.env`. Default the override to `resolveDefault…BaseDir()` so production callers do not have to think about it.
9. **Inject the clock and ID generator too.** The defaults are `() => new Date().toISOString()` and `randomBytes(8).toString("hex")`; tests inject deterministic versions. This keeps unit tests fast and snapshot-stable.

## Anti-patterns

- ❌ Reading `XDG_DATA_HOME` / `~/.local/share` directly. `getAgentDir()` already owns "where does agent state live" for the whole Pi install; rolling a parallel cascade fragments user data.
- ❌ Writing under `<workspace>/.pi/`. Most repos do not gitignore `.pi/`.
- ❌ Embedding user-visible paths or repo URLs in filenames. Hash them.
- ❌ Sharing one JSON between unrelated features. One feature → one subdirectory under `data/pi-mmr/`.
- ❌ Persisting secrets, tokens, OAuth state, or anything else a Free-mode user would not expect MMR to keep.
- ❌ Silent migrations on read. Either keep the same `version` and respect it, or ship a versioned migration step with logging.
- ❌ Re-implementing `PI_CODING_AGENT_DIR` env handling or `~`-expansion. Always call `getAgentDir()`.

## Archived worked example: workspace-scoped task coordination

The archived `task_list` coordination prototype used this shape:

- Resolver: `resolveDefaultTaskStoreBaseDir()` returned `path.join(getAgentDir(), "data", "pi-mmr", "task-list")`.
- Scope key: sha256 of the absolute workspace root path (the nearest enclosing git repo, or the cwd itself), truncated to 32 hex chars, with a `.json` extension.
- Final path: `~/.pi/agent/data/pi-mmr/task-list/<sha256(workspaceRoot)>.json` by default; `$PI_CODING_AGENT_DIR/data/pi-mmr/task-list/...` when the env var is set.
- Atomic writes: `<storePath>.<pid>.<random>.tmp` → `rename(...)`. Failure rolls back the temp file.
- Refuse-to-overwrite: corrupt or unrecognized JSON threw `TaskStoreError` with a "refusing to overwrite; inspect manually" message.
- Version: `{ version: 1, tasks: [...] }`.
- In-process mutex: `withTaskStoreLock(storePath, fn)` chained promises per store path; the cleanup `finally` removed the entry so the inflight map stayed bounded.
- Tests injected `baseDir` (a `mkdtempSync` directory) so suites did not pollute the developer's real `~/.pi/`.

The active `mmr-tasks task_list` no longer uses this on-disk convention. It is a session-local todo list persisted as `mmr-tasks.todo-state` `CustomEntry` records in the current session log (`{ version: 2, tasks }`, while existing flat version 1 entries remain readable). Existing files under `data/pi-mmr/task-list/` are intentionally left orphaned and can be recovered by checking out `archive/task-list-coordination-prototype-v1`.

## When you're about to ship a new feature that persists data

Quick checklist before merging:

- [ ] Path under `<getAgentDir()>/data/pi-mmr/<feature>/...` (imported via `getAgentDir`, not reconstructed).
- [ ] Schema includes a `version` field; reader rejects unknown versions.
- [ ] Writes are atomic (temp file + `rename`).
- [ ] Reads tolerate `ENOENT`; corrupt JSON throws a typed error.
- [ ] Per-path mutex serializes mutations within a Pi process; mutex map is cleaned up in `finally`.
- [ ] `baseDir`, clock, and ID generator are injectable; tests use a `mkdtemp` `baseDir`.
- [ ] Cross-process mutation semantics are implemented or explicitly documented (lockfile/SQLite/etc. for shared mutable state, or a clear last-writer-wins warning for intentionally unlocked state).
- [ ] Tool description names the on-disk path so the model knows where state lives, and explicitly states the cross-process locking or last-writer-wins behavior.
- [ ] No secrets, tokens, or credentials end up in the file.
- [ ] No code path writes anything under the workspace.
