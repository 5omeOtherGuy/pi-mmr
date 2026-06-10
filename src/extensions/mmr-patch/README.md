# mmr-patch

Ships the `apply_patch` tool: structured, atomic, multi-file workspace edits in the Codex patch format.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../mmr-toolbox/ROADMAP.md`](../mmr-toolbox/ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | `apply_patch` | none | `/mmr-status`, tool result `details` |

## When to use it

- Apply structured single-file or multi-file workspace edits instead of shell or script rewrites.
- Add, delete, update, or move/rename files in one atomic patch.
- Make context-anchored edits that match by surrounding text, not line numbers.

## Status and enablement

Default: on. `mmr-patch` is registered in `package.json` `pi.extensions` and loads without opt-in config.

The extension registers a concrete Pi tool named `apply_patch` and claims ownership through an `mmr-patch` tool provider. `mmr-core` resolves the name by exact identity against Pi's live tool inventory; its exact-name status catalog also credits `mmr-patch` for the name when Pi loads entrypoints in isolated module caches and the provider call cannot reach the central registry. The tool is `active` only when the concrete `apply_patch` registration exists; Pi's built-in `edit` / `write` remain independent.

## Tools / commands / surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| `apply_patch` | Tool | Apply a Codex-format patch to workspace files |

Result shape: `content[0].text` begins with one `Applied patch: …` status line, a blank line, then a structured diff body; `details` carries `{ summary, files }` with per-file metadata and a unified `diff`.

## Configuration

No settings or environment variables. The extension loads on startup and registers `apply_patch` unconditionally; nothing is sampled at load.

## Behavior

`apply_patch` is a custom Pi tool that accepts a structured Codex-format patch and applies it to workspace files.

### Schema and model-visible surfaces

- **Schema**: `{ patchText: string }` with `additionalProperties: false`. The patch must wrap in `*** Begin Patch` / `*** End Patch` markers.
- **`description` (model-visible)**: self-contained — carries the formal grammar block, context rules (3-line default; 5–10 lines for repetitive or large files; no duplicated context between adjacent changes), additional rules, reliability tips, and a worked example for each distinct operation. Two `pi-mmr`-specific behaviors are documented inline: ambiguous matches are rejected rather than first-match-wins, and the workspace + sibling-worktree path-safety contract.
- **`promptGuidelines` (system prompt)**: short high-signal cues — prefer `apply_patch` for single-file edits and patch-style add/delete/rename/multi-file changes; read enough context first; use 5–10 lines or an `@@` anchor for repetitive or ambiguous locations; avoid unanchored insert-only hunks; redact secrets before submission.
- **`promptSnippet`**: `"Apply a Codex-format patch to workspace files"`.

### Operations and hunks

- **Operations**: `*** Add File: <path>`, `*** Delete File: <path>`, `*** Update File: <path>` (optionally followed by `*** Move to: <newPath>`). Multiple operations in a single patch.
- **Hunks**: `@@` headers with optional scope hints (`@@ class Foo`), body lines prefixed with ` ` (context), `-` (remove), or `+` (add), and an optional `*** End of File` anchor. Hunks match by surrounding context, not line numbers. Consecutive `@@` headers progressively narrow scope; each hint is a plain substring search and matching continues after the matched anchor. A missing anchor falls back to body-only context matching from the carry-in cursor.
- **Strict ambiguity rejection**: when more than one body location passes, the patch is rejected with a request for more context or an `@@` anchor rather than silently choosing a match. This is the one notable behavior a model could reasonably misread, so it is called out in the description.

### Path safety

- Paths resolve relative to `ctx.cwd`. The workspace root is canonicalized once per patch via `realpath`, so a symlinked `cwd` is handled in one namespace.
- **Allowed roots** = `ctx.cwd` plus every sibling worktree of the same git repo, discovered once per patch via `git worktree list --porcelain`. If `ctx.cwd` is not in a git repo (or git is unavailable) the only allowed root is `ctx.cwd`.
- Absolute paths into unrelated directories, paths escaping via `..` past every allowed root, and symlink traversal escaping every allowed root are all rejected before any hunk applies. The boundary error names the current workspace, the discovered worktree roots, and the rejected target.
- Caveat (TOCTOU): the boundary check runs at path resolution, before the per-file mutation lock is acquired. In the single-user CLI context this tool targets, that is sufficient; a hostile concurrent process that swaps a symlink between resolution and read could still race the boundary check.

### Concurrency and atomicity

- Every file referenced is locked through Pi's per-file mutation queue (`withFileMutationQueue`) for the full read-validate-write window. Locks key on canonical realpath so symlink aliases collapse onto the same lock; the lock set is sorted before acquisition so concurrent patches over overlapping files cannot deadlock.
- Repeated operations on the same file run against an in-memory virtual file state, so later ops see earlier ops' changes; the file is read once per patch.
- All hunks validate against the in-lock state before any write, so a single failing hunk leaves the workspace untouched. A pre-flush topology check rejects any patch that would write a file beneath an ancestor that is not (and will not be) a directory. Deletes are flushed before writes so replace-file-with-directory patterns succeed.
- Caveat: beyond the topology check, the final flush writes each file sequentially inside the held locks. A non-deterministic filesystem failure mid-flush may leave partial state; there is no cross-file rollback log.

### Execution mode

`apply_patch` declares `executionMode: "sequential"`. Pi runs the entire assistant tool-call batch sequentially in model order whenever any called tool is sequential, so a turn that mixes `apply_patch` with other tool calls cannot race its own workspace mutations.

## Diagnostics and troubleshooting

- **`apply_patch` rejected an ambiguous match.** Add more context lines (5–10) or an `@@` scope hint to anchor the hunk; `apply_patch` will not silently choose between multiple matches.
- **`apply_patch` rejected a path.** The boundary error names the workspace, discovered worktree roots, and the rejected target. The target must resolve inside `ctx.cwd` or a sibling worktree of the same git repo.
- **`apply_patch` reported a missing or colliding file.** `*** Update File` / `*** Delete File` require the file to exist; `*** Add File` requires it not to. A write beneath a non-directory ancestor is rejected as a path topology conflict.
- **Tool result marked as an error.** Malformed envelopes, unknown headers, ambiguous matches, missing context, missing/colliding files, and unsafe paths all throw `ApplyPatchError`; Pi marks the tool result as an error so the model observes the failure.

## Public API

Stable re-exports from `pi-mmr`: `registerMmrPatchProviders`, `ApplyPatchError`. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- `mmr-patch` was split out of the former `mmr-toolbox`, which is now a deprecated compatibility shim that re-exports this extension (and `mmr-tasks`).
- `apply_patch` keeps the `{ patchText: string }` schema and Codex-format grammar so deep-mode models can call it unchanged; future format extensions must be additive.
- The deliberate ambiguity rejection is the only documented notable behavior of `apply_patch` that a model could reasonably misread. Any further notable behaviors must be called out explicitly here.
- `apply_patch` validates every path against `ctx.cwd` (and same-repo worktrees) before writing anything; no plan touching outside the allowed roots may reach the file mutation queue.
