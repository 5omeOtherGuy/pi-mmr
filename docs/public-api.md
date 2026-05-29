# pi-mmr non-core public API

**Audience.** Developers writing code that imports from `pi-mmr` and wants the stable programmatic surface owned by the non-core extensions.

**Scope.** Package-root re-exports owned by `mmr-toolbox`, `mmr-web`, `mmr-subagents`, `mmr-history`, and `mmr-session-fallback`. The `mmr-core` runtime, routing, prompt assembly, and feature-gate APIs live in [`mmr-core-api.md`](./mmr-core-api.md).

**Related.** Package overview: [`../README.md`](../README.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

Anything not listed here (or in `mmr-core-api.md`) is internal and may change without warning. Names re-exported from the package root are the stable contract; deep imports under `src/extensions/<name>/<file>` are not part of the public surface unless this document calls them out.

## Public principles

Identical to `mmr-core`:

1. Provider claims are identity-only. Tool and feature-gate providers
   claim logical names through `mmr-core` provider registration; the
   live tool inventory is the source of truth for active vs deferred.
2. State snapshots are deep-cloned; raw event payloads are read-only
   for the duration of an emission.
3. Each extension keeps its own routing, gating, and persistence
   invariants. Document any change in the extension's own README and in
   tests before changing the public surface.
4. Public-safe wording only. Names, statuses, and reasons described
   here are owned `pi-mmr` concepts.

## Import paths

- **Package root** — `import { ... } from "pi-mmr"` (resolves to
  `src/index.ts`). Use this in production code.
- **Extension entrypoint** — `import extension from
  "pi-mmr/extensions/<name>"` when wiring an extension into a Pi
  package manifest.

The entrypoint default export and any `create<Extension>Extension(...)`
factory are stable; everything else listed below is re-exported through
the package root.

---

## `mmr-toolbox`

Local-utility extension: ships a real `apply_patch` custom tool and a
session-local `task_list` (todo) tool. Other toolbox capabilities remain
deferred and are reported as such through `mmr-core` diagnostics.

### Stability

Stable. The `apply_patch` and `task_list` Pi tools, their schemas, and
their session-state shapes are part of the supported surface.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `registerMmrToolboxProviders` | function | Registers the toolbox MMR tool provider. Called by the extension entrypoint; safe to call from a host that bypasses the default extension load. |
| `ApplyPatchError` | class | Thrown by the apply-patch engine for structured patch failures. |
| `createTodoListTool` | function | Constructs the `task_list` Pi tool (returns the Pi tool definition). |
| `refreshTodoWidget` | function | Refreshes the pinned task-list widget. |
| `TASK_LIST_WIDGET_ID` | constant | Stable widget id for the pinned task list. |
| `TodoValidationError` | class | Validation error surfaced by the `task_list` schema. |
| `TODO_STATE_ENTRY`, `TODO_STATE_VERSION` | constants | Persisted session-state entry name and version. |
| `findLatestPersistedTodoState`, `parsePersistedTodoState`, `toPersistedTodoState` | functions | Read/parse/serialize the persisted task-list state. |

### Re-exported types

`PersistedTodoState`, `TaskListItem`, `TaskListSubtask`, `TodoStatus`,
`CreateTodoListToolOptions`, `RefreshTodoWidgetOptions`,
`TodoListDetails`, `TodoListErrorDetails`.

### Usage

Hosts that load `pi-mmr` through Pi's extension manifest do not need to
call any of these directly. Consumers that build their own Pi runtime,
or that want to inspect persisted task-list state from outside a Pi
session, can use the `PersistedTodoState` helpers safely; they perform
their own validation and never throw on malformed input.

---

## `mmr-web`

Network-backed extension. Owns the `web_search` and `read_web_page`
logical tools and registers them with Pi only when network access is
explicitly enabled. Disabled by default.

### Stability

Stable. Settings shape (`MmrWebSettings`), SSRF validation result, the
feature-gate name, and the provider-factory entrypoints are part of the
supported surface.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrWebExtension` | function | Factory producing the Pi extension. Accepts `MmrWebFactoryOverrides` for tests; production callers pass no overrides. |
| `createMmrWebToolProvider` | function | Constructs the `mmr-web` MMR tool provider. |
| `createMmrWebFeatureGateProvider` | function | Constructs the feature-gate provider. |
| `MMR_WEB_FEATURE_GATE` | constant | Feature-gate name (`"mmr-web"`). |
| `MMR_WEB_PROVIDER_NAME` | constant | Provider identity string used in diagnostics. |
| `loadMmrWebSettings` | function | Reads non-secret settings from Pi's settings files and env. |
| `DEFAULT_MAX_RESULT_BYTES`, `DEFAULT_TIMEOUT_MS` | constants | Defaults applied when settings are absent. |
| `validateExternalHttpUrl` | function | SSRF/policy gate used by `read_web_page`. Rejects non-`http(s)`, localhost, private IPs, link-local hosts, and non-Internet URLs. |

### Re-exported types

`MmrWebSettings`, `LoadedMmrWebSettings`, `MmrWebFactoryOverrides`,
`UrlValidationResult`.

### Usage

`validateExternalHttpUrl` is the only piece other extensions should
reach for directly: when an extension wants to dereference a
user-supplied URL with the same SSRF policy that `mmr-web` applies, it
should call this helper rather than reimplement the checks.

API keys (e.g. `BRAVE_API_KEY`) remain environment-only and are never
exposed through this surface.

---

## `mmr-github`

Read-only GitHub repository tools. Owns the seven repository-provider tool
names (`read_github`, `list_directory_github`, `glob_github`, `search_github`,
`commit_search`, `diff_github`, `list_repositories`) and the `mmr-github`
feature gate. Network access is off by default (`MMR_GITHUB_ENABLE`); the token
is environment-only (`MMR_GITHUB_TOKEN` / `GITHUB_TOKEN`).

### Stability

Stable for: provider/factory entrypoints, settings loader and defaults, the
client factory and repository parser, ownership helpers, and the owned tool
name constants. Tool descriptions and schema text are model-visible behavior
covered by deterministic tests.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrGithubExtension` | function | Factory producing the Pi extension. Accepts `MmrGithubFactoryOverrides` for tests. |
| `loadMmrGithubSettings`, `MMR_GITHUB_ENABLE_ENV`, `DEFAULT_GITHUB_API_BASE_URL`, `DEFAULT_GITHUB_TIMEOUT_MS`, `DEFAULT_GITHUB_MAX_RESULT_BYTES` | function/constants | Settings loader and defaults. |
| `createMmrGithubToolProvider`, `createMmrGithubFeatureGateProvider`, `MMR_GITHUB_PROVIDER_NAME`, `MMR_GITHUB_FEATURE_GATE` | functions/constants | Provider entrypoints and identifiers. |
| `MMR_GITHUB_TOOL_NAMES`, `hasMmrGithubOwnedTools`, `isMmrGithubOwnedToolInfo`, `isMmrGithubToolName` | constants/functions | Source-path ownership helpers used by librarian gating and child activation. |
| `createGithubClient`, `parseGithubRepository`, `GithubApiError`, `GithubRepoParseError` | functions/classes | Read-only client and repository-reference parser. |
| `registerMmrGithubTools`, `MMR_GITHUB_PROMPT_GUIDELINES` | function/constant | Tool registration and shared prompt guidelines. |

### Usage

The GitHub tools are the repository-provider surface for the `mmr-subagents`
`librarian` worker. They are read-only (GET requests only) and never expose
issue, pull request, branch, or write endpoints. See
[`../src/extensions/mmr-github/README.md`](../src/extensions/mmr-github/README.md).

---

## `mmr-subagents`

Worker/subagent extension. Owns the `Task`, `finder`, `oracle`, and
`librarian` logical tool names and the `mmr-subagents` feature gate.
Concrete workers ship for all four; `librarian` resolves as `active`
only when the read-only `mmr-github` tools are registered and
source-owned by `mmr-github`.

### Stability

Stable for: provider/factory entrypoints, owned-tool name constants,
worker model-preference defaults, prompt-builder functions, and worker
runner contracts (`MmrSubagentRunner`, `MmrSubagentWorkerRunResult`,
`MmrWorkerInvocation`).

Worker prompt text and tool descriptions are model-visible behavior
covered by deterministic tests; treat changes to them as behavior
changes.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrSubagentsExtension` | function | Factory producing the Pi extension. |
| `createMmrSubagentsToolProvider` | function | MMR tool provider for the four owned tool names. |
| `createMmrSubagentsFeatureGateProvider` | function | Feature-gate provider for `mmr-subagents`. |
| `MMR_SUBAGENTS_FEATURE_GATE`, `MMR_SUBAGENTS_OWNED_TOOLS`, `MMR_SUBAGENTS_PROVIDER_NAME` | constants | Stable identifiers. |
| `createFinderTool`, `registerFinderTool`, `buildFinderWorkerSystemPrompt` | functions | Finder worker surface. |
| `createOracleTool`, `registerOracleTool`, `buildOracleWorkerSystemPrompt` | functions | Oracle worker surface. |
| `createLibrarianTool`, `registerLibrarianTool`, `buildLibrarianWorkerSystemPrompt`, `isLibrarianGithubToolPrerequisiteRegistered`, `MmrLibrarianContextWindowError`, `LIBRARIAN_SUBAGENT_PROFILE_NAME`, `LIBRARIAN_GATING_REASON` | functions/values | Librarian worker surface and gating helpers (gated on `mmr-github` tools). |
| `createTaskTool`, `registerTaskTool`, `buildTaskWorkerSystemPrompt`, `classifyTaskOutcome`, `coerceTaskParams`, `hasUsableTaskFinalText`, `TaskParamsError`, `TASK_SUBAGENT_PROFILE` | functions/values | Task worker surface. |
| `*_TOOL_NAME`, `*_DESCRIPTION`, `*_PARAMETERS_SCHEMA`, `*_PROGRESS_PLACEHOLDER`, `*_PROMPT_GUIDELINES`, `*_PROMPT_SNIPPET`, `*_WORKER_TOOLS`, `*_DEFAULT_MODEL_PREFERENCES` | constants | Per-worker metadata. Tested directly. |
| `buildHistoryReaderWorkerSystemPrompt`, `buildLibrarianWorkerRolePrompt` | functions | Cross-extension prompt builders kept in `mmr-subagents/prompts.ts`. |
| `runMmrSubagentWorker`, `createChildCliMmrSubagentRunner`, `createMmrSubagentRunnerFromRunWorker`, `buildMmrWorkerArgs`, `classifyMmrWorkerOutcome`, `truncateMmrWorkerOutput`, `getMmrWorkerFinalOutput`, `hasUsableMmrWorkerFinalOutput`, `emptyMmrWorkerUsageStats`, `resolveMmrWorkerPiInvocation`, `resolveMmrWorkerPiInvocationFromEnv` | functions | Worker-runner contract and helpers. |
| `DEFAULT_MMR_WORKER_KILL_TIMEOUT_MS`, `DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT`, `MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT`, `MMR_WORKER_TRAIL_LIMIT` | constants | Worker-runner defaults. |
| `discoverMmrCustomSubagents`, `parseMmrCustomSubagentMarkdown`, `normalizeMmrCustomSubagentToolPatterns`, `toMmrCustomSubagentToolName`, `MMR_CUSTOM_SUBAGENT_TOOL_PREFIX`, `MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES`, `MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH`, `DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH` | functions/constants | Custom subagent Markdown discovery. Discovery only; registration is a separate explicit step. |

### Re-exported types

`MmrSubagentsFactoryOverrides`, `MmrSubagentsCapabilities`,
`FinderDetails`, `FinderParams`, `FinderToolDeps`, `OracleDetails`,
`OracleParams`, `OracleToolDeps`, `OracleAttachmentRecord`,
`LibrarianDetails`, `LibrarianParams`, `LibrarianStatus`,
`LibrarianToolDeps`, `ResolveLibrarianInvocationInput`,
`TaskDetails`, `TaskParams`, `TaskToolDeps`,
`TaskWorkerSystemPromptInput`, `TaskOutcomeInput`,
`ResolveTaskInvocationInput`,
`MmrSubagentRunner`, `MmrSubagentRunOptions`, `MmrSubagentRunProgress`,
`MmrSubagentWorkerRunResult`, `MmrSubagentWorkerDetailsBase`,
`MmrSpawnedSubagentWorkerDetailsBase`, `MmrWorkerInvocation`,
`MmrWorkerOutcomeStatus`, `MmrWorkerMessage`,
`MmrWorkerPiInvocationEnv`, `MmrWorkerProcess`,
`MmrWorkerProgressSnapshot`, `MmrWorkerResult`, `MmrWorkerRunnerDeps`,
`MmrWorkerSpawn`, `MmrWorkerTrailItem`, `MmrWorkerUsageStats`,
`RunMmrSubagentWorkerOptions`, `ClassifyMmrWorkerOutcomeOptions`,
`DiscoverMmrCustomSubagentsArgs`, `MmrCustomSubagentDefinition`,
`ParseMmrCustomSubagentMarkdownArgs`.

> Note: `TaskStatus` is intentionally **not** a named package-root export.
> Consumers that need the status discriminator should use
> `TaskDetails["status"]` so the public surface stays tied to the details
> shape instead of a deep import path.

### Usage

The runner-contract helpers and worker prompt builders are intended for
hosts that compose their own subagent pipelines (for example, tests
that exercise the worker contract without spawning a child Pi). The
default extension factory wires everything Pi needs in a normal load.

---

## `mmr-history`

Opt-in extension that lets the agent search and read prior local Pi
sessions across every project on disk, with deterministic redaction and
a model-backed reader. Disabled by default; enabled by setting
`MMR_HISTORY_ENABLE=true` before Pi starts.

### Stability

Stable for: settings, env-gate name, public tool factories, the
`history-reader` worker contract (profile, default model preferences,
packet-byte limit), and the persisted query/index shapes.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrHistoryExtension` | function | Factory producing the Pi extension. |
| `loadMmrHistorySettings` | function | Reads settings from env. |
| `MMR_HISTORY_ENABLE_ENV`, `DEFAULT_MMR_HISTORY_MAX_RESULTS`, `MAX_MMR_HISTORY_RESULTS`, `DEFAULT_MMR_HISTORY_MAX_EXCERPT_BYTES` | constants | Env name and limits. |
| `createFindSessionTool`, `createReadSessionTool`, `registerMmrHistoryTools`, `createDefaultMmrHistoryToolDeps` | functions | Tool factories and default dependency wiring. |
| `parseSessionQuery`, `tokenizeSessionQuery` | functions | Query DSL parser/tokenizer. |
| `searchSessions`, `resolveSessionById` | functions | Catalog operations. |
| `createSessionIndex` | function | Builds the in-memory session index. |
| `readSessionForGoal`, `formatSessionReadResult` | functions | `read_session` core. |
| `runHistoryReaderAnalysis`, `buildHistoryReaderSessionPacket`, `selectHistoryReaderWorkerModel` | functions | History-reader worker helpers. |
| `HISTORY_READER_SUBAGENT_PROFILE`, `HISTORY_READER_WORKER_TOOLS`, `HISTORY_READER_DEFAULT_MODEL_PREFERENCES`, `DEFAULT_HISTORY_READER_PACKET_BYTE_LIMIT` | constants | History-reader worker metadata. |

### Re-exported types

`HistoryAnalysisMode`, `HistoryReaderAnalysisResult`,
`HistoryReaderWorkerDetails`, `SanitizedHistoryReaderSessionPacket`,
`SessionReadExcerpt`, `SessionReadResult`,
`ResolvedSession`, `SearchSessionsOptions`, `SessionCatalogDeps`,
`SessionSearchMatch`, `SessionIndex`,
`FindSessionDetails`, `ReadSessionDetails`, `MmrHistoryToolDeps`.

### Usage

The query parser, catalog functions, and reader helpers are safe to use
outside Pi (for example, in tests or analysis scripts). Tool results
never surface raw file paths or raw project cwds; matches are
identified by Pi session id and an opaque `projectRef` hash, and that
contract holds across every consumer of these helpers.

---

## `mmr-session-fallback`

Reactive extension that classifies provider quota / rate-limit errors
and offers a session-scoped fallback override. Persists override state
in the session log so a resumed session keeps the same routing.

### Stability

Stable for: the persisted state shape (`PersistedMmrSessionFallbackOverride`,
entry name, version), the classifier output type, the snapshot
accessor, and the extension factory.

The override is intentionally session-scoped; nothing in this surface
writes outside Pi's session log.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrSessionFallbackExtension` | function | Factory producing the Pi extension. |
| `classifyMmrSessionFallbackError` | function | Pure classifier: takes `{ provider?, errorMessage? }` and returns a `MmrSessionFallbackErrorClassification`. Use this to decide whether to prompt for a fallback. |
| `MMR_SESSION_FALLBACK_ENTRY`, `MMR_SESSION_FALLBACK_STATE_VERSION` | constants | Session-state entry name and version. |
| `findLatestPersistedMmrSessionFallbackOverride`, `parsePersistedMmrSessionFallbackOverride`, `toPersistedMmrSessionFallbackOverride` | functions | Read/parse/serialize persisted override entries. |
| `getMmrSessionFallbackOverrideSnapshot` | function | Returns the current in-memory override snapshot (deep-cloned). |

### Re-exported types

`MmrSessionFallbackErrorClassification`,
`MmrSessionFallbackQuotaKind`,
`PersistedMmrSessionFallbackOverride`.

### Usage

`classifyMmrSessionFallbackError` is the recommended entry point for
other extensions or hosts that want to reuse the quota/rate-limit
heuristics without taking on the rest of the fallback prompt UI.
Persisted-state helpers tolerate malformed input (they return
`undefined` rather than throwing) and are safe to use from outside a
running Pi session.

---

## Compatibility expectations

- Names listed above will not be removed without a deprecation cycle.
- Constant **values** (defaults, byte limits, gate names) may be tuned
  in minor releases when the behavior change is documented in
  `CHANGELOG.md`; the **identifiers** themselves are stable.
- Worker prompt and tool-description text is behavior, not commentary.
  Changes to it are accompanied by deterministic test updates and
  changelog entries; do not parse or pattern-match against it from
  external code.
- Deep imports under `src/extensions/<name>/<file>` are not stable
  except where this document or `mmr-core-api.md` explicitly calls them
  out.
