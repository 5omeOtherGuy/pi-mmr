import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isRecord } from "../mmr-core/internal/json.js";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { getMmrModeStateSnapshot } from "../mmr-core/runtime.js";
import { registerMmrSubagentPromptBuilder } from "../mmr-core/subagent-prompt-assembly.js";
import {
  registerMmrSubagentProfile,
  type MmrSubagentProfile,
} from "../mmr-core/subagent-profiles.js";
import { selectMmrModelRoute } from "../mmr-core/model-resolver.js";
import type { MmrModelPreference } from "../mmr-core/types.js";
import {
  type MmrCustomSubagentDefinition,
  MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS,
  MMR_CUSTOM_SUBAGENT_TOOL_PREFIX,
  discoverMmrCustomSubagentsSync,
  isUnsafeMmrCustomSubagentToolPattern,
} from "./custom-loader.js";
import { renderMmrSubagentCall, renderMmrSubagentResult } from "./progress-rendering.js";
import {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  classifyMmrWorkerOutcome,
  createChildCliMmrSubagentRunner,
  createMmrSubagentRunnerFromRunWorker,
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
  progressTextOrPlaceholder,
} from "./worker-result-shaping.js";
import {
  resolveCtxMmrModelRegistry,
  resolveMmrWorkerModelContextWindowFromCtx,
} from "./worker-model-metadata.js";
import { resolveMmrSubagentInvocation } from "../mmr-core/subagent-resolver.js";

export const CUSTOM_SUBAGENT_PARAMETERS_SCHEMA = Type.Object(
  {
    task: Type.String({
      description: "The concrete task, question, or request for this custom Markdown subagent.",
    }),
  },
  { additionalProperties: false },
);

export type CustomSubagentParams = Static<typeof CUSTOM_SUBAGENT_PARAMETERS_SCHEMA>;

export interface CustomSubagentDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: string;
  status?: MmrWorkerOutcomeStatus;
  toolName: string;
  definitionName: string;
  filePath: string;
  prompt: string;
  /**
   * User-facing notice emitted when the subagent relied on a fallback for
   * `model`, thinking/effort level, or `tools` (including running with no
   * tools). Recommends the author pin those fields. Absent when all three
   * were declared.
   */
  fallbackNotice?: string;
}

export interface CustomSubagentToolDeps {
  runner?: MmrSubagentRunner;
  runWorker?: typeof runMmrSubagentWorker;
  runnerDeps?: MmrWorkerRunnerDeps;
  outputByteLimit?: number;
}

export interface RegisterMmrCustomSubagentToolsOptions extends CustomSubagentToolDeps {
  roots?: readonly string[];
  cwd?: string;
  homeDir?: string;
  definitions?: readonly MmrCustomSubagentDefinition[];
}

function defaultCustomSubagentRoots(cwd: string, home = homedir()): string[] {
  return [path.join(cwd, ".claude", "agents"), path.join(home, ".claude", "agents")];
}

export function getDefaultMmrCustomSubagentRoots(cwd: string, homeDir?: string): readonly string[] {
  return defaultCustomSubagentRoots(cwd, homeDir);
}

function toModelPreference(model: string): MmrModelPreference | undefined {
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed === "inherit") return undefined;
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return { providers: [trimmed.slice(0, slash)], model: trimmed.slice(slash + 1) };
  }
  return { model: trimmed };
}

function readCurrentModelPreference(ctx: unknown): MmrModelPreference | undefined {
  if (!isRecord(ctx)) return undefined;
  const model = ctx.model;
  if (!isRecord(model)) return undefined;
  const id = typeof model.id === "string" ? model.id : undefined;
  if (!id) return undefined;
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  return provider ? { providers: [provider], model: id } : { model: id };
}

function preferencesForDefinition(definition: MmrCustomSubagentDefinition): readonly MmrModelPreference[] {
  const preference = toModelPreference(definition.model);
  return preference ? [preference] : [];
}

/**
 * Effective tool intent for a custom subagent: the author's declared
 * `tools:` list, or the standard default toolset when no `tools` key was
 * written at all. An explicitly empty list (declared with no entries) stays
 * empty so an author can deliberately run a prompt-only subagent.
 */
function effectiveCustomSubagentToolPatterns(definition: MmrCustomSubagentDefinition): readonly string[] {
  return definition.toolsDeclared ? definition.toolPatterns : MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS;
}

function createProfile(definition: MmrCustomSubagentDefinition): MmrSubagentProfile {
  return {
    name: definition.toolName,
    displayName: definition.name,
    modelPreferences: preferencesForDefinition(definition),
    tools: [...effectiveCustomSubagentToolPatterns(definition)],
    ...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
    denyTools: [
      "Task",
      "oracle",
      "librarian",
      "handoff",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
      "apply_patch",
      "read_mcp_resource",
    ],
    promptRoute: "standalone",
    promptBuilder: definition.toolName,
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  };
}

function coerceParams(raw: unknown): { ok: true; value: CustomSubagentParams } | { ok: false; message: string } {
  if (!isRecord(raw) || typeof raw.task !== "string" || raw.task.trim().length === 0) {
    return { ok: false, message: "Custom subagent requires a non-empty task string." };
  }
  return { ok: true, value: { task: raw.task } };
}

function resolveRunner(deps: CustomSubagentToolDeps): MmrSubagentRunner {
  if (deps.runner) return deps.runner;
  if (deps.runWorker) return createMmrSubagentRunnerFromRunWorker(deps.runWorker, deps.runnerDeps);
  if (deps.runnerDeps) return createChildCliMmrSubagentRunner(deps.runnerDeps);
  return createChildCliMmrSubagentRunner();
}

function getRegisteredToolNames(pi: ExtensionAPI): string[] {
  return pi.getAllTools().map((tool) => tool.name).filter((name) => typeof name === "string" && name.length > 0);
}

function getParentAllowedRegisteredTools(pi: ExtensionAPI): string[] {
  const registered = new Set(getRegisteredToolNames(pi));
  const active = new Set(pi.getActiveTools().filter((name) => typeof name === "string" && name.length > 0));
  return [...active].filter((name) => registered.has(name));
}

function formatHumanList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Build the user-facing notice shown when a custom subagent relied on a
 * fallback for `model`, thinking/effort level, or `tools`. pi-mmr lowers
 * friction by defaulting an omitted `tools:` key to the standard toolset
 * and inheriting the parent model/thinking level, but it surfaces this so
 * the author can pin the fields for predictable behavior. An explicitly
 * empty `tools` list is reported as "ran with no tools" (a deliberate
 * prompt-only subagent) rather than a default.
 *
 * Returns `undefined` when `model`, thinking level, and a non-empty tools
 * set were all resolved without a fallback.
 */
export function buildMmrCustomSubagentFallbackNotice(
  definition: MmrCustomSubagentDefinition,
  workerTools: readonly string[],
): string | undefined {
  const lines: string[] = [];
  const recommend: string[] = [];
  if (!definition.modelDeclared) {
    lines.push("No model selected — falling back to the parent model.");
    recommend.push("`model`");
  }
  if (definition.thinkingLevel === undefined) {
    lines.push("No effort/thinking level selected — falling back to the parent/default level.");
    recommend.push("`thinkingLevel`");
  }
  if (!definition.toolsDeclared) {
    lines.push("No tools selected — defaulting to the standard toolset (read, bash, edit, write, find, grep, web).");
    recommend.push("`tools`");
  } else if (workerTools.length === 0) {
    lines.push(
      "No tools available — the `tools` list is empty, so this subagent ran with no tools and answered from its prompt only (it could not read files, search, run commands, or edit).",
    );
    recommend.push("a non-empty `tools` list");
  }
  if (lines.length === 0) return undefined;
  const file = path.basename(definition.filePath);
  const body = lines.map((line) => `- ${line}`).join("\n");
  return `Note (${definition.name}):\n${body}\nRecommend setting ${formatHumanList(recommend)} in ${file} for predictable subagent behavior.`;
}

function buildProgressContent(snapshot: MmrWorkerProgressSnapshot, definition: MmrCustomSubagentDefinition): string {
  return progressTextOrPlaceholder(snapshot, `${definition.name}: worker running…`);
}

function buildFinalContent(
  result: MmrWorkerResult,
  definition: MmrCustomSubagentDefinition,
): string {
  // The fallback notice is intentionally NOT prepended here: it is a
  // user-facing advisory surfaced only via `details.fallbackNotice` and the
  // result renderer, so it never enters the model-consumed content.
  const status = classifyMmrWorkerOutcome(result, { partialOutputPolicy: "fail-on-nonzero" });
  const text = result.truncatedFinalOutput || result.finalOutput;
  if (status === "success") {
    return text.trim().length > 0 ? text : `${definition.name}: completed with no output.`;
  }
  return `${definition.name}: worker failed (${status}).${result.errorMessage ? ` ${result.errorMessage}` : ""}${text ? `\n\n${text}` : ""}`;
}

function buildProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  definition: MmrCustomSubagentDefinition,
  ctx: { cwd: string; workerTools: readonly string[]; model?: string; contextWindow?: number; prompt: string },
): CustomSubagentDetails {
  const fallbackNotice = buildMmrCustomSubagentFallbackNotice(definition, ctx.workerTools);
  return {
    worker: `mmr-subagents.${definition.toolName}`,
    toolName: definition.toolName,
    definitionName: definition.name,
    filePath: definition.filePath,
    prompt: ctx.prompt,
    ...(fallbackNotice ? { fallbackNotice } : {}),
    ...buildSpawnedProgressDetailsBase({
      snapshot,
      cwd: ctx.cwd,
      workerTools: ctx.workerTools,
      resolvedModel: ctx.model,
      contextWindow: ctx.contextWindow,
    }),
  };
}

function buildFinalDetails(
  result: MmrWorkerResult,
  definition: MmrCustomSubagentDefinition,
  ctx: { cwd: string; workerTools: readonly string[]; model?: string; contextWindow?: number; prompt: string },
): CustomSubagentDetails {
  const fallbackNotice = buildMmrCustomSubagentFallbackNotice(definition, ctx.workerTools);
  return {
    worker: `mmr-subagents.${definition.toolName}`,
    status: classifyMmrWorkerOutcome(result, { partialOutputPolicy: "fail-on-nonzero" }),
    toolName: definition.toolName,
    definitionName: definition.name,
    filePath: definition.filePath,
    prompt: ctx.prompt,
    ...(fallbackNotice ? { fallbackNotice } : {}),
    ...buildSpawnedFinalDetailsBase({
      result,
      cwd: ctx.cwd,
      workerTools: ctx.workerTools,
      resolvedModel: ctx.model,
      contextWindow: ctx.contextWindow,
    }),
  };
}

export function createMmrCustomSubagentTool(
  pi: ExtensionAPI,
  definition: MmrCustomSubagentDefinition,
  deps: CustomSubagentToolDeps = {},
): ToolDefinition {
  const description = [
    definition.description,
    "",
    `Custom Markdown subagent loaded from ${path.basename(definition.filePath)}.`,
    "Provide a specific task for the worker. The worker runs with the Markdown body as its system prompt and only the requested tools that are registered and active in the parent session.",
  ].join("\n");
  return {
    name: definition.toolName,
    label: definition.name,
    description,
    promptSnippet: definition.description,
    promptGuidelines: [
      `Use ${definition.toolName} when the task matches this custom subagent: ${definition.description}`,
      "Provide a concrete task, relevant files or evidence, constraints, and the expected output shape.",
      "Do not use this custom subagent when a direct tool call or built-in subagent is a better fit.",
    ],
    parameters: CUSTOM_SUBAGENT_PARAMETERS_SCHEMA,
    executionMode: effectiveCustomSubagentToolPatterns(definition).some((tool) => ["bash", "edit", "write", "apply_patch"].includes(tool))
      ? "sequential" as const
      : "parallel" as const,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrSubagentCall(definition.toolName, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrSubagentResult(definition.toolName, result, options, theme, context);
    },
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<CustomSubagentDetails>> {
      const parsed = coerceParams(rawParams);
      if (!parsed.ok) {
        return {
          content: [{ type: "text", text: `${definition.name}: ${parsed.message}` }],
          details: {
            worker: `mmr-subagents.${definition.toolName}`,
            toolName: definition.toolName,
            definitionName: definition.name,
            filePath: definition.filePath,
            prompt: "",
            status: "worker-error",
            exitCode: null,
            signal: null,
            aborted: false,
            outputTruncated: false,
            ignoredJsonLines: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            stderr: "",
            command: "",
            args: [],
            cwd: ctx.cwd,
            workerTools: [],
            trail: [],
            errorMessage: parsed.message,
          },
        };
      }

      const cwd = ctx.cwd;
      const registry = resolveCtxMmrModelRegistry(ctx);
      const parentMode = getMmrModeStateSnapshot()?.mode;
      const modelPreferencesOverride = definition.model === "inherit"
        ? [readCurrentModelPreference(ctx)].filter((entry): entry is MmrModelPreference => Boolean(entry))
        : undefined;
      const profile = modelPreferencesOverride && modelPreferencesOverride.length > 0
        ? { ...createProfile(definition), modelPreferences: modelPreferencesOverride }
        : createProfile(definition);
      const registeredTools = getParentAllowedRegisteredTools(pi);
      const invocation = registry
        ? resolveMmrSubagentInvocation({
            profile,
            registry,
            registeredTools,
            parentActiveTools: pi.getActiveTools(),
            ...(parentMode ? { parentMode } : {}),
          })
        : undefined;
      if (registry && invocation && !invocation.ok) {
        return {
          content: [{ type: "text", text: `${definition.name}: ${invocation.message}` }],
          details: {
            worker: `mmr-subagents.${definition.toolName}`,
            toolName: definition.toolName,
            definitionName: definition.name,
            filePath: definition.filePath,
            prompt: parsed.value.task,
            status: "activation-error",
            exitCode: null,
            signal: null,
            aborted: false,
            outputTruncated: false,
            ignoredJsonLines: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            stderr: "",
            command: "",
            args: [],
            cwd,
            workerTools: invocation.workerTools,
            trail: [],
            errorMessage: invocation.message,
          },
        };
      }
      const model = invocation?.ok
        ? invocation.modelArg
        : registry && modelPreferencesOverride && modelPreferencesOverride.length > 0
          ? selectMmrModelRoute({ modelPreferences: modelPreferencesOverride, registry }).selected
          : undefined;
      const modelArg = typeof model === "string" ? model : model ? `${model.provider}/${model.model}` : undefined;
      const workerTools = invocation?.workerTools
        ?? registeredTools.filter((tool) => effectiveCustomSubagentToolPatterns(definition).includes(tool));
      const contextWindow = resolveMmrWorkerModelContextWindowFromCtx(ctx, modelArg);
      const result = await resolveRunner(deps).run({
        profileName: definition.toolName,
        prompt: parsed.value.task,
        cwd,
        ...(modelArg ? { model: modelArg } : {}),
        tools: workerTools,
        ...(modelPreferencesOverride && modelPreferencesOverride.length > 0 ? { modelPreferencesOverride } : {}),
        systemPrompt: definition.systemPrompt,
        systemPromptDelivery: definition.isolatedContext ? "replace" : "append",
        outputByteLimit: deps.outputByteLimit ?? DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
        signal,
        onProgress: onUpdate
          ? (snapshot) => onUpdate({
              content: [{ type: "text", text: buildProgressContent(snapshot, definition) }],
              details: buildProgressDetails(snapshot, definition, { cwd, workerTools, model: modelArg, contextWindow, prompt: parsed.value.task }),
            })
          : undefined,
      });
      return {
        content: [{ type: "text", text: buildFinalContent(result, definition) }],
        details: buildFinalDetails(result, definition, { cwd, workerTools, model: modelArg, contextWindow, prompt: parsed.value.task }),
      };
    },
  } satisfies ToolDefinition;
}

export function registerMmrCustomSubagentDefinition(
  pi: ExtensionAPI,
  definition: MmrCustomSubagentDefinition,
  deps: CustomSubagentToolDeps = {},
): ToolDefinition {
  const unsafeTool = definition.toolPatterns.find(isUnsafeMmrCustomSubagentToolPattern);
  if (unsafeTool) {
    throw new Error(`custom subagent "${definition.name}" requests denied tool "${unsafeTool}"`);
  }
  registerMmrSubagentProfile(createProfile(definition));
  registerMmrSubagentPromptBuilder(definition.toolName, () => definition.systemPrompt);
  const tool = createMmrCustomSubagentTool(pi, definition, deps);
  registerMmrOwnedTool(definition.toolName);
  pi.registerTool(tool);
  return tool;
}

export function registerMmrCustomSubagentTools(
  pi: ExtensionAPI,
  options: RegisterMmrCustomSubagentToolsOptions = {},
): ToolDefinition[] {
  const cwd = options.cwd ?? process.cwd();
  const roots = options.roots ?? defaultCustomSubagentRoots(cwd, options.homeDir);
  const definitions = options.definitions ?? discoverMmrCustomSubagentsSync({ roots });
  return definitions
    .filter((definition) => definition.toolName.startsWith(MMR_CUSTOM_SUBAGENT_TOOL_PREFIX))
    .filter((definition) => !definition.toolPatterns.some(isUnsafeMmrCustomSubagentToolPattern))
    .map((definition) => registerMmrCustomSubagentDefinition(pi, definition, options));
}
