# Extension compatibility

**Audience.** Users running `pi-mmr` alongside their own Pi extensions, tools, custom providers, or MCP servers, and contributors reasoning about how locked modes interact with foreign Pi surfaces.

**Related.** Package overview: [`../README.md`](../README.md). Mode and tool semantics: [`../src/extensions/mmr-core/README.md`](../src/extensions/mmr-core/README.md). Architecture: [`reference-architecture.md`](reference-architecture.md).

## Summary

`pi-mmr` is additive to Pi. It does not remove or rename anything you install; it only changes what is *active* while one of its **locked modes** (`smart`, `smartGPT`, `smartSonnet`, `rush`, `test`, `large`, `deep`) is selected. In **`open` mode**, Pi-native model/thinking/prompt controls stay active while Smart-equivalent parent-session tools are selected. In **`free` mode**, `pi-mmr` releases all enforcement and behaves as if it were not installed (it only drops its own tool registrations), so every Pi extension works normally.

Three locked-mode mechanics drive every interaction below:

- **Tool allowlist.** A locked mode sets the active tool set to its fixed allowlist (plus any `lockedModeExtraTools`) and blocks other tools at `tool_call`.
- **Native opt-out.** A native model or thinking-level change (`/model`, model-cycle, `shift+tab`) drops you from a locked mode to `free`, by design. Use `open` when you want native controls while keeping Smart tools active.
- **Model preference resolution.** Locked modes use explicit model preference order. Known family names (`claude-*`, `gpt-*`, `gemini-*`/`gemma-*`) expand to known provider ids with subscription/OAuth entries first.

The stance below is per scenario. "Supported" means it works in locked modes today; "Supported (free)" means it works in `free` mode and we recommend `free` for it; "Not supported" means it is intentionally constrained, with the reason.

## Stance by scenario

### Safety / lifecycle gates — Supported (synergistic)

`permission-gate`, `protected-paths`, `confirm-destructive`, `dirty-repo-guard`, `sandbox`, and similar `tool_call`/session-event blockers compose cleanly. `pi-mmr` blocks independently; both must allow a call, so your guards add safety on top of any mode. No action needed.

### Your own model-callable tools — Supported with recommendation

Tools you register (custom extension tools, third-party tools, individual MCP server tools) are **blocked in locked modes by default** because they are not in the mode allowlist.

- **You can use them** by listing their exact names in `mmrCore.lockedModeExtraTools` (see [mmr-core README](../src/extensions/mmr-core/README.md#locked-mode-extra-tools)). They merge into the active set additively and fail-closed is preserved.
- **We recommend** keeping the extra-tool list small and intentional. If you depend on many ad-hoc or dynamically named tools (common with large MCP servers), prefer **`free` mode**, which exposes everything without per-name configuration. Locked modes exist precisely to constrain the surface; opting dozens of tools back in defeats that purpose.

We deliberately do **not** support wildcards, "allow all MCP", or source/path-based grants: tool source metadata is not portable across machines, and broad grants would turn a locked mode into a near-`free` mode silently.

### Tools registered after activation — Supported with recommendation

A tool registered after a mode is applied does not become active until the mode is re-applied (`/mode <same>`), because the active set is computed at activation. Re-select the mode after late registration, or register at `session_start`.

### Tool rendering / built-in overrides — Supported

`built-in-tool-renderer`, `minimal-mode`, `truncated-tool`, and `tool-override` change rendering or wrap a built-in by re-registering the same name. Rendering is orthogonal to allowlists. Re-registering a Pi built-in (e.g. `read`) is fine. Re-registering a `pi-mmr`-owned name (e.g. `handoff`) is allowed but note the ownership nuance below.

### Name collisions with pi-mmr tools — Supported (last-writer)

If your extension registers a name `pi-mmr` also owns (e.g. `handoff`, `Task`), Pi keeps the last registration for that name. In a locked mode the allowlisted slot activates whichever live registration exists; in `free` mode `pi-mmr` preserves your registration (it only drops tools whose source is a `pi-mmr` extension). Prefer a distinct name to avoid surprise.

### Mode/model/tool-replacing extensions — Supported (free), not composable in locked modes

`preset` (sets model + tools), interactive `tools` (enable/disable), `plan-mode`, and any extension that calls `setModel`/`setThinkingLevel` take over the model/tool state that locked modes own. By design, a native model/thinking change **drops you to `free`**, where the extension then controls model and tools. This is intentional: two systems cannot both own the locked mode profile. Use these in `free` mode.

### Custom providers / models — Supported when named to match; otherwise free or per-mode preferences

Custom provider extensions are considered in locked modes **only** when the model name matches a known family prefix (`claude-*`, `gpt-*`, `gemini-*`/`gemma-*`) and the provider id is one `pi-mmr` expands from the explicit preference. For a novel provider id or model name:

- **Supported** via `mmrCore.modelPreferences` — add an explicit `provider/model` route for the relevant mode(s); `pi-mmr` will use it.
- Otherwise use **`free` mode**, where Pi's native model selection reaches any registered provider.

### Input transforms — Supported

`inline-bash`, `input-transform`, `file-trigger`, `send-user-message` chain normally. The only edge: in `smart` mode an auto-compaction may handle a submission and replay it post-compaction, which can re-order a transform for that one submission. Cooperative in practice.

### System-prompt extensions — Supported (append) / not supported (head replacement)

Append-style extensions (`pirate`, `claude-rules`, `prompt-customizer`, `system-prompt-header`, `appendSystemPrompt`, `systemPromptOptions`) are preserved byte-for-byte by `pi-mmr`'s prompt-assembly contract in locked modes. Extensions that replace Pi's auto-rendered **head** conflict with the locked-mode head rewrite; their head changes are not supported in locked modes (use `free`).

### Compaction extensions — Supported with recommendation

`custom-compaction`, `trigger-compact`, and similar overlap `smart` mode's auto-compaction. Both triggers can fire; behavior depends on load order and thresholds. If you run your own compaction policy, prefer a non-`smart` locked mode or `free` to avoid double-triggering.

### UI, footer/header, widgets, games, session metadata — Supported

`status-line`, `custom-footer`/`custom-header`, `widget-placement`, `model-status`, editors, overlays, games, `session-name`, `bookmark`, `notify`, autocomplete, `qna`, etc. are orthogonal to locked-mode model/tool/prompt state. The only minor overlap: footer/status extensions and `pi-mmr`'s status line both write UI; last writer wins.

### Git, system, resources, messaging — Supported

`git-checkpoint`, `auto-commit-on-exit`, `mac-system-theme`, `dynamic-resources`, `message-renderer`, `event-bus` are independent of `pi-mmr` and work in any mode.

### Subagent extensions — Supported (parent), not extended to pi-mmr workers

Your own subagent/`Task`-style extension runs in the parent session like any other tool (subject to the allowlist rules above). `pi-mmr`'s own subagent workers keep their fixed profile allowlists and safety flags (`allowMcp`/`allowToolbox`); `lockedModeExtraTools` and parent tools are **not** propagated into `pi-mmr` workers. That isolation is intentional and not configurable.

## Quick reference

| Scenario | Locked modes | Recommended |
| --- | --- | --- |
| Safety/lifecycle gates | Supported | use anywhere |
| Your own / MCP tools | Supported via `lockedModeExtraTools` | few tools: extras; many/dynamic: `free` |
| Late-registered tools | Supported after re-apply | register at `session_start` |
| Rendering / built-in overrides | Supported | use anywhere |
| Name collisions with pi-mmr tools | Supported (last-writer) | use a distinct name |
| `preset` / `tools` / `plan-mode` / native `setModel` | Drops to `free` | use in `free` |
| Custom providers/models | Supported if family/provider matches | else `mmrCore.modelPreferences` or `free` |
| Input transforms | Supported | use anywhere |
| System-prompt append | Supported | use anywhere |
| System-prompt head replacement | Not supported in locked modes | use `free` |
| Compaction extensions | Supported | avoid `smart`, or use `free` |
| UI / metadata / git / resources | Supported | use anywhere |
| Subagent extensions | Supported in parent only | n/a |
