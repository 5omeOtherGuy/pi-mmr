import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MMR_BACKGROUND_RUN_PARAMETER_FIELDS } from "./background-dispatch.js";
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
import {
  isMmrCapabilityProfileKey,
  type MmrCapabilityProfileKey,
} from "../mmr-core/subagent-tool-policy.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import type { MmrModelRegistryLike, MmrRegisteredModelLike } from "../mmr-core/model-resolver.js";
import { loadMmrCoreSettings } from "../mmr-core/settings.js";
import { TASK_BACKGROUND_GUIDANCE } from "./tool-guidance.js";
import { buildWorkerToolManifest, type ToolHostLike } from "./worker-host.js";
import { readMmrModelContextWindow } from "./worker-model-metadata.js";
import {
  createChildCliMmrSubagentRunner,
  createMmrSubagentRunnerFromRunWorker,
  type MmrSubagentRunner,
  type MmrWorkerRunnerDeps,
  runMmrSubagentWorker,
} from "./runner.js";
import {
  TASK_PROGRESS_PLACEHOLDER,
  TASK_SUBAGENT_PROFILE,
  buildResolverFailureContent,
  buildTaskDetails,
  buildTaskFinalContent,
  buildTaskProgressDetails,
  makeFailureResult,
  type TaskDetails,
  type TaskDetailsContext,
  type TaskStatus,
} from "./task-result.js";
import {
  createWorkerRunPreparer,
  createWorkerTool,
  type MmrWorkerRunPreparer,
  type MmrWorkerToolRunContext,
  type MmrWorkerToolSpec,
} from "./worker-tool-factory.js";

// Re-export the Task result/outcome shaping surface from its new home
// (`task-result.ts`) so this entry file remains the stable public surface.
export {
  TASK_PROGRESS_PLACEHOLDER,
  TASK_SUBAGENT_PROFILE,
  buildSpawnErrorWorkerResult,
  buildTaskFinalResult,
  buildTaskProgressResult,
  classifyTaskOutcome,
  hasUsableTaskFinalText,
} from "./task-result.js";
export type {
  TaskDetails,
  TaskDetailsContext,
  TaskOutcomeInput,
  TaskStatus,
} from "./task-result.js";

export const TASK_TOOL_NAME = "Task";

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
  'Task is blocking. For multiple or parallel Task workers, prefer start_task (agent: "Task") so they run in the background while you keep working; reserve back-to-back blocking Task calls for the rare case where you must have every result before the next step, and keep code-writing single-threaded unless write targets are clearly disjoint.',
  "Use capabilityProfile (read-only or read-write) only to narrow a Task worker's tool surface; omit it to preserve the default Task behavior.",
  "When the worker finishes, inspect its diff or evidence, run any combined validation, and summarize the user-relevant result yourself.",
] as const;

export const TASK_DESCRIPTION = [
  "Perform a bounded sub-task in a worker process derived from the active MMR subagent framework.",
  "",
  "Use Task when a scoped implementation, investigation, repair, UI check, or review would produce enough intermediate output that it is better handled outside the parent turn.",
  "",
  TASK_BACKGROUND_GUIDANCE,
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
  '- For background or fan-out runs, use start_task (agent: "Task"); blocking Task is not the parallel mechanism.',
  "- Optionally set capabilityProfile (read-only or read-write) to narrow the worker's tools; leaving it unset preserves the default Task surface.",
].join("\n");

const TASK_CAPABILITY_PROFILE_SCHEMA = Type.Union(
  [
    Type.Literal("read-only"),
    Type.Literal("read-write"),
  ],
  {
    description:
      "Optional capability profile that narrows this Task worker's tools. Unset preserves the default Task tool surface; read-only removes file-edit and shell tools (read/search/web/skill/task_list only); read-write keeps file edits but removes shell. Narrowing only; it never grants tools the default Task surface lacks.",
  },
);

export const TASK_PARAMETERS_SCHEMA = Type.Object(
  {
    prompt: Type.String({
      description: "The bounded task prompt for the worker. Include goal, scope, context, constraints, validation, and expected result shape.",
    }),
    description: Type.String({
      description: "Short display label for the worker task.",
    }),
    capabilityProfile: Type.Optional(TASK_CAPABILITY_PROFILE_SCHEMA),
    ...MMR_BACKGROUND_RUN_PARAMETER_FIELDS,
  },
  { additionalProperties: false },
);

export const taskParameters = TASK_PARAMETERS_SCHEMA;

export type TaskParams = Static<typeof TASK_PARAMETERS_SCHEMA>;

/** Caps from spec §9.5. Validation rejects values that exceed these caps. */
export const TASK_PROMPT_MAX_BYTES = 8 * 1024;
export const TASK_DESCRIPTION_MAX_BYTES = 512;

let latestParentSystemPrompt: string | undefined;
let latestParentSystemPromptOptions: MmrTaskParentPromptOptions | undefined;

/**
 * Minimal structural view of Pi's `BuildSystemPromptOptions` retained for the
 * most recent parent turn. Captured alongside the parent system-prompt string
 * so Task-worker diagnostics can classify the parent surface (custom prompt vs
 * locked-mode head, and the parent's rendered tool selection). Metadata only —
 * never used to rebuild a prompt.
 */
export interface MmrTaskParentPromptOptions {
  selectedTools?: string[];
  customPrompt?: string;
}

function readParentPromptOptions(value: unknown): MmrTaskParentPromptOptions | undefined {
  if (!isRecord(value)) return undefined;
  const result: MmrTaskParentPromptOptions = {};
  if (Array.isArray(value.selectedTools)) {
    // Preserve an empty selection (`[]`) as distinct from "not supplied": Pi
    // explicitly rendering zero tools is meaningful, so callers can tell an
    // empty selection apart from a missing one.
    result.selectedTools = value.selectedTools.filter((name): name is string => typeof name === "string");
  }
  if (typeof value.customPrompt === "string" && value.customPrompt.length > 0) {
    result.customPrompt = value.customPrompt;
  }
  return result.selectedTools !== undefined || result.customPrompt !== undefined ? result : undefined;
}

/**
 * Capture the parent turn's system prompt and its structured options together.
 * The options are only updated when a non-empty prompt string is seen, so the
 * stored options always correspond to the stored prompt (never desynced from a
 * stale earlier turn).
 */
export function captureTaskParentPrompt(systemPrompt: unknown, systemPromptOptions: unknown): void {
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    latestParentSystemPrompt = systemPrompt;
    latestParentSystemPromptOptions = readParentPromptOptions(systemPromptOptions);
  }
}

export function getTaskParentSystemPrompt(): string | undefined {
  return latestParentSystemPrompt;
}

export function getTaskParentSystemPromptOptions(): MmrTaskParentPromptOptions | undefined {
  return latestParentSystemPromptOptions;
}

export function registerTaskParentPromptCapture(pi: Pick<ExtensionAPI, "on">): void {
  pi.on("before_agent_start", (event) => {
    if (getMmrSubagentState()) return;
    const e = event as { systemPrompt?: unknown; systemPromptOptions?: unknown };
    captureTaskParentPrompt(e.systemPrompt, e.systemPromptOptions);
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

const TASK_KNOWN_PARAM_KEYS: ReadonlySet<string> = new Set(["prompt", "description", "capabilityProfile"]);
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
  if (
    obj.capabilityProfile !== undefined
    && !isMmrCapabilityProfileKey(obj.capabilityProfile)
  ) {
    throw new TaskParamsError("Task.capabilityProfile must be one of: read-only, read-write.");
  }
  return {
    prompt: obj.prompt,
    description: obj.description,
    // Safe assertion: the guard above rejected any non-public value, so a
    // defined capabilityProfile here is read-only | read-write.
    ...(obj.capabilityProfile !== undefined
      ? { capabilityProfile: obj.capabilityProfile as TaskParams["capabilityProfile"] }
      : {}),
  };
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
  capabilityProfile?: MmrCapabilityProfileKey;
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
    ...(input.capabilityProfile !== undefined ? { capabilityProfile: input.capabilityProfile } : {}),
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

/**
 * Resolve the effective {@link MmrSubagentRunner} from the Task deps,
 * mirroring the historical per-execute precedence: explicit `runner`
 * wins, then a `runWorker` adapter (with optional `runnerDeps`), then a
 * child-CLI runner (with optional `runnerDeps`), otherwise a default
 * child-CLI runner.
 */
export function resolveTaskRunner(deps: TaskToolDeps): MmrSubagentRunner {
  if (deps.runner) return deps.runner;
  if (deps.runWorker) return createMmrSubagentRunnerFromRunWorker(deps.runWorker, deps.runnerDeps);
  if (deps.runnerDeps) return createChildCliMmrSubagentRunner(deps.runnerDeps);
  return createChildCliMmrSubagentRunner();
}

interface TaskRunData {
  /** Parent mode snapshot captured once per execute (fallback scope key + candidate ranking + prompt base). */
  parentMode: MmrModeKey | undefined;
}

/**
 * One spec + factory-options pair shared by the blocking tool definition and
 * the background run preparer, so both surfaces are generated from the same
 * declarative source. This replaces the former `prepareTaskRun` parallel
 * path: the async background surface now prepares Task runs through the
 * factory exactly like the blocking tool.
 */
function taskToolBlueprint(deps: TaskToolDeps): {
  spec: MmrWorkerToolSpec<TaskParams, TaskDetails, TaskRunData>;
  factoryOptions: Parameters<typeof createWorkerTool<TaskParams, TaskDetails, TaskRunData>>[2];
} {
  if (deps.runner && deps.runWorker) {
    // eslint-disable-next-line no-console
    console.warn(
      "createTaskTool: both runner and runWorker were provided; the runner takes precedence and runWorker is ignored.",
    );
  }
  const resolveInvocation = deps.resolveInvocation ?? defaultResolveTaskInvocation;
  const detailsCtxOf = (
    runCtx: MmrWorkerToolRunContext<TaskParams, TaskRunData>,
  ): TaskDetailsContext => ({
    prompt: runCtx.params.prompt,
    description: runCtx.params.description,
    cwd: runCtx.cwd,
    workerTools: runCtx.workerTools,
    ...(runCtx.resolvedModel !== undefined ? { resolvedModel: runCtx.resolvedModel } : {}),
    ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
  });
  return {
    spec: {
      toolName: TASK_TOOL_NAME,
      profileName: TASK_SUBAGENT_PROFILE,
      description: TASK_DESCRIPTION,
      promptSnippet: TASK_PROMPT_SNIPPET,
      promptGuidelines: TASK_PROMPT_GUIDELINES,
      parameters: taskParameters,
      // Workflow worker: a Task child can run bash/edit/write in the
      // workspace, so force sequential scheduling. Read-only research
      // workers (finder, oracle, librarian) stay parallel-eligible
      // because independent read-only subagent research is safe to run
      // concurrently.
      executionMode: "sequential",
      progressPlaceholder: TASK_PROGRESS_PLACEHOLDER,
      backgroundCapable: true,
      coerceParams: coerceTaskParams,
      paramsFailure: (message, raw, cwd) =>
        makeFailureResult({
          status: "validation-error",
          prompt: typeof (raw as { prompt?: unknown })?.prompt === "string"
            ? (raw as { prompt: string }).prompt
            : "",
          description: typeof (raw as { description?: unknown })?.description === "string"
            ? (raw as { description: string }).description
            : "",
          cwd,
          workerTools: TASK_WORKER_TOOLS,
          content: `Task: invalid parameters: ${message}`,
          errorMessage: message,
        }),
      computeRunData: () => ({ parentMode: resolveParentMode() }),
      resolveInvocation: (input, params, runData) => {
        const resolverInput: ResolveTaskInvocationInput = {
          ctx: input.ctx,
          parentMode: runData.parentMode,
        };
        if (input.registeredTools !== undefined) resolverInput.registeredTools = input.registeredTools;
        if (input.modelPreferencesOverride !== undefined) {
          resolverInput.modelPreferencesOverride = input.modelPreferencesOverride;
        }
        if (params.capabilityProfile !== undefined) resolverInput.capabilityProfile = params.capabilityProfile;
        return resolveInvocation(resolverInput);
      },
      resolutionFailure: "fail-closed",
      // Fail closed when the resolver could not produce a model/tool
      // route. Pi's AgentToolResult has no top-level isError flag; the
      // parent agent infers failure from the Task-prefixed content text
      // plus the status/errorMessage fields in details.
      resolutionFailureResult: (invocation, params, cwd) => {
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
      },
      mirrorWorkerTools: true,
      detailsWorkerTools: "invocation",
      workerToolsConstant: TASK_WORKER_TOOLS,
      progressModelBinding: "initial",
      buildUserPrompt: (params) => params.prompt,
      assembleSystemPrompt: (cwd, workerTools, runCtx) => {
        // After a successful resolution, `invocation.promptBaseMode` is
        // defined for mode-derived profiles (Task is always mode-derived
        // `from-parent`); fall back to the parent mode snapshot when
        // present, otherwise pin `smart` so prompt assembly always sees
        // a concrete mode key.
        const promptParentMode: MmrModeKey =
          runCtx.invocation?.promptBaseMode ?? runCtx.runData.parentMode ?? "smart";
        const promptInput: TaskWorkerSystemPromptInput = {
          cwd,
          parentMode: promptParentMode,
          activeToolManifest: buildWorkerToolManifest(deps.pi, workerTools ?? []),
          baseSystemPrompt: deps.getBaseSystemPrompt?.() ?? getTaskParentSystemPrompt() ?? "",
          // Forward the resolver's deny-aware, registered-tool
          // intersection so the assembled worker prompt's `Available
          // tools:` block lists exactly the tools the worker will have.
          ...(workerTools !== undefined ? { workerTools } : {}),
        };
        return deps.buildSystemPrompt
          ? deps.buildSystemPrompt(promptInput)
          : buildTaskWorkerSystemPrompt(promptInput);
      },
      resolveContextWindow: (_ctx, _model, invocation) =>
        readMmrModelContextWindow(invocation?.selected?.registeredModel),
      extraRunnerOptions: (runCtx) => {
        const runnerParentMode = runCtx.invocation?.parentMode ?? runCtx.runData.parentMode;
        return {
          ...(runnerParentMode !== undefined ? { parentMode: runnerParentMode } : {}),
          // Task uses exact system-prompt replacement so the assembled
          // worker prompt is the only model-visible system prompt.
          systemPromptDelivery: "replace",
        };
      },
      // Rank/suggest fallback candidates from the parent mode's chain
      // when the profile declares mode-specific preferences (e.g. rush
      // uses a cheaper chain), falling back to the default chain.
      candidatePreferences: (runCtx) =>
        (runCtx.runData.parentMode !== undefined
          ? requireTaskProfile().modeModelPreferences?.[runCtx.runData.parentMode]
          : undefined)
        ?? requireTaskProfile().modelPreferences,
      fallbackParentMode: (runCtx) => runCtx.runData.parentMode,
      buildProgressDetails: (snapshot, runCtx) => buildTaskProgressDetails(snapshot, detailsCtxOf(runCtx)),
      buildFinalDetails: (result, runCtx) => buildTaskDetails(result, detailsCtxOf(runCtx)),
      buildFinalContent: (result) => buildTaskFinalContent(result),
      // Spec §9.4 rule 2: runner throws (spawn failures) before/while
      // spawning are mapped to status `spawn-error`.
      mapRunError: (err, runCtx) => {
        const message = err instanceof Error ? err.message : String(err);
        return makeFailureResult({
          status: "spawn-error",
          prompt: runCtx.params.prompt,
          description: runCtx.params.description,
          cwd: runCtx.cwd,
          workerTools: runCtx.workerTools,
          content: `Task: worker failed to spawn: ${message}`,
          errorMessage: message,
          ...(runCtx.resolvedModel !== undefined ? { resolvedModel: runCtx.resolvedModel } : {}),
          ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
        });
      },
      describeRun: (params) => ({
        description: params.description,
        displayPrompt: params.prompt,
      }),
    },
    factoryOptions: {
      effectiveRunner: resolveTaskRunner(deps),
      resolveModelPreferencesOverride: (cwd) => resolveTaskModelPreferencesOverride(cwd, deps),
    },
  };
}

export function createTaskTool(deps: TaskToolDeps = {}): ToolDefinition {
  const { spec, factoryOptions } = taskToolBlueprint(deps);
  return createWorkerTool(spec, deps, factoryOptions);
}

/** Background-surface seam: prepare a registry-ready Task run from raw params. */
export function createTaskRunPreparer(deps: TaskToolDeps = {}): MmrWorkerRunPreparer<TaskDetails> {
  const { spec, factoryOptions } = taskToolBlueprint(deps);
  return createWorkerRunPreparer(spec, deps, factoryOptions);
}

export function registerTaskTool(pi: ExtensionAPI, deps: TaskToolDeps = {}): ToolDefinition {
  const definition = createTaskTool({ ...deps, pi });
  registerMmrOwnedTool(TASK_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
