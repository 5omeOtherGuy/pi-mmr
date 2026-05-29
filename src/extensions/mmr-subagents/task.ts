import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isRecord } from "../mmr-core/internal/json.js";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { getMmrModeStateSnapshot, getMmrSubagentState } from "../mmr-core/runtime.js";
import type {
  MmrActiveToolManifestEntry,
  MmrModelPreference,
  MmrModeKey,
} from "../mmr-core/types.js";
import { assembleMmrSubagentSurface } from "../mmr-core/subagent-prompt-assembly.js";
import { getMmrSubagentProfile } from "../mmr-core/subagent-profiles.js";
import {
  resolveMmrSubagentInvocation,
  type MmrSubagentInvocation,
} from "../mmr-core/subagent-resolver.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import type { MmrModelRegistryLike, MmrRegisteredModelLike } from "../mmr-core/model-resolver.js";
import { loadMmrCoreSettings } from "../mmr-core/settings.js";
import {
  type MmrWorkerFallbackRegistry,
  readMmrWorkerSessionId,
  runMmrWorkerWithModelFallback,
} from "./fallback.js";
import { renderMmrSubagentCall, renderMmrSubagentResult } from "./progress-rendering.js";
import { readMmrModelContextWindow } from "./worker-model-metadata.js";
import {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  classifyMmrWorkerOutcome,
  createChildCliMmrSubagentRunner,
  createMmrSubagentRunnerFromRunWorker,
  emptyMmrWorkerUsageStats,
  hasUsableMmrWorkerFinalOutput,
  type MmrSpawnedSubagentWorkerDetailsBase,
  type MmrSubagentRunOptions,
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
  progressTextOrPlaceholder,
} from "./worker-result-shaping.js";

export const TASK_TOOL_NAME = "Task";
export const TASK_SUBAGENT_PROFILE = "task-subagent";

function requireTaskProfile() {
  const profile = getMmrSubagentProfile(TASK_SUBAGENT_PROFILE);
  if (!profile) {
    throw new Error(
      `mmr-core does not expose a "${TASK_SUBAGENT_PROFILE}" subagent profile; Task cannot run without it.`,
    );
  }
  return profile;
}

/**
 * Profile-intended worker tool surface for the Task profile. Used as a
 * stable public reference for parent-side fixtures and feature tests.
 *
 * The actual per-invocation tool list passed through `pi --tools` is
 * computed by `resolveMmrSubagentInvocation` against the host's
 * registered tools and may be a subset of this when a deployment is
 * missing one of the intended tools.
 */
export const TASK_WORKER_TOOLS: readonly string[] = Object.freeze(
  (() => {
    const profile = requireTaskProfile();
    const deny = new Set(profile.denyTools ?? []);
    return profile.tools.filter((t) => !deny.has(t));
  })(),
);

export const TASK_PROMPT_SNIPPET = "Perform a bounded task in a subagent worker";

export const TASK_PROMPT_GUIDELINES: readonly string[] = [
  "Use Task for bounded worker jobs: implementation units, focused investigation, test repair, UI checking, or review.",
  "When not to use Task: do not spawn a worker for a single file read, a single exact search, a small edit you can complete directly, or a task whose plan is not yet clear.",
  "Write outcome-first prompts that include the goal, scope, relevant context, files or evidence to inspect first, constraints and non-goals, validation to run, and the expected return shape.",
  "Ask for compact results, not transcripts: outcome, files changed or inspected, summary, validation result, concerns or blockers, and next action.",
  "Run multiple Task workers only for genuinely independent work. Keep code-writing single-threaded unless write targets are clearly disjoint.",
  "When the worker finishes, inspect its diff or evidence, run any combined validation, and summarize the user-relevant result yourself.",
] as const;

export const TASK_DESCRIPTION = [
  "Perform a bounded sub-task in a worker process derived from the active MMR subagent framework.",
  "",
  "Use Task when a scoped implementation, investigation, repair, UI check, or review would produce enough intermediate output that it is better handled outside the parent turn.",
  "",
  "When NOT to use Task:",
  "- Do not use Task for a single file read, one exact search, or one small edit the parent can complete directly.",
  "- Do not use Task before the plan is clear enough to give the worker a bounded objective.",
  "- Do not use Task to avoid reviewing or validating the result yourself; the parent remains responsible for integration and the final answer.",
  "",
  "How to use Task:",
  "- Provide an outcome-first prompt with the goal, scope, relevant files or evidence, constraints, validation to run, and expected result shape.",
  "- Provide a short description for progress display and diagnostics.",
  "- Expect a compact final result, not a transcript. The worker should report outcome, files changed or inspected, summary, validation, and concerns or blockers.",
  "- Run workers in parallel only for independent read-only work or clearly disjoint implementation units.",
].join("\n");

export const TASK_PARAMETERS_SCHEMA = Type.Object(
  {
    prompt: Type.String({
      description: "The bounded task prompt for the worker. Include goal, scope, context, constraints, validation, and expected result shape.",
    }),
    description: Type.String({
      description: "Short display label for the worker task.",
    }),
  },
  { additionalProperties: false },
);

export const taskParameters = TASK_PARAMETERS_SCHEMA;

export type TaskParams = Static<typeof TASK_PARAMETERS_SCHEMA>;

/**
 * Discriminator for the outcome of a Task invocation. Pi's `AgentToolResult`
 * has no top-level error flag, so the parent agent infers failure from the
 * Task-prefixed content text plus this status. Precedence is fixed (see
 * `classifyTaskOutcome`) so the parent can rely on it during integration.
 */
export type TaskStatus =
  | "success"
  | "validation-error"
  | "activation-error"
  | "aborted"
  | "spawn-error"
  | "worker-error"
  | "no-agent-start"
  | "empty-output";

/** Caps from spec §9.5. Validation rejects values that exceed these caps. */
export const TASK_PROMPT_MAX_BYTES = 8 * 1024;
export const TASK_DESCRIPTION_MAX_BYTES = 512;

export interface TaskDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: "mmr-subagents.Task";
  /** Outcome discriminator; see {@link TaskStatus}. */
  status: TaskStatus;
  prompt: string;
  description: string;
}

/**
 * Inputs to {@link classifyTaskOutcome}. Narrower than `MmrWorkerResult` so
 * the classifier is unit-testable without constructing a full worker result.
 */
export interface TaskOutcomeInput {
  spawnError?: string;
  subagentActivationError?: string;
  aborted: boolean;
  signal: NodeJS.Signals | null;
  exitCode: number | null;
  finalOutput: string;
  truncatedFinalOutput: string;
  /**
   * Optional: did the child Pi process emit `agent_start`? When absent,
   * the classifier treats the agent loop as having run (backwards
   * compatible with older callers). When `false`, clean-exit empty
   * output classifies as `no-agent-start` instead of `empty-output`.
   * See `MmrWorkerResult.agentStarted` for the underlying signal.
   */
  agentStarted?: boolean;
}

/**
 * Predicate from spec §9.4: "usable final text". Thin wrapper around
 * the shared `hasUsableMmrWorkerFinalOutput` helper, kept for callers
 * that import the Task-specific name. The truncated form wins when
 * present so partial responses still count.
 */
export function hasUsableTaskFinalText(input: Pick<TaskOutcomeInput, "finalOutput" | "truncatedFinalOutput">): boolean {
  return hasUsableMmrWorkerFinalOutput(input);
}

/**
 * Precedence-ordered classifier for Task outcomes (spec §9.4). Thin
 * wrapper around {@link classifyMmrWorkerOutcome} with Task's
 * `partialOutputPolicy: "prefer-usable-output"` baked in so non-zero
 * exit with usable final text still classifies as `success`. Task's
 * additional `validation-error` state is handled by the caller before
 * any worker-result input is available, so it is intentionally not
 * part of this classifier.
 */
export function classifyTaskOutcome(input: TaskOutcomeInput): TaskStatus {
  const outcome: MmrWorkerOutcomeStatus = classifyMmrWorkerOutcome(
    {
      ...(input.spawnError !== undefined ? { spawnError: input.spawnError } : {}),
      ...(input.subagentActivationError !== undefined
        ? { subagentActivationError: input.subagentActivationError }
        : {}),
      aborted: input.aborted,
      signal: input.signal,
      exitCode: input.exitCode,
      finalOutput: input.finalOutput,
      truncatedFinalOutput: input.truncatedFinalOutput,
      ...(input.agentStarted !== undefined ? { agentStarted: input.agentStarted } : {}),
    },
    { partialOutputPolicy: "prefer-usable-output" },
  );
  return outcome;
}

export const TASK_PROGRESS_PLACEHOLDER = "Task: worker running…";

let latestParentSystemPrompt: string | undefined;

export function captureTaskParentSystemPrompt(systemPrompt: unknown): void {
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    latestParentSystemPrompt = systemPrompt;
  }
}

export function getTaskParentSystemPrompt(): string | undefined {
  return latestParentSystemPrompt;
}

export function registerTaskParentPromptCapture(pi: Pick<ExtensionAPI, "on">): void {
  pi.on("before_agent_start", (event) => {
    if (getMmrSubagentState()) return;
    captureTaskParentSystemPrompt((event as { systemPrompt?: unknown }).systemPrompt);
  });
}

export interface TaskWorkerSystemPromptInput {
  cwd: string;
  parentMode: MmrModeKey;
  activeToolManifest?: readonly MmrActiveToolManifestEntry[];
  baseSystemPrompt?: string;
  /**
   * Effective worker tool set computed by
   * {@link resolveMmrSubagentInvocation}. Forwarded to
   * `assembleMmrSubagentSurface` so the worker prompt's
   * `Available tools:` block describes exactly the tools the worker
   * will have at the child Pi process. When omitted, the manifest is
   * filtered by the Task profile's intent allowlist, which is broader
   * than the deny-aware, registered-tool subset.
   */
  workerTools?: readonly string[];
}

export function buildTaskWorkerSystemPrompt(input: TaskWorkerSystemPromptInput): string {
  const profile = requireTaskProfile();
  return assembleMmrSubagentSurface({
    profile,
    baseSystemPrompt: input.baseSystemPrompt ?? "",
    activeToolManifest: [...(input.activeToolManifest ?? [])],
    cwd: input.cwd,
    parentMode: input.parentMode,
    ...(input.workerTools !== undefined ? { workerTools: input.workerTools } : {}),
  }).systemPrompt;
}

/**
 * Validation error thrown by {@link coerceTaskParams}. Carries a stable
 * deterministic message so tests can pin the string surface.
 */
export class TaskParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskParamsError";
  }
}

const TASK_KNOWN_PARAM_KEYS: ReadonlySet<string> = new Set(["prompt", "description"]);
const TASK_DESCRIPTION_CONTROL_RE = /[\u0000-\u001f\u007f]/;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function coerceTaskParams(raw: unknown): TaskParams {
  // Spec §3 validation order: shape → extra props → prompt → description.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TaskParamsError("Task expects an object with `prompt` and `description` fields.");
  }
  try {
    checkMmrToolParams(TASK_TOOL_NAME, TASK_PARAMETERS_SCHEMA, raw);
  } catch {
    // Preserve Task's long-standing deterministic validation order and
    // message surface below; the shared TypeBox check is the source of
    // schema validation while TaskParamsError remains the public wrapper.
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TASK_KNOWN_PARAM_KEYS.has(key)) {
      throw new TaskParamsError(`Task does not accept extra parameter "${key}".`);
    }
  }
  if (typeof obj.prompt !== "string") {
    throw new TaskParamsError("Task.prompt is required and must be a non-empty string.");
  }
  if (obj.prompt.trim().length === 0) {
    throw new TaskParamsError("Task.prompt is required and must be a non-empty string.");
  }
  if (byteLength(obj.prompt) > TASK_PROMPT_MAX_BYTES) {
    throw new TaskParamsError(
      `Task.prompt exceeds the ${TASK_PROMPT_MAX_BYTES}-byte cap (got ${byteLength(obj.prompt)} bytes).`,
    );
  }
  if (typeof obj.description !== "string") {
    throw new TaskParamsError("Task.description is required and must be a non-empty string.");
  }
  if (obj.description.trim().length === 0) {
    throw new TaskParamsError("Task.description is required and must be a non-empty string.");
  }
  if (byteLength(obj.description) > TASK_DESCRIPTION_MAX_BYTES) {
    throw new TaskParamsError(
      `Task.description exceeds the ${TASK_DESCRIPTION_MAX_BYTES}-byte cap (got ${byteLength(obj.description)} bytes).`,
    );
  }
  if (TASK_DESCRIPTION_CONTROL_RE.test(obj.description)) {
    throw new TaskParamsError("Task.description must not contain control characters other than space.");
  }
  return { prompt: obj.prompt, description: obj.description };
}

function resolveCwd(ctx: ExtensionContext | undefined): string {
  const candidate = (ctx as { cwd?: unknown } | undefined)?.cwd;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return process.cwd();
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

function resolveRegisteredTools(pi: ToolHostLike | undefined): readonly string[] | undefined {
  if (!pi) return undefined;
  try {
    const tools = pi.getAllTools?.();
    if (!Array.isArray(tools)) return undefined;
    return tools.flatMap((t) => {
      if (!isRecord(t)) return [];
      return typeof t.name === "string" && t.name.length > 0 ? [t.name] : [];
    });
  } catch {
    return undefined;
  }
}

function progressContent(snapshot: MmrWorkerProgressSnapshot): string {
  return progressTextOrPlaceholder(snapshot, TASK_PROGRESS_PLACEHOLDER);
}

interface TaskDetailsContext {
  prompt: string;
  description: string;
  cwd: string;
  workerTools: readonly string[];
  resolvedModel?: string;
  contextWindow?: number;
}

function buildProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  ctx: TaskDetailsContext,
): TaskDetails {
  // Progress is intentionally classified as `success`; a final non-success
  // status is only known once the worker exits and the runner returns a
  // complete `MmrWorkerResult`.
  const base = buildSpawnedProgressDetailsBase({
    snapshot,
    cwd: ctx.cwd,
    workerTools: ctx.workerTools,
    ...(ctx.resolvedModel !== undefined ? { resolvedModel: ctx.resolvedModel } : {}),
    ...(ctx.contextWindow !== undefined ? { contextWindow: ctx.contextWindow } : {}),
  });
  return {
    worker: "mmr-subagents.Task",
    status: "success",
    prompt: ctx.prompt,
    description: ctx.description,
    ...base,
  };
}

function buildDetails(
  result: MmrWorkerResult,
  ctx: TaskDetailsContext,
  statusOverride?: TaskStatus,
): TaskDetails {
  // Task's status policy stays local: classify from the result (with
  // structured spawn/activation discriminators forwarded to the
  // classifier) unless the caller is building a pre-spawn failure
  // result and passes an explicit override.
  const status = statusOverride ?? classifyTaskOutcome({
    aborted: result.aborted,
    signal: result.signal,
    exitCode: result.exitCode,
    finalOutput: result.finalOutput,
    truncatedFinalOutput: result.truncatedFinalOutput,
    agentStarted: result.agentStarted,
    ...(result.spawnError ? { spawnError: result.spawnError } : {}),
    ...(result.subagentActivationError ? { subagentActivationError: result.subagentActivationError } : {}),
  });
  const base = buildSpawnedFinalDetailsBase({
    result,
    cwd: ctx.cwd,
    workerTools: ctx.workerTools,
    ...(ctx.resolvedModel !== undefined ? { resolvedModel: ctx.resolvedModel } : {}),
    ...(ctx.contextWindow !== undefined ? { contextWindow: ctx.contextWindow } : {}),
  });
  return {
    worker: "mmr-subagents.Task",
    status,
    prompt: ctx.prompt,
    description: ctx.description,
    ...base,
  };
}

function buildFinalContent(result: MmrWorkerResult): string {
  if (result.spawnError) {
    return `Task: worker failed to spawn: ${result.spawnError}`;
  }
  if (result.subagentActivationError) {
    return `Task: subagent activation failed: ${result.subagentActivationError}`;
  }
  const text = result.truncatedFinalOutput || result.finalOutput;
  if (text && text.trim().length > 0) return text;
  if (result.aborted) return "Task: worker was cancelled before producing a result.";
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `Task: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  // Clean exit, no text. Distinguish "agent ran and produced nothing"
  // from "agent loop never started" so operators see the right hint.
  if (result.agentStarted === false) {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `Task: worker exited before the agent loop started. No output was produced; another Pi extension's input handler likely consumed the prompt. Check stderr for extension diagnostics.${detail}`;
  }
  return "Task: worker produced no final output. Re-run with a narrower prompt or more context.";
}

interface ToolHostLike {
  getActiveTools?: () => readonly string[];
  getAllTools?: () => readonly unknown[];
}

/**
 * Build the worker's tool manifest from the resolved `workerTools` set
 * (deny-aware, registered-tool intersection from
 * `resolveMmrSubagentInvocation`) rather than from `pi.getActiveTools()`.
 *
 * `pi.getActiveTools()` reflects the parent mode's current active set,
 * which is generally a subset of the registered-tool inventory. When
 * the parent mode does not currently expose a tool that is nevertheless
 * registered in the host, the previous parent-active-filtered manifest
 * would omit it even though the child's `workerTools` includes it — the
 * worker could call the tool at runtime but its system prompt never
 * described it, producing silent under-advertising. Filtering by
 * `workerTools` yields a manifest that exactly matches the worker's
 * runtime tool surface.
 *
 * Tools listed in `workerTools` but absent from `pi.getAllTools()` are
 * dropped from the manifest (no metadata available). This matches the
 * graceful handling for profile-listed but unregistered tools elsewhere
 * in the resolver path.
 */
function buildWorkerToolManifest(
  pi: ToolHostLike | undefined,
  workerTools: readonly string[],
): MmrActiveToolManifestEntry[] {
  if (!pi || workerTools.length === 0) return [];
  const wanted = new Set(workerTools);
  let allTools: readonly unknown[] = [];
  try {
    const tools = pi.getAllTools?.();
    if (Array.isArray(tools)) allTools = tools;
  } catch {
    allTools = [];
  }
  return allTools.flatMap((tool): MmrActiveToolManifestEntry[] => {
    if (!isRecord(tool) || typeof tool.name !== "string" || !wanted.has(tool.name)) return [];
    const promptGuidelines = Array.isArray(tool.promptGuidelines)
      ? tool.promptGuidelines.filter((entry): entry is string => typeof entry === "string")
      : [];
    const description = typeof tool.description === "string"
      ? tool.description
      : typeof tool.promptSnippet === "string"
        ? tool.promptSnippet
        : "";
    const promptSnippet = typeof tool.promptSnippet === "string" ? tool.promptSnippet : undefined;
    return [{
      name: tool.name,
      owner: "runtime",
      ...(promptSnippet !== undefined ? { promptSnippet } : {}),
      promptGuidelines,
      description,
      schema: tool.parameters ?? {},
    }];
  });
}

/**
 * Returns the live parent mode for prompt-base resolution. Returns
 * `undefined` when the parent has no Task-enabled locked mode (no
 * snapshot, or snapshot mode is `"free"`), so the invocation resolver
 * can emit `prompt-base.unresolved` for `from-parent` profiles instead
 * of silently falling back to `"smart"`.
 */
function resolveParentMode(): MmrModeKey | undefined {
  const mode = getMmrModeStateSnapshot()?.mode;
  if (mode && mode !== "free") return mode;
  return undefined;
}

export interface ResolveTaskInvocationInput {
  ctx: ExtensionContext | undefined;
  /**
   * Resolved parent mode, or `undefined` when no Task-enabled parent
   * mode is active. The default resolver forwards this verbatim so
   * `from-parent` profiles fail closed via `prompt-base.unresolved`.
   */
  parentMode: MmrModeKey | undefined;
  registeredTools?: readonly string[];
  /**
   * Effective settings-driven model preference override resolved by the
   * Task tool before calling the resolver. Explicit
   * {@link TaskToolDeps.modelPreferencesOverride} wins over the
   * settings read; absent when neither source supplies one. The default
   * resolver forwards this verbatim to
   * {@link resolveMmrSubagentInvocation}.
   */
  modelPreferencesOverride?: readonly MmrModelPreference[];
}

export interface TaskToolDeps {
  /** Generic subagent runner. Preferred seam for tests and alternate hosts. */
  runner?: MmrSubagentRunner;
  /** Legacy direct worker seam retained for consistency with finder/oracle tests. */
  runWorker?: typeof runMmrSubagentWorker;
  /**
   * Override the per-invocation resolver. Tests inject this to avoid
   * needing a full {@link MmrModelRegistryLike} stub on `ctx`. Defaults to
   * `resolveMmrSubagentInvocation` against `ctx.modelRegistry`.
   */
  resolveInvocation?: (input: ResolveTaskInvocationInput) => MmrSubagentInvocation;
  /**
   * Explicit programmatic model preference override. When provided this
   * wins over the settings read below; useful for tests and future host
   * integrations that want to pin a preference without touching
   * `.pi/settings.json`. When omitted, the Task tool reads settings on
   * every execute (see {@link loadSubagentModelPreferences}) so a
   * `/mmr-config` change takes effect on the next invocation, matching
   * the child activation path.
   */
  modelPreferencesOverride?: readonly MmrModelPreference[];
  /**
   * Settings loader seam. Defaults to
   * `loadMmrCoreSettings(cwd).settings.subagentModelPreferences`. Tests
   * inject a deterministic loader to assert that the Task tool reads
   * settings on every execute, matching how the child Pi process reads
   * them in `applySubagentProfile`. F5: parent and child must read
   * `subagentModelPreferences` through the same code path so a settings
   * override applied at one side is automatically honored at the other.
   */
  loadSubagentModelPreferences?: (cwd: string) =>
    Record<string, readonly MmrModelPreference[]> | undefined;
  /** Override the worker output byte cap. */
  outputByteLimit?: number;
  /** Override prompt text while still using the Task runner plumbing. */
  buildSystemPrompt?: (input: TaskWorkerSystemPromptInput) => string;
  /** Return the latest parent system prompt used as the base for mode-derived Task prompt assembly. */
  getBaseSystemPrompt?: () => string | undefined;
  /** Forwarded to {@link runMmrSubagentWorker} as its second argument. */
  runnerDeps?: MmrWorkerRunnerDeps;
  /** Pi host, captured by registerTaskTool so prompt assembly can inspect active tool metadata. */
  pi?: ToolHostLike;
}

function defaultResolveTaskInvocation(
  input: ResolveTaskInvocationInput,
): MmrSubagentInvocation {
  const profile = requireTaskProfile();
  const registry = resolveCtxModelRegistry(input.ctx);
  if (!registry) {
    return {
      ok: false,
      profile,
      code: "model.no-route",
      message: `Task could not resolve a model registry from the extension context; expected ctx.modelRegistry to expose getAll/find.`,
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: [],
      diagnostics: [],
      parentMode: input.parentMode,
      workerTools: [],
      toolResolution: {
        intendedTools: [],
        deniedTools: profile.denyTools ?? [],
        omittedTools: [],
      },
    };
  }
  return resolveMmrSubagentInvocation({
    profile,
    registry,
    ...(input.parentMode !== undefined ? { parentMode: input.parentMode } : {}),
    ...(input.registeredTools !== undefined ? { registeredTools: input.registeredTools } : {}),
    ...(input.modelPreferencesOverride !== undefined
      ? { modelPreferencesOverride: input.modelPreferencesOverride }
      : {}),
  });
}

/**
 * Resolve the effective settings-driven model preference override for a
 * Task execute() call. Explicit programmatic overrides win over settings
 * so test injection stays deterministic. Settings reads that throw are
 * swallowed so a malformed settings file does not block Task spawn;
 * the child activation path will surface any settings warnings through
 * its own loader call.
 */
function resolveTaskModelPreferencesOverride(
  cwd: string,
  deps: TaskToolDeps,
): readonly MmrModelPreference[] | undefined {
  if (deps.modelPreferencesOverride !== undefined) return deps.modelPreferencesOverride;
  try {
    const loaded = deps.loadSubagentModelPreferences
      ? deps.loadSubagentModelPreferences(cwd)
      : loadMmrCoreSettings(cwd).settings.subagentModelPreferences;
    const profilePref = loaded?.[TASK_SUBAGENT_PROFILE];
    if (profilePref && profilePref.length > 0) return profilePref;
  } catch {
    // Settings read errors must not block Task spawn; the child
    // activation path performs its own settings load and surfaces
    // warnings to the user.
  }
  return undefined;
}

interface MakeFailureResultArgs {
  status: TaskStatus;
  prompt: string;
  description: string;
  cwd: string;
  workerTools: readonly string[];
  content: string;
  errorMessage: string;
  resolvedModel?: string;
  contextWindow?: number;
  spawnError?: string;
  subagentActivationError?: string;
}

/**
 * Build a Pi `AgentToolResult` for a pre-spawn failure path: validation,
 * resolver, or spawn errors. Ensures every failure path emits a complete
 * {@link TaskDetails} shape with the correct {@link TaskStatus}.
 */
function makeFailureResult(args: MakeFailureResultArgs): AgentToolResult<TaskDetails> {
  const synthetic: MmrWorkerResult = {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    exitCode: null,
    signal: null,
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    // Pre-spawn failures never reach the agent loop. The classifier reads
    // `agentStarted` only when nothing earlier in the precedence ladder
    // fired, so this is documentation as much as it is correctness.
    agentStarted: false,
    usage: emptyMmrWorkerUsageStats(),
    stderr: "",
    command: "",
    args: [],
    prompt: args.prompt,
    cwd: args.cwd,
    trail: [],
    errorMessage: args.errorMessage,
    ...(args.subagentActivationError ? { subagentActivationError: args.subagentActivationError } : {}),
  };
  const detailsCtx: TaskDetailsContext = {
    prompt: args.prompt,
    description: args.description,
    cwd: args.cwd,
    workerTools: args.workerTools,
    ...(args.resolvedModel !== undefined ? { resolvedModel: args.resolvedModel } : {}),
    ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
  };
  const details = buildDetails(synthetic, detailsCtx, args.status);
  if (args.spawnError !== undefined) details.spawnError = args.spawnError;
  return {
    content: [{ type: "text", text: args.content }],
    details,
  };
}

function buildResolverFailureContent(invocation: MmrSubagentInvocation): string {
  if (invocation.ok) return "";
  switch (invocation.code) {
    case "tools.empty":
      return `Task worker has no available tools after deny + registered intersection: ${invocation.message}`;
    case "prompt-base.unresolved":
      return `Task worker requires a Task-enabled parent mode: ${invocation.message}`;
    case "model.no-route":
      return `Task worker could not resolve a model route: ${invocation.message}`;
    default:
      return `Task worker could not be prepared: ${invocation.message}`;
  }
}

export function createTaskTool(deps: TaskToolDeps = {}): ToolDefinition {
  if (deps.runner && deps.runWorker) {
    // eslint-disable-next-line no-console
    console.warn(
      "createTaskTool: both runner and runWorker were provided; the runner takes precedence and runWorker is ignored.",
    );
  }
  const runner: MmrSubagentRunner = deps.runner
    ?? (deps.runWorker
      ? createMmrSubagentRunnerFromRunWorker(deps.runWorker)
      : createChildCliMmrSubagentRunner());
  const outputByteLimit = deps.outputByteLimit ?? DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT;
  const resolveInvocation = deps.resolveInvocation ?? defaultResolveTaskInvocation;
  return {
    name: TASK_TOOL_NAME,
    label: TASK_TOOL_NAME,
    description: TASK_DESCRIPTION,
    promptSnippet: TASK_PROMPT_SNIPPET,
    promptGuidelines: [...TASK_PROMPT_GUIDELINES],
    parameters: taskParameters,
    // Workflow worker: a Task child can run bash/edit/write in the
    // workspace, so force sequential scheduling. Read-only research
    // workers (finder, oracle, librarian, cthulu) stay parallel-eligible
    // because independent read-only subagent research is safe to run
    // concurrently.
    executionMode: "sequential" as const,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrSubagentCall(TASK_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrSubagentResult(TASK_TOOL_NAME, result, options, theme, context);
    },
    async execute(
      _toolCallId,
      rawParams,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<TaskDetails>> {
      // Spec §3 + §9.4 rule 1: parameter validation runs before any spawn
      // or resolver call; deterministic error strings flow into details.
      let params: TaskParams;
      try {
        params = coerceTaskParams(rawParams);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return makeFailureResult({
          status: "validation-error",
          prompt: typeof (rawParams as { prompt?: unknown })?.prompt === "string"
            ? (rawParams as { prompt: string }).prompt
            : "",
          description: typeof (rawParams as { description?: unknown })?.description === "string"
            ? (rawParams as { description: string }).description
            : "",
          cwd: resolveCwd(ctx),
          workerTools: TASK_WORKER_TOOLS,
          content: `Task: invalid parameters: ${message}`,
          errorMessage: message,
        });
      }
      const cwd = resolveCwd(ctx);
      const parentMode = resolveParentMode();
      const registeredTools = resolveRegisteredTools(deps.pi);
      // F5: parent and child must read `subagentModelPreferences` through
      // the same code path. Resolve the effective override on every
      // execute so a `/mmr-config` change takes effect on the next
      // invocation without restarting the host.
      const settingsOverride = resolveTaskModelPreferencesOverride(cwd, deps);
      const resolverInput: ResolveTaskInvocationInput = {
        ctx,
        parentMode,
      };
      if (registeredTools !== undefined) resolverInput.registeredTools = registeredTools;
      if (settingsOverride !== undefined) resolverInput.modelPreferencesOverride = settingsOverride;
      const invocation = resolveInvocation(resolverInput);

      const detailsCtx: TaskDetailsContext = {
        prompt: params.prompt,
        description: params.description,
        cwd,
        workerTools: invocation.workerTools,
      };
      if (invocation.ok) {
        detailsCtx.resolvedModel = invocation.modelArg;
        detailsCtx.contextWindow = readMmrModelContextWindow(invocation.selected?.registeredModel);
      }

      // Fail closed when the resolver could not produce a model/tool route.
      // Pi's AgentToolResult has no top-level isError flag; the parent agent
      // infers failure from the Task-prefixed content text plus the
      // status/errorMessage/subagentActivationError fields in details.
      if (!invocation.ok) {
        const status: TaskStatus = invocation.code === "prompt-base.unresolved"
          || invocation.code === "tools.empty"
          ? "worker-error"
          : invocation.code === "model.no-route"
            ? "worker-error"
            : "activation-error";
        return makeFailureResult({
          status,
          prompt: params.prompt,
          description: params.description,
          cwd,
          workerTools: invocation.workerTools,
          content: buildResolverFailureContent(invocation),
          errorMessage: invocation.message,
        });
      }

      // After the resolver succeeds, `invocation.promptBaseMode` is
      // guaranteed to be defined for mode-derived profiles (Task is
      // always mode-derived `from-parent`); fall back to the parent
      // mode snapshot when present, otherwise pin `smart` so prompt
      // assembly always sees a concrete mode key for assembly. The
      // fail-closed path above prevents reaching this with neither.
      const promptParentMode: MmrModeKey =
        invocation.promptBaseMode ?? parentMode ?? "smart";
      const promptInput: TaskWorkerSystemPromptInput = {
        cwd,
        parentMode: promptParentMode,
        activeToolManifest: buildWorkerToolManifest(deps.pi, invocation.workerTools),
        baseSystemPrompt: deps.getBaseSystemPrompt?.() ?? getTaskParentSystemPrompt() ?? "",
        // Forward the resolver's deny-aware, registered-tool intersection
        // so the assembled worker prompt's `Available tools:` block lists
        // exactly the tools the worker will have, not the broader parent
        // active tool set or the profile's intent allowlist.
        workerTools: invocation.workerTools,
      };
      const runnerParentMode = invocation.parentMode ?? parentMode;
      const runnerOptions: MmrSubagentRunOptions = {
        profileName: TASK_SUBAGENT_PROFILE,
        prompt: params.prompt,
        cwd,
        tools: invocation.workerTools,
        model: invocation.modelArg,
        ...(runnerParentMode !== undefined ? { parentMode: runnerParentMode } : {}),
        systemPrompt: deps.buildSystemPrompt
          ? deps.buildSystemPrompt(promptInput)
          : buildTaskWorkerSystemPrompt(promptInput),
        // Task uses exact system-prompt replacement so the assembled worker
        // prompt is the only model-visible system prompt (no duplicate
        // Available tools: block, no inherited coding-assistant head).
        systemPromptDelivery: "replace",
        signal,
        outputByteLimit,
        onProgress: onUpdate
          ? (snapshot) => {
              onUpdate({
                content: [{ type: "text", text: progressContent(snapshot) }],
                details: buildProgressDetails(snapshot, detailsCtx),
              });
            }
          : undefined,
      };

      const effectiveRunner = deps.runner
        ? deps.runner
        : deps.runWorker
          ? createMmrSubagentRunnerFromRunWorker(deps.runWorker, deps.runnerDeps)
          : deps.runnerDeps
            ? createChildCliMmrSubagentRunner(deps.runnerDeps)
            : runner;
      // Session-scoped model fallback (issue #9). The closure re-resolves
      // the route under an applied override so parent spawn and child
      // activation agree, and forwards the override to the child via the
      // runner env channel. Task is mode-derived, so the fallback scope key
      // includes the parent mode.
      const runWorkerOnce = async (
        runArgs: { override?: readonly MmrModelPreference[] },
      ): Promise<{ result: MmrWorkerResult; route: string | undefined }> => {
        let options = runnerOptions;
        let route = invocation.modelArg;
        if (runArgs.override) {
          const overrideInput: ResolveTaskInvocationInput = { ctx, parentMode };
          if (registeredTools !== undefined) overrideInput.registeredTools = registeredTools;
          overrideInput.modelPreferencesOverride = runArgs.override;
          const overrideInvocation = resolveInvocation(overrideInput);
          if (overrideInvocation.ok) {
            route = overrideInvocation.modelArg;
            options = {
              ...runnerOptions,
              model: overrideInvocation.modelArg,
              tools: overrideInvocation.workerTools,
              modelPreferencesOverride: runArgs.override,
            };
          }
          // If the override does not resolve (rare — the chosen candidate
          // was authenticated), fall through to the original route WITHOUT
          // forwarding the override env, so parent --model and child
          // activation still agree rather than guaranteeing a mismatch.
        }
        const runResult = await effectiveRunner.run(options);
        return { result: runResult, route };
      };

      // Spec §9.4 rule 2: runner throws (spawn failures) before/while
      // spawning are mapped to status `spawn-error`.
      let result: MmrWorkerResult;
      try {
        const outcome = await runMmrWorkerWithModelFallback({
          ctx,
          sessionId: readMmrWorkerSessionId(ctx),
          registry: ctx.modelRegistry as unknown as MmrWorkerFallbackRegistry,
          toolName: TASK_TOOL_NAME,
          profileName: TASK_SUBAGENT_PROFILE,
          ...(parentMode !== undefined ? { parentMode } : {}),
          // Rank/suggest candidates from the parent mode's chain when the
          // profile declares mode-specific preferences (e.g. rush uses a
          // cheaper chain), falling back to the default chain otherwise.
          candidatePreferences:
            (parentMode !== undefined ? requireTaskProfile().modeModelPreferences?.[parentMode] : undefined)
            ?? requireTaskProfile().modelPreferences,
          classifyOutcome: (candidate) => classifyMmrWorkerOutcome(candidate, { partialOutputPolicy: "prefer-usable-output" }),
          run: runWorkerOnce,
        });
        result = outcome.result;
        if (outcome.route !== undefined) detailsCtx.resolvedModel = outcome.route;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failureDetails = makeFailureResult({
          status: "spawn-error",
          prompt: params.prompt,
          description: params.description,
          cwd,
          workerTools: invocation.workerTools,
          content: `Task: worker failed to spawn: ${message}`,
          errorMessage: message,
          resolvedModel: invocation.modelArg,
          contextWindow: detailsCtx.contextWindow,
        });
        return failureDetails;
      }
      return {
        content: [{ type: "text", text: buildFinalContent(result) }],
        details: buildDetails(result, detailsCtx),
      };
    },
  } satisfies ToolDefinition;
}

export function registerTaskTool(pi: ExtensionAPI, deps: TaskToolDeps = {}): ToolDefinition {
  const definition = createTaskTool({ ...deps, pi });
  registerMmrOwnedTool(TASK_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
