import fs from "node:fs";
import path from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
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
import { selectMmrModelRoute } from "../mmr-core/model-resolver.js";
import { loadMmrCoreSettings, type LoadedMmrCoreSettings } from "../mmr-core/settings.js";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { buildOracleWorkerSystemPrompt as buildOracleWorkerSystemPromptFromPrompts } from "./prompts.js";
import { readMmrWorkerSessionId } from "./fallback.js";
import {
  resolveEffectiveRunner,
  runMmrWorkerWithSharedFallback,
} from "./worker-fallback-run.js";
import { renderMmrSubagentCall, renderMmrSubagentResult } from "./progress-rendering.js";
import { ORACLE_ALWAYS_BLOCKING_GUIDANCE } from "./tool-guidance.js";
import { resolveWorkerCwd } from "./worker-host.js";
import {
  resolveCtxMmrModelRegistry,
  resolveMmrWorkerModelContextWindowFromCtx,
} from "./worker-model-metadata.js";
import {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  classifyMmrWorkerOutcome,
  type MmrSpawnedSubagentWorkerDetailsBase,
  type MmrWorkerOutcomeStatus,
  type MmrSubagentRunOptions,
  type MmrSubagentRunner,
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
 * `modelPreferences` (see `resolveAdvisorModelPreferences`), so this
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

export const ORACLE_PARAMETERS_SCHEMA = Type.Object(
  {
    task: Type.String({
      description:
        "The task or question you want the oracle to help with. Be specific about what kind of guidance, review, or planning you need.",
    }),
    context: Type.Optional(
      Type.String({
        description:
          "Optional context about the current situation, what you've tried, or background information that would help the oracle provide better guidance.",
      }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional list of specific file paths (text files, images) that the oracle should examine as part of its analysis. These files will be attached to the oracle input.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const oracleParameters = ORACLE_PARAMETERS_SCHEMA;

export type OracleParams = Static<typeof ORACLE_PARAMETERS_SCHEMA>;

export interface OracleDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: string;
  // Final-run outcome from the shared classifier. The renderer reads this
  // first, so a successful run that merely preserved a non-fatal provider
  // `errorMessage` still renders as completed instead of failed.
  status?: MmrWorkerOutcomeStatus;
  /** Summary of how each requested `files[]` entry was handled. */
  attachments: readonly OracleAttachmentRecord[];
}

export type OracleAttachmentRecord =
  | {
      kind: "text";
      path: string;
      bytes: number;
      truncated: boolean;
      originalBytes: number;
    }
  | { kind: "image"; path: string; bytes: number }
  | { kind: "skipped"; path: string; reason: string };

/** Compact progress status surfaced to the model before the worker finishes. */
export const ORACLE_PROGRESS_PLACEHOLDER = "oracle: consulting…";

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

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".svg",
]);

function coerceAdvisorParams(toolName: string, raw: unknown): OracleParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${toolName} expects an object with a \`task\` field.`);
  }
  const validated = checkMmrToolParams(toolName, ORACLE_PARAMETERS_SCHEMA, raw);
  if (validated.task.trim().length === 0) {
    throw new Error(`${toolName}.task is required and must be a non-empty string.`);
  }
  // Preserve existing files[] normalization: trim each entry and drop
  // empty strings. TypeBox validates element types but does not
  // normalize, so this step stays in coerce.
  let files: string[] | undefined;
  if (validated.files !== undefined) {
    const cleaned: string[] = [];
    for (const entry of validated.files) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      cleaned.push(trimmed);
    }
    files = cleaned;
  }
  const result: OracleParams = { task: validated.task };
  if (validated.context !== undefined) result.context = validated.context;
  if (files !== undefined) result.files = files;
  return result;
}

interface InternalAttachment {
  record: OracleAttachmentRecord;
  /** Text already truncated to the per-file byte cap, if `kind === "text"`. */
  text?: string;
}

function pathInsideCwd(absoluteTarget: string, absoluteCwd: string): boolean {
  const relative = path.relative(absoluteCwd, absoluteTarget);
  if (relative === "") return true;
  if (relative.startsWith("..")) return false;
  if (path.isAbsolute(relative)) return false;
  return true;
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

function buildOracleUserPrompt(
  params: OracleParams,
  attachments: readonly InternalAttachment[],
): string {
  const parts: string[] = [`Task: ${params.task.trim()}`];
  if (params.context && params.context.trim().length > 0) {
    parts.push("", "Context:", params.context.trim());
  }
  if (attachments.length > 0) {
    parts.push("", "Attached files:");
    for (const att of attachments) {
      const record = att.record;
      if (record.kind === "text") {
        const header = record.truncated
          ? `### File: ${record.path} (truncated to first ${record.bytes} bytes of ${record.originalBytes})`
          : `### File: ${record.path}`;
        parts.push("", header, "```", att.text ?? "", "```");
      } else if (record.kind === "image") {
        parts.push(
          "",
          `### Image: ${record.path}`,
          "(Binary image — open with the `read` tool if you need to view it.)",
        );
      } else {
        parts.push("", `### File: ${record.path} (${record.reason})`);
      }
    }
  }
  return parts.join("\n");
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
  /** Override the per-file byte cap when inlining text-file contents. */
  perFileByteLimit?: number;
  /** Override prompt text while still flowing through the subagent surface API. Tests inject deterministic text. */
  buildSystemPrompt?: (cwd: string) => string;
  /** Forwarded to {@link runMmrSubagentWorker} as its second argument. */
  runnerDeps?: MmrWorkerRunnerDeps;
}

/** Alias for the advisor tool dependency seam. */
export type MmrAdvisorToolDeps = OracleToolDeps;

/**
 * Resolve the ordered worker-model preference list used by an advisor
 * parent on every execute. Precedence (top wins):
 *  1. `deps.modelPreferences` — explicit programmatic override.
 *  2. `subagentModelPreferences.<profile>` from settings — user-driven
 *     `/mmr-config` override.
 *  3. The profile's `modelPreferences` defaults.
 *
 * Returns `MmrModelPreference[]` fed straight into the shared
 * `selectMmrModelRoute` registry resolver — the same path the child Pi
 * process uses at activation, so parent and child can never disagree on
 * the route. Settings are re-read on every invocation so a `/mmr-config`
 * update takes effect on the next call without a process restart.
 */
function resolveAdvisorModelPreferences(
  profileName: string,
  cwd: string,
  deps: OracleToolDeps,
): readonly MmrModelPreference[] {
  if (deps.modelPreferences && deps.modelPreferences.length > 0) {
    return deps.modelPreferences;
  }
  let settingsBlock: readonly MmrModelPreference[] | undefined;
  if (deps.subagentModelPreferencesOverride !== undefined) {
    settingsBlock = deps.subagentModelPreferencesOverride;
  } else {
    try {
      const loaded = deps.loadSubagentModelPreferences
        ? deps.loadSubagentModelPreferences(cwd)
        : loadMmrCoreSettings(cwd).settings;
      settingsBlock = loaded?.subagentModelPreferences?.[profileName];
    } catch {
      // Settings read errors must not block advisor spawn; fall through
      // to profile defaults below.
    }
  }
  if (settingsBlock && settingsBlock.length > 0) {
    return settingsBlock;
  }
  return requireMmrAdvisorProfile(profileName).modelPreferences;
}

function progressContent(snapshot: MmrWorkerProgressSnapshot, placeholder: string): string {
  return progressTextOrPlaceholder(snapshot, placeholder);
}

function buildProgressDetails(
  config: MmrAdvisorToolConfig,
  snapshot: MmrWorkerProgressSnapshot,
  resolvedModel: string | undefined,
  cwd: string,
  attachments: readonly InternalAttachment[],
  contextWindow: number | undefined,
): OracleDetails {
  const base = buildSpawnedProgressDetailsBase({
    snapshot,
    cwd,
    workerTools: config.workerTools,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  return { worker: config.workerDiscriminator, ...base, attachments: attachments.map((a) => a.record) };
}

function buildDetails(
  config: MmrAdvisorToolConfig,
  result: MmrWorkerResult,
  resolvedModel: string | undefined,
  cwd: string,
  attachments: readonly InternalAttachment[],
  contextWindow: number | undefined,
): OracleDetails {
  const base = buildSpawnedFinalDetailsBase({
    result,
    cwd,
    workerTools: config.workerTools,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  const status = classifyMmrWorkerOutcome(result, { partialOutputPolicy: "fail-on-nonzero" });
  return { worker: config.workerDiscriminator, status, ...base, attachments: attachments.map((a) => a.record) };
}

function buildFinalContent(label: string, result: MmrWorkerResult): string {
  // Failure-state precedence is now owned by `classifyMmrWorkerOutcome`
  // (fail-on-nonzero policy). The classifier guarantees `spawn-error`
  // / `activation-error` / `aborted` / `worker-error` win over output
  // rendering, and the structured `result.spawnError` field takes
  // precedence over `result.errorMessage` text so spawn-failure reasons
  // (`spawn ENOENT`, `EACCES`, etc.) are not lost when stderr is empty.
  const outcome = classifyMmrWorkerOutcome(result, {
    partialOutputPolicy: "fail-on-nonzero",
  });
  if (outcome === "spawn-error") {
    const reason = result.spawnError ?? result.errorMessage ?? "unknown spawn error";
    return `${label}: worker spawn failed: ${reason}`;
  }
  if (outcome === "activation-error") {
    return `${label}: subagent activation failed: ${result.subagentActivationError}`;
  }
  if (outcome === "aborted") {
    return `${label}: consultation was cancelled before producing a result.`;
  }
  if (outcome === "worker-error") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detailText = tail.length > 0 ? tail : (result.errorMessage ?? "");
    const detail = detailText.length > 0 ? `\n\n${detailText}` : "";
    return `${label}: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  if (outcome === "no-agent-start") {
    // Mirrors finder's diagnostic: the worker exited cleanly without ever
    // entering the agent loop. Almost always means another Pi extension's
    // `input` event hook consumed the prompt before any provider call
    // could happen. Surface the actionable hint instead of the empty
    // advisory message.
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `${label}: worker exited before the agent loop started. No advisory output was produced; another Pi extension's input handler likely consumed the prompt. Check stderr for extension diagnostics.${detail}`;
  }
  if (outcome === "success") {
    return result.truncatedFinalOutput || result.finalOutput;
  }
  // empty-output
  if (result.errorMessage && result.errorMessage.length > 0) {
    return `${label}: worker reported an error: ${result.errorMessage}`;
  }
  return `${label}: no advisory output was produced. Re-run with a more specific task or attached files.`;
}

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
 * Build an attachment-aware advisory subagent tool from a static config
 * plus runtime dependency seams. Shared core for the oracle.
 */
export function createMmrAdvisorTool(
  config: MmrAdvisorToolConfig,
  deps: OracleToolDeps = {},
): ToolDefinition {
  const effectiveRunner = resolveEffectiveRunner(deps);
  const outputByteLimit = deps.outputByteLimit ?? DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT;
  const perFileByteLimit = deps.perFileByteLimit ?? config.defaultPerFileByteLimit;
  return {
    name: config.toolName,
    label: config.toolName,
    description: config.description,
    promptSnippet: config.promptSnippet,
    promptGuidelines: [...config.promptGuidelines],
    parameters: oracleParameters,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return config.renderCall(args, theme, context) as ReturnType<NonNullable<ToolDefinition["renderCall"]>>;
    },
    renderResult(result, options, theme, context) {
      return config.renderResult(result, options, theme, context) as ReturnType<NonNullable<ToolDefinition["renderResult"]>>;
    },
    async execute(
      _toolCallId,
      rawParams,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<OracleDetails>> {
      const params = coerceAdvisorParams(config.toolName, rawParams);
      const cwd = resolveWorkerCwd(ctx);
      const attachments: InternalAttachment[] = (params.files ?? []).map((entry) =>
        resolveOracleAttachment(entry, cwd, perFileByteLimit),
      );
      const userPrompt = buildOracleUserPrompt(params, attachments);
      const basePreferences = resolveAdvisorModelPreferences(
        config.profileName,
        cwd,
        deps,
      );
      const profile = requireMmrAdvisorProfile(config.profileName);
      const registry = resolveCtxMmrModelRegistry(ctx);

      // Run the worker with session-scoped model fallback (issue #9). The
      // closure owns normal model preference resolution; when a fallback override is
      // supplied it selects from the override and forwards it to the child.
      const runWorkerOnce = async (
        runArgs: { override?: readonly MmrModelPreference[] },
      ): Promise<{ result: Awaited<ReturnType<typeof effectiveRunner.run>>; route: string | undefined }> => {
        const preferences = runArgs.override ?? basePreferences;
        const route = registry
          ? selectMmrModelRoute({
              modelPreferences: preferences,
              modeThinkingLevel: profile.thinkingLevel,
              registry,
            }).selected
          : undefined;
        const model = route ? `${route.provider}/${route.model}` : undefined;
        const contextWindow = resolveMmrWorkerModelContextWindowFromCtx(ctx, model);
        const runnerOptions: MmrSubagentRunOptions = {
          profileName: config.profileName,
          prompt: userPrompt,
          cwd,
        // Worker tool set is resolved by the child Pi process against its
        // own registered-tool inventory (see `resolveMmrSubagentInvocation`
        // in mmr-core). Parent must not pass explicit --tools here because
        // the profile lists tools whose owning extension may be unloaded
        // in the child environment (e.g. mmr-web's web_search /
        // read_web_page, mmr-history's read_session / find_session). The
        // child computes the deny-aware, registered intersection itself and
        // applies it via pi.setActiveTools.
          systemPrompt: assembleAdvisorSystemPrompt(profile, cwd, deps.buildSystemPrompt),
          signal,
          outputByteLimit,
          onProgress: onUpdate
            ? (snapshot) => {
                onUpdate({
                  content: [{ type: "text", text: progressContent(snapshot, config.progressPlaceholder) }],
                  details: buildProgressDetails(config, snapshot, model, cwd, attachments, contextWindow),
                });
              }
            : undefined,
        };
        if (model) runnerOptions.model = model;
        if (runArgs.override) runnerOptions.modelPreferencesOverride = runArgs.override;
        const result = await effectiveRunner.run(runnerOptions);
        return { result, route: model };
      };

      const outcome = await runMmrWorkerWithSharedFallback({
        ctx,
        sessionId: readMmrWorkerSessionId(ctx),
        toolName: config.toolName,
        profileName: config.profileName,
        candidatePreferences: profile.modelPreferences,
        run: runWorkerOnce,
      });

      const model = outcome.route;
      const contextWindow = resolveMmrWorkerModelContextWindowFromCtx(ctx, model);
      return {
        content: [{ type: "text", text: buildFinalContent(config.outputLabel, outcome.result) }],
        details: buildDetails(config, outcome.result, model, cwd, attachments, contextWindow),
      };
    },
  } satisfies ToolDefinition;
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
  const definition = createOracleTool(deps);
  registerMmrOwnedTool(ORACLE_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
