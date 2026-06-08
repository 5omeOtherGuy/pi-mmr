# pi-mmr

[![CI](https://github.com/5omeOtherGuy/pi-mmr/actions/workflows/ci.yml/badge.svg)](https://github.com/5omeOtherGuy/pi-mmr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Pi package](https://img.shields.io/badge/Pi-package-7c3aed)

> Switch your entire Pi coding harness — model, thinking, tools, and prompt — with one command. Fully reversible.

`pi-mmr` turns Pi into a coding harness you control. Instead of one fixed model-and-prompt configuration, you pick a mode — `smart`, `smartGPT`, `rush`, `large`, or `deep` — and `pi-mmr` swaps the **whole** profile in a single switch: that mode's provider-neutral model preferences, thinking policy, context profile, active-tool allowlist, worker profile, and prompt behavior. Every knob is exposed instead of hidden, and `free` releases every lock to return you to stock Pi at any time.

It is a modular Pi extension package, not a fork or a separate IDE — it builds on Pi's native behavior instead of replacing it. Each mode's prompt is assembled from its own fragments and surgically swapped into Pi's auto-rendered prompt head, preserving Pi's own tool list, guidelines, documentation, and tail. Tool resolution is exact-name based, runtime state is session-scoped, and everything runs on your own provider subscriptions and API keys.

Beyond modes, `pi-mmr` adds Pi-native tools for codebase search, expert review, GitHub repository research, web lookup, prior-session recall, safe patching, todos, and subscription quota fallback — each behind explicit feature gates. Bounded work can be delegated to workers (`finder`, `oracle`, `librarian`, `Task`) and to your own Markdown subagents, each running in its own context and returning just the result. Independent work can run in the background as a worker fleet (`start_task`/`task_poll`/`task_wait`/`task_cancel`) that renders in the Pi TUI with live status, output previews, an expandable trail, usage counters, and a grouped task board — so you can watch what runs instead of guessing. Locked modes are fail-closed, everything is reversible, and the deterministic test suite never makes live provider calls.

## Why pi-mmr

- **One command changes the whole harness.** `/mode deep` is not just a model switch; it locks mode, model-preference order, thinking, tools, and prompt behavior together — and per-mode postures genuinely differ (fast and frugal vs. broad-context vs. careful-reasoning).
- **A framework, not a black box.** Model routing, thinking policy, tool allowlists, and prompt assembly are all explicit, inspectable via `/mmr-status`, and configurable in settings.
- **Provider-neutral by design.** Modes use explicit preference order: subscription/OAuth provider entries first, then API-key entries, then other registered providers — so the same mode follows you across providers.
- **Right-sized delegation.** Use `finder`, `oracle`, `Task`, and `librarian`, run independent jobs as a background fleet, or ship your own Markdown subagents — without hand-picking child models and tools.
- **Fail-closed and reversible.** A locked mode refuses to activate without a usable model and active tools; `free` releases every MMR-owned lock and tool registration.
- **Optional reach, off by default.** Web, GitHub, and local session-history tools stay gated until you explicitly enable them.
- **Runs on your stack.** Open source (MIT), self-hosted as a Pi package, driven by the providers you already authenticate.

## Quick start

Pi must already be installed and authenticated.

```bash
pi -e git:github.com/5omeOtherGuy/pi-mmr --mmr-mode smart
```

Install globally or per project:

```bash
pi install git:github.com/5omeOtherGuy/pi-mmr
pi install -l git:github.com/5omeOtherGuy/pi-mmr
```

Verify the active locked mode inside Pi:

```text
/mmr-status
/mode rush
/mode free
```

Pi (`@earendil-works/pi-coding-agent`) and `@earendil-works/pi-agent-core` are peer dependencies and are not bundled.

## First two minutes

1. Start a session in the default locked mode:

   ```bash
   pi -e git:github.com/5omeOtherGuy/pi-mmr --mmr-mode smart
   ```

2. Inspect the active locked mode and gates:

   ```text
   /mmr-status
   /mmr-status debug
   ```

3. Switch modes by intent:

   ```text
   /mode rush       # fast, low-token turns
   /mode deep       # hard reasoning, planning, review
   /mode free       # stock Pi behavior; MMR-owned tools removed
   ```

4. Ask Pi to use a worker when the job is bounded:

   ```text
   Use finder to locate where provider model preferences are resolved.
   Ask oracle to review the mode activation design.
   Use Task to update the focused docs file and run the narrow check.
   ```

5. Enable optional reach only when needed:

   ```bash
   export MMR_WEB_ENABLE=true
   export MMR_GITHUB_ENABLE=true
   export MMR_HISTORY_ENABLE=true
   ```

## Choose a mode

| I want to... | Use | What changes |
| --- | --- | --- |
| Do balanced coding | `smart` | Default locked route, standard tool set, toggleable thinking |
| Prefer GPT-family models | `smartGPT` | Smart profile with GPT-family model preferences |
| Move quickly | `rush` | Fast model preferences, low-token posture, smaller tool set |
| Work with long context | `large` | Long-context model preferences and broad-context posture |
| Plan, debug, or review deeply | `deep` | High-reasoning route, diagnostic posture, deep-specific tools |
| Return to stock Pi | `free` | Releases MMR locks and removes MMR-owned tools |

Mode selection precedence: `--mmr-mode` flag → persisted session → `mmrCore.defaultMode` → `smart`.

Useful controls:

```text
/mode              # show current mode
/mode deep         # switch mode
/mmr-status        # locked-mode status (add `debug` for model/tool resolution)
Ctrl+Shift+S       # mode picker  (Alt+M fallback)
Ctrl+Space         # cycle smart → smartGPT → rush → large → deep
Alt+R              # toggle the active mode's thinking preset (where supported)
```

## Choose a tool

| I need to... | Use | Owner |
| --- | --- | --- |
| Patch files safely | `apply_patch` | [`mmr-toolbox`](src/extensions/mmr-toolbox/README.md) |
| Track session work | `task_list` | [`mmr-toolbox`](src/extensions/mmr-toolbox/README.md) |
| Search the codebase by behavior | `finder` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) |
| Ask for deep advice or review | `oracle` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) |
| Run bounded child work | `Task` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) |
| Run independent work in the background | `start_task` / `task_poll` / `task_wait` / `task_cancel` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) |
| Research GitHub repositories | `librarian` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) + [`mmr-github`](src/extensions/mmr-github/README.md) |
| Search the web | `web_search` | [`mmr-web`](src/extensions/mmr-web/README.md) |
| Read public web pages | `read_web_page` | [`mmr-web`](src/extensions/mmr-web/README.md) |
| Find old Pi sessions | `find_session` | [`mmr-history`](src/extensions/mmr-history/README.md) |
| Reuse old session context | `read_session` | [`mmr-history`](src/extensions/mmr-history/README.md) |

For command-style lookup, see the [quick reference](docs/quick-reference.md).

## Delegate work to workers

Workers run bounded jobs in their own context and return just the result, so the main session stays focused:

- **`finder`** — fast, parallel codebase search; returns relevant files and line ranges.
- **`oracle`** — expert review, planning, and hard-bug reasoning, zero-shot.
- **`librarian`** — read-only research over remote GitHub repositories (gated on `mmr-github`).
- **`Task`** — a general worker for a scoped implementation, investigation, repair, or review; optionally narrowed to `read-only` or `read-write`.
- **Custom subagents** — your own Markdown-defined workers (`sa__*`), with model, thinking, tools, and skills set in frontmatter.

Independent work can run as a **background fleet**: `start_task` launches a worker (or a named group via `group_id`), and `task_poll`/`task_wait`/`task_cancel` coordinate it. Completed work is surfaced automatically or pulled on demand, and the Pi TUI shows a live, grouped task board. See [`docs/subagent-framework.md`](docs/subagent-framework.md).

## Feature map

| Extension | Default | User value |
| --- | --- | --- |
| [`mmr-core`](src/extensions/mmr-core/README.md) | On | Locked modes, model resolution, thinking policy, tool allowlists, prompt rewrite, diagnostics |
| [`mmr-toolbox`](src/extensions/mmr-toolbox/README.md) | On | Safe patching (`apply_patch`) and session-local todo tracking (`task_list`) |
| [`mmr-subagents`](src/extensions/mmr-subagents/README.md) | On | `finder`, `oracle`, `Task`, gated `librarian`, background task fleet, and custom Markdown subagents |
| [`mmr-session-fallback`](src/extensions/mmr-session-fallback/README.md) | On | Interactive fallback when subscription routes hit quota or rate limits |
| [`mmr-web`](src/extensions/mmr-web/README.md) | Off | `web_search` and `read_web_page` via SearXNG, Brave, or DuckDuckGo |
| [`mmr-history`](src/extensions/mmr-history/README.md) | Off | Search and summarize prior local Pi sessions with redaction |
| [`mmr-github`](src/extensions/mmr-github/README.md) | Off | Read-only GitHub files, directories, search, commits, diffs, repositories |

## Optional capabilities

Non-secret settings live in Pi settings files. Secrets belong in environment variables.

```json
{
  "mmrCore": {
    "defaultMode": "rush",
    "modelPreferences": {
      "deep": [{ "model": "gpt-5.5", "thinkingLevel": "medium" }]
    },
    "subagentModelPreferences": {
      "finder": [{ "model": "gpt-5.4-mini", "thinkingLevel": "low" }]
    }
  },
  "mmrWeb": { "enabled": true }
}
```

```bash
export MMR_WEB_ENABLE=true            # register web_search/read_web_page
export MMR_GITHUB_ENABLE=true         # register read-only GitHub tools
export MMR_HISTORY_ENABLE=true        # register find_session/read_session
export BRAVE_API_KEY="..."            # optional; env only
export MMR_GITHUB_TOKEN="ghp_xxx"     # optional; env only
```

Settings are read from `~/.pi/agent/settings.json` and `<project>/.pi/settings.json`. Restart Pi after changing settings or env vars that gate tool registration.

## Safety and privacy

- Locked modes are **fail-closed**: no usable model or zero active tools aborts activation before mutating Pi state.
- Tool resolution is exact-name based and reported as `active`, `gated`, `disabled`, `deferred`, or `missing` in `/mmr-status`.
- `mmr-web` only runs after opt-in and rejects localhost/private/link-local reads for `read_web_page`.
- `mmr-github` exposes read-only GitHub requests only; tokens are read from env and never echoed.
- `mmr-history` redacts session packets and returns opaque `projectRef` values instead of raw session paths or project roots.
- `free` mode drops only `pi-mmr`-owned tool registrations; third-party tools keep working.

## Troubleshooting

Run `/mmr-status` first; add `debug` for model/tool resolution details.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Model applied: no` | Provider missing, unauthenticated, or rejected by Pi | Inspect `/mmr-status debug` model candidates |
| Mode flipped to Free | Native `/model` or `/think` changed a locked route | Re-enter `/mode <key>` |
| Tool is `gated` | Owning extension is disabled or prerequisite missing | Enable the extension and restart Pi |
| `librarian` is gated | `mmr-github` tools are not registered/source-owned | Set `MMR_GITHUB_ENABLE=true`; add `MMR_GITHUB_TOKEN` for private/search |
| Locked mode refused activation | No usable model or zero active tools | Check model auth and tool resolution |

Full troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Documentation

- **Start here:** [`docs/README.md`](docs/README.md)
- **Quick lookup:** [`docs/quick-reference.md`](docs/quick-reference.md)
- **Public API:** [`docs/public-api.md`](docs/public-api.md), [`docs/mmr-core-api.md`](docs/mmr-core-api.md)
- **Architecture:** [`docs/reference-architecture.md`](docs/reference-architecture.md)
- **Subagents:** [`docs/subagent-framework.md`](docs/subagent-framework.md)
- **Compatibility:** [`docs/extension-compatibility.md`](docs/extension-compatibility.md)
- **Contributor map:** [`INDEX.md`](INDEX.md), [`REPOMAP.md`](REPOMAP.md), [`ROADMAP.md`](ROADMAP.md)

## Development

```bash
npm test
npm run check
npm run pack:dry-run
pi -e "$PWD" --list-models
```

Tests are deterministic and must not make live provider/API calls. Documentation conventions: [`docs/documentation-style-guide.md`](docs/documentation-style-guide.md).

## License

[MIT](LICENSE).
