import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MMR_BACKGROUND_RUN_PARAMETER_FIELDS } from "./background-dispatch.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
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
import { loadMmrCoreSettings, type LoadedMmrCoreSettings } from "../mmr-core/settings.js";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { CODE_REVIEW_BACKGROUND_GUIDANCE } from "../mmr-core/worker-tool-guidance.js";
import { buildCodeReviewWorkerSystemPrompt as buildCodeReviewWorkerSystemPromptFromPrompts } from "./prompts.js";
import { resolveEffectiveRunner } from "./worker-fallback-run.js";
import {
  clipMmrWorkerDescription,
  createWorkerRunPreparer,
  createWorkerTool,
  resolveWorkerModelPreferencesOverride,
  type MmrWorkerRunPreparer,
  type MmrWorkerToolResolveInput,
  type MmrWorkerToolSpec,
} from "./worker-tool-factory.js";
import { type ToolHostLike } from "./worker-host.js";
import {
  resolveCtxMmrModelRegistry,
  resolveMmrWorkerModelContextWindowFromCtx,
} from "./worker-model-metadata.js";
import {
  classifyMmrWorkerOutcomeForProfile,
  type MmrSpawnedSubagentWorkerDetailsBase,
  type MmrWorkerOutcomeStatus,
  type MmrSubagentRunner,
  type MmrWorkerProgressSnapshot,
  type MmrWorkerResult,
  type MmrWorkerRunnerDeps,
  runMmrSubagentWorker,
} from "./runner.js";
import {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
} from "./worker-result-shaping.js";

export const CODE_REVIEW_TOOL_NAME = "code_review";

export const CODE_REVIEW_SUBAGENT_PROFILE = "code-review";

function requireCodeReviewProfile() {
  const profile = getMmrSubagentProfile(CODE_REVIEW_SUBAGENT_PROFILE);
  if (!profile) {
    throw new Error(
      `mmr-core does not expose a "${CODE_REVIEW_SUBAGENT_PROFILE}" subagent profile; code_review cannot run without it.`,
    );
  }
  return profile;
}

/**
 * Read-only review tool allowlist passed through `pi --tools` to the
 * isolated review subprocess: local reads/searches plus bash for the
 * whitelisted merge-base git diff commands. The worker prompt forbids
 * edits and git state mutation.
 *
 * Source of truth: the `code-review` subagent profile in mmr-core. This
 * export is a derived constant for callers and tests; the profile remains
 * authoritative at runtime.
 */
export const CODE_REVIEW_WORKER_TOOLS: readonly string[] = Object.freeze([
  ...requireCodeReviewProfile().tools,
]);

export const CODE_REVIEW_PROMPT_SNIPPET =
  "Run an expert review of a code diff (uncommitted work, branch or staged changes) and return prioritized findings";

/**
 * Single routing guideline for Pi's `Guidelines:` block. The full when/how
 * guidance lives only in {@link CODE_REVIEW_DESCRIPTION} (the schema the
 * model already receives); cross-worker policy renders once in the
 * `## Using workers` block (`mmr-core/worker-tool-guidance.ts`).
 */
export const CODE_REVIEW_PROMPT_GUIDELINES: readonly string[] = [
  "Use code_review when a unit of work is complete or the user asks for a review of changes: pass a natural-language description of which diff to review (the worker computes and reads the diff itself). The reviewer is read-only and reports findings; acting on them stays with you.",
];

export const CODE_REVIEW_DESCRIPTION = [
  "Review code changes, diffs, outstanding changes, or modified files: an independent expert reviewer reads the diff in a fresh context and returns a prioritized findings report (severity, file, line range, suggested fix).",
  "",
  CODE_REVIEW_BACKGROUND_GUIDANCE,
  "",
  "It takes a description of the diff or code change that can be used to generate the full diff, which is then reviewed. Do not run git diff or any other tool to generate the diff yourself; pass a natural language description of how to compute the diff in diff_description (it may name a git command or describe the changes, e.g. \"all uncommitted changes\" or \"the changes on this branch since diverging from the upstream default branch\").",
  "",
  "WHEN TO USE THIS TOOL:",
  "- A coherent unit of work is complete and you want an independent review before finalizing",
  "- The user asks to review changes, check code quality, or analyze uncommitted work",
  "- You want a second model to catch bugs, hackiness, or abstraction problems in a diff",
  "",
  "WHEN NOT TO USE THIS TOOL:",
  "- Reviewing code that is not a change — read the files directly instead",
  "- Generating or applying fixes — the reviewer is read-only and only reports findings",
  "- Very large diffs (more than ~100 changed files or ~10,000 lines); the reviewer aborts those with a single critical finding",
  "",
  "USAGE GUIDELINES:",
  "1. Describe which diff to review, not its contents; the worker computes and reads the diff itself.",
  "2. Use files to focus the review on specific paths and instructions to set emphasis (e.g. \"focus on concurrency\").",
  "3. Relay the important findings to the user and act on the ones you agree with; the reviewer never edits files.",
].join("\n");

export const CODE_REVIEW_PARAMETERS_SCHEMA = Type.Object(
  {
    diff_description: Type.String({
      description:
        "A description of the diff or code change that can be used to generate the full diff. This can include a git command to generate the diff or a description of the change which the reviewer turns into the right git command itself.",
    }),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Specific files to focus the review on. If empty, all changed files covered by the diff description are reviewed.",
      }),
    ),
    instructions: Type.Optional(
      Type.String({
        description: "Additional instructions to guide the review (e.g. areas of emphasis).",
      }),
    ),
    ...MMR_BACKGROUND_RUN_PARAMETER_FIELDS,
  },
  { additionalProperties: false },
);

export const codeReviewParameters = CODE_REVIEW_PARAMETERS_SCHEMA;

export type CodeReviewParams = Static<typeof CODE_REVIEW_PARAMETERS_SCHEMA>;

export interface CodeReviewDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: "mmr-subagents.code_review";
  // Final-run outcome from the shared classifier. The renderer reads this
  // first, so a successful run that merely preserved a non-fatal provider
  // `errorMessage` still renders as completed instead of failed.
  status?: MmrWorkerOutcomeStatus;
}

/** Compact "thinking" status surfaced to the model before the worker finishes. */
export const CODE_REVIEW_PROGRESS_PLACEHOLDER = "code_review: reviewing changes…";

/**
 * Build the code-review worker system prompt. Re-exported here for
 * symmetry with the other worker modules; the canonical owner is
 * `mmr-workers/prompts.ts`, which also registers the code-review builder
 * against mmr-core's prompt-assembly registry.
 */
export function buildCodeReviewWorkerSystemPrompt(cwd: string): string {
  return buildCodeReviewWorkerSystemPromptFromPrompts(cwd);
}

/**
 * Build the worker task text: the diff description verbatim, then the
 * optional files focus and extra instructions. The report format is part
 * of the system prompt, not the task text.
 */
export function buildCodeReviewUserPrompt(params: {
  diff_description: string;
  files?: readonly string[];
  instructions?: string;
}): string {
  const parts = [`Review the following diff: ${params.diff_description}`];
  const files = (params.files ?? []).map((file) => file.trim()).filter((file) => file.length > 0);
  if (files.length > 0) {
    parts.push(`Focus the review on these files:\n${files.map((file) => `- ${file}`).join("\n")}`);
  }
  const instructions = params.instructions?.trim() ?? "";
  if (instructions.length > 0) {
    parts.push(instructions);
  }
  return parts.join("\n\n");
}

function coerceCodeReviewParams(raw: unknown): CodeReviewParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("code_review expects an object with a `diff_description` field.");
  }
  const params = checkMmrToolParams(CODE_REVIEW_TOOL_NAME, CODE_REVIEW_PARAMETERS_SCHEMA, raw);
  if (params.diff_description.trim().length === 0) {
    throw new Error("code_review.diff_description is required and must be a non-empty string.");
  }
  return params;
}

export interface CodeReviewToolDeps {
  /**
   * Generic subagent runner. When set, code_review uses this instead of
   * the default child-CLI runner. Preferred entry point for new callers.
   */
  runner?: MmrSubagentRunner;
  /**
   * Legacy seam: run the underlying Pi subagent worker directly. Retained
   * for parity with the other worker tools' test seams. Prefer
   * {@link CodeReviewToolDeps.runner}; when both are set, `runner` wins.
   */
  runWorker?: typeof runMmrSubagentWorker;
  /**
   * Override the ordered worker-model preference list. Wins over both the
   * settings-driven `subagentModelPreferences.code-review` block and the
   * profile defaults.
   */
  modelPreferences?: readonly MmrModelPreference[];
  /**
   * Settings-driven override: wins over the profile defaults but loses to
   * an explicit `modelPreferences`. When omitted, `execute()` reads
   * `loadMmrCoreSettings(cwd).settings.subagentModelPreferences["code-review"]`
   * on every invocation so a `/mmr-config` update takes effect on the
   * next call, matching the child activation path.
   */
  subagentModelPreferencesOverride?: readonly MmrModelPreference[];
  /** Settings loader seam. Defaults to `loadMmrCoreSettings(cwd)`. */
  loadSubagentModelPreferences?: (cwd: string) =>
    | Pick<LoadedMmrCoreSettings["settings"], "subagentModelPreferences">
    | undefined;
  /** Override the worker output byte cap. */
  outputByteLimit?: number;
  /** Override prompt text while still flowing through the subagent surface API. Tests inject deterministic text. */
  buildSystemPrompt?: (cwd: string) => string;
  /** Pi host, captured by registerCodeReviewTool so child startup can keep provider/extension paths. */
  pi?: ToolHostLike;
  /** Forwarded to the underlying runner (custom spawner / invocation resolver seams). */
  runnerDeps?: MmrWorkerRunnerDeps;
}

function buildProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  resolvedModel: string | undefined,
  cwd: string,
  contextWindow: number | undefined,
): CodeReviewDetails {
  const base = buildSpawnedProgressDetailsBase({
    snapshot,
    cwd,
    workerTools: CODE_REVIEW_WORKER_TOOLS,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  return { worker: "mmr-subagents.code_review", ...base };
}

function buildDetails(
  result: MmrWorkerResult,
  resolvedModel: string | undefined,
  cwd: string,
  contextWindow: number | undefined,
): CodeReviewDetails {
  const base = buildSpawnedFinalDetailsBase({
    result,
    cwd,
    workerTools: CODE_REVIEW_WORKER_TOOLS,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  const status = classifyMmrWorkerOutcomeForProfile(result, requireCodeReviewProfile());
  return { worker: "mmr-subagents.code_review", status, ...base };
}

function buildFinalContent(result: MmrWorkerResult): string {
  // Failure-state precedence is owned by the shared worker-outcome
  // classifier under the code-review profile's fail-on-nonzero policy;
  // the messages below mirror that precedence with code_review phrasing.
  const outcome = classifyMmrWorkerOutcomeForProfile(result, requireCodeReviewProfile());
  if (outcome === "spawn-error") {
    const reason = result.spawnError ?? result.errorMessage ?? "unknown spawn error";
    return `code_review: worker spawn failed: ${reason}`;
  }
  if (outcome === "activation-error") {
    return `code_review: subagent activation failed: ${result.subagentActivationError}`;
  }
  if (outcome === "aborted") {
    return "code_review: the review was cancelled before producing a report.";
  }
  if (outcome === "worker-error") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detailText = tail.length > 0 ? tail : (result.errorMessage ?? "");
    const detail = detailText.length > 0 ? `\n\n${detailText}` : "";
    return `code_review: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  if (outcome === "no-agent-start") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `code_review: worker exited before the agent loop started. The prompt was not processed by the worker model; another Pi extension's input handler likely consumed it. Check stderr for extension diagnostics.${detail}`;
  }
  if (outcome === "success") {
    return result.truncatedFinalOutput || result.finalOutput;
  }
  // empty-output
  if (result.errorMessage && result.errorMessage.length > 0) {
    return `code_review: worker reported an error: ${result.errorMessage}`;
  }
  return "code_review: the review produced no report. Check the diff description and try again.";
}

function assembleCodeReviewSystemPrompt(
  cwd: string,
  buildSystemPrompt: ((cwd: string) => string) | undefined,
): string {
  const profile = requireCodeReviewProfile();
  if (!buildSystemPrompt) {
    return assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd,
    }).systemPrompt;
  }

  const previous = getMmrSubagentPromptBuilder(profile.promptBuilder);
  registerMmrSubagentPromptBuilder(profile.promptBuilder, ({ cwd: builderCwd }) => buildSystemPrompt(builderCwd));
  try {
    return assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd,
    }).systemPrompt;
  } finally {
    if (previous) registerMmrSubagentPromptBuilder(profile.promptBuilder, previous);
    else unregisterMmrSubagentPromptBuilder(profile.promptBuilder);
  }
}

/**
 * Default parent-side invocation resolution: the shared
 * `resolveMmrSubagentInvocation` against `ctx.modelRegistry`. The
 * code-review spec runs in degrade mode (the finder contract): a
 * resolution failure means "spawn with no explicit --model and let the
 * child resolve the route" rather than a pre-spawn error.
 */
function resolveCodeReviewInvocation(
  input: MmrWorkerToolResolveInput,
): MmrSubagentInvocation {
  const profile = requireCodeReviewProfile();
  const registry = resolveCtxMmrModelRegistry(input.ctx);
  if (!registry) {
    return {
      ok: false,
      profile,
      code: "model.no-route",
      message: "code_review could not resolve a model registry from the extension context; expected ctx.modelRegistry to expose getAll/find.",
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
    ...(input.modelPreferencesOverride !== undefined
      ? { modelPreferencesOverride: input.modelPreferencesOverride }
      : {}),
  });
}

/**
 * One spec + factory-options pair shared by the blocking tool definition and
 * the background run preparer, so both surfaces are generated from the same
 * declarative source.
 */
function codeReviewToolBlueprint(deps: CodeReviewToolDeps): {
  spec: MmrWorkerToolSpec<CodeReviewParams, CodeReviewDetails>;
  factoryOptions: Parameters<typeof createWorkerTool<CodeReviewParams, CodeReviewDetails>>[2];
} {
  const effectiveRunner = resolveEffectiveRunner(deps, "createCodeReviewTool");
  return {
    spec: {
      toolName: CODE_REVIEW_TOOL_NAME,
      profileName: CODE_REVIEW_SUBAGENT_PROFILE,
      description: CODE_REVIEW_DESCRIPTION,
      promptSnippet: CODE_REVIEW_PROMPT_SNIPPET,
      promptGuidelines: CODE_REVIEW_PROMPT_GUIDELINES,
      parameters: codeReviewParameters,
      progressPlaceholder: CODE_REVIEW_PROGRESS_PLACEHOLDER,
      // Invalid params propagate as a thrown error to the Pi tool host
      // (the finder/oracle contract), so no paramsFailure here.
      backgroundCapable: true,
      coerceParams: coerceCodeReviewParams,
      resolveInvocation: resolveCodeReviewInvocation,
      resolutionFailure: "degrade",
      // The child Pi process computes its own workerTools via
      // `resolveMmrSubagentInvocation` against its registered-tool
      // inventory; the profile lists only Pi built-ins, so skipping
      // explicit --tools keeps parent and child agreement (the finder
      // rationale).
      mirrorWorkerTools: false,
      detailsWorkerTools: "profile-constant",
      workerToolsConstant: CODE_REVIEW_WORKER_TOOLS,
      progressModelBinding: "per-attempt",
      buildUserPrompt: (params) => buildCodeReviewUserPrompt(params),
      assembleSystemPrompt: (cwd) => assembleCodeReviewSystemPrompt(cwd, deps.buildSystemPrompt),
      resolveContextWindow: (ctx, model) => resolveMmrWorkerModelContextWindowFromCtx(ctx, model),
      candidatePreferences: () => requireCodeReviewProfile().modelPreferences,
      buildProgressDetails: (snapshot, runCtx) =>
        buildProgressDetails(snapshot, runCtx.resolvedModel, runCtx.cwd, runCtx.contextWindow),
      buildFinalDetails: (result, runCtx) =>
        buildDetails(result, runCtx.resolvedModel, runCtx.cwd, runCtx.contextWindow),
      buildFinalContent: (result) => buildFinalContent(result),
      describeRun: (params) => ({
        description: `code_review: ${clipMmrWorkerDescription(params.diff_description)}`,
        displayPrompt: params.diff_description,
      }),
    },
    factoryOptions: {
      effectiveRunner,
      resolveModelPreferencesOverride: (cwd) =>
        resolveWorkerModelPreferencesOverride({
          profileName: CODE_REVIEW_SUBAGENT_PROFILE,
          cwd,
          ...(deps.modelPreferences !== undefined ? { explicit: deps.modelPreferences } : {}),
          ...(deps.subagentModelPreferencesOverride !== undefined
            ? { settingsOverride: deps.subagentModelPreferencesOverride }
            : {}),
          loadSettings: (loadCwd) =>
            (deps.loadSubagentModelPreferences
              ? deps.loadSubagentModelPreferences(loadCwd)
              : loadMmrCoreSettings(loadCwd).settings
            )?.subagentModelPreferences,
        }),
    },
  };
}

export function createCodeReviewTool(deps: CodeReviewToolDeps = {}): ToolDefinition {
  const { spec, factoryOptions } = codeReviewToolBlueprint(deps);
  return createWorkerTool(spec, deps, factoryOptions);
}

/** Background-surface seam: prepare a registry-ready code_review run from raw params. */
export function createCodeReviewRunPreparer(deps: CodeReviewToolDeps = {}): MmrWorkerRunPreparer<CodeReviewDetails> {
  const { spec, factoryOptions } = codeReviewToolBlueprint(deps);
  return createWorkerRunPreparer(spec, deps, factoryOptions);
}

/**
 * Register the code_review Pi tool on the supplied extension API and record
 * it as MMR-owned so Free mode strips it like every other MMR-authored tool.
 */
export function registerCodeReviewTool(pi: ExtensionAPI, deps: CodeReviewToolDeps = {}): ToolDefinition {
  const definition = createCodeReviewTool({ ...deps, pi });
  registerMmrOwnedTool(CODE_REVIEW_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
