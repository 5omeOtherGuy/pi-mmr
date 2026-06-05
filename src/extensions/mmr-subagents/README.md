# mmr-subagents

Worker/subagent extension. Owns the logical tool names `Task`, `finder`, `oracle`, `librarian` and the `mmr-subagents` feature gate.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`ROADMAP.md`](ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md). Framework boundary: [`../../../docs/subagent-framework.md`](../../../docs/subagent-framework.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | `finder`, `oracle`, `Task`, `librarian` (gated) | `mmr-web` active for `librarian` | `/mmr-status`, tool result `details`, subagent fixtures |

## When to use it

- Bounded multi-step work in a child Pi worker via `Task`.
- Read-only code search across the workspace via `finder`.
- Standalone advisory worker for plans, reviews, debugging via `oracle`.
- Public remote-repository research via `librarian` (when `mmr-web` is active).
- User-authored Markdown subagents enabled through config as `sa__*` tools (Pi-owned roots; `.claude/agents` is import-only).

## Status and enablement

Finder, oracle, Task, and the public-web MVP of librarian ship as concrete Pi tools.

- The feature-gate provider reports `mmr-subagents` **enabled** with the active capability list (`finder, oracle, Task`, plus `librarian` only when both mmr-web tools are active).
- `finder`, `oracle`, `Task` resolve `{ kind: "active" }` and surface as `active` in modes that request them.
- `librarian` resolves `{ kind: "active" }` only when `web_search` and `read_web_page` are both registered by `mmr-web` (source-owned, not just same-named) and active in the parent process. Otherwise it stays `gated` with the reason `librarian: requires mmr-web with web_search and read_web_page active.`. Execute-time checks repeat the prerequisite and fail closed with `status: "provider-gated"` if the active tool set changes before the call runs.

Deferred repository-provider variants of `librarian` (GitHub, Bitbucket, …): [`ROADMAP.md`](ROADMAP.md).

## Tools

| Tool        | Profile route                    | Worker tools                                                                                                  |
| ----------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `finder`    | standalone                       | `[grep, find, read]`                                                                                          |
| `oracle`    | standalone                       | `[read, grep, find, web_search, read_web_page, read_session, find_session]` (child intersects with registered) |
| `librarian` | standalone, gated on `mmr-web`   | `[web_search, read_web_page]`                                                                                  |
| `Task`      | mode-derived from parent mode    | `[read, bash, edit, write, read_web_page, web_search, finder, skill, task_list]` minus `denyTools` |

The internal `history-reader` profile is used by `mmr-history.read_session`; it is not a model-visible Pi tool. See `mmr-core` for the profile table.

## Behavior

### Concrete subagent ownership

`mmr-subagents` owns every concrete subagent that ships in `pi-mmr`: the Pi tool registration, the worker prompt text and prompt-builder registration against `mmr-core`'s registry, the worker runner invocation, and the result rendering surfaced back to the parent agent.

The framework split keeps `mmr-core` provider-agnostic: it owns the profile contract, route resolver, prompt-assembly contract, and prompt-builder registry. `mmr-subagents` registers concrete prompt builders via `registerMmrSubagentsPromptBuilders()` (invoked during the extension factory's init so the registry is populated before any worker resolves).

Concrete prompts live in [`prompts.ts`](prompts.ts):

- Pure synchronous functions; no I/O.
- Keyed by `MmrSubagentProfile.promptBuilder`; framework fails closed when the builder is unregistered.
- Idempotent across reloads; process-global registry survives Pi's isolated extension caches.

### Finder

- Profile/tool name: `finder`. Prompt route: `standalone`; builder `finder`.
- Model preferences: `antigravity/gemini-3.5-flash-extra-low` → `gpt-5.4-mini` → `claude-haiku-4-5`. Gemini primary is provider-pinned; fallbacks expand with standard provider hints against the parent registry.
- Thinking: `minimal`. `allowMcp: false`, `allowToolbox: false`. Tools: `[grep, find, read]`.
- Concrete tool registered through `pi.registerTool` and recorded as MMR-owned (Free mode strips it).
- Parameters: `{ query: string }`; `additionalProperties: false`.
- Spawns `pi --mode json -p --no-session` via `runMmrSubagentWorker` with `--mmr-subagent finder`. Parent passes `--model` when it can select one, but intentionally **not** `--tools` — the child resolves `[grep, find, read]` against its own registered inventory and applies the profile's effective set. This prevents `tools.mismatch` if parent and child registries differ. System prompt assembled via `assembleMmrSubagentSurface(...)`.
- The parent resolves the worker route through the shared `selectMmrModelRoute` registry resolver (the same path the child Pi process uses at activation), using the `finder` profile's `modelPreferences` (or a settings/programmatic override). This guarantees parent and child agree on the route. If no authenticated route matches, `--model` is omitted and the worker inherits Pi's default.
- Visible content: worker's final summary plus `file://` links with line ranges, capped at `DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT`. Outside-workspace `file://` links are rewritten to plain display text before exposure. Aborted/nonzero-exit/empty paths return graceful messages.
- Activation failure (unknown profile, no model route, explicit `--model` / `--tools` mismatch) surfaces as a clear `finder: subagent activation failed: <reason>` message and a structured `details.subagentActivationError`, never an empty success.
- Progress updates forward partial output (or `finder: searching codebase…` placeholder) and a typed `FinderDetails`.

### Oracle

- Profile/tool name: `oracle`. Standalone; builder `oracle`. Model prefs `gpt-5.5` → `claude-opus-4-6`, high thinking.
- Profile tool intent: `[read, grep, find, web_search, read_web_page, read_session, find_session]`. `allowMcp: false`, `allowToolbox: false`.
- Parent intentionally skips explicit `--tools`: sibling web/history tools may be absent in the child, so the child computes its registered-tool intersection.
- Parameters: `{ task: string, context?: string, files?: string[] }`, `additionalProperties: false`. Text attachments inside cwd inline up to `DEFAULT_ORACLE_PER_FILE_BYTE_LIMIT` (32 KiB each); images and outside-workspace files are reported to the worker as notes rather than read.
- Outcome policy: finder/oracle consume worker output verbatim → nonzero exit is `worker-error` even with partial text. Spawn/activation/abort/no-agent-start/empty-output cases surface directed diagnostics plus structured details.

### Librarian

- Profile/tool name: `librarian`. Standalone; builder `librarian`. Model prefs `claude-opus-4-6` → `gpt-5.4`, thinking `medium`.
- Profile tool intent and effective worker tools: `[web_search, read_web_page]`. `allowMcp: false`, `allowToolbox: false`.
- Prerequisite: parent process must have `web_search` and `read_web_page` registered by `mmr-web` (same-named third-party tools are not sufficient) and active. The provider gates model visibility on this; `execute()` checks again before spawning.
- Parameters: `{ query: string, context?: string }`. The worker prompt is public-remote-repository research only; local workspace work should use direct tools or `finder`.
- Parent spawn passes resolver-selected `--model`, effective `--tools web_search,read_web_page`, and exact system-prompt replacement.
- Status values: `success`, `validation-error`, `provider-gated`, `activation-error`, `context-window-exhausted`, `aborted`, `spawn-error`, `worker-error`, `empty-output`. A clean exit before the agent loop is normalized to `worker-error`.

### Task

- Parent tool name: `Task`. Profile name: `task-subagent`. Mode-derived; `baseMode: "from-parent"` (with `deep` using the `smart` prompt base). Parent mode must be a Task-enabled locked mode; missing or `free` parent state fails closed before spawn.
- Default model preferences: `claude-opus-4-8` high → `gpt-5.5` medium → `claude-opus-4-6` high → `claude-haiku-4-5-20251001` low → `claude-haiku-4-5` low. Rush overrides: `gpt-5.5` off → Haiku 4.5 off.
- Profile tool intent: `[read, bash, edit, write, read_web_page, web_search, finder, skill, task_list]`. `denyTools` removes `Task`, `oracle`, `librarian`, `handoff`. The per-call worker tool set is the deny-aware registered-tool intersection, passed explicitly via `--tools` and used for the worker `Available tools:` block.
- Parameters: `{ prompt: string, description: string }`; caps `TASK_PROMPT_MAX_BYTES` (8 KiB), `TASK_DESCRIPTION_MAX_BYTES` (512 B).
- Parent spawn passes `--mmr-parent-mode`, resolver-selected `--model`, effective `--tools`, and exact system-prompt replacement.
- Status values: `success`, `validation-error`, `activation-error`, `aborted`, `spawn-error`, `worker-error`, `no-agent-start`, `empty-output`. Task uses the `prefer-usable-output` policy: nonzero exit with usable final text still classifies as `success`.
- Execution mode: `Task` declares `executionMode: "sequential"` (issue #8) because a Task child can run `bash`/`edit`/`write` in the workspace. Pi serializes the whole assistant tool-call batch when any called tool is sequential. The read-only research workers (`finder`, `oracle`, `librarian`) stay parallel-eligible, so independent read-only subagent research can still run concurrently.

### Custom Markdown subagents

- Pi-owned roots: `<cwd>/.pi/subagents` (project) and `~/.pi/agent/subagents` (global). `.claude/agents` is scanned only as an *import candidate source* by the setup/import flow; it is never auto-registered. Scans are bounded to local-agent scale (100 definitions / 1000 Markdown files by default), skip symlink roots/entries, and recheck realpath containment under the configured root before reading.
- **Config is the enablement boundary (discovery ≠ activation).** A Markdown file present in a Pi-owned root is a *candidate*; it is not registered and not model-visible until an enabled `mmrSubagents.custom.agents.<id>` record (in global `~/.pi/agent/settings.json` or project `<cwd>/.pi/settings.json`) references it. This keeps a fresh install from inheriting a harness's broad subagent set and preserves least privilege.
- Config record shape: `{ enabled, source: { root: "global"|"project", file }, toolName, modes: "allLocked"|[locked modes], projects?: "all"|[absolute cwd paths] (global only), model, thinkingLevel?, tools }`. Records are merged global-then-project, with the project layer overriding by id. The record's `toolName`/`model`/`thinkingLevel`/`tools` win over the Markdown frontmatter. `source.file` must be relative with no `..` segments; `toolName` must match `sa__<slug>` (lowercase letters/digits/underscore); global `projects` entries must be absolute (relative entries are dropped with a warning); reserved ids (`__proto__`/`prototype`/`constructor`) are rejected. Enabled record source files are read with `O_NOFOLLOW` + realpath containment under their Pi-owned root, so a symlink inside `.pi/subagents` pointing outside the root is refused.
- **Per-mode exposure:** an enabled subagent is registered as a tool but only enters a locked mode's active tool set when that mode is listed in the record's `modes` scope. This is implemented through an `mmr-core` mode-extra-tool provider hook (`registerMmrModeExtraToolProvider`), merged through the same additive, fail-closed path as `lockedModeExtraTools`. The reserved `sa__*` namespace is *excluded* from the user-controlled `lockedModeExtraTools` setting (`excludeReservedSubagentNames`), so a custom subagent can only ever enter a mode through this scope-aware provider, never by hand-listing its name as an extra tool. A custom subagent never appears in Free mode.
- **Setup/import flow:** `/mmr-config` → "subagent (setup/import custom)" scans Pi-owned and legacy Claude candidates, recommends model/thinking/tools (read-only by default; a missing source `tools` list never means "all Pi tools"), maps Claude tool aliases, blocks recursive/advisory/MCP/mutation tools, asks for modes and project scope, copies external Markdown into a Pi-owned root, and writes an enabled config record.
- **Migration:** when legacy `.claude/agents` candidates exist but nothing is enabled in config, a one-time-per-session notice points the user at the setup/import flow. There is no compatibility switch that silently restores `.claude/agents` auto-loading.
- Valid definitions (`type: subagent`, `isolatedContext: true`, or a name+description+body) register as their record's `sa__<slug>` Pi tool at extension activation, with descriptions/guidelines derived from frontmatter.
- The Markdown body is the worker system prompt. `isolatedContext: true` uses exact system-prompt replacement; otherwise the body is appended.
- `model: <route>` pins the worker route; `model: inherit` forwards the parent model through the existing subagent model-preference override env so parent spawn and child activation agree. An omitted `model` key also inherits the parent model.
- `thinkingLevel:` (aliases: `thinking:`, `effort:`) pins the worker thinking/effort level to a provider-neutral canonical Pi level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, case-insensitive). Vendor-specific aliases are not accepted. Omitted/invalid values inherit the parent/default level.
- `tools:` names exact Pi tools. Execution filters them through the parent-active registered tool set and passes the reduced list explicitly to the child, so unavailable or denied tools do not leak into the custom worker.
- Default toolset (lower friction): when a definition declares no `tools` (or `allowed-tools`/`allowedTools`) field, the subagent defaults to the standard toolset `read, bash, edit, write, find, grep, web_search, read_web_page` (each still intersected with the registered/active tools). A fixed constant is used rather than "all registered tools" so the parent and the spawned child resolve the same set and the worker never fails activation on a tool mismatch; recursive/advisory subagents, toolbox, and MCP tools are excluded by construction. An explicitly empty list (`tools:` or `tools: []`) still runs with no tools so an author can deliberately build a prompt-only subagent.
- Fallback notice: when the subagent relied on a fallback for `model`, thinking level, or `tools` (including the explicit no-tools case), a single advisory listing each fallback is shown in the rendered tool result and on `details.fallbackNotice`. It is deliberately kept out of the model-consumed `content`, so it reaches the human author without adding noise to the parent model's context.

### `history-reader`

Registered in mmr-core's profile table for `mmr-history`. Not a model-visible Pi tool. Standalone, `tools: []`, `maxTurns: 1`, model prefs `gpt-5.4-mini` → `claude-haiku-4-5`, low thinking. The parent `read_session` sends only a sanitized session packet; the worker never gets direct filesystem, shell, web, or history tools.

### Progress / details surface

All spawned workers emit:

- bounded `trail` (latest 32 transcript/tool events),
- usage stats, `reportedModel`, `contextWindow` when resolvable,
- stderr/spawn metadata, `spawnError`, `subagentActivationError`,
- status / no-agent-start diagnostics, and the worker's effective `workerTools`.

The TUI renderer prefers a producing tool's known `details.status` when present, renders `success` as completed, other known statuses as failed, and otherwise falls back to raw exit/signal heuristics. Collapsed rows use shared `running...` / `completed` labels; expanded rows render native-style transcript/tool blocks plus a worker footer.

### Runner

Generic `MmrSubagentRunner` interface plus a child-CLI adapter. The default adapter follows Pi's subprocess JSON-mode pattern: spawn `pi --mode json -p --no-session`, pass `--mmr-subagent <name>`, optionally pass `--model`, a concrete tool allowlist, and a temporary system-prompt file, and parse streamed JSON-line events into a structured result. Prompt files are delivered with `--append-system-prompt` by default; `Task` and `librarian` use exact replacement (`--system-prompt` plus no context/skills) so their assembled prompts are the only model-visible system prompts.

`runMmrSubagentWorker(options, deps?)` is the child-process primitive and requires a non-empty `profileName` — a missing profile would bypass `mmr-core`'s activation guard and could silently inherit the parent's locked-mode posture. Missing/blank fails closed before any spawn.

`finder`, `oracle`, `Task`, and `librarian` run as their matching subagent profiles. Profiles are the authoritative source of model/thinking/tool/prompt-route policy in the child. Any explicit `--model` or `--tools` passed for observability must match the resolved profile route or activation fails closed (see [Subagent profiles](../mmr-core/README.md#subagent-profiles)).

Current runner behavior:

- single worker invocation only;
- no parallel/chain orchestration, no project/user agent discovery, no durable task coordination;
- no workspace state writes except a temporary system-prompt file removed after child exit;
- structured exit/error/stderr/usage details;
- bounded model-visible final output, full final output retained in the result;
- parent abort propagation via SIGTERM, then SIGKILL after a grace period;
- detects `pi-mmr: subagent activation failed: <reason>` stderr marker (`MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX`) and converts it into an unmissable failure even when Pi exits 0, exposing the reason via `MmrWorkerResult.subagentActivationError` and mirroring it into `errorMessage` as `subagent activation failed: <reason>`.

## Configuration

Subagent model preferences are configured through `mmr-core`'s `/mmr-config` flow and stored under `mmrCore.subagentModelPreferences`. The child-CLI runner has no separate settings surface.

## Diagnostics and troubleshooting

- **`librarian` stays `gated`.** `mmr-web` is not active or its `web_search` / `read_web_page` are not registered by `mmr-web` itself. Enable network access (`MMR_WEB_ENABLE=true` or `mmrWeb.enabled=true`) and restart Pi.
- **`Task` activation failed.** Parent mode is `free` or missing; Task only runs from a locked mode. Check `/mmr-status` for `Mode:`.
- **Worker reported `subagentActivationError`.** Profile/route mismatch (unknown profile, no model route, explicit `--model` or `--tools` mismatch, invalid `--mmr-parent-mode`). The reason appears in stderr as `pi-mmr: subagent activation failed: <reason>` and in `details.subagentActivationError`.
- **Worker exited 0 but the parent reported failure.** The runner intentionally detects the activation-failure stderr marker and converts it to a hard failure even on exit-0. This is fail-closed behavior, not a bug.

## Public API

Re-exported from `pi-mmr`. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

Extension surface:

- `createMmrSubagentsExtension(overrides?)` — extension factory.
- `createMmrSubagentsFeatureGateProvider(capabilities?)` — feature-gate provider; active flags flip the gate to `enabled`.
- `createMmrSubagentsToolProvider(capabilities?)` — exact-name provider; active flags claim `{ kind: "active" }`; inactive return `gated`.
- `MMR_SUBAGENTS_PROVIDER_NAME`, `MMR_SUBAGENTS_FEATURE_GATE`, `MMR_SUBAGENTS_OWNED_TOOLS`.
- `MmrSubagentsCapabilities` — per-tool flags (`finder`, `oracle`, `Task`, `librarian`); booleans or zero-argument predicates (so `librarian` can reflect live mmr-github tool registration state).

Tool-specific (`create<X>Tool(deps?)` / `register<X>Tool(pi, deps?)` plus constants, schemas, prompt helpers, types):

- **Finder.** `FINDER_TOOL_NAME`, `FINDER_WORKER_TOOLS`, `FINDER_DEFAULT_MODEL_PREFERENCES`, `FINDER_PROMPT_SNIPPET`, `FINDER_PROMPT_GUIDELINES`, `FINDER_DESCRIPTION`, `FINDER_PARAMETERS_SCHEMA`, `FINDER_PROGRESS_PLACEHOLDER`, `buildFinderWorkerSystemPrompt(cwd)`. Types: `FinderParams`, `FinderDetails`, `FinderToolDeps`.
- **Oracle.** Analogous (`ORACLE_*`, `DEFAULT_ORACLE_PER_FILE_BYTE_LIMIT`). Params `{ task, context?, files? }`. Types: `OracleParams`, `OracleDetails`, `OracleToolDeps`, `OracleAttachmentRecord`.
- **Librarian.** `LIBRARIAN_TOOL_NAME`, `LIBRARIAN_SUBAGENT_PROFILE_NAME`, `LIBRARIAN_WORKER_TOOLS`, prompt/schema constants, `buildLibrarianWorkerSystemPrompt(cwd)`, `isLibrarianGithubToolPrerequisiteRegistered(pi)`, `LIBRARIAN_GATING_REASON`, `MmrLibrarianContextWindowError`. Types: `LibrarianParams`, `LibrarianDetails`, `LibrarianStatus`, `LibrarianToolDeps`, `ResolveLibrarianInvocationInput`. Params `{ query, context? }`. The worker's read-only repository tools are owned by `mmr-github`; librarian stays gated until those tools are registered and source-owned. See [`../mmr-github/README.md`](../mmr-github/README.md).
- **Task.** `TASK_TOOL_NAME`, `TASK_SUBAGENT_PROFILE`, `TASK_WORKER_TOOLS`, prompt/schema constants, `TASK_PROMPT_MAX_BYTES` (8 KiB), `TASK_DESCRIPTION_MAX_BYTES` (512 B), `buildTaskWorkerSystemPrompt`, `classifyTaskOutcome`, `coerceTaskParams`, `hasUsableTaskFinalText`, `TaskParamsError`. Types: `TaskParams`, `TaskDetails`, `TaskToolDeps`, `TaskWorkerSystemPromptInput`, `ResolveTaskInvocationInput`, `TaskOutcomeInput`. The `TaskStatus` discriminator is exported from the deep path `pi-mmr/src/extensions/mmr-subagents/task.js` only — the package root keeps a negative-export guard against a legacy task-list type with the same name.
  - Task does **not** expose `select*WorkerModel` or `TASK_DEFAULT_MODEL_PREFERENCES`. Routing is owned by `resolveMmrSubagentInvocation` against the `task-subagent` profile. Programmatic overrides: `TaskToolDeps.modelPreferencesOverride`. Settings overrides: `mmrCore.subagentModelPreferences.task-subagent`.

Runner:

- `createChildCliMmrSubagentRunner(deps?)` — default `MmrSubagentRunner` backed by the child Pi worker.
- `runMmrSubagentWorker(options, deps?)` — child-process primitive. `options.parentMode` is forwarded as `--mmr-parent-mode` for mode-derived workers.
- Types: `MmrSubagentRunner`, `MmrSubagentRunOptions`, `MmrSubagentWorkerRunResult`, `MmrSubagentRunProgress`, plus existing `MmrWorker*` child-runner types.

## Developer notes

### Adding or changing a subagent

Keep the profile as the single source of truth and reuse the shared framework:

1. Add/update the profile in [`../mmr-core/subagent-profiles.ts`](../mmr-core/subagent-profiles.ts) (name, display, model prefs, thinking, tools, `promptRoute`, optional `baseMode`, `promptBuilder`, `allowMcp` / `allowToolbox`).
2. Confirm `resolveMmrSubagentInvocation(...)` fails closed before mutation for unknown profile, no model route, invalid `--mmr-parent-mode`, explicit `--model` mismatch, explicit `--tools` mismatch (against the deny-aware registered-tool intersection), empty effective tools when the profile intended tools, or missing parent mode for `from-parent` profiles.
3. Register the concrete Pi tool but route through the profile and shared runner. Do not hard-code independent model/tool policy. Exported constants (e.g. `FINDER_WORKER_TOOLS`) derive from the profile.
4. Register a prompt builder under the profile's identifier via `registerMmrSubagentsPromptBuilders()`. Do not reintroduce ad-hoc `--append-system-prompt` builders or new bespoke runner paths; assemble via `assembleMmrSubagentSurface`.
5. Dispatch through `runMmrSubagentWorker({ profileName, ... })`. Mode-derived workers pass `parentMode`. Missing/blank `profileName` fails closed.
6. Update the `mmr-subagents` tool-provider capabilities so only shipped, prerequisite-satisfied tools resolve `active`; unavailable tools stay `gated`.
7. Add a deterministic effective-surface fixture under [`../../../tests/fixtures/mmr-subagent-surface/`](../../../tests/fixtures/mmr-subagent-surface) covering the worker's system prompt and active tool manifest, and refresh the relevant mode surface fixture if the parent inventory changes.
8. Update this README, [`../mmr-core/README.md`](../mmr-core/README.md), [`../../../tests/README.md`](../../../tests/README.md), [`../../../CHANGELOG.md`](../../../CHANGELOG.md) for user-visible or framework-contract changes.

Prompt routes:

- **Standalone** — focused workers whose role is specific to one capability (`finder`, `oracle`, `librarian`, `history-reader`). The profile still owns active tools and model/thinking policy.
- **Mode-derived** — broad workers (`Task`) that inherit a parent locked-mode prompt assembly through `baseMode` and append a worker-role block.

### Framework-only surfaces

- `custom-loader.ts` parses Markdown definitions into `sa__*` subagent definitions, accepts inline and YAML block-list `tools:` / `skills:`, maps Claude Code tool aliases to Pi-native names, records `modelDeclared` and preserves `model: inherit`, parses a provider-neutral `thinkingLevel`/`thinking`/`effort` level (reusing `mmr-core`'s `isThinkingLevel`), exposes the `MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS` standard-toolset and `MMR_CUSTOM_SUBAGENT_RECOMMENDED_READONLY_TOOLS` constants, and provides sync/async hardened discovery used by candidate scanning and runtime registration.\n- `custom-config.ts` loads/merges/writes the `mmrSubagents.custom.agents` records (global + project, project overrides by id), resolves Pi-owned source roots, applies project scope, and is the enablement boundary for registration.\n- `custom-import.ts` is the pure import planner: maps source `tools:` onto safe Pi names, blocks recursive/advisory/MCP/mutation tools, flags unknown tools and unavailable declared models, and recommends a least-privilege read-only toolset when a source declares none.\n- `config-flow.ts` is the interactive `/mmr-config` setup/import wizard plus its pure helpers (`importIdForName`, `resolveImportDestination`, `buildImportConfigInput`).
- `mmr-core/subagent-runner-contract.ts` defines progress, tool-use, and permission-context shapes plus a fail-closed in-process runner placeholder that throws until the host runtime exposes nested in-process execution with filtered shared tool access.

### Invariants

- The tool provider only claims names in `MMR_SUBAGENTS_OWNED_TOOLS`; returns `undefined` for everything else so `mmr-core`, `mmr-web`, `mmr-toolbox`, and user aliases are never shadowed.
- The feature-gate provider only claims the `mmr-subagents` gate.
- Each entrypoint registers its absolute path via `registerMmrOwnedExtensionPath(...)` so `mmr-core` Free mode matches Pi's `sourceInfo.path` and drops worker tools without dropping same-named third-party tools.
- No subagent state is written inside the workspace; durable state follows [`../../../docs/data-storage-conventions.md`](../../../docs/data-storage-conventions.md).

### Smoke tests

`tests/smoke/{finder,oracle,librarian}-live-smoke.mjs` spawn real Pi workers against the current repository. Intentionally outside `npm test`; run them explicitly with `node <path>`.

Per-tool env knobs (prefix `FINDER_SMOKE_` / `ORACLE_SMOKE_` / `LIBRARIAN_SMOKE_`): `*_QUERY` (finder), `*_TASK` / `*_FILES` (oracle), `*_QUERY` / `*_CONTEXT` (librarian), plus shared `*_MODEL`, `*_TIMEOUT_MS`, `*_EXTENSION_PATHS`. The `*_EXTENSION_PATHS` variable is opt-in dev-loop isolation: comma-separated extension paths; when set the smoke appends `--no-extensions -e <path>` per entry so the spawned `pi` loads only the specified extensions. Production tools never pass these. Scripts force runner spawn from `PATH` because they are invoked from generic node entry points. By default the smokes are production-faithful: discovery is normal Pi extension discovery. Smokes **fail explicitly** on any `subagentActivationError` so fail-closed activation can never silently report `OK`.

Tests: `tests/mmr-subagents*.test.mjs`, `tests/fixtures/mmr-subagent-surface/`.
