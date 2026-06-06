# What's New in pi-mmr

A quick tour of what changed in the last couple of days, focused on what you can
actually use. For the full technical record, see [`CHANGELOG.md`](../CHANGELOG.md).

> Scope: this covers the PRs merged on 2026-06-05 and 2026-06-06. The wider
> `0.2.0` release also shipped on 2026-06-05 — see the changelog for everything in
> that release (GitHub-backed `librarian`, `lockedModeExtraTools`, background task
> tools, and the worker model-fallback prompt all landed earlier and are part of
> `0.2.0`).

## Cleaner, Pi-native task and background rendering

The biggest visible change: the live task and background widgets now match Pi's
own working indicator and take up less space.

- The pinned `task_list` widget uses Pi-native status glyphs (`–` pending,
  `✓` completed, braille spinner for in-progress) instead of the old round
  glyphs, and animates in-progress rows with the same spinner Pi uses. The
  redundant `Tasks` header is gone, so the widget shows task rows directly.
- Background subagents now read like normal blocking subagents: a single pinned
  board at the bottom of the window shows running agents with a braille spinner,
  and each finished task's full result appears exactly once — no more duplicate
  cards or raw `task_<id>` rows.
- The background board shows useful live metadata: elapsed time, the resolved
  worker model, the latest worker tool, turn/tool counts, and context usage.
- A launched background task renders an inline running card immediately,
  collapsed to its short label until you expand it with `ctrl+o`.
- The task list and background widgets stay in fixed positions (task list above
  the editor, background agents below) so they no longer swap places on refresh.
- Background completions are delivered as Pi follow-ups, so a task that finishes
  while you're still working is queued right behind the active turn instead of
  waiting for your next prompt. Notifications are now the default result path —
  you rarely need to poll.

(Background tasks are launched with `start_task` and managed with `task_poll` /
`task_wait` / `task_cancel`; those tools shipped in `0.2.0`.)

## Custom Markdown subagents

You can now define your own subagents as Markdown files and call them as tools.

- Author a subagent in a Pi-owned root: `<cwd>/.pi/subagents` (project) or
  `~/.pi/agent/subagents` (global). The Markdown body becomes the worker's system
  prompt; frontmatter sets the model, thinking level, and tool allowlist.
- Enable and configure them through the `/mmr-config` → **subagent (setup/import
  custom)** wizard. It scans Pi-owned roots and can **import existing
  `.claude/agents` definitions**, recommends a least-privilege read-only toolset,
  maps tool aliases, blocks unsafe (recursive/advisory/MCP/mutation) tools, and
  lets you scope each subagent to specific locked modes and projects.
- Config is the on switch: a Markdown file is just a candidate until an enabled
  `mmrSubagents.custom.agents.<id>` record references it. A fresh install never
  auto-inherits another harness's subagents.
- Sensible fallbacks reduce friction: a subagent with no declared `tools` gets a
  standard toolset (`read, bash, edit, write, find, grep, web_search,
  read_web_page`), and an omitted `model` inherits the parent model. When a
  fallback is used, the rendered result tells you which fields to pin — without
  leaking that notice into the model's answer. An explicitly empty `tools: []`
  still runs a deliberate prompt-only subagent.

A restart is required after enabling a subagent (they load at activation).

## More reliable `task_list` during long work

`task_list` now nudges the agent to keep its list honest: stricter usage and
completion rules, a reminder to keep the list current after each successful write,
a verification nudge when a 3+ item list is marked all-complete without a check
step, and a bounded stale-update reminder after repeated turns with no list write.

## Safer `/mmr-config` writes

All `/mmr-config` settings writes (core, web, and custom-subagent records) now go
through one hardened path: symlinked `settings.json` files are refused, non-JSON
files are not clobbered, and writes are atomic — a crash mid-write can no longer
truncate your settings. The config menu also re-reads from disk on entry, so the
values shown reflect the file rather than a stale snapshot. SearXNG sidecar
start/stop commands are now trusted only from global settings (stripped with a
warning if found in project-local settings).

## Runs under Pi 0.78.x

The Pi host peer range was widened to `>=0.77.0 <0.79.0`, so `pi-mmr` loads under
the current Pi `0.78.x` line. The terminal-only task-list widget and the worker
model-fallback dialog were adapted to Pi 0.78's RPC/`hasUI` semantics, so headless
and RPC hosts behave correctly and an interrupted session dismisses the fallback
prompt cleanly.

## Smaller editing-guidance improvement

The built-in `edit` guidance now states that each `edits[]` item carries only
`oldText` and `newText` (no extra annotation/comment keys or numbered variants),
steering the agent to split changes across separate items instead of retrying a
rejected call.

## For developers: opt-in request/response capture (`mmr-debug`)

A new developer-only extension can record the ground-truth provider
request/response surface (assembled system prompt, advertised tools, response
status/headers, and model output) as JSON Lines for turn-by-turn debugging. It is
fully inert unless `MMR_DEBUG_CAPTURE_FILE` is set and is not auto-loaded — opt in
with:

```
MMR_DEBUG_CAPTURE_FILE="$PWD/.pi/mmr-debug/capture.jsonl" \
  pi -e "$PWD/src/extensions/mmr-debug/index.ts"
```

`MMR_DEBUG_CAPTURE_FULL=1` additionally dumps the entire raw request payload.
Capture files contain full prompt/session text, so keep them out of version
control (the recommended `.pi/mmr-debug/` path is gitignored).

## Also of note

- The hidden `cthulu` advisory easter egg was removed entirely, along with its
  prompt gate and rendering.
