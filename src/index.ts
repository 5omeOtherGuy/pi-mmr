export type {
  MmrActiveToolManifestEntry,
  MmrCoreSettings,
  MmrFeatureGateDecision,
  MmrFeatureGateProvider,
  MmrFeatureGateProviderDecision,
  MmrFeatureGateRegistry,
  MmrFeatureGateStatus,
  MmrModeDefinition,
  MmrModeKey,
  MmrModeSelection,
  MmrModeSelectionSource,
  MmrModeState,
  MmrModelCandidateResolution,
  MmrModelPreference,
  MmrModelResolution,
  MmrPlannedToolMetadata,
  MmrPolicyDiagnostic,
  MmrPolicyDiagnosticCode,
  MmrPolicyDiagnosticSeverity,
  MmrPromptAssemblyResult,
  MmrPromptBlock,
  MmrPromptBlockKind,
  MmrPromptRoute,
  MmrSessionIdentity,
  MmrSessionIdentitySource,
  MmrToolDecision,
  MmrToolProvider,
  MmrToolResolution,
  MmrToolRule,
  MmrToolStatus,
} from "./extensions/mmr-core/types.js";
export type { MmrPromptLayerContext } from "./extensions/mmr-core/prompt.js";
export type {
  MmrModelRouteSelection,
  ResolveAndApplyMmrModelArgs,
  SelectMmrModelRouteArgs,
  MmrModelRegistryLike,
  MmrRegisteredModelLike,
} from "./extensions/mmr-core/model-resolver.js";

export { DEFAULT_MMR_MODE, MMR_MODE_KEYS, MMR_MODES, getMmrMode, isMmrModeKey } from "./extensions/mmr-core/modes.js";
export { resolveAndApplyMmrModel, selectMmrModelRoute } from "./extensions/mmr-core/model-resolver.js";
export { resolveMmrModeSelection } from "./extensions/mmr-core/routing.js";
export { createMmrFeatureGateRegistry } from "./extensions/mmr-core/feature-gates.js";
export { getMmrPolicyDiagnostics } from "./extensions/mmr-core/diagnostics.js";
export {
  MMR_EVENT_SESSION_IDENTITY_CHANGED,
  MMR_EVENT_STATE_CHANGED,
  createMmrCoreRuntime,
  getMmrModeState,
  getMmrModeStateSnapshot,
  getMmrPromptRoute,
  getMmrSessionIdentity,
  getMmrSessionIdentitySnapshot,
  isToolAllowed,
  onMmrSessionIdentityChanged,
  onMmrStateChanged,
  registerMmrFeatureGateProvider,
  registerMmrToolProvider,
  resolveMmrFeatureGates,
  resolveMmrModel,
  resolveMmrTools,
} from "./extensions/mmr-core/runtime.js";
export type {
  MmrEventBusHost,
  MmrSessionIdentityChangedHandler,
  MmrStateChangedHandler,
} from "./extensions/mmr-core/runtime.js";
export { loadMmrCoreSettings } from "./extensions/mmr-core/settings.js";
export { MMR_PROMPT_LAYER_END, MMR_PROMPT_LAYER_START, buildMmrPromptLayer } from "./extensions/mmr-core/prompt.js";
export {
  expandMmrModelPreferencesToStrings,
  getMmrSubagentProfile,
  listMmrSubagentProfiles,
} from "./extensions/mmr-core/subagent-profiles.js";
export type {
  MmrSubagentBaseMode,
  MmrSubagentProfile,
  MmrSubagentPromptRoute,
} from "./extensions/mmr-core/subagent-profiles.js";
// `clearMmrSubagentPromptBuilders` is an internal test seam and is
// intentionally not re-exported from the package root. Tests reach it
// through the module directly.
export {
  assembleMmrSubagentSurface,
  getMmrSubagentPromptBuilder,
  registerMmrSubagentPromptBuilder,
} from "./extensions/mmr-core/subagent-prompt-assembly.js";
export type {
  AssembleMmrSubagentSurfaceInput,
  MmrSubagentPromptAssemblyResult,
  MmrSubagentPromptBlockKind,
  MmrSubagentPromptBuilder,
  MmrSubagentPromptBuilderInput,
  MmrSubagentSurfaceBlock,
} from "./extensions/mmr-core/subagent-prompt-assembly.js";
export {
  MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX,
  extractMmrSubagentActivationFailure,
  resolveMmrSubagentInvocation,
} from "./extensions/mmr-core/subagent-resolver.js";
export type {
  MmrSubagentInvocation,
  MmrSubagentInvocationFail,
  MmrSubagentInvocationOk,
  MmrSubagentResolveCode,
  MmrSubagentResolveDiagnostic,
  MmrSubagentToolResolution,
  ResolveMmrSubagentInvocationArgs,
} from "./extensions/mmr-core/subagent-resolver.js";
export { extractExplicitWorkerCliFlags } from "./extensions/mmr-core/worker-cli-flags.js";
export type { ExplicitWorkerCliFlags } from "./extensions/mmr-core/worker-cli-flags.js";
export { getMmrSubagentState } from "./extensions/mmr-core/runtime.js";
export type { MmrSubagentState } from "./extensions/mmr-core/runtime.js";
export {
  MMR_IN_PROCESS_SUBAGENT_RUNNER_AVAILABLE,
  MMR_SUBAGENT_RUN_STATUSES,
  MMR_SUBAGENT_TOOL_USE_STATUSES,
  MmrInProcessRunnerUnavailableError,
  runMmrSubagentInProcess,
} from "./extensions/mmr-core/subagent-runner-contract.js";
export type {
  MmrSubagentPermissionContext,
  MmrSubagentProgressEvent,
  MmrSubagentRunResult,
  MmrSubagentRunStatus,
  MmrSubagentToolUseProgress,
  MmrSubagentToolUseStatus,
  MmrSubagentTurnProgress,
  RunMmrSubagentInProcessOptions,
} from "./extensions/mmr-core/subagent-runner-contract.js";
export {
  MMR_ADDITIONAL_TOOLS_LINE,
  MMR_IDENTITY_LINE,
  MMR_RESPONSE_STYLE_HEADING,
  MMR_TOOL_USE_HEADING,
  MMR_TOOL_USE_POSTURE_LINE,
  assembleActiveSurface,
} from "./extensions/mmr-core/prompt-assembly.js";
export type { AssembleActiveSurfaceInput } from "./extensions/mmr-core/prompt-assembly.js";
export {
  MMR_BUILTIN_TOOL_GUIDANCE_HEADING,
  buildBuiltinToolGuidance,
  extractActiveBuiltinToolNames,
  listBuiltinToolGuidanceTools,
} from "./extensions/mmr-core/builtin-tool-guidance.js";
export { MMR_PLANNED_TOOL_CATALOG } from "./extensions/mmr-core/planned-catalog.js";
export { renderMmrPromptDebugFixture, stringifyMmrToolSchema } from "./extensions/mmr-core/prompt-debug-renderer.js";
export { MMR_MODE_STATE_ENTRY, findLatestPersistedModeState } from "./extensions/mmr-core/state.js";
export { createMmrToolRegistry, isMmrToolAllowed, resolveMmrTools as resolveMmrToolNames } from "./extensions/mmr-core/tool-registry.js";
export { createMmrSessionFallbackExtension } from "./extensions/mmr-session-fallback/index.js";
export { classifyMmrSessionFallbackError } from "./extensions/mmr-session-fallback/classifier.js";
export type { MmrSessionFallbackErrorClassification, MmrSessionFallbackQuotaKind } from "./extensions/mmr-session-fallback/classifier.js";
export {
  MMR_SESSION_FALLBACK_ENTRY,
  MMR_SESSION_FALLBACK_STATE_VERSION,
  findLatestPersistedMmrSessionFallbackOverride,
  parsePersistedMmrSessionFallbackOverride,
  toPersistedMmrSessionFallbackOverride,
} from "./extensions/mmr-session-fallback/state.js";
export type { PersistedMmrSessionFallbackOverride } from "./extensions/mmr-session-fallback/state.js";
export { getMmrSessionFallbackOverrideSnapshot } from "./extensions/mmr-session-fallback/runtime.js";
export { ApplyPatchError } from "./extensions/mmr-toolbox/apply-patch.js";
export { registerMmrToolboxProviders } from "./extensions/mmr-toolbox/index.js";
export {
  TODO_STATE_ENTRY,
  TODO_STATE_VERSION,
  findLatestPersistedTodoState,
  parsePersistedTodoState,
  toPersistedTodoState,
} from "./extensions/mmr-toolbox/todo-list.js";
export type {
  PersistedTodoState,
  TaskListItem,
  TaskListSubtask,
  TodoStatus,
} from "./extensions/mmr-toolbox/todo-list.js";
export {
  TASK_LIST_WIDGET_ID,
  TodoValidationError,
  createTodoListTool,
  refreshTodoWidget,
} from "./extensions/mmr-toolbox/todo-list-tool.js";
export {
  createMmrHistoryExtension,
} from "./extensions/mmr-history/index.js";
export {
  DEFAULT_MMR_HISTORY_MAX_EXCERPT_BYTES,
  DEFAULT_MMR_HISTORY_MAX_RESULTS,
  MAX_MMR_HISTORY_RESULTS,
  MMR_HISTORY_ENABLE_ENV,
  loadMmrHistorySettings,
} from "./extensions/mmr-history/config.js";
export {
  DEFAULT_HISTORY_READER_PACKET_BYTE_LIMIT,
  HISTORY_READER_DEFAULT_MODEL_PREFERENCES,
  HISTORY_READER_SUBAGENT_PROFILE,
  HISTORY_READER_WORKER_TOOLS,
  buildHistoryReaderSessionPacket,
  runHistoryReaderAnalysis,
  selectHistoryReaderWorkerModel,
} from "./extensions/mmr-history/analysis-worker.js";
export type {
  HistoryAnalysisMode,
  HistoryReaderAnalysisResult,
  HistoryReaderWorkerDetails,
  SanitizedHistoryReaderSessionPacket,
} from "./extensions/mmr-history/analysis-worker.js";
export {
  formatSessionReadResult,
  readSessionForGoal,
} from "./extensions/mmr-history/read-session.js";
export type {
  SessionReadExcerpt,
  SessionReadResult,
} from "./extensions/mmr-history/read-session.js";
export {
  parseSessionQuery,
  tokenizeSessionQuery,
} from "./extensions/mmr-history/query.js";
export {
  resolveSessionById,
  searchSessions,
} from "./extensions/mmr-history/session-catalog.js";
export type {
  ResolvedSession,
  SearchSessionsOptions,
  SessionCatalogDeps,
  SessionSearchMatch,
} from "./extensions/mmr-history/session-catalog.js";
export { createSessionIndex } from "./extensions/mmr-history/session-index.js";
export type { SessionIndex } from "./extensions/mmr-history/session-index.js";
export {
  createDefaultMmrHistoryToolDeps,
  createFindSessionTool,
  createReadSessionTool,
  registerMmrHistoryTools,
} from "./extensions/mmr-history/tools.js";
export type {
  FindSessionDetails,
  MmrHistoryToolDeps,
  ReadSessionDetails,
} from "./extensions/mmr-history/tools.js";
export type {
  CreateTodoListToolOptions,
  RefreshTodoWidgetOptions,
  TodoListDetails,
  TodoListErrorDetails,
} from "./extensions/mmr-toolbox/todo-list-tool.js";

export type { MmrWebSettings, LoadedMmrWebSettings } from "./extensions/mmr-web/config.js";
export { DEFAULT_MAX_RESULT_BYTES, DEFAULT_TIMEOUT_MS, loadMmrWebSettings } from "./extensions/mmr-web/config.js";
export {
  MMR_WEB_FEATURE_GATE,
  MMR_WEB_PROVIDER_NAME,
  createMmrWebFeatureGateProvider,
  createMmrWebToolProvider,
} from "./extensions/mmr-web/provider.js";
export { validateExternalHttpUrl } from "./extensions/mmr-web/url-policy.js";
export type { UrlValidationResult } from "./extensions/mmr-web/url-policy.js";
export { createMmrWebExtension } from "./extensions/mmr-web/index.js";
export type { MmrWebFactoryOverrides } from "./extensions/mmr-web/index.js";

export type { MmrGithubSettings, LoadedMmrGithubSettings } from "./extensions/mmr-github/config.js";
export {
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_MAX_RESULT_BYTES,
  DEFAULT_GITHUB_TIMEOUT_MS,
  MMR_GITHUB_ENABLE_ENV,
  loadMmrGithubSettings,
} from "./extensions/mmr-github/config.js";
export {
  MMR_GITHUB_FEATURE_GATE,
  MMR_GITHUB_PROVIDER_NAME,
  createMmrGithubFeatureGateProvider,
  createMmrGithubToolProvider,
} from "./extensions/mmr-github/provider.js";
export {
  MMR_GITHUB_TOOL_NAMES,
  hasMmrGithubOwnedTools,
  isMmrGithubOwnedToolInfo,
  isMmrGithubToolName,
} from "./extensions/mmr-github/tool-ownership.js";
export type { MmrGithubToolName, MmrGithubToolInfoLike } from "./extensions/mmr-github/tool-ownership.js";
export {
  GithubApiError,
  GithubRepoParseError,
  createGithubClient,
  parseGithubRepository,
} from "./extensions/mmr-github/client.js";
export type { GithubClient, GithubClientOptions, GithubRepoRef } from "./extensions/mmr-github/client.js";
export {
  MMR_GITHUB_PROMPT_GUIDELINES,
  registerMmrGithubTools,
} from "./extensions/mmr-github/tools.js";
export type { MmrGithubToolDeps } from "./extensions/mmr-github/tools.js";
export { createMmrGithubExtension } from "./extensions/mmr-github/index.js";
export type { MmrGithubFactoryOverrides } from "./extensions/mmr-github/index.js";

export {
  MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
  MMR_SUBAGENTS_ASYNC_TASK_TOOLS,
  MMR_SUBAGENTS_FEATURE_GATE,
  MMR_SUBAGENTS_OWNED_TOOLS,
  MMR_SUBAGENTS_PROVIDER_NAME,
  createMmrSubagentsFeatureGateProvider,
  createMmrSubagentsToolProvider,
} from "./extensions/mmr-subagents/provider.js";
export { createMmrSubagentsExtension } from "./extensions/mmr-subagents/index.js";
export type { MmrSubagentsFactoryOverrides } from "./extensions/mmr-subagents/index.js";
export type { MmrSubagentsCapabilities } from "./extensions/mmr-subagents/provider.js";
export {
  FINDER_DEFAULT_MODEL_PREFERENCES,
  FINDER_DESCRIPTION,
  FINDER_PARAMETERS_SCHEMA,
  FINDER_PROGRESS_PLACEHOLDER,
  FINDER_PROMPT_GUIDELINES,
  FINDER_PROMPT_SNIPPET,
  FINDER_TOOL_NAME,
  FINDER_WORKER_TOOLS,
  buildFinderWorkerSystemPrompt,
  createFinderTool,
  registerFinderTool,
  selectFinderWorkerModel,
} from "./extensions/mmr-subagents/finder.js";
export type { FinderDetails, FinderParams, FinderToolDeps } from "./extensions/mmr-subagents/finder.js";
export {
  DEFAULT_ORACLE_PER_FILE_BYTE_LIMIT,
  ORACLE_DEFAULT_MODEL_PREFERENCES,
  ORACLE_DESCRIPTION,
  ORACLE_PARAMETERS_SCHEMA,
  ORACLE_PROGRESS_PLACEHOLDER,
  ORACLE_PROMPT_GUIDELINES,
  ORACLE_PROMPT_SNIPPET,
  ORACLE_TOOL_NAME,
  ORACLE_WORKER_TOOLS,
  buildOracleWorkerSystemPrompt,
  createMmrAdvisorTool,
  createOracleTool,
  registerOracleTool,
  requireMmrAdvisorProfile,
  selectOracleWorkerModel,
} from "./extensions/mmr-subagents/oracle.js";
export type {
  MmrAdvisorToolConfig,
  MmrAdvisorToolDeps,
  OracleAttachmentRecord,
  OracleDetails,
  OracleParams,
  OracleToolDeps,
} from "./extensions/mmr-subagents/oracle.js";
export {
  CTHULU_DEFAULT_MODEL_PREFERENCES,
  CTHULU_DESCRIPTION,
  CTHULU_PROGRESS_PLACEHOLDER,
  CTHULU_PROMPT_GUIDELINES,
  CTHULU_PROMPT_SNIPPET,
  CTHULU_SUBAGENT_PROFILE,
  CTHULU_TOOL_CONFIG,
  CTHULU_TOOL_NAME,
  CTHULU_WORKER_TOOLS,
  buildCthuluWorkerSystemPrompt,
  createCthuluTool,
  registerCthuluTool,
} from "./extensions/mmr-subagents/cthulu.js";
export {
  LIBRARIAN_DESCRIPTION,
  LIBRARIAN_GATING_REASON,
  LIBRARIAN_PARAMETERS_SCHEMA,
  LIBRARIAN_PROGRESS_PLACEHOLDER,
  LIBRARIAN_PROMPT_GUIDELINES,
  LIBRARIAN_PROMPT_SNIPPET,
  LIBRARIAN_SUBAGENT_PROFILE_NAME,
  LIBRARIAN_TOOL_NAME,
  LIBRARIAN_WORKER_TOOLS,
  MmrLibrarianContextWindowError,
  buildLibrarianWorkerSystemPrompt,
  createLibrarianTool,
  isLibrarianGithubToolPrerequisiteRegistered,
  registerLibrarianTool,
} from "./extensions/mmr-subagents/librarian.js";
export type {
  LibrarianDetails,
  LibrarianParams,
  LibrarianStatus,
  LibrarianToolDeps,
  ResolveLibrarianInvocationInput,
} from "./extensions/mmr-subagents/librarian.js";
export {
  buildHistoryReaderWorkerSystemPrompt,
  buildLibrarianWorkerSystemPrompt as buildLibrarianWorkerRolePrompt,
} from "./extensions/mmr-subagents/prompts.js";
// Note: the worker outcome discriminator type is intentionally NOT
// re-exported from the package root. The legacy task-list coordination
// type that previously occupied that name is gone (see
// tests/mmr-pi-root-todo-exports.test.mjs negative guard), and re-exporting
// any matching identifier would conflict with that guard's source-text
// check. Consumers that need the new type can import it from the deep path
// `./extensions/mmr-subagents/task.js` instead.
export {
  TASK_DESCRIPTION,
  TASK_DESCRIPTION_MAX_BYTES,
  TASK_PARAMETERS_SCHEMA,
  TASK_PROGRESS_PLACEHOLDER,
  TASK_PROMPT_GUIDELINES,
  TASK_PROMPT_MAX_BYTES,
  TASK_PROMPT_SNIPPET,
  TASK_SUBAGENT_PROFILE,
  TASK_TOOL_NAME,
  TASK_WORKER_TOOLS,
  TaskParamsError,
  buildTaskFinalResult,
  buildTaskProgressResult,
  buildTaskRunnerThrowResult,
  buildTaskWorkerSystemPrompt,
  classifyTaskOutcome,
  coerceTaskParams,
  createTaskTool,
  hasUsableTaskFinalText,
  prepareTaskRun,
  registerTaskTool,
  resolveTaskRunner,
} from "./extensions/mmr-subagents/task.js";
export type {
  PrepareTaskRunResult,
  PreparedTaskRun,
  ResolveTaskInvocationInput,
  TaskDetails,
  TaskDetailsContext,
  TaskOutcomeInput,
  TaskParams,
  TaskToolDeps,
  TaskWorkerSystemPromptInput,
} from "./extensions/mmr-subagents/task.js";
export {
  ASYNC_TASK_TOOL_NAMES,
  START_TASK_TOOL_NAME,
  TASK_CANCEL_TOOL_NAME,
  TASK_POLL_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  createStartTaskTool,
  createTaskCancelTool,
  createTaskPollTool,
  createTaskWaitTool,
  registerAsyncTaskTools,
} from "./extensions/mmr-subagents/async-task-tools.js";
export type {
  AsyncTaskToolDeps,
  AsyncTaskToolDetails,
} from "./extensions/mmr-subagents/async-task-tools.js";
export {
  ASYNC_TASK_CANCEL_DEAD_AFTER_MS,
  ASYNC_TASK_MAX_RUNTIME_MS,
  ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS,
  ASYNC_TASK_STALLED_AFTER_MS,
  ASYNC_TASK_TERMINAL_TTL_MS,
  DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION,
  DEFAULT_TASK_WAIT_TIMEOUT_MS,
  MAX_TASK_WAIT_TIMEOUT_MS,
  createMmrAsyncTaskRegistry,
  getMmrAsyncTaskRegistry,
  toPublicAsyncTaskSnapshot,
} from "./extensions/mmr-subagents/async-task-registry.js";
export type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskBoardEntry,
  MmrAsyncTaskFreshness,
  MmrAsyncTaskInternalSnapshot,
  MmrAsyncTaskRegistry,
  MmrAsyncTaskRegistryDeps,
  MmrAsyncTaskSnapshot,
  MmrAsyncTaskStatus,
  StartAsyncTaskArgs,
  StartAsyncTaskResult,
  WaitForAsyncTaskResult,
} from "./extensions/mmr-subagents/async-task-registry.js";
export {
  DEFAULT_MMR_WORKER_KILL_TIMEOUT_MS,
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT,
  MMR_WORKER_TRAIL_LIMIT,
  buildMmrWorkerArgs,
  classifyMmrWorkerOutcome,
  createChildCliMmrSubagentRunner,
  createMmrSubagentRunnerFromRunWorker,
  emptyMmrWorkerUsageStats,
  getMmrWorkerFinalOutput,
  hasUsableMmrWorkerFinalOutput,
  resolveMmrWorkerPiInvocation,
  resolveMmrWorkerPiInvocationFromEnv,
  runMmrSubagentWorker,
  truncateMmrWorkerOutput,
} from "./extensions/mmr-subagents/runner.js";
export type {
  ClassifyMmrWorkerOutcomeOptions,
  MmrSpawnedSubagentWorkerDetailsBase,
  MmrSubagentRunOptions,
  MmrSubagentRunProgress,
  MmrSubagentRunner,
  MmrSubagentWorkerDetailsBase,
  MmrSubagentWorkerRunResult,
  MmrWorkerInvocation,
  MmrWorkerOutcomeStatus,
  MmrWorkerMessage,
  MmrWorkerPiInvocationEnv,
  MmrWorkerProcess,
  MmrWorkerProgressSnapshot,
  MmrWorkerResult,
  MmrWorkerRunnerDeps,
  MmrWorkerSpawn,
  MmrWorkerTrailItem,
  MmrWorkerUsageStats,
  RunMmrSubagentWorkerOptions,
} from "./extensions/mmr-subagents/runner.js";
export {
  DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH,
  MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES,
  MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH,
  MMR_CUSTOM_SUBAGENT_TOOL_PREFIX,
  discoverMmrCustomSubagents,
  normalizeMmrCustomSubagentToolPatterns,
  parseMmrCustomSubagentMarkdown,
  toMmrCustomSubagentToolName,
} from "./extensions/mmr-subagents/custom-loader.js";
export type {
  DiscoverMmrCustomSubagentsArgs,
  MmrCustomSubagentDefinition,
  ParseMmrCustomSubagentMarkdownArgs,
} from "./extensions/mmr-subagents/custom-loader.js";
