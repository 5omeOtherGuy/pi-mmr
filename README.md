# pi-mmr

[![CI](https://github.com/5omeOtherGuy/pi-mmr/actions/workflows/ci.yml/badge.svg)](https://github.com/5omeOtherGuy/pi-mmr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Pi package](https://img.shields.io/badge/Pi-package-7c3aed)

> Amp Code-style mode routing, worker tools, and fail-safe defaults for Pi.

`pi-mmr` is for Pi users who want Amp Code-style, one-command coding profiles without leaving Pi. It deliberately mirrors that workflow shape: pick a mode such as `rush`, `smart`, `large`, or `deep`, and `pi-mmr` applies the model route, thinking policy, context profile, active-tool set, worker profile, and prompt behavior for that job.

It also brings Pi-native tools for codebase search, expert review, GitHub repository research, web lookup, prior-session recall, safe patching, todos, and subscription quota fallback — all scoped by explicit feature gates and reversible with `free` mode.

## Why pi-mmr

- **One command changes the whole harness.** `/mode deep` is not just a model switch; it locks routing, thinking, tools, and prompt behavior together.
- **Provider-neutral routing.** Modes prefer subscription/OAuth routes first, then API-key routes, then other registered providers.
- **Right-sized worker delegation.** Use `finder`, `oracle`, `Task`, and `librarian` without hand-picking child models and tools.
- **Fail-closed safety.** A locked mode refuses to activate without a usable model and active tools; `free` releases MMR-owned locks.
- **Optional reach.** Web, GitHub, and local session history tools stay gated until you explicitly enable them.

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

Verify the active route inside Pi:

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

2. Inspect routing and gates:

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
   Use finder to locate where provider routing is resolved.
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
| Do balanced coding | `smart` | Default locked route and standard tool set |
| Prefer GPT routing | `smartGPT` | Smart profile routed through GPT-family preferences |
| Move quickly | `rush` | Fast model preferences, lower token posture, smaller tool set |
| Work with long context | `large` | Long-context model preferences and standard tools |
| Plan, debug, or review deeply | `deep` | High-reasoning route and deep-specific tools |
| Return to stock Pi | `free` | Releases MMR locks and removes MMR-owned tools |

Mode selection precedence: `--mmr-mode` flag → persisted session → `mmrCore.defaultMode` → `smart`.

Useful controls:

```text
/mode              # show current mode
/mode deep         # switch mode
/mmr-status        # routing state
Ctrl+Shift+S       # mode picker  (Alt+M fallback)
Ctrl+Space         # cycle smart → smartGPT → rush → large → deep
```

## Choose a tool

| I need to... | Use | Owner |
| --- | --- | --- |
| Patch files safely | `apply_patch` | [`mmr-toolbox`](src/extensions/mmr-toolbox/README.md) |
| Track session work | `task_list` | [`mmr-toolbox`](src/extensions/mmr-toolbox/README.md) |
| Search the codebase by behavior | `finder` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) |
| Ask for deep advice or review | `oracle` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) |
| Run bounded child work | `Task` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) |
| Research GitHub repositories | `librarian` | [`mmr-subagents`](src/extensions/mmr-subagents/README.md) + [`mmr-github`](src/extensions/mmr-github/README.md) |
| Search the web | `web_search` | [`mmr-web`](src/extensions/mmr-web/README.md) |
| Read public web pages | `read_web_page` | [`mmr-web`](src/extensions/mmr-web/README.md) |
| Find old Pi sessions | `find_session` | [`mmr-history`](src/extensions/mmr-history/README.md) |
| Reuse old session context | `read_session` | [`mmr-history`](src/extensions/mmr-history/README.md) |

For command-style lookup, see the [quick reference](docs/quick-reference.md).

## Feature map

| Extension | Default | User value |
| --- | --- | --- |
| [`mmr-core`](src/extensions/mmr-core/README.md) | On | Locked modes, model resolution, tool allowlists, prompt rewrite, diagnostics |
| [`mmr-toolbox`](src/extensions/mmr-toolbox/README.md) | On | Safe patching and session-local todo tracking |
| [`mmr-subagents`](src/extensions/mmr-subagents/README.md) | On | `finder`, `oracle`, `Task`, and gated `librarian` workers |
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
export BRAVE_API_KEY="brv_xxx"        # optional; env only
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

Run `/mmr-status` first; add `debug` for the full routing dump.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Model applied: no` | Provider missing, unauthenticated, or rejected by Pi | Inspect `/mmr-status debug` model candidates |
| Mode flipped to Free | Native `/model` or `/think` changed a locked route | Re-enter `/mode <key>` |
| Tool is `gated` | Owning extension is disabled or prerequisite missing | Enable the extension and restart Pi |
| `librarian` is gated | `mmr-github` tools are not registered/source-owned | Set `MMR_GITHUB_ENABLE=true`; add `MMR_GITHUB_TOKEN` for private/search |
| Locked mode refused activation | No usable model or zero active tools | Check model auth and tool decisions |

Full troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Documentation

- **Start here:** [`docs/README.md`](docs/README.md)
- **Quick lookup:** [`docs/quick-reference.md`](docs/quick-reference.md)
- **Public API:** [`docs/public-api.md`](docs/public-api.md), [`docs/mmr-core-api.md`](docs/mmr-core-api.md)
- **Architecture:** [`docs/reference-architecture.md`](docs/reference-architecture.md)
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
