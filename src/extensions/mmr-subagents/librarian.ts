import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isRecord } from "../mmr-core/internal/json.js";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import {
  assembleMmrSubagentSurface,
  getMmrSubagentPromptBuilder,
  registerMmrSubagentPromptBuilder,
  unregisterMmrSubagentPromptBuilder,
} from "../mmr-core/subagent-prompt-assembly.js";
import { getMmrSubagentProfile } from "../mmr-core/subagent-profiles.js";
import {
  resolveMmrSubagentInvocation,
  type MmrSubagentInvocation,
} from "../mmr-core/subagent-resolver.js";
import type { MmrModelRegistryLike, MmrRegisteredModelLike } from "../mmr-core/model-resolver.js";
import { loadMmrCoreSettings } from "../mmr-core/settings.js";
import type { MmrActiveToolManifestEntry, MmrModelPreference } from "../mmr-core/types.js";
import {
  hasMmrGithubOwnedTools,
  type MmrGithubToolInfoLike,
} from "../mmr-github/tool-ownership.js";
import { buildLibrarianWorkerSystemPrompt as buildLibrarianWorkerSystemPromptFromPrompts } from "./prompts.js";
import { resolveEffectiveRunner } from "./worker-fallback-run.js";
import {
  createWorkerTool,
  type MmrWorkerToolRunContext,
} from "./worker-tool-factory.js";
import { LIBRARIAN_BACKGROUND_GUIDANCE } from "./tool-guidance.js";
import { buildWorkerToolManifest, type ToolHostLike } from "./worker-host.js";
import { readMmrModelContextWindow } from "./worker-model-metadata.js";
import {
  classifyMmrWorkerOutcomeForProfile,
  emptyMmrWorkerUsageStats,
  type MmrSpawnedSubagentWorkerDetailsBase,
  type MmrSubagentRunner,
  type MmrWorkerOutcomeStatus,
  type MmrWorkerProgressSnapshot,
  type MmrWorkerResult,
  type MmrWorkerRunnerDeps,
  runMmrSubagentWorker,
} from "./runner.js";
import {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
} from "./worker-result-shaping.js";

export const LIBRARIAN_TOOL_NAME = "librarian";
export const LIBRARIAN_SUBAGENT_PROFILE_NAME = "librarian";
export const LIBRARIAN_GATING_REASON =
  "librarian: requires mmr-github read-only GitHub tools (set MMR_GITHUB_ENABLE=true).";

function requireLibrarianProfile() {
  const profile = getMmrSubagentProfile(LIBRARIAN_SUBAGENT_PROFILE_NAME);
  if (!profile) {
    throw new Error(
      `mmr-core does not expose a "${LIBRARIAN_SUBAGENT_PROFILE_NAME}" subagent profile; librarian cannot run without it.`,
    );
  }
  return profile;
}

export const LIBRARIAN_WORKER_TOOLS: readonly string[] = Object.freeze([
  ...requireLibrarianProfile().tools,
]);

export const LIBRARIAN_PROMPT_SNIPPET =
  "Research remote repositories and repository history with a read-only librarian worker.";

export const LIBRARIAN_PROMPT_GUIDELINES: readonly string[] = [
  "Use librarian for remote repository research: architecture, external feature implementations, cross-repository pattern comparisons, commit/diff history, and remote file or README inspection.",
  "Do not use librarian for local workspace reads/searches, code modifications, simple local lookups, or questions unrelated to repository content.",
  "When calling librarian, name the repository as owner/repo or a full repository URL when possible.",
  "Ask a precise librarian research question and include intent, branch/revision, known files, commit IDs, or related repositories in `context` when those details matter.",
  "Return the librarian's full answer to the user-facing response; do not compress away evidence links, caveats, or conclusions.",
  LIBRARIAN_BACKGROUND_GUIDANCE,
] as const;

export const LIBRARIAN_DESCRIPTION = [
  "Research remote repositories with the librarian, a read-only repository-understanding worker for code outside the local workspace.",
  "",
  LIBRARIAN_BACKGROUND_GUIDANCE,
  "",
  "Coverage:",
  "- Public GitHub repositories, and connected private repositories when an",
  "  access token is configured: file reads, directory listings, glob lookups,",
  "  code search, commit history, and diffs between refs.",
  "",
  "Use the librarian when:",
  "- You need an architecture explanation for a remote repository.",
  "- You need to find where a feature is implemented outside the local workspace.",
  "- You need to compare patterns across remote repositories.",
  "- You need to understand behavior evolution through commits or diffs.",
  "- You need to read, link, or summarize remote files, directories, READMEs, or",
  "  diffs.",
  "",
  "Do not use the librarian when:",
  "- The answer is in the local workspace; use read, grep, find, or finder.",
  "- You need to modify files, run code, create branches, or open pull requests.",
  "- You already know the exact local file or local symbol to inspect.",
  "- The question is unrelated to repository code, repository documentation, or",
  "  repository history.",
  "",
  "Usage guidelines:",
  "- Name the repository whenever possible (e.g. owner/repo or a full repository URL).",
  "- Ask a specific question with clear success criteria.",
  "- Include context about why you need the answer, relevant branches, commits,",
  "  files, or related repositories.",
  "- Expect a thorough answer suitable for sharing with the user, including",
  "  links and caveats.",
  "- Preserve the librarian's full answer in your response; do not summarize",
  "  away important evidence.",
  "",
  "Examples:",
  "",
  "Research authentication in a public repository:",
  '{"query":"In kubernetes/kubernetes, explain how service account token authentication is implemented end-to-end.","context":"Focus on the API server request path and cite the main files."}',
  "",
  "Trace rendering behavior in a public UI repository:",
  '{"query":"In facebook/react, trace how a function component update reaches the commit phase.","context":"Need the main scheduler and reconciler files with links."}',
  "",
  "Understand routing in a public framework:",
  '{"query":"In vercel/next.js, explain how app-route handlers are discovered and invoked.","context":"Focus on current default-branch behavior."}',
  "",
  "Compare patterns across two public repositories:",
  '{"query":"Compare request-cancellation handling in axios/axios and node-fetch/node-fetch.","context":"Focus on AbortSignal integration."}',
  "",
  "Explain a public commit:",
  '{"query":"In rust-lang/rust, explain what commit 1.75.0 changed about async fn in traits.","context":"Cite the main RFCs and the implementation PR."}',
].join("\n");

export const LIBRARIAN_PARAMETERS_SCHEMA = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description:
        "Specific remote-repository research question. Name the repository when you know it; include the feature, API, file, commit, branch, or architecture area you want explained; and state what a complete answer should prove.",
    }),
    context: Type.Optional(
      Type.String({
        description:
          "Optional background that helps scope the research: why the answer is needed, relevant branch/revision, known files, related repositories, constraints, or prior findings. Do not put secrets or credentials here.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const librarianParameters = LIBRARIAN_PARAMETERS_SCHEMA;

export type LibrarianParams = Static<typeof LIBRARIAN_PARAMETERS_SCHEMA>;

export type LibrarianStatus =
  | "success"
  | "validation-error"
  | "provider-gated"
  | "activation-error"
  | "context-window-exhausted"
  | "aborted"
  | "spawn-error"
  | "worker-error"
  | "empty-output";

export interface LibrarianDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: "mmr-subagents.librarian";
  status: LibrarianStatus;
  query: string;
  context?: string;
}

export const LIBRARIAN_PROGRESS_PLACEHOLDER =
  "librarian: researching repositories…";

export class MmrLibrarianContextWindowError extends Error {
  constructor(message = "Librarian context window limit reached.") {
    super(message);
    this.name = "MmrLibrarianContextWindowError";
  }
}

export interface ResolveLibrarianInvocationInput {
  ctx: ExtensionContext | undefined;
  registeredTools?: readonly string[];
  /**
   * Effective settings-driven model preference override resolved by the
   * librarian tool before calling the resolver. Explicit
   * {@link LibrarianToolDeps.modelPreferencesOverride} wins over settings;
   * absent when neither source supplies one.
   */
  modelPreferencesOverride?: readonly MmrModelPreference[];
}

export interface LibrarianToolDeps {
  /** Generic subagent runner. Preferred seam for tests and alternate hosts. */
  runner?: MmrSubagentRunner;
  /** Legacy direct worker seam retained for consistency with finder/oracle tests. */
  runWorker?: typeof runMmrSubagentWorker;
  /** Override the per-invocation resolver. Tests inject this to avoid a full model registry stub. */
  resolveInvocation?: (input: ResolveLibrarianInvocationInput) => MmrSubagentInvocation;
  /**
   * Explicit programmatic model preference override. When provided this
   * wins over settings; when omitted, the librarian tool reads
   * `mmrCore.subagentModelPreferences.librarian` on every execute so the
   * parent and child activation paths cannot drift after `/mmr-config`.
   */
  modelPreferencesOverride?: readonly MmrModelPreference[];
  /** Settings loader seam for deterministic tests. */
  loadSubagentModelPreferences?: (cwd: string) =>
    Record<string, readonly MmrModelPreference[]> | undefined;
  /** Override the worker output byte cap. */
  outputByteLimit?: number;
  /** Override prompt text while still flowing through the subagent surface API. */
  buildSystemPrompt?: (cwd: string) => string;
  /** Forwarded to {@link runMmrSubagentWorker} as its second argument. */
  runnerDeps?: MmrWorkerRunnerDeps;
  /** Pi host, captured by registerLibrarianTool so activation can inspect tool state. */
  pi?: ToolHostLike;
}

export function buildLibrarianWorkerSystemPrompt(cwd: string): string {
  return buildLibrarianWorkerSystemPromptFromPrompts(cwd);
}

function resolveCtxModelRegistry<TModel extends MmrRegisteredModelLike>(
  ctx: ExtensionContext | undefined,
): MmrModelRegistryLike<TModel> | undefined {
  const registry = (ctx as { modelRegistry?: unknown } | undefined)?.modelRegistry;
  if (!registry || typeof registry !== "object") return undefined;
  const candidate = registry as Partial<MmrModelRegistryLike<TModel>>;
  if (typeof candidate.getAll !== "function") return undefined;
  if (typeof candidate.find !== "function") return undefined;
  return registry as MmrModelRegistryLike<TModel>;
}

function toolInfosFromAllTools(pi: ToolHostLike | undefined): readonly MmrGithubToolInfoLike[] | undefined {
  if (!pi) return undefined;
  try {
    const tools = pi.getAllTools?.();
    if (!Array.isArray(tools)) return undefined;
    return tools.flatMap((tool) => {
      if (!isRecord(tool)) return [];
      if (typeof tool.name !== "string" || tool.name.length === 0) return [];
      const sourceInfo = isRecord(tool.sourceInfo) && typeof tool.sourceInfo.path === "string"
        ? { path: tool.sourceInfo.path }
        : undefined;
      return [{ name: tool.name, ...(sourceInfo !== undefined ? { sourceInfo } : {}) }];
    });
  } catch {
    return undefined;
  }
}

/**
 * The librarian's GitHub provider tools are registered globally by
 * `mmr-github` but are intentionally not part of any user-facing mode's
 * active tool set. The child worker activates them by name through
 * `--tools`, so the parent gate checks that every required tool is
 * registered and source-owned by `mmr-github` rather than active in the
 * parent.
 */
export function isLibrarianGithubToolPrerequisiteRegistered(pi: ToolHostLike | undefined): boolean {
  const registered = toolInfosFromAllTools(pi);
  if (!registered) return false;
  return hasMmrGithubOwnedTools(registered);
}

function coerceLibrarianParams(raw: unknown): LibrarianParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("librarian expects an object with a `query` field.");
  }
  const params = checkMmrToolParams(LIBRARIAN_TOOL_NAME, LIBRARIAN_PARAMETERS_SCHEMA, raw);
  const query = params.query.trim();
  if (query.length === 0) {
    throw new Error("librarian.query is required and must be a non-empty string.");
  }
  const result: LibrarianParams = { query };
  if (params.context !== undefined) {
    const context = params.context.trim();
    if (context.length > 0) result.context = context;
  }
  return result;
}

function buildLibrarianUserPrompt(params: LibrarianParams): string {
  if (params.context && params.context.trim().length > 0) {
    return `Context: ${params.context.trim()}\n\nQuery: ${params.query.trim()}`;
  }
  return `Query: ${params.query.trim()}`;
}

function defaultResolveLibrarianInvocation(input: ResolveLibrarianInvocationInput): MmrSubagentInvocation {
  const profile = requireLibrarianProfile();
  const registry = resolveCtxModelRegistry(input.ctx);
  if (!registry) {
    return {
      ok: false,
      profile,
      code: "model.no-route",
      message: "librarian could not resolve a model registry from the extension context; expected ctx.modelRegistry to expose getAll/find.",
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: [],
      diagnostics: [],
      workerTools: [],
      toolResolution: {
        intendedTools: [...profile.tools],
        deniedTools: profile.denyTools ?? [],
        omittedTools: [],
      },
    };
  }
  return resolveMmrSubagentInvocation({
    profile,
    registry,
    ...(input.registeredTools !== undefined ? { registeredTools: input.registeredTools } : {}),
    explicitTools: LIBRARIAN_WORKER_TOOLS,
    ...(input.modelPreferencesOverride !== undefined
      ? { modelPreferencesOverride: input.modelPreferencesOverride }
      : {}),
  });
}

function resolveLibrarianModelPreferencesOverride(
  cwd: string,
  deps: LibrarianToolDeps,
): readonly MmrModelPreference[] | undefined {
  if (deps.modelPreferencesOverride !== undefined) return deps.modelPreferencesOverride;
  try {
    const loaded = deps.loadSubagentModelPreferences
      ? deps.loadSubagentModelPreferences(cwd)
      : loadMmrCoreSettings(cwd).settings.subagentModelPreferences;
    const profilePref = loaded?.[LIBRARIAN_SUBAGENT_PROFILE_NAME];
    if (profilePref && profilePref.length > 0) return profilePref;
  } catch {
    // Settings read errors must not block librarian spawn; child
    // activation performs its own settings load and surfaces warnings.
  }
  return undefined;
}

function assembleLibrarianSystemPrompt(
  cwd: string,
  deps: LibrarianToolDeps,
  activeToolManifest: readonly MmrActiveToolManifestEntry[],
  workerTools: readonly string[],
): string {
  const profile = requireLibrarianProfile();
  if (!deps.buildSystemPrompt) {
    return assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [...activeToolManifest],
      cwd,
      workerTools,
    }).systemPrompt;
  }

  const previous = getMmrSubagentPromptBuilder(profile.promptBuilder);
  registerMmrSubagentPromptBuilder(profile.promptBuilder, ({ cwd: builderCwd }) => deps.buildSystemPrompt?.(builderCwd) ?? "");
  try {
    return assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [...activeToolManifest],
      cwd,
      workerTools,
    }).systemPrompt;
  } finally {
    if (previous) registerMmrSubagentPromptBuilder(profile.promptBuilder, previous);
    else unregisterMmrSubagentPromptBuilder(profile.promptBuilder);
  }
}

interface LibrarianDetailsContext {
  status: LibrarianStatus;
  query: string;
  context?: string;
  cwd: string;
  workerTools: readonly string[];
  resolvedModel?: string;
  contextWindow?: number;
}

function createBaseDetails(ctx: LibrarianDetailsContext): LibrarianDetails {
  const details: LibrarianDetails = {
    worker: "mmr-subagents.librarian",
    status: ctx.status,
    query: ctx.query,
    exitCode: null,
    signal: null,
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    usage: emptyMmrWorkerUsageStats(),
    stderr: "",
    command: "",
    args: [],
    cwd: ctx.cwd,
    workerTools: ctx.workerTools,
    trail: [],
  };
  if (ctx.context !== undefined) details.context = ctx.context;
  if (ctx.resolvedModel !== undefined) details.model = ctx.resolvedModel;
  if (ctx.contextWindow !== undefined) details.contextWindow = ctx.contextWindow;
  return details;
}

function makeFailureResult(args: {
  status: LibrarianStatus;
  query: string;
  context?: string;
  cwd: string;
  workerTools: readonly string[];
  content: string;
  errorMessage: string;
  resolvedModel?: string;
  contextWindow?: number;
  spawnError?: string;
  subagentActivationError?: string;
}): AgentToolResult<LibrarianDetails> {
  const details = createBaseDetails({
    status: args.status,
    query: args.query,
    ...(args.context !== undefined ? { context: args.context } : {}),
    cwd: args.cwd,
    workerTools: args.workerTools,
    ...(args.resolvedModel !== undefined ? { resolvedModel: args.resolvedModel } : {}),
    ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
  });
  details.errorMessage = args.errorMessage;
  if (args.spawnError !== undefined) details.spawnError = args.spawnError;
  if (args.subagentActivationError !== undefined) {
    details.subagentActivationError = args.subagentActivationError;
  }
  return { content: [{ type: "text", text: args.content }], details };
}

function buildProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  ctx: Omit<LibrarianDetailsContext, "status">,
): LibrarianDetails {
  const base = buildSpawnedProgressDetailsBase({
    snapshot,
    cwd: ctx.cwd,
    workerTools: ctx.workerTools,
    ...(ctx.resolvedModel !== undefined ? { resolvedModel: ctx.resolvedModel } : {}),
    ...(ctx.contextWindow !== undefined ? { contextWindow: ctx.contextWindow } : {}),
  });
  const details: LibrarianDetails = {
    worker: "mmr-subagents.librarian",
    status: "success",
    query: ctx.query,
    ...base,
  };
  if (ctx.context !== undefined) details.context = ctx.context;
  return details;
}

function classifyLibrarianOutcome(result: MmrWorkerResult): LibrarianStatus {
  const outcome: MmrWorkerOutcomeStatus = classifyMmrWorkerOutcomeForProfile(result, requireLibrarianProfile());
  if (outcome === "no-agent-start") return "worker-error";
  return outcome;
}

function buildDetails(
  result: MmrWorkerResult,
  ctx: Omit<LibrarianDetailsContext, "status">,
): LibrarianDetails {
  // Librarian wraps `no-agent-start` as `worker-error` locally via
  // {@link classifyLibrarianOutcome}; the shared helper only handles
  // common base-field propagation.
  const base = buildSpawnedFinalDetailsBase({
    result,
    cwd: ctx.cwd,
    workerTools: ctx.workerTools,
    ...(ctx.resolvedModel !== undefined ? { resolvedModel: ctx.resolvedModel } : {}),
    ...(ctx.contextWindow !== undefined ? { contextWindow: ctx.contextWindow } : {}),
  });
  const details: LibrarianDetails = {
    worker: "mmr-subagents.librarian",
    status: classifyLibrarianOutcome(result),
    query: ctx.query,
    ...base,
  };
  if (ctx.context !== undefined) details.context = ctx.context;
  return details;
}

function buildFinalContent(result: MmrWorkerResult): string {
  const status = classifyLibrarianOutcome(result);
  if (status === "spawn-error") {
    const reason = result.spawnError ?? result.errorMessage ?? "unknown spawn error";
    return `librarian: worker failed to spawn: ${reason}`;
  }
  if (status === "activation-error") {
    return `librarian: subagent activation failed: ${result.subagentActivationError}`;
  }
  if (status === "aborted") {
    return "librarian: research was cancelled before producing a result.";
  }
  if (status === "worker-error") {
    if (result.agentStarted === false && !result.subagentActivationError && !result.spawnError) {
      const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
      const detail = tail.length > 0 ? `\n\n${tail}` : "";
      return `librarian: worker exited before the agent loop started. No repository findings were produced; another Pi extension's input handler likely consumed the prompt. Check stderr for extension diagnostics.${detail}`;
    }
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detailText = tail.length > 0 ? tail : (result.errorMessage ?? "");
    const detail = detailText.length > 0 ? `\n\n${detailText}` : "";
    return `librarian: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  if (status === "success") {
    return result.truncatedFinalOutput || result.finalOutput;
  }
  if (result.errorMessage && result.errorMessage.length > 0) {
    return `librarian: worker reported an error: ${result.errorMessage}`;
  }
  return "librarian: no repository findings were produced. Re-run with a narrower repository and question.";
}

function isContextWindowError(err: unknown): boolean {
  return err instanceof MmrLibrarianContextWindowError
    || (err instanceof Error && err.name === "MmrLibrarianContextWindowError");
}

export function createLibrarianTool(deps: LibrarianToolDeps = {}): ToolDefinition {
  const effectiveRunner = resolveEffectiveRunner(deps, "createLibrarianTool");
  const resolveInvocation = deps.resolveInvocation ?? defaultResolveLibrarianInvocation;
  const detailsCtxOf = (
    runCtx: MmrWorkerToolRunContext<LibrarianParams>,
  ): Omit<LibrarianDetailsContext, "status"> => ({
    query: runCtx.params.query,
    ...(runCtx.params.context !== undefined ? { context: runCtx.params.context } : {}),
    cwd: runCtx.cwd,
    workerTools: runCtx.workerTools,
    ...(runCtx.resolvedModel !== undefined ? { resolvedModel: runCtx.resolvedModel } : {}),
    ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
  });
  return createWorkerTool<LibrarianParams, LibrarianDetails>(
    {
      toolName: LIBRARIAN_TOOL_NAME,
      profileName: LIBRARIAN_SUBAGENT_PROFILE_NAME,
      description: LIBRARIAN_DESCRIPTION,
      promptSnippet: LIBRARIAN_PROMPT_SNIPPET,
      promptGuidelines: LIBRARIAN_PROMPT_GUIDELINES,
      parameters: librarianParameters,
      progressPlaceholder: LIBRARIAN_PROGRESS_PLACEHOLDER,
      coerceParams: coerceLibrarianParams,
      paramsFailure: (message, raw, cwd) =>
        makeFailureResult({
          status: "validation-error",
          query: typeof (raw as { query?: unknown })?.query === "string"
            ? (raw as { query: string }).query.trim()
            : "",
          cwd,
          workerTools: LIBRARIAN_WORKER_TOOLS,
          content: `librarian: invalid parameters: ${message}`,
          errorMessage: message,
        }),
      preSpawnGate: (params, cwd) => {
        if (isLibrarianGithubToolPrerequisiteRegistered(deps.pi)) return undefined;
        return makeFailureResult({
          status: "provider-gated",
          query: params.query,
          ...(params.context !== undefined ? { context: params.context } : {}),
          cwd,
          workerTools: LIBRARIAN_WORKER_TOOLS,
          content: LIBRARIAN_GATING_REASON,
          errorMessage: LIBRARIAN_GATING_REASON,
        });
      },
      resolveInvocation: (input) => {
        const invocationInput: ResolveLibrarianInvocationInput = { ctx: input.ctx };
        if (input.registeredTools !== undefined) invocationInput.registeredTools = input.registeredTools;
        if (input.modelPreferencesOverride !== undefined) {
          invocationInput.modelPreferencesOverride = input.modelPreferencesOverride;
        }
        return resolveInvocation(invocationInput);
      },
      resolutionFailure: "fail-closed",
      resolutionFailureResult: (invocation, params, cwd) => {
        const prefix = invocation.code === "model.no-route"
          ? "librarian: could not resolve a model route"
          : "librarian: could not prepare the web research worker";
        return makeFailureResult({
          status: "activation-error",
          query: params.query,
          ...(params.context !== undefined ? { context: params.context } : {}),
          cwd,
          workerTools: invocation.workerTools.length > 0 ? invocation.workerTools : LIBRARIAN_WORKER_TOOLS,
          content: `${prefix}: ${invocation.message}`,
          errorMessage: invocation.message,
          subagentActivationError: invocation.message,
        });
      },
      mirrorWorkerTools: true,
      detailsWorkerTools: "invocation",
      workerToolsConstant: LIBRARIAN_WORKER_TOOLS,
      progressModelBinding: "initial",
      buildUserPrompt: (params) => buildLibrarianUserPrompt(params),
      assembleSystemPrompt: (cwd, workerTools) =>
        assembleLibrarianSystemPrompt(
          cwd,
          deps,
          buildWorkerToolManifest(deps.pi, workerTools ?? []),
          workerTools ?? [],
        ),
      resolveContextWindow: (_ctx, _model, invocation) =>
        readMmrModelContextWindow(invocation?.selected.registeredModel),
      extraRunnerOptions: () => ({ systemPromptDelivery: "replace" }),
      candidatePreferences: () => requireLibrarianProfile().modelPreferences,
      buildProgressDetails: (snapshot, runCtx) => buildProgressDetails(snapshot, detailsCtxOf(runCtx)),
      buildFinalDetails: (result, runCtx) => buildDetails(result, detailsCtxOf(runCtx)),
      buildFinalContent: (result) => buildFinalContent(result),
      mapRunError: (err, runCtx) => {
        const message = err instanceof Error ? err.message : String(err);
        if (isContextWindowError(err)) {
          return makeFailureResult({
            status: "context-window-exhausted",
            query: runCtx.params.query,
            ...(runCtx.params.context !== undefined ? { context: runCtx.params.context } : {}),
            cwd: runCtx.cwd,
            workerTools: runCtx.workerTools,
            content: "librarian: context window limit reached before the worker could return a result.",
            errorMessage: message,
            ...(runCtx.invocation !== undefined ? { resolvedModel: runCtx.invocation.modelArg } : {}),
            ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
          });
        }
        return makeFailureResult({
          status: "spawn-error",
          query: runCtx.params.query,
          ...(runCtx.params.context !== undefined ? { context: runCtx.params.context } : {}),
          cwd: runCtx.cwd,
          workerTools: runCtx.workerTools,
          content: `librarian: worker failed to spawn: ${message}`,
          errorMessage: message,
          spawnError: message,
          ...(runCtx.invocation !== undefined ? { resolvedModel: runCtx.invocation.modelArg } : {}),
          ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
        });
      },
    },
    deps,
    {
      effectiveRunner,
      resolveModelPreferencesOverride: (cwd) => resolveLibrarianModelPreferencesOverride(cwd, deps),
    },
  );
}

export function registerLibrarianTool(pi: ExtensionAPI, deps: LibrarianToolDeps = {}): ToolDefinition {
  const definition = createLibrarianTool({ ...deps, pi });
  registerMmrOwnedTool(LIBRARIAN_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
