# mmr-core

Foundation locked-mode extension for `pi-mmr`. Owns locked modes, model resolution, request policy, tool resolution, and the per-turn system-prompt rewrite.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`ROADMAP.md`](ROADMAP.md). Public API: [`../../../docs/mmr-core-api.md`](../../../docs/mmr-core-api.md) (full surface) and [`../../../docs/public-api.md`](../../../docs/public-api.md) (package-root re-exports).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Locked modes, model resolver, tool registry, prompt rewrite, subagent execution profile | none | `/mmr-status` (`debug` for model/tool resolution detail) |

## When to use it

- Always loaded. Other `pi-mmr` extensions register against this one.
- Read this file for mode semantics, request policy, tool resolution, prompt assembly, the subagent profile contract, and the `/mmr-status` field reference.

## Status and enablement

Active by default. Mode resolution: `--mmr-mode` flag → restored session state → `mmrCore.defaultMode` setting → default `smart`. The selected mode is persisted as a `mmr-core.mode-state` custom session entry on every explicit change.

Shortcuts: `Ctrl+Shift+S` / `Alt+M` pick a mode, `Ctrl+Space` cycles `smart → smartGPT → smartSonnet → smartFable → rush → test → large → deep → open`. Subagent execution uses a separate profile via `--mmr-subagent <name>` (see [Subagent profiles](#subagent-profiles)).

## Behavior

### Locked modes

`smart`, `smartGPT`, `smartSonnet`, `smartFable`, `rush`, `test`, `large`, `deep` apply a locked-mode profile (model preferences, request policy, context profile, active-tool allowlist, MMR-owned prompt block). `open` keeps Pi-native model, thinking, request, and prompt behavior while activating the Smart parent-session tool surface. `free` releases all enforcement and restores the pre-MMR baseline.

- **Model resolution** is provider-neutral against the live Pi registry. Subscription-backed routes (`claude-subscription`, `openai-codex`, `github-copilot`) sort first; explicit `provider/model` settings force a route; `claude-haiku-4-5` and `claude-haiku-4-5-20251001` are aliases.
- **Pi baseline thinking** per mode: `smart` medium, `smartGPT` medium, `smartSonnet` medium, `smartFable` medium, `rush` off, `test` medium, `large` medium, `deep` medium. Request-level thinking is enforced separately by the per-mode request policy hook.
- **Thinking-level toggle (`alt+r`)**: `smart`, `smartGPT`, `smartSonnet`, `smartFable`, and `deep` are toggleable. The MMR-owned `alt+r` shortcut cycles the active mode through its configured presets in place without releasing the mode — `smart` Opus medium↔high, `smartGPT`/`deep` GPT medium↔xhigh, `smartSonnet` Sonnet medium→high→low→medium, `smartFable` Fable medium→high→low→medium. The toggle drives the Pi thinking level and the wire reasoning effort. For `smart`, the Anthropic adaptive effort follows the native Opus route's Pi-level map (Option 1): the medium preset (Pi `medium`) maps to Anthropic `high`, and the high preset (Pi `high`) maps to Anthropic `xhigh`; both presets keep the Anthropic output budget at 64k so the displayed max-input remains 236k on the capped 300k Opus route. OpenAI Responses effort tracks the Pi level (`medium`/`high`). `smartSonnet`'s three presets set no Anthropic-effort override, so each Pi level (`low`/`medium`/`high`) echoes directly as the Anthropic adaptive effort, keeping the 32k output budget fixed across presets. The toggle is lightweight (concise status line, no mode-activation banner) and no-ops in non-toggleable modes. Toggle overrides are session-scoped (process memory); the default preset is re-derived on each apply. A dedicated key is used because Pi reserves `shift+tab` (`app.thinking.cycle`) and extensions cannot override it.
- **Request policy** rewrites only token/reasoning fields on `before_provider_request` (`max_tokens`, `max_output_tokens`, Anthropic `thinking` / `output_config.effort`, OpenAI Responses `reasoning`). Never mutates provider identity, auth, headers, base URLs, messages, system blocks, or tools.
- **Context profiles**: `smart` 300k/236k/64k (Anthropic branch), `smartGPT` native, `smartSonnet` 1M/968k/32k, `smartFable` native, `rush` native, `test` native, `large` 1M/968k/32k, `deep` native. A mode that declares a profile total caps its active model's `contextWindow` down to it via a shallow clone at the `setModel` call site (`context-cap.ts`), derived from the mode's own request policy so the enforced and advertised windows stay in sync. This makes Pi's native compaction, overflow, footer, percent, and `getContextUsage()` run at the profile window even when the route's native window is larger (e.g. `smart` pins its Opus route to 300k). The GPT/Codex-primary/rush-style modes (`smartGPT`, `smartFable`, `rush`, `test`, `deep`) intentionally declare **no** context profile, so every GPT/Codex route and the test Opus route run at Pi's own registered window with no pi-mmr override that could drift from Pi's metadata. Capping is cap-down only, so a smaller custom route stays authoritative, and `open`/`free` (no policy) are never capped. The cap is reasserted defensively if a provider (re)registration (e.g. `/login`) transiently re-resolves the active model to its uncapped window.
- **Fail-closed** before any Pi mutation when a locked mode would resolve zero active tools or no usable model.
- **Auto-switch to `free`** with a warning when native Pi model selection (`/model`, model-cycle) or the native thinking-cycle (`shift+tab`) is used from a locked mode. MMR does not undo the user's native change; it disables request/prompt/tool policy and restores the baseline minus `pi-mmr`-owned tools. `open` is already native-control mode, so native model/thinking changes do not release it. Use `alt+r` for the in-mode thinking toggle that does not release.

### Tool resolution

Exact-name resolution against Pi's live tool inventory through the tool-provider registry. No aliases, no candidate fallbacks. Each decision carries owner-extension metadata, a status, and human-readable diagnostic text:

| Status | Meaning |
| --- | --- |
| `active` | Registered and reachable in this mode. |
| `gated` | Owner is loaded but a prerequisite is unmet (`librarian` waits on source-owned `mmr-github` tools). |
| `disabled` | Owner is loaded but turned off or has no active capability. |
| `deferred` | Recognized name reserved in the status catalog; concrete tool not shipped. |
| `missing` | No extension claimed the name; Pi has not registered it. |

The status catalog covers `apply_patch`, `task_list`, `web_search`, `read_web_page`, `Task`, `finder`, `oracle`, `librarian`, `find_session`, `read_session`, `handoff`, `chart`, `read_mcp_resource`, `skill` so `/mmr-status` credits the owning extension when a tool is deferred. Sibling extensions claim exact names via `registerMmrToolProvider(...)`; latest-registered wins. Active-tool allowlist enforcement and `tool_call` blocking apply while locked.

### Locked-mode extra tools

Locked modes ship a fixed allowlist, so a user's own extension tools, third-party tools, or MCP tools are blocked while a locked mode is active. The `mmrCore.lockedModeExtraTools` setting opts specific exact tool names back in without releasing to `free`:

```jsonc
{
  "mmrCore": {
    "lockedModeExtraTools": {
      "all": ["my_tool", "mcp__server__search"], // every locked mode
      "deep": ["deep_only_tool"]                  // deep only
    }
  }
}
```

- Keys: `all` plus any locked mode (`smart`, `smartGPT`, `smartSonnet`, `smartFable`, `rush`, `test`, `large`, `deep`). `open`, `free`, and unknown keys are ignored with a warning.
- Exact-name only (no aliases); names trim/dedupe; global and project settings merge additively per key.
- Extras merge into the active set *after* the base allowlist and are credited to a `user-allowlist` owner in `/mmr-status` when they resolve by plain identity.
- Fail-closed is preserved: extras never satisfy the zero-active-tools activation abort (only a mode's own tools can), and a missing extra is a non-fatal no-op surfaced as `missing`.
- Parent session only — extras never apply to subagent workers, which keep their profile allowlists.

Project `.pi/settings.json` is a trust boundary: it can re-enable exact tool names in locked modes. See [`../../../docs/extension-compatibility.md`](../../../docs/extension-compatibility.md) for the full stance on user extensions, tools, providers, and MCP.

### Free mode and source-aware ownership

Free mode disables all MMR enforcement and restores the baseline captured before the locked mode. Source-aware ownership filtering: each MMR extension records its absolute path via `registerMmrOwnedExtensionPath(...)`, and Free mode only drops a tool when the active registration's `ToolInfo.sourceInfo.path` matches one of those paths. Same-named third-party tools are preserved. When Pi does not surface a source path, Free falls back to the name registry.

### Prompt assembly

Per-turn rewrite via `before_agent_start` consumes Pi's already-rendered native prompt as the base prompt. The active base/fragment map lives in [`prompt-registry.ts`](prompt-registry.ts): `pi-native-default-v1` records Pi's identity and section anchors, `MMR_PROMPT_FRAGMENTS` describes Pi-native passthrough fragments and MMR-owned fragments, and each prompted mode has a recipe (`basePromptId` + ordered fragment IDs + mode-specific intro/posture/response style). Adding a prompted mode should be a registry entry plus model/tool policy, not a new ad hoc prompt splice.

The renderer surgically replaces Pi's auto-rendered head (identity line through the `Pi documentation` block) by rendering the recipe fragments in order. The only MMR-owned XML marker is the initial one-line role marker (`<mmr_mode name="smart">…</mmr_mode>`); mode sections use Markdown headings. Pi's auto `Available tools:`, `Guidelines:`, and `Pi documentation` blocks remain Pi-native fragments and embed byte-identically under `## Tool use`.

Content prepended by earlier handlers is preserved byte-for-byte before the rewritten identity line. Pi's `appendSystemPrompt`, `# Project Context`, `<available_skills>`, host/extension blocks after the documentation section, `Current date:` / `Current working directory:`, and tail-appended extension content are preserved byte-for-byte as the `preserved-tail` fragment. Pi prompts pass through unchanged when the auto head cannot be located (e.g. user-supplied `--system-prompt`) and in `open`/`free` mode. MMR-owned built-in-tool guidance, shared tool guidance, mode posture, and response style are separate fragments. The shared coding guidance is further split into named fragments (`autonomy`, `discovery-discipline`, `pragmatism`, `verification`, `careful-actions`, `diagrams`, `file-links`, `collaboration`) so a recipe can include only the sections a mode needs; the default recipe renders all of them in order (byte-identical to the prior single block), and `rush` is the one mode that drops `diagrams` for token economy.

### Subagent profiles

Subagent workers run as a separate execution route from user-facing locked modes. Activated via `--mmr-subagent <name>` on the child Pi process; ignored when absent. The profile is the single source of truth for model/thinking/tools/prompt-assembly policy; explicit `--model` / `--tools` on the worker exist for compatibility and observability and must match the profile route or activation fails closed before any mutation. Mode-derived workers may receive `--mmr-parent-mode` so child activation can apply parent-mode-specific worker routes without inferring from a model id.

Profile fields ([`subagent-profiles.ts`](subagent-profiles.ts)):

- `name`, `displayName` — identifier and human-facing label.
- `modelPreferences` — ordered worker-model preferences resolved against the local Pi registry.
- `modeModelPreferences?` — optional parent-mode-specific overrides (mode-derived only); lookup follows the resolved prompt-base key (`deep → smart` aliases). Task uses this so Rush workers follow Rush's GPT-5.5 / Haiku route.
- `thinkingLevel?` — optional; defaults to Pi's default thinking level when omitted.
- `tools` — profile-intent concrete tool allowlist. `resolveMmrSubagentInvocation(...)` computes effective worker tools as `(profile.tools \ profile.denyTools) ∩ registeredTools` when the host supplies a registered set, otherwise just `profile.tools \ profile.denyTools`.
- `denyTools?` — removed from the effective set. Recursive/advisory tools (`Task`, `oracle`, `librarian`, `handoff`) belong here for broad workers.
- `maxTurns?` — optional turn cap; `history-reader` sets this to `1`.
- `promptRoute` — `standalone` (profile owns the entire prompt) or `mode-derived` (derives from a parent mode and appends a worker-role block). The registry enforces `standalone` profiles must not declare `baseMode`; `mode-derived` profiles must.
- `baseMode?` — parent mode for `mode-derived` profiles.
- `promptBuilder` — identifier registered through the subagent prompt-builder registry. Concrete prompt text is owned by `mmr-subagents`, not by `mmr-core`.
- `allowMcp` / `allowToolbox` — explicit MCP / toolbox surface flags. Read-only workers (finder) must keep both `false`.
- `enforceLockedMode: false`, `persistSubagentState: false` — workers never apply locked-mode policy or persist mode/subagent state.

Invariants:

- Activation never captures or restores a Pi baseline, never persists `mmr-core.mode-state`, never emits `MMR_EVENT_STATE_CHANGED`, never applies locked-mode prompt templates / request policy / Free-mode tool restoration.
- `before_agent_start` preserves Pi's base prompt (including `--append-system-prompt`) byte-for-byte; no locked-mode template tags inside a worker.
- Empty effective tool set on a tool-intending profile fails closed. Invalid profile, unresolvable model route, invalid `--mmr-parent-mode`, or explicit `--model` / `--tools` mismatch all fail closed. The canonical marker `pi-mmr: subagent activation failed: <reason>` (`MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX`) is written to stderr; the runner detects it via `extractMmrSubagentActivationFailure(stderr)` and turns it into a hard failure even when Pi exits 0.

Registered profiles:

| Name             | Route                  | Tools                                                                                                                                              | Model preferences                                                                                                                              | Thinking | MCP / Toolbox |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| `finder`         | standalone, `finder`   | `[grep, find, read]`                                                                                                                               | `antigravity/gemini-3.5-flash` → `gpt-5.4-mini` → `claude-haiku-4-5` (Gemini primary is provider-pinned; fallbacks expand with provider hints) | `low` | false / false |
| `history-reader` | standalone             | `[]` (`maxTurns: 1`)                                                                                                                               | `antigravity/gemini-3.5-flash-extra-low` → `gpt-5.4-mini` → `claude-haiku-4-5` (Gemini primary is provider-pinned; fallbacks expand with provider hints) | `minimal` | false / false |
| `oracle`         | standalone, `oracle`   | `[read, grep, find, web_search, read_web_page, read_session, find_session]` (child filters out unregistered sibling-extension tools)                | `gpt-5.5` xhigh → `claude-opus-4-6` high                                                                                                                  | `xhigh`   | false / false |
| `librarian`      | standalone, `librarian`| `[read_github, list_directory_github, glob_github, search_github, commit_search, diff_github, list_repositories]`                                  | `claude-opus-4-6` → `gpt-5.4`                                                                                                                  | `medium` | false / false |
| `task-subagent`  | mode-derived, `Task`   | `[read, bash, edit, write, read_web_page, web_search, finder, skill, task_list]` minus `denyTools: [Task, oracle, librarian, handoff]` | `claude-opus-4-8` high → `gpt-5.5` medium → `claude-opus-4-6` high → Haiku 4.5 low; Rush override: `gpt-5.5` off → Haiku 4.5 off                | varies   | false / false |

Pure route resolver lives in [`subagent-resolver.ts`](subagent-resolver.ts).

### Subagent prompt assembly

`assembleMmrSubagentSurface` ([`subagent-prompt-assembly.ts`](subagent-prompt-assembly.ts)) returns an `MmrSubagentPromptAssemblyResult` mirroring `MmrPromptAssemblyResult` (`{ profile, blocks, systemPrompt, activeToolManifest }`) so the same renderers and effective-surface fixtures drive both surfaces.

- **Standalone** (`finder`, `oracle`, `history-reader`, `librarian`). The profile owns the entire prompt. Assembly resolves `profile.promptBuilder` against the registry, calls the builder with `{ profile, cwd, baseSystemPrompt, modeState? }`, and returns its output as the system prompt plus a single `standalone-prompt` block.
- **Mode-derived** (`task-subagent`). Derives from `profile.baseMode` (with `from-parent` resolved by the invocation resolver and `deep` aliased to `smart` for prompt base). Assembly calls `assembleActiveSurface` with a minimal mode state stamped for the resolved base mode, rewrites the `active-tools` block from the subagent-filtered worker manifest, then appends one `subagent-worker-role` block. Flattened blocks reproduce `systemPrompt` byte-for-byte.

Ownership: `mmr-core` owns the framework, registry, and contract. Concrete prompt text and builder registrations live in `mmr-subagents`. Builders are pure synchronous functions and must not perform I/O. The active tool manifest is filtered down to the resolver's effective `workerTools` (or the profile's tool intent for backwards-compatible callers) before being surfaced. Missing/unregistered builders fail closed.

The assembled surface drives [`tests/fixtures/mmr-subagent-surface/`](../../../tests/fixtures/mmr-subagent-surface) so drift is caught at PR time.

## Diagnostics and troubleshooting

`/mmr-status` renders the resolved `MmrModeState`. Pass `debug` or `--debug` to append a `Debug:` section with the selected source, rejected source candidates, and per-candidate resolution detail.

Locked-mode fields (Free uses a strict subset):

| Field | Meaning |
| --- | --- |
| `Mode:` | Display name + key. |
| `Selected source:` | `flag` / `session` / `settings` / `default` / `native`. |
| `Rejected sources:` | Sources considered and discarded with reason, or `none`. |
| `Model preference order:` | Ordered preference list attempted (mode defaults merged with settings). |
| `Resolved model:` | `provider/model thinking:level` actually applied, or `none`. |
| `Resolved model available:` / `Model applied:` | Whether a candidate matched a registered model / whether Pi accepted it. Can diverge when Pi rejects. |
| `Configured fallback:` | `no` or `yes - <reason>`. |
| `Thinking:` | Pi session level plus per-mode request policy. |
| `Context:` / `Context cap:` | Profile after provider clamping; `none` in Free, `model default` when no MMR input profile, otherwise `<tokens> input tokens (mode profile)`. |
| `Baseline captured:` | Whether mmr-core has a pre-MMR restore snapshot (no auth detail, never persisted). |
| `Prompt surface:` | `default` (MMR head replacement) / `passthrough` / `disabled` (Free). |
| `Active tools:` / `Missing tools:` / `Deferred tools:` / `Gated tools:` / `Disabled tools:` | Outcome of tool resolution per requested tool name. |
| `Tool resolution:` | Each requested tool's provider, status, candidate list, and diagnostic. |
| `Feature gates:` | Reserved capability gates and resolution. |
| `Settings files read:` / `Settings warnings:` | Absolute paths that contributed; non-fatal warnings named per file. Runtime-only — not part of `PersistedMmrModeState`. |
| `Policy warnings:` / `Diagnostics by severity:` | From `getMmrPolicyDiagnostics(state)`. Grouped block sorts by severity; legacy single-line `Policy warnings:` kept for compatibility. |
| `State version:` / `Applied at:` | Schema version and last successful `applyMode` timestamp. |
| `Debug:` (with `debug`/`--debug`) | Selected source, rejected sources, and per-`MmrModelCandidateResolution` lines (`registered`, `authenticated`, `subscription`, `attempted`, `applied`/`not-applied`, `thinking=…`, `reason`). |

Common symptoms:

- **`Model applied: no`.** Combine `Resolved model:` / `Resolved model available:` / `Configured fallback:` with Debug `Model preference candidates:`. Common reasons: provider not registered, OAuth/API key missing (`authenticated=no`), Pi rejected the id (`attempted, not-applied`).
- **Auto-switched to Free.** Native `/model` or `/think` from a locked mode is a fail-soft switch with a warning. `Selected source: native` makes it visible. Re-enter `/mode <key>`.
- **Settings file silently ignored.** Check `Settings files read:`. A present file missing here is unreadable JSON — a `Settings warnings:` entry will name it.
- **Settings warning naming a block.** The block was discarded but the rest of the file (and the sibling file) still loaded. Fix the shape against the example in [`../../../README.md`](../../../README.md#settings). A `toolAliases` warning means the deprecated alias setting was found and ignored.
- **Tool stays `missing` / `deferred`.** `Tool resolution:` shows each request's provider and chosen tool. Resolution is identity-only: `missing` means no extension has claimed it and Pi has not registered the name; `deferred` means the catalog credits an owner that has not shipped/registered the concrete tool.
- **Locked mode refused to activate.** The resolver returned zero active tools; the previous state is kept. Inspect `Tool resolution:` on the previous state.
- **Feature gate `missing` / `disabled` / `gated`.** `missing` = no provider claimed it; `disabled` = owner loaded but off or no active capability; `gated` names the prerequisite (e.g. `librarian` waits on source-owned `mmr-github` tools).

All diagnostic codes come from `getMmrPolicyDiagnostics(state)` so `/mmr-status` and mode-change warning notifications stay in sync. Full list: [`docs/mmr-core-api.md`](../../../docs/mmr-core-api.md#policy-diagnostics).

## Public API

Re-exported from `pi-mmr`. Canonical catalog: [`../../../docs/mmr-core-api.md`](../../../docs/mmr-core-api.md). Package-root re-exports: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

Non-goals:

- No `Task` / `finder` / `oracle` / `librarian` implementations; full librarian support also needs repository-provider tools outside mmr-core.
- No handoff, review/check runner, toolbox/MCP bridge.
- No provider replacement; no auth/header/base-URL mutation.
- No rewriting of Pi/extension content outside the auto-rendered head.
- No legacy `<!-- mmr-core:start --> / <!-- mmr-core:end -->` block emission.
- Prompt text is `pi-mmr`-authored; no third-party prompt material is copied. Provenance: [`docs/prompt-provenance.md`](../../../docs/prompt-provenance.md).

Tests: `tests/mmr-core*.test.mjs`, `tests/fixtures/mmr-core-prompts/`, `tests/fixtures/mmr-effective-surface/`, `tests/fixtures/mmr-subagent-surface/`.
