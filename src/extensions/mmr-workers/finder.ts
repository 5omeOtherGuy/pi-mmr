import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MMR_BACKGROUND_RUN_PARAMETER_FIELDS } from "./background-dispatch.js";
import { getMmrSubagentState } from "../mmr-core/runtime.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
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
} from "../mmr-core/subagent-profiles.js";
import {
  resolveMmrSubagentInvocation,
  type MmrSubagentInvocation,
} from "../mmr-core/subagent-resolver.js";
import { loadMmrCoreSettings, type LoadedMmrCoreSettings } from "../mmr-core/settings.js";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { buildFinderWorkerSystemPrompt as buildFinderWorkerSystemPromptFromPrompts } from "./prompts.js";
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
import { FINDER_BACKGROUND_GUIDANCE } from "../mmr-core/worker-tool-guidance.js";
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
  type MmrWorkerTrailItem,
  runMmrSubagentWorker,
} from "./runner.js";
import {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
} from "./worker-result-shaping.js";

export const FINDER_TOOL_NAME = "finder";

export const FINDER_SUBAGENT_PROFILE = "finder";

function requireFinderProfile() {
  const profile = getMmrSubagentProfile(FINDER_SUBAGENT_PROFILE);
  if (!profile) {
    throw new Error(
      `mmr-core does not expose a "${FINDER_SUBAGENT_PROFILE}" subagent profile; finder cannot run without it.`,
    );
  }
  return profile;
}

/**
 * Read-only worker tool allowlist passed through `pi --tools` to the
 * isolated finder subprocess. The finder is search-only by design and must
 * not be able to mutate the workspace, run arbitrary shell commands, or
 * reach the network.
 *
 * Source of truth: the `finder` subagent profile in mmr-core. This export
 * is a derived constant kept for backward compatibility with existing
 * callers (tests, documentation, the runner spy). The profile remains
 * authoritative at runtime.
 */
export const FINDER_WORKER_TOOLS: readonly string[] = Object.freeze([
  ...requireFinderProfile().tools,
]);

/**
 * Ordered worker-model preferences with both canonical (`provider/id`)
 * and bare-id forms so the loose-match logic ({@link selectFinderWorkerModel})
 * succeeds regardless of which form the parent Pi registry exposes.
 *
 * Source of truth: the `finder` subagent profile in mmr-core. The profile
 * may pin providers for specific preferences; this list keeps those exact
 * routes provider-specific and expands implicit preferences with common
 * canonical provider routes so legacy match-by-canonical callers keep working.
 */
export const FINDER_DEFAULT_MODEL_PREFERENCES: readonly string[] = Object.freeze([
  ...expandMmrModelPreferencesToStrings(requireFinderProfile().modelPreferences),
]);

export const FINDER_PROMPT_SNIPPET =
  "Intelligently search your codebase for complex, multi-step search tasks based on functionality or concepts rather than exact matches";

/**
 * Single routing guideline for Pi's `Guidelines:` block. The full when/how
 * guidance lives only in {@link FINDER_DESCRIPTION} (the schema the model
 * already receives); cross-worker policy renders once in the
 * `## Using workers` block (`mmr-core/worker-tool-guidance.ts`).
 */
export const FINDER_PROMPT_GUIDELINES: readonly string[] = [
  "Use finder for complex, multi-step codebase discovery: behavior-level questions, flows spanning multiple modules, or correlating related patterns. For direct symbol, path, or exact-string lookups, use grep or find first.",
];

export const FINDER_DESCRIPTION = [
  "Intelligently search your codebase: Use finder for complex, multi-step search tasks where you need to find code based on functionality or concepts rather than exact matches. Anytime you want to chain multiple grep calls you should use this tool.",
  "",
  FINDER_BACKGROUND_GUIDANCE,
  "",
  "WHEN TO USE THIS TOOL:",
  "- You must locate code by behavior or concept",
  "- You need to run multiple greps in sequence",
  "- You must correlate or look for connection between several areas of the codebase.",
  "- You must filter broad terms (\"config\", \"logger\", \"cache\") by context.",
  "- You need answers to codebase-location questions such as \"Where do we validate JWT authentication headers?\" or \"Which module handles file-watcher retry logic\"",
  "",
  "WHEN NOT TO USE THIS TOOL:",
  "- When you know the exact file path - use read directly",
  "- When looking for specific symbols or exact strings - use find or grep",
  "- When you need to create, modify files, or run terminal commands",
  "",
  "USAGE GUIDELINES:",
  "1. Always run multiple independent search strategies in parallel to maximise speed.",
  "2. Formulate your query as a precise engineering request.",
  "   ✓ \"Find every place we build an HTTP error response.\"",
  "   ✗ \"error handling search\"",
  "3. Name concrete artifacts, patterns, or APIs to narrow scope (e.g., \"Express middleware\", \"fs.watch debounce\").",
  "4. State explicit success criteria so the agent knows when to stop (e.g., \"Return file paths and line numbers for all JWT verification calls\").",
  "5. Never issue vague or exploratory commands - be definitive and goal-oriented.",
  "6. Avoid broad root-level filename scans when you can scope to a directory.",
  "   ✓ \"Find watchdog-related files under core and server/src.\"",
  "   ✗ \"Find files named watchdog anywhere.\"",
  "7. Prefer scoped grep searches before falling back to repo-wide filename scans.",
].join("\n");

export const FINDER_PARAMETERS_SCHEMA = Type.Object(
  {
    query: Type.String({
      description:
        "The search query describing to the finder worker what it should find. Be specific and include technical terms, file types, expected code patterns, concrete artifacts, APIs, scoped directories, and explicit success criteria to help the worker find relevant code. Formulate the query in a way that makes it clear to the worker when it has found the right thing.",
    }),
    ...MMR_BACKGROUND_RUN_PARAMETER_FIELDS,
  },
  { additionalProperties: false },
);

export const finderParameters = FINDER_PARAMETERS_SCHEMA;

export type FinderParams = Static<typeof FINDER_PARAMETERS_SCHEMA>;

export interface FinderDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: "mmr-subagents.finder";
  // Final-run outcome from the shared classifier. The renderer reads this
  // first, so a successful run that merely preserved a non-fatal provider
  // `errorMessage` still renders as completed instead of failed.
  status?: MmrWorkerOutcomeStatus;
}

/** Compact "thinking" status surfaced to the model before the worker finishes. */
export const FINDER_PROGRESS_PLACEHOLDER = "finder: searching codebase…";

/**
 * Build the finder worker system prompt. Re-exported here for
 * compatibility with existing imports; the canonical owner is
 * `mmr-subagents/prompts.ts`, which also registers the finder builder
 * against mmr-core's prompt-assembly registry.
 */
export function buildFinderWorkerSystemPrompt(cwd: string): string {
  return buildFinderWorkerSystemPromptFromPrompts(cwd);
}

interface FinderLinkRange {
  start: number;
  end?: number;
}

const FINDER_FILE_LINK_PATTERN = /\[([^\]\n]*)\]\((file:\/\/[^)\s]+)\)/g;
const FINDER_LINE_FRAGMENT_PATTERN = /^L(\d+)(?:-L(\d+))?$/;
const FINDER_DISPLAY_LINE_SUFFIX_PATTERN = /#L\d+(?:-L\d+)?$/;

function parseFinderLineFragment(fragment: string): FinderLinkRange | undefined {
  const match = FINDER_LINE_FRAGMENT_PATTERN.exec(fragment);
  if (!match) return undefined;
  const start = Number.parseInt(match[1], 10);
  const end = match[2] ? Number.parseInt(match[2], 10) : undefined;
  if (!Number.isSafeInteger(start) || start < 1) return undefined;
  if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) return undefined;
  return { start, end };
}

function formatFinderLineFragment(range: FinderLinkRange): string {
  return range.end !== undefined && range.end !== range.start
    ? `L${range.start}-L${range.end}`
    : `L${range.start}`;
}

function pathInsideCwd(targetPath: string, cwd: string): boolean {
  const target = path.resolve(targetPath);
  const root = path.resolve(cwd);
  const relative = path.relative(root, target);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

const finderLineCountCache = new Map<string, number | undefined>();

function getFinderFileLineCount(absolutePath: string): number | undefined {
  const key = path.resolve(absolutePath);
  if (finderLineCountCache.has(key)) return finderLineCountCache.get(key);
  let lineCount: number | undefined;
  try {
    // Read directly rather than statSync()-then-readFileSync(): the latter
    // is a file-system race (the path could change between the two calls).
    // A directory read throws EISDIR and a missing path throws ENOENT;
    // both are caught below and leave the line count undefined (no clamp).
    const content = fs.readFileSync(key, "utf8");
    lineCount = content.length === 0 ? 0 : content.split("\n").length;
  } catch {
    lineCount = undefined;
  }
  finderLineCountCache.set(key, lineCount);
  return lineCount;
}

function sanitizeFinderFileLink(displayText: string, target: string, cwd: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return `[${displayText}](${target})`;
  }
  if (url.protocol !== "file:" || !url.hash.startsWith("#")) {
    return `[${displayText}](${target})`;
  }
  let absolutePath: string;
  try {
    absolutePath = fileURLToPath(url);
  } catch {
    return `[${displayText}](${target})`;
  }
  const range = parseFinderLineFragment(decodeURIComponent(url.hash.slice(1)));
  if (!range) return `[${displayText}](${target})`;
  // Outside-workspace file:// targets are never trustworthy from the parent
  // process's point of view: the worker may have invented the path or pointed
  // at unrelated user data. For finder-shaped links (file:// with a parseable
  // #Lx[-Ly] fragment), render the display text as plain text so the link is
  // not clickable in downstream renderers. Non-finder-shaped links above were
  // already returned unchanged so non-link content is preserved.
  if (!pathInsideCwd(absolutePath, cwd)) return displayText;
  const lineCount = getFinderFileLineCount(absolutePath);
  if (lineCount === undefined) return `[${displayText}](${target})`;

  if (range.start > lineCount) {
    url.hash = "";
    const nextDisplay = displayText.replace(FINDER_DISPLAY_LINE_SUFFIX_PATTERN, "");
    return `[${nextDisplay}](${url.href})`;
  }

  const clampedRange = range.end !== undefined && range.end > lineCount
    ? { start: range.start, end: lineCount }
    : range;
  const nextFragment = formatFinderLineFragment(clampedRange);
  url.hash = nextFragment;
  const nextDisplay = displayText.replace(FINDER_DISPLAY_LINE_SUFFIX_PATTERN, `#${nextFragment}`);
  return `[${nextDisplay}](${url.href})`;
}

/**
 * Clamp or remove impossible finder-produced `file://...#Lx-Ly` fragments
 * before exposing worker output to callers. Finder workers cite files from
 * model-generated text, so the parent process performs a final filesystem
 * check against the current workspace to prevent impossible line links.
 */
export function sanitizeFinderFileLinks(text: string, cwd: string): string {
  if (text.length === 0) return text;
  finderLineCountCache.clear();
  return text.replace(FINDER_FILE_LINK_PATTERN, (_match, displayText: string, target: string) => {
    return sanitizeFinderFileLink(displayText, target, cwd);
  });
}

function sanitizeFinderTrailText(text: string | undefined, cwd: string): string | undefined {
  return text === undefined ? undefined : sanitizeFinderFileLinks(text, cwd);
}

function sanitizeFinderTrail(trail: readonly MmrWorkerTrailItem[], cwd: string): MmrWorkerTrailItem[] {
  return trail.map((item): MmrWorkerTrailItem => {
    switch (item.type) {
      case "user":
      case "assistant":
      case "thinking":
        return { ...item, text: sanitizeFinderFileLinks(item.text, cwd) };
      case "toolResult": {
        const text = sanitizeFinderTrailText(item.text, cwd);
        return text === undefined ? { ...item } : { ...item, text };
      }
      case "bashExecution": {
        const output = sanitizeFinderTrailText(item.output, cwd);
        return output === undefined ? { ...item } : { ...item, output };
      }
      case "compactionSummary":
        return { ...item, summary: sanitizeFinderFileLinks(item.summary, cwd) };
      case "branchSummary":
        return { ...item, summary: sanitizeFinderFileLinks(item.summary, cwd) };
      case "custom": {
        const text = sanitizeFinderTrailText(item.text, cwd);
        return text === undefined ? { ...item } : { ...item, text };
      }
      case "skillInvocation": {
        const text = sanitizeFinderTrailText(item.text, cwd);
        return text === undefined ? { ...item } : { ...item, text };
      }
      case "tool":
        return { ...item };
      default: {
        const _exhaustive: never = item;
        void _exhaustive;
        return item;
      }
    }
  });
}

function firstTextContent(content: ToolResultEvent["content"]): string | undefined {
  const first = content.find((entry) => entry.type === "text") as { type: "text"; text: string } | undefined;
  return typeof first?.text === "string" ? first.text : undefined;
}

function getReadOffset(input: Record<string, unknown>): number {
  const offset = input.offset;
  if (typeof offset === "number" && Number.isSafeInteger(offset) && offset > 0) return offset;
  return 1;
}

function padLineNumber(lineNumber: number, width: number): string {
  return String(lineNumber).padStart(width, " ");
}

/**
 * Add stable 1-indexed line prefixes to text returned by Pi's native `read`
 * tool while a finder subagent is active. Pi's read tool accepts `offset`,
 * so the first returned content line is numbered from that offset.
 */
export function addLineNumbersToFinderReadText(text: string, offset = 1): string {
  if (text.length === 0) return text;
  const lines = text.split("\n");
  const linePrefixWidth = String(offset + Math.max(lines.length - 1, 0)).length;
  return lines
    .map((line, index) => `${padLineNumber(offset + index, linePrefixWidth)}: ${line}`)
    .join("\n");
}

export function maybeNumberFinderReadToolResult(
  event: ToolResultEvent,
): { content?: ToolResultEvent["content"] } | undefined {
  if (event.toolName !== "read" || event.isError) return undefined;
  const state = getMmrSubagentState();
  if (state?.profile !== FINDER_SUBAGENT_PROFILE) return undefined;
  const text = firstTextContent(event.content);
  if (text === undefined) return undefined;
  return {
    content: event.content.map((entry) => {
      if (entry.type !== "text") return entry;
      return { ...entry, text: addLineNumbersToFinderReadText(entry.text, getReadOffset(event.input)) };
    }),
  };
}

function coerceFinderParams(raw: unknown): FinderParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("finder expects an object with a `query` field.");
  }
  const params = checkMmrToolParams(FINDER_TOOL_NAME, FINDER_PARAMETERS_SCHEMA, raw);
  if (params.query.trim().length === 0) {
    throw new Error("finder.query is required and must be a non-empty string.");
  }
  return params;
}

export interface FinderToolDeps {
  /**
   * Generic subagent runner. When set, finder uses this instead of the
   * default child-CLI runner. Preferred entry point for new callers.
   */
  runner?: MmrSubagentRunner;
  /**
   * Legacy seam: run the underlying Pi subagent worker directly.
   * Retained for backward compatibility with existing tests that inject
   * a fake `runMmrSubagentWorker`. Prefer {@link FinderToolDeps.runner};
   * when both are set, `runner` wins and a one-line console warning is
   * emitted (test-misconfiguration signal only).
   */
  runWorker?: typeof runMmrSubagentWorker;
  /**
   * Override the ordered worker-model preference list. When set, this
   * value wins over both the settings-driven
   * `subagentModelPreferences.finder` block and the profile defaults;
   * useful for tests and host integrations that want to pin a
   * preference without touching `.pi/settings.json`. Fed straight into
   * the shared `selectMmrModelRoute` registry resolver.
   */
  modelPreferences?: readonly MmrModelPreference[];
  /**
   * Settings-driven override: when present, expanded via
   * `expandMmrModelPreferencesToStrings` and used as the preference
   * list. Wins over the profile defaults but loses to an explicit
   * `modelPreferences`. When omitted, `execute()` reads
   * `loadMmrCoreSettings(cwd).settings.subagentModelPreferences.finder`
   * on every invocation so a `/mmr-config` update takes effect on the
   * next call, matching the child activation path.
   */
  subagentModelPreferencesOverride?: readonly MmrModelPreference[];
  /**
   * Settings loader seam. Defaults to `loadMmrCoreSettings(cwd)`. Tests
   * inject a deterministic loader to assert the settings read happens
   * on every execute.
   */
  loadSubagentModelPreferences?: (cwd: string) =>
    | Pick<LoadedMmrCoreSettings["settings"], "subagentModelPreferences">
    | undefined;
  /** Override the worker output byte cap. */
  outputByteLimit?: number;
  /** Override prompt text while still flowing through the subagent surface API. Tests inject deterministic text. */
  buildSystemPrompt?: (cwd: string) => string;
  /** Pi host, captured by registerFinderTool so child startup can keep provider/extension paths. */
  pi?: ToolHostLike;
  /**
   * Forwarded to {@link runMmrSubagentWorker} as its second argument. Used
   * by tests and smoke scripts that need to inject a custom subprocess
   * spawner or a fixed Pi invocation resolver (the default resolver
   * inherits the parent process's `argv[1]`, which is only meaningful when
   * finder runs inside a Pi parent process).
   */
  runnerDeps?: MmrWorkerRunnerDeps;
}

/**
 * Stub `FinderDetails` used while the worker is still running. The runner
 * has not surfaced an exit code, stderr, args, etc. yet, so this snapshot
 * fills the typed fields with safe placeholders and the live values it
 * does know (`model`, `cwd`, `workerTools`, partial `usage`, and the
 * worker's first reported model/stopReason/errorMessage if any). The
 * final `execute` return value rebuilds the real `FinderDetails` from the
 * full {@link MmrWorkerResult}.
 */
function buildProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  resolvedModel: string | undefined,
  cwd: string,
  contextWindow: number | undefined,
): FinderDetails {
  const base = buildSpawnedProgressDetailsBase({
    snapshot,
    cwd,
    workerTools: FINDER_WORKER_TOOLS,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    // Sanitize finder file links locally; the shared helper takes the
    // sanitized trail verbatim.
    trail: sanitizeFinderTrail(snapshot.trail ?? [], cwd),
  });
  return { worker: "mmr-subagents.finder", ...base };
}

function buildDetails(
  result: MmrWorkerResult,
  resolvedModel: string | undefined,
  cwd: string,
  contextWindow: number | undefined,
): FinderDetails {
  const base = buildSpawnedFinalDetailsBase({
    result,
    cwd,
    workerTools: FINDER_WORKER_TOOLS,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    // Sanitize finder file links locally; the shared helper takes the
    // sanitized trail verbatim and forwards spawnError /
    // subagentActivationError so the renderer keeps showing a
    // deterministic spawn-failed line for runner spawn errors.
    trail: sanitizeFinderTrail(result.trail ?? [], cwd),
  });
  const status = classifyMmrWorkerOutcomeForProfile(result, requireFinderProfile());
  return { worker: "mmr-subagents.finder", status, ...base };
}

function buildFinalContent(result: MmrWorkerResult, cwd: string): string {
  // Failure-state precedence is owned by the shared worker-outcome
  // classifier under the finder profile's nonzero-exit policy. The
  // classifier guarantees that `spawn-error`, `activation-error`,
  // `aborted`, and `worker-error` win over output rendering, and the
  // human-readable message below mirrors that precedence for
  // finder-specific phrasing. The structured `result.spawnError` field
  // also takes precedence over `result.errorMessage` text so
  // spawn-failure reasons (`spawn ENOENT`, `EACCES`, etc.) are not lost
  // when stderr is empty.
  const outcome = classifyMmrWorkerOutcomeForProfile(result, requireFinderProfile());
  if (outcome === "spawn-error") {
    const reason = result.spawnError ?? result.errorMessage ?? "unknown spawn error";
    return `finder: worker spawn failed: ${reason}`;
  }
  if (outcome === "activation-error") {
    return `finder: subagent activation failed: ${result.subagentActivationError}`;
  }
  if (outcome === "aborted") {
    return "finder: search was cancelled before producing a result.";
  }
  if (outcome === "worker-error") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detailText = tail.length > 0 ? tail : (result.errorMessage ?? "");
    const detail = detailText.length > 0 ? `\n\n${detailText}` : "";
    return `finder: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  if (outcome === "no-agent-start") {
    // The worker exited cleanly without ever entering the agent loop.
    // This is observably different from "the model produced no result"
    // and almost always means another Pi extension's `input` event hook
    // consumed the prompt before any provider call could happen.
    // Surface the actionable diagnostic instead of the cheerful empty
    // result so operators look at stderr, not their query.
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `finder: worker exited before the agent loop started. The prompt was not processed by the worker model; another Pi extension's input handler likely consumed it. Check stderr for extension diagnostics.${detail}`;
  }
  if (outcome === "success") {
    const text = result.truncatedFinalOutput || result.finalOutput;
    return sanitizeFinderFileLinks(text, cwd);
  }
  // empty-output
  if (result.errorMessage && result.errorMessage.length > 0) {
    return `finder: worker reported an error: ${result.errorMessage}`;
  }
  return "finder: no relevant evidence found. Try a narrower or differently scoped query.";
}

function assembleFinderSystemPrompt(
  cwd: string,
  buildSystemPrompt: ((cwd: string) => string) | undefined,
): string {
  const profile = requireFinderProfile();
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
 * Default parent-side finder invocation resolution: the shared
 * `resolveMmrSubagentInvocation` against `ctx.modelRegistry`. Returns a
 * `model.no-route` failure when the context exposes no registry; the
 * finder spec runs in degrade mode, so that failure means "spawn with
 * no explicit --model and let the child resolve the route" rather than
 * a pre-spawn error.
 */
function resolveFinderInvocation(
  input: MmrWorkerToolResolveInput,
): MmrSubagentInvocation {
  const profile = requireFinderProfile();
  const registry = resolveCtxMmrModelRegistry(input.ctx);
  if (!registry) {
    return {
      ok: false,
      profile,
      code: "model.no-route",
      message: "finder could not resolve a model registry from the extension context; expected ctx.modelRegistry to expose getAll/find.",
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
function finderToolBlueprint(deps: FinderToolDeps): {
  spec: MmrWorkerToolSpec<FinderParams, FinderDetails>;
  factoryOptions: Parameters<typeof createWorkerTool<FinderParams, FinderDetails>>[2];
} {
  const effectiveRunner = resolveEffectiveRunner(deps, "createFinderTool");
  return {
    spec: {
      toolName: FINDER_TOOL_NAME,
      profileName: FINDER_SUBAGENT_PROFILE,
      description: FINDER_DESCRIPTION,
      promptSnippet: FINDER_PROMPT_SNIPPET,
      promptGuidelines: FINDER_PROMPT_GUIDELINES,
      parameters: finderParameters,
      progressPlaceholder: FINDER_PROGRESS_PLACEHOLDER,
      // Invalid params propagate as a thrown error to the Pi tool host
      // (the long-standing finder contract), so no paramsFailure here.
      backgroundCapable: true,
      coerceParams: coerceFinderParams,
      resolveInvocation: resolveFinderInvocation,
      resolutionFailure: "degrade",
      // The child Pi process computes its own workerTools via
      // `resolveMmrSubagentInvocation` against its registered-tool
      // inventory. Skipping explicit --tools keeps parent and child
      // agreement even if the child's `read`/`grep`/`find` registry
      // diverges from the parent's, preventing a spurious tools.mismatch
      // failure at child activation time.
      mirrorWorkerTools: false,
      detailsWorkerTools: "profile-constant",
      workerToolsConstant: FINDER_WORKER_TOOLS,
      progressModelBinding: "per-attempt",
      buildUserPrompt: (params) => params.query,
      assembleSystemPrompt: (cwd) => assembleFinderSystemPrompt(cwd, deps.buildSystemPrompt),
      resolveContextWindow: (ctx, model) => resolveMmrWorkerModelContextWindowFromCtx(ctx, model),
      candidatePreferences: () => requireFinderProfile().modelPreferences,
      buildProgressDetails: (snapshot, runCtx) =>
        buildProgressDetails(snapshot, runCtx.resolvedModel, runCtx.cwd, runCtx.contextWindow),
      buildFinalDetails: (result, runCtx) =>
        buildDetails(result, runCtx.resolvedModel, runCtx.cwd, runCtx.contextWindow),
      buildFinalContent: (result, runCtx) => buildFinalContent(result, runCtx.cwd),
      describeRun: (params) => ({
        description: `finder: ${clipMmrWorkerDescription(params.query)}`,
        displayPrompt: params.query,
      }),
    },
    factoryOptions: {
      effectiveRunner,
      resolveModelPreferencesOverride: (cwd) =>
        resolveWorkerModelPreferencesOverride({
          profileName: FINDER_SUBAGENT_PROFILE,
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

export function createFinderTool(deps: FinderToolDeps = {}): ToolDefinition {
  const { spec, factoryOptions } = finderToolBlueprint(deps);
  return createWorkerTool(spec, deps, factoryOptions);
}

/** Background-surface seam: prepare a registry-ready finder run from raw params. */
export function createFinderRunPreparer(deps: FinderToolDeps = {}): MmrWorkerRunPreparer<FinderDetails> {
  const { spec, factoryOptions } = finderToolBlueprint(deps);
  return createWorkerRunPreparer(spec, deps, factoryOptions);
}

/**
 * Register the finder Pi tool on the supplied extension API and record it as
 * MMR-owned so Free mode strips it like every other MMR-authored tool.
 */
export function registerFinderTool(pi: ExtensionAPI, deps: FinderToolDeps = {}): ToolDefinition {
  const definition = createFinderTool({ ...deps, pi });
  registerMmrOwnedTool(FINDER_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
