import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import {
  assembleMmrSubagentSurface,
  getMmrSubagentPromptBuilder,
  registerMmrSubagentPromptBuilder,
  unregisterMmrSubagentPromptBuilder,
} from "../mmr-core/subagent-prompt-assembly.js";
import {
  expandMmrModelPreferencesToStrings,
  getMmrSubagentProfile,
  type MmrSubagentProfile,
} from "../mmr-core/subagent-profiles.js";
import {
  resolveMmrSubagentInvocation,
  type MmrSubagentInvocation,
} from "../mmr-core/subagent-resolver.js";
import { loadMmrCoreSettings, type LoadedMmrCoreSettings } from "../mmr-core/settings.js";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { buildOracleWorkerSystemPrompt as buildOracleWorkerSystemPromptFromPrompts } from "./prompts.js";
import { resolveEffectiveRunner } from "./worker-fallback-run.js";
import {
  clipMmrWorkerDescription,
  createWorkerTool,
  resolveWorkerModelPreferencesOverride,
  type MmrWorkerToolResolveInput,
} from "./worker-tool-factory.js";
import { renderMmrSubagentCall, renderMmrSubagentResult } from "./progress-rendering.js";
import { ORACLE_ALWAYS_BLOCKING_GUIDANCE } from "./tool-guidance.js";
import { type ToolHostLike } from "./worker-host.js";
import {
  resolveCtxMmrModelRegistry,
  resolveMmrWorkerModelContextWindowFromCtx,
} from "./worker-model-metadata.js";
import {
  type MmrSubagentRunner,
  type MmrWorkerRunnerDeps,
  runMmrSubagentWorker,
} from "./runner.js";
import {
  IMAGE_EXTENSIONS,
  buildOracleUserPrompt,
  coerceAdvisorParams,
  oracleParameters,
  pathInsideCwd,
  type InternalAttachment,
  type OracleParams,
} from "./oracle-prompt.js";
import {
  ORACLE_PROGRESS_PLACEHOLDER,
  buildDetails,
  buildFinalContent,
  buildProgressDetails,
  type OracleDetails,
} from "./oracle-result.js";

// Re-export the oracle params/prompt and result shaping surface from their
// new homes (`oracle-prompt.ts`, `oracle-result.ts`) so this entry file
// remains the stable public surface for them.
export { ORACLE_PARAMETERS_SCHEMA, oracleParameters } from "./oracle-prompt.js";
export type { OracleParams } from "./oracle-prompt.js";
export { ORACLE_PROGRESS_PLACEHOLDER } from "./oracle-result.js";
export type { OracleAttachmentRecord, OracleDetails } from "./oracle-result.js";

export const ORACLE_TOOL_NAME = "oracle";

export const ORACLE_SUBAGENT_PROFILE = "oracle";

/**
 * Per-file byte cap when inlining text-file contents into the advisor
 * user prompt. Sized so a small handful of typical source files (a few
 * hundred lines each) fit without blowing the worker context. The
 * advisor tool factory accepts a `perFileByteLimit` override for tests
 * and tuning.
 */
export const DEFAULT_ORACLE_PER_FILE_BYTE_LIMIT = 32 * 1024;

/**
 * Look up a subagent profile by name or throw. Shared by attachment-aware
 * advisory workers backed by an mmr-core standalone profile.
 */
export function requireMmrAdvisorProfile(profileName: string): MmrSubagentProfile {
  const profile = getMmrSubagentProfile(profileName);
  if (!profile) {
    throw new Error(
      `mmr-core does not expose a "${profileName}" subagent profile; the advisor cannot run without it.`,
    );
  }
  return profile;
}

function requireOracleProfile(): MmrSubagentProfile {
  return requireMmrAdvisorProfile(ORACLE_SUBAGENT_PROFILE);
}

/**
 * Worker tool allowlist derived from the `oracle` subagent profile in
 * `mmr-core`. Tools whose owning extension is not loaded in the child
 * Pi process (e.g. `read_session` / `find_session` when `mmr-history`
 * is unloaded or `MMR_HISTORY_ENABLE` is unset) are still listed here
 * for profile honesty — the child resolves the deny-aware, registered
 * intersection itself and applies it via `pi.setActiveTools`. Parent
 * does not pass explicit `--tools` so the child's resolution path is
 * always the source of truth.
 */
export const ORACLE_WORKER_TOOLS: readonly string[] = Object.freeze([
  ...requireOracleProfile().tools,
]);

/**
 * Ordered worker-model preferences with both canonical
 * (`provider/id`) and bare-id forms, derived from the `oracle` subagent
 * profile in `mmr-core` (the single source of truth).
 *
 * Export-only/legacy convenience constant: it is retained for
 * compatibility and is no longer wired into any tool config field. The
 * advisor parent resolves its provider/model through the shared
 * `selectMmrModelRoute` registry resolver using the profile's
 * `modelPreferences` (via the shared worker-tool factory), so this
 * frozen list has no internal runtime consumer beyond its own test and
 * the package-root re-export. The dual canonical/bare-id forms let loose
 * matching ({@link selectOracleWorkerModel}) succeed regardless of which
 * form the parent Pi registry exposes.
 */
export const ORACLE_DEFAULT_MODEL_PREFERENCES: readonly string[] = Object.freeze([
  ...expandMmrModelPreferencesToStrings(requireOracleProfile().modelPreferences),
]);

export const ORACLE_PROMPT_SNIPPET =
  "Consult the oracle - an AI advisor that can plan, review, debug, and provide expert technical guidance.";

export const ORACLE_PROMPT_GUIDELINES: readonly string[] = [
  "Use oracle for code reviews and architecture feedback, finding difficult bugs that flow across many files, planning complex implementations or refactors, answering complex technical questions that require deep reasoning, or getting an alternative point of view when you are struggling to solve a problem.",
  "Do not use oracle for simple file reads or keyword searches (use read or grep directly), codebase searches (use finder), web browsing and searching (use read_web_page or web_search), or basic code modifications you can do yourself (do it yourself or use Task).",
  "Be specific about what you want the oracle to review, plan, or debug; provide relevant context about what you're trying to achieve so the oracle can give better guidance.",
  "When you know the files involved, list them in the oracle `files` parameter as a JSON array of strings (`[\"path/to/file1.ts\", \"path/to/file2.ts\"]`) even when there is only one file (`[\"path/to/file1.ts\"]`).",
  "When you invoke the oracle, mention to the user why — use language such as `I'm going to ask the oracle for advice` or `I need to consult with the oracle.`",
  "Run multiple oracle calls in parallel only when they address distinct concerns (for example architecture review, performance analysis, race-condition investigation); each oracle call is invoked zero-shot, so every call must be self-contained.",
  ORACLE_ALWAYS_BLOCKING_GUIDANCE,
  "Example oracle call for an architecture review with attached files: `{\"task\":\"Review the authentication architecture and suggest improvements\",\"files\":[\"src/auth/index.ts\",\"src/auth/jwt.ts\"]}`.",
  "Example oracle call for planning a feature when no files are needed: `{\"task\":\"Plan the implementation of real-time collaboration feature\"}`.",
  "Example oracle call for a performance analysis using `context` instead of files: `{\"task\":\"Analyze performance bottlenecks\",\"context\":\"Users report slow response times when processing large datasets\"}`.",
  "Example oracle call for an API design review using both `context` and `files`: `{\"task\":\"Review API design\",\"context\":\"This is a REST API for user management\",\"files\":[\"src/api/users.ts\"]}`.",
  "Example oracle call for debugging a failing test with `context` and `files`: `{\"task\":\"Help debug why tests are failing\",\"context\":\"Tests fail with \\\"undefined is not a function\\\" after refactoring the auth module\",\"files\":[\"src/auth/auth.test.ts\"]}`.",
];

export const ORACLE_DESCRIPTION = [
  "Consult the oracle - an AI advisor powered by OpenAI's GPT-5.5 reasoning model that can plan, review, and provide expert guidance.",
  "",
  ORACLE_ALWAYS_BLOCKING_GUIDANCE,
  "",
  "The oracle has access to the following tools:",
  "- read",
  "- grep",
  "- find",
  "- web_search",
  "- read_web_page",
  "- read_session",
  "- find_session",
  "",
  "You should consult the oracle for:",
  "- Code reviews and architecture feedback",
  "- Finding difficult bugs in codepaths that flow across many files",
  "- Planning complex implementations or refactors",
  "- Answering complex technical questions that require deep technical reasoning",
  "- Providing an alternative point of view when you are struggling to solve a problem",
  "",
  "You should NOT consult the oracle for:",
  "- File reads or simple keyword searches (use read or grep directly)",
  "- Codebase searches (use finder)",
  "- Web browsing and searching (use read_web_page or web_search)",
  "- Basic code modifications and when you need to execute code changes (do it yourself or use Task)",
  "",
  "Usage guidelines:",
  "- Be specific about what you want the oracle to review, plan, or debug",
  "- Provide relevant context about what you're trying to achieve. If you know that 3 files are involved, list them and they will be attached.",
  "",
  "# Examples",
  "",
  "Review the authentication system architecture and suggest improvements",
  "```json",
  '{"task":"Review the authentication architecture and suggest improvements","files":["src/auth/index.ts","src/auth/jwt.ts"]}',
  "```",
  "",
  "Plan the implementation of real-time collaboration features",
  "```json",
  '{"task":"Plan the implementation of real-time collaboration feature"}',
  "```",
  "",
  "Analyze the performance bottlenecks in the data processing pipeline",
  "```json",
  '{"task":"Analyze performance bottlenecks","context":"Users report slow response times when processing large datasets"}',
  "```",
  "",
  "Review this API design and suggest better patterns",
  "```json",
  '{"task":"Review API design","context":"This is a REST API for user management","files":["src/api/users.ts"]}',
  "```",
  "",
  "Debug failing tests after refactor",
  "```json",
  '{"task":"Help debug why tests are failing","context":"Tests fail with \\"undefined is not a function\\" after refactoring the auth module","files":["src/auth/auth.test.ts"]}',
  "```",
].join("\n");

/**
 * Build the oracle worker system prompt. Re-exported here for
 * compatibility with callers that import the builder through the
 * concrete-tool module; the canonical owner is
 * `mmr-subagents/prompts.ts`, which also registers the oracle builder
 * against mmr-core's prompt-assembly registry.
 */
export function buildOracleWorkerSystemPrompt(cwd: string): string {
  return buildOracleWorkerSystemPromptFromPrompts(cwd);
}

function readTextFileBounded(absolutePath: string, byteLimit: number, totalBytes: number): { text: string; truncated: boolean } {
  if (totalBytes <= byteLimit) {
    return { text: fs.readFileSync(absolutePath, "utf8"), truncated: false };
  }
  const fd = fs.openSync(absolutePath, "r");
  try {
    const buf = Buffer.alloc(byteLimit);
    fs.readSync(fd, buf, 0, byteLimit, 0);
    return { text: buf.toString("utf8"), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

function resolveOracleAttachment(
  rawPath: string,
  cwd: string,
  perFileByteLimit: number,
): InternalAttachment {
  const absoluteCwd = path.resolve(cwd);
  const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(absoluteCwd, rawPath);
  if (!pathInsideCwd(absolute, absoluteCwd)) {
    return {
      record: {
        kind: "skipped",
        path: rawPath,
        reason: "outside the working directory; not attached",
      },
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch (err) {
    return {
      record: {
        kind: "skipped",
        path: rawPath,
        reason: `could not be attached: ${(err as Error).message}`,
      },
    };
  }
  if (!stat.isFile()) {
    return {
      record: { kind: "skipped", path: rawPath, reason: "not a regular file; not attached" },
    };
  }
  const ext = path.extname(absolute).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      record: { kind: "image", path: rawPath, bytes: stat.size },
    };
  }
  let read: { text: string; truncated: boolean };
  try {
    read = readTextFileBounded(absolute, perFileByteLimit, stat.size);
  } catch (err) {
    return {
      record: {
        kind: "skipped",
        path: rawPath,
        reason: `could not be attached: ${(err as Error).message}`,
      },
    };
  }
  return {
    record: {
      kind: "text",
      path: rawPath,
      bytes: Buffer.byteLength(read.text, "utf8"),
      truncated: read.truncated,
      originalBytes: stat.size,
    },
    text: read.text,
  };
}

export interface OracleToolDeps {
  /**
   * Generic subagent runner. Preferred seam for new callers; defaults
   * to a child-CLI runner backed by {@link runMmrSubagentWorker}.
   */
  runner?: MmrSubagentRunner;
  /**
   * Legacy direct worker seam retained for one compatibility cycle.
   * Prefer {@link OracleToolDeps.runner}; when both are set, `runner`
   * wins and a one-line console warning is emitted.
   */
  runWorker?: typeof runMmrSubagentWorker;
  /**
   * Override the ordered worker-model preference list. When set, this
   * value wins over both the settings-driven
   * `subagentModelPreferences.<profile>` block and the profile
   * defaults; useful for tests and host integrations that want to pin a
   * preference without touching `.pi/settings.json`. Fed straight into
   * the shared `selectMmrModelRoute` registry resolver.
   */
  modelPreferences?: readonly MmrModelPreference[];
  /**
   * Settings-driven override: when present, expanded via
   * `expandMmrModelPreferencesToStrings` and used as the preference
   * list. Wins over profile defaults but loses to an explicit
   * `modelPreferences`. When omitted, `execute()` reads
   * `loadMmrCoreSettings(cwd).settings.subagentModelPreferences.<profile>`
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
  /** Pi host, captured by registerOracleTool so child startup can keep provider/extension paths. */
  pi?: ToolHostLike;
  /** Override the per-file byte cap when inlining text-file contents. */
  perFileByteLimit?: number;
  /** Override prompt text while still flowing through the subagent surface API. Tests inject deterministic text. */
  buildSystemPrompt?: (cwd: string) => string;
  /** Forwarded to {@link runMmrSubagentWorker} as its second argument. */
  runnerDeps?: MmrWorkerRunnerDeps;
}

/** Alias for the advisor tool dependency seam. */
export type MmrAdvisorToolDeps = OracleToolDeps;

function assembleAdvisorSystemPrompt(
  profile: MmrSubagentProfile,
  cwd: string,
  buildSystemPrompt: ((cwd: string) => string) | undefined,
): string {
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
 * Static configuration for an attachment-aware advisory subagent tool.
 * The oracle is built from this shape via {@link createMmrAdvisorTool}.
 */
export interface MmrAdvisorToolConfig {
  /** Pi tool name (e.g. `oracle`). */
  toolName: string;
  /** mmr-core subagent profile name driving model/tools/prompt. */
  profileName: string;
  /** `result.details.worker` discriminator literal. */
  workerDiscriminator: string;
  /** Tool description shown in the model's tool inventory. */
  description: string;
  /** Short prompt snippet surfaced in the main agent system prompt. */
  promptSnippet: string;
  /** Prompt guideline lines surfaced in the main agent system prompt. */
  promptGuidelines: readonly string[];
  /** Compact progress placeholder shown before the worker finishes. */
  progressPlaceholder: string;
  /** Prefix used in failure/empty-output advisory messages. */
  outputLabel: string;
  /** Profile-resolved worker tool allowlist (for details reporting). */
  workerTools: readonly string[];
  /** Default per-file inline byte cap. */
  defaultPerFileByteLimit: number;
  /** Render the streaming call component. */
  renderCall(args: unknown, theme: unknown, context: unknown): unknown;
  /** Render the (partial/final) result component. */
  renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): unknown;
}

/**
 * Default parent-side advisor invocation resolution: the shared
 * `resolveMmrSubagentInvocation` against `ctx.modelRegistry`. Returns a
 * `model.no-route` failure when the context exposes no registry; the
 * advisor spec runs in degrade mode, so that failure means "spawn with
 * no explicit --model and let the child resolve the route" rather than
 * a pre-spawn error.
 */
function resolveAdvisorInvocation(
  profileName: string,
  input: MmrWorkerToolResolveInput,
): MmrSubagentInvocation {
  const profile = requireMmrAdvisorProfile(profileName);
  const registry = resolveCtxMmrModelRegistry(input.ctx);
  if (!registry) {
    return {
      ok: false,
      profile,
      code: "model.no-route",
      message: `${profileName} could not resolve a model registry from the extension context; expected ctx.modelRegistry to expose getAll/find.`,
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
 * Build an attachment-aware advisory subagent tool from a static config
 * plus runtime dependency seams. Shared core for the oracle.
 */
export function createMmrAdvisorTool(
  config: MmrAdvisorToolConfig,
  deps: OracleToolDeps = {},
): ToolDefinition {
  const effectiveRunner = resolveEffectiveRunner(deps, `createMmrAdvisorTool(${config.toolName})`);
  const perFileByteLimit = deps.perFileByteLimit ?? config.defaultPerFileByteLimit;
  return createWorkerTool<OracleParams, OracleDetails, InternalAttachment[]>(
    {
      toolName: config.toolName,
      profileName: config.profileName,
      description: config.description,
      promptSnippet: config.promptSnippet,
      promptGuidelines: config.promptGuidelines,
      parameters: oracleParameters,
      renderCall: (args, theme, context) => config.renderCall(args, theme, context),
      renderResult: (result, options, theme, context) => config.renderResult(result, options, theme, context),
      progressPlaceholder: config.progressPlaceholder,
      // Invalid params propagate as a thrown error to the Pi tool host
      // (the long-standing advisor contract), so no paramsFailure here.
      coerceParams: (raw) => coerceAdvisorParams(config.toolName, raw),
      computeRunData: (params, cwd) =>
        (params.files ?? []).map((entry) => resolveOracleAttachment(entry, cwd, perFileByteLimit)),
      resolveInvocation: (input) => resolveAdvisorInvocation(config.profileName, input),
      resolutionFailure: "degrade",
      // The worker tool set is resolved by the child Pi process against
      // its own registered-tool inventory (see
      // `resolveMmrSubagentInvocation` in mmr-core). Parent must not pass
      // explicit --tools here because the profile lists tools whose
      // owning extension may be unloaded in the child environment (e.g.
      // mmr-web's web_search / read_web_page, mmr-history's read_session
      // / find_session). The child computes the deny-aware, registered
      // intersection itself and applies it via pi.setActiveTools.
      mirrorWorkerTools: false,
      detailsWorkerTools: "profile-constant",
      workerToolsConstant: config.workerTools,
      progressModelBinding: "per-attempt",
      buildUserPrompt: (params, attachments) => buildOracleUserPrompt(params, attachments),
      assembleSystemPrompt: (cwd) =>
        assembleAdvisorSystemPrompt(requireMmrAdvisorProfile(config.profileName), cwd, deps.buildSystemPrompt),
      resolveContextWindow: (ctx, model) => resolveMmrWorkerModelContextWindowFromCtx(ctx, model),
      candidatePreferences: () => requireMmrAdvisorProfile(config.profileName).modelPreferences,
      buildProgressDetails: (snapshot, runCtx) =>
        buildProgressDetails(config, snapshot, runCtx.resolvedModel, runCtx.cwd, runCtx.runData, runCtx.contextWindow),
      buildFinalDetails: (result, runCtx) =>
        buildDetails(config, result, runCtx.resolvedModel, runCtx.cwd, runCtx.runData, runCtx.contextWindow),
      buildFinalContent: (result) => buildFinalContent(config.outputLabel, result, config.profileName),
      describeRun: (params) => ({
        description: `${config.toolName}: ${clipMmrWorkerDescription(params.task)}`,
        displayPrompt: params.task,
      }),
    },
    deps,
    {
      effectiveRunner,
      resolveModelPreferencesOverride: (cwd) =>
        resolveWorkerModelPreferencesOverride({
          profileName: config.profileName,
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
  );
}

/** Static config for the oracle advisor tool. */
export const ORACLE_TOOL_CONFIG: MmrAdvisorToolConfig = {
  toolName: ORACLE_TOOL_NAME,
  profileName: ORACLE_SUBAGENT_PROFILE,
  workerDiscriminator: "mmr-subagents.oracle",
  description: ORACLE_DESCRIPTION,
  promptSnippet: ORACLE_PROMPT_SNIPPET,
  promptGuidelines: ORACLE_PROMPT_GUIDELINES,
  progressPlaceholder: ORACLE_PROGRESS_PLACEHOLDER,
  outputLabel: ORACLE_TOOL_NAME,
  workerTools: ORACLE_WORKER_TOOLS,
  defaultPerFileByteLimit: DEFAULT_ORACLE_PER_FILE_BYTE_LIMIT,
  renderCall: (args, theme, context) =>
    renderMmrSubagentCall(ORACLE_TOOL_NAME, args, theme as never, context as never),
  renderResult: (result, options, theme, context) =>
    renderMmrSubagentResult(ORACLE_TOOL_NAME, result as never, options as never, theme as never, context as never),
};

export function createOracleTool(deps: OracleToolDeps = {}): ToolDefinition {
  return createMmrAdvisorTool(ORACLE_TOOL_CONFIG, deps);
}

/**
 * Register the oracle Pi tool on the supplied extension API and record
 * it as MMR-owned so Free mode strips it like every other MMR-authored
 * tool.
 */
export function registerOracleTool(pi: ExtensionAPI, deps: OracleToolDeps = {}): ToolDefinition {
  const definition = createOracleTool({ ...deps, pi });
  registerMmrOwnedTool(ORACLE_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
