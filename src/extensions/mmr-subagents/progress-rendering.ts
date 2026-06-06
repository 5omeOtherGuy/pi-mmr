import { homedir } from "node:os";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentToolResult,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { isRecord } from "../mmr-core/internal/json.js";
import type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskBoardEntry,
} from "./async-task-registry.js";
import type { MmrWorkerTrailItem, MmrWorkerUsageStats } from "./runner.js";
import {
  formatMmrWorkerTokens,
  stripMmrWorkerModelProvider,
} from "./worker-usage-format.js";

type TrailToolStatus = Extract<MmrWorkerTrailItem, { type: "tool" }>["status"];
type AssistantMessageInput = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
type BranchSummaryMessageInput = ConstructorParameters<typeof BranchSummaryMessageComponent>[0];
type CompactionSummaryMessageInput = ConstructorParameters<typeof CompactionSummaryMessageComponent>[0];
type CustomMessageInput = ConstructorParameters<typeof CustomMessageComponent>[0];
type SkillBlockInput = ConstructorParameters<typeof SkillInvocationMessageComponent>[0];

/**
 * Subagent-tool status discriminator the producing tool may set on
 * `result.details.status` to make the rendered row reflect the tool's
 * own outcome policy. Task uses this for the spec's §9.4 precedence;
 * other subagents (finder, oracle, history-reader) keep status
 * undefined and the renderer derives status from raw fields.
 *
 * `"success"` is rendered as the green succeeded row even when the
 * underlying `exitCode` or `signal` would otherwise look like a
 * failure (e.g. Task non-zero exit with usable final text). Any other
 * known value renders as failed. Unknown strings fall back to the
 * raw-field heuristic, which is the existing behavior.
 */
const SUBAGENT_DETAILS_STATUS_VALUES = new Set([
  "success",
  "validation-error",
  "activation-error",
  "aborted",
  "spawn-error",
  "worker-error",
  "no-agent-start",
  "empty-output",
]);

export const ASYNC_TASK_COMPLETION_CUSTOM_TYPE = "mmr-subagents.async-task-completion" as const;

/**
 * Structured payload carried on the async-task completion push message's
 * `details`. The renderer reads this instead of parsing the model-facing
 * XML `content`. `description` is included so the row can show the task
 * label without scraping the XML; older replayed messages may omit it.
 */
export interface AsyncTaskCompletionDetails {
  version: 1;
  kind: typeof ASYNC_TASK_COMPLETION_CUSTOM_TYPE;
  taskId: string;
  status: string;
  description?: string;
  outcomeText?: string;
}

interface BackgroundTaskDetails {
  worker?: string;
  tool?: string;
  agent?: string;
  taskId?: string;
  groupId?: string;
  status?: string;
  terminalOutcome?: string;
  board?: unknown;
  group?: unknown;
  description?: string;
  /** Full worker prompt/query, used as the rendered Markdown task body. */
  prompt?: string;
  finalOutput?: string;
  /** Projected subagent details (model, usage, trail) for the rich card. */
  final?: unknown;
  /** Resolved worker model id; header/usage fallback before first progress. */
  resolvedModel?: string;
  /** Worker context window; usage-line fallback before first progress. */
  contextWindow?: number;
  errorMessage?: string;
}

interface SubagentProgressDetails {
  model?: string;
  reportedModel?: string;
  contextWindow?: number;
  usage?: MmrWorkerUsageStats;
  errorMessage?: string;
  stopReason?: string;
  subagentActivationError?: string;
  spawnError?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  aborted?: boolean;
  trail?: readonly MmrWorkerTrailItem[];
  description?: string;
  prompt?: string;
  task?: string;
  query?: string;
  /**
   * Producing tool's outcome discriminator. When set to a known
   * `TaskStatus`-shaped value, the renderer prefers it over deriving
   * status from raw exit fields. Tools that do not set it (finder /
   * oracle / history-reader today) keep the legacy raw-field path.
   */
  status?: string;
  /**
   * User-facing advisory shown only in the rendered result (never placed
   * in the model-consumed `content`). Custom Markdown subagents set this
   * when they relied on a fallback for `model`, thinking level, or
   * `tools`. Other subagents leave it unset.
   */
  fallbackNotice?: string;
}

interface SubagentTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
}

interface RenderContextLike {
  args?: unknown;
  isError?: boolean;
  isPartial?: boolean;
  showImages?: boolean;
  cwd?: string;
  state?: unknown;
  executionStarted?: boolean;
  argsComplete?: boolean;
  expanded?: boolean;
  lastComponent?: unknown;
}

type RenderStatus = "running" | "succeeded" | "failed";

const RESULT_RENDERED_STATE_KEY = "mmrSubagentResultRendered";
const CALL_COMPONENT_STATE_KEY = "mmrSubagentCallComponent";

const NOOP_TUI = {
  requestRender() {
    // Nested transcript components are rendered inside this tool result;
    // the parent component owns invalidation, so child requests are no-ops.
  },
} as unknown as TUI;

function textContent(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

function compactOneLine(value: string, limit = 140): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

// Token / model-name formatting is shared with mmr-history's
// history-reader render path via worker-usage-format.ts. Local aliases
// keep the existing call-site names short.
const stripProvider = stripMmrWorkerModelProvider;
const formatTokens = formatMmrWorkerTokens;

function subagentStatusName(toolName: string): string {
  return toolName === "Task" ? "task" : toolName;
}

function formatWorkerContextUsage(
  usage: MmrWorkerUsageStats | undefined,
  contextWindow: number | undefined,
): string | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const contextTokens = usage?.contextTokens ?? 0;
  return `${((contextTokens / contextWindow) * 100).toFixed(1)}%/${formatTokens(contextWindow)}`;
}

function formatWorkerStatusLeft(
  usage: MmrWorkerUsageStats | undefined,
  contextWindow: number | undefined,
): string {
  const parts: string[] = [];
  if (usage) {
    if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
    if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  }
  const context = formatWorkerContextUsage(usage, contextWindow);
  if (context) parts.push(context);
  return parts.join(" ");
}

function formatWorkerStatusLine(
  toolName: string,
  usage: MmrWorkerUsageStats | undefined,
  contextWindow: number | undefined,
  model: string | undefined,
  width: number,
): string {
  if (width <= 0) return "";
  let left = formatWorkerStatusLeft(usage, contextWindow);
  const right = [model, subagentStatusName(toolName)].filter((part): part is string => typeof part === "string" && part.length > 0).join(" • ");

  let leftWidth = visibleWidth(left);
  if (leftWidth > width) {
    left = truncateToWidth(left, width, "...");
    leftWidth = visibleWidth(left);
  }

  if (!right) return left;
  if (!left) return `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${truncateToWidth(right, width, "")}`;

  const rightWidth = visibleWidth(right);
  const minPadding = 2;
  if (leftWidth + minPadding + rightWidth <= width) {
    return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
  }

  const availableRight = width - leftWidth - minPadding;
  if (availableRight > 0) {
    const truncatedRight = truncateToWidth(right, availableRight, "");
    return `${left}${" ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)))}${truncatedRight}`;
  }

  return left;
}

class WorkerStatusLineComponent implements Component {
  private readonly toolName: string;
  private readonly usage: MmrWorkerUsageStats | undefined;
  private readonly contextWindow: number | undefined;
  private readonly model: string | undefined;
  private readonly theme: SubagentTheme;

  constructor(
    toolName: string,
    usage: MmrWorkerUsageStats | undefined,
    contextWindow: number | undefined,
    model: string | undefined,
    theme: SubagentTheme,
  ) {
    this.toolName = toolName;
    this.usage = usage;
    this.contextWindow = contextWindow;
    this.model = model;
    this.theme = theme;
  }

  render(width: number): string[] {
    const line = formatWorkerStatusLine(this.toolName, this.usage, this.contextWindow, this.model, width);
    return [this.theme.fg("dim", line)];
  }

  invalidate(): void {
    // Stateless: line is computed from the current render width.
  }
}

function isSuccessfulStopReason(stopReason: string | undefined): boolean {
  if (!stopReason) return true;
  return stopReason === "end_turn" || stopReason === "stop" || stopReason === "toolUse";
}

function statusFromDetails(
  details: SubagentProgressDetails | undefined,
  isPartial: boolean,
  context: RenderContextLike | undefined,
): RenderStatus {
  if (isPartial) return "running";
  // When the producing tool stamped a known outcome discriminator on
  // `details.status`, trust it. This lets Task's §9.4 policy (non-zero
  // exit with usable final text == success) render correctly without
  // the renderer recomputing failure from raw exit fields. Unknown
  // string values fall through to the legacy heuristic.
  if (typeof details?.status === "string" && SUBAGENT_DETAILS_STATUS_VALUES.has(details.status)) {
    return details.status === "success" ? "succeeded" : "failed";
  }
  if (details?.aborted || details?.stopReason === "aborted") return "failed";
  if (context?.isError === true || details?.subagentActivationError) return "failed";
  if (details?.exitCode !== undefined && details.exitCode !== null && details.exitCode !== 0) return "failed";
  if (details?.signal) return "failed";
  if (details?.errorMessage) return "failed";
  if (!isSuccessfulStopReason(details?.stopReason)) return "failed";
  return "succeeded";
}

function statusColor(status: RenderStatus | TrailToolStatus): string {
  if (status === "failed") return "error";
  if (status === "running") return "warning";
  return "success";
}

function statusBgColor(status: RenderStatus): string {
  if (status === "failed") return "toolErrorBg";
  if (status === "running") return "toolPendingBg";
  return "toolSuccessBg";
}

function statusBgFn(status: RenderStatus, theme: SubagentTheme): (text: string) => string {
  return (text: string) => theme.bg?.(statusBgColor(status), text) ?? text;
}

function successBgFn(theme: SubagentTheme): (text: string) => string {
  return (text: string) => theme.bg?.("toolSuccessBg", text) ?? text;
}

function statusLabel(status: RenderStatus | TrailToolStatus): string {
  if (status === "running") return "running...";
  if (status === "succeeded" || status === "completed") return "completed";
  return status;
}

function formatTitle(toolName: string, model: string | undefined, theme: SubagentTheme): string {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  return model ? `${title} ${theme.fg("muted", "•")} ${theme.fg("accent", model)}` : title;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function operationLabel(
  toolName: string,
  details: SubagentProgressDetails | undefined,
  context: RenderContextLike | undefined,
): string | undefined {
  const args = context?.args;
  const fromArgs = toolName === "Task"
    ? readStringField(args, "description") ?? readStringField(args, "prompt")
    : toolName === "oracle"
      ? readStringField(args, "task")
      : readStringField(args, "query");
  return fromArgs
    ?? details?.description
    ?? details?.task
    ?? details?.query
    ?? details?.prompt;
}

function expandedOperationLabel(
  toolName: string,
  details: SubagentProgressDetails | undefined,
  context: RenderContextLike | undefined,
): string | undefined {
  const args = context?.args;
  if (toolName === "Task") return readStringField(args, "prompt") ?? details?.prompt ?? operationLabel(toolName, details, context);
  if (toolName === "oracle") return readStringField(args, "task") ?? details?.task ?? operationLabel(toolName, details, context);
  return readStringField(args, "query") ?? details?.query ?? operationLabel(toolName, details, context);
}

function operationLabelFromArgs(toolName: string, args: unknown): string | undefined {
  if (toolName === "Task") return readStringField(args, "description") ?? readStringField(args, "prompt");
  if (toolName === "oracle") return readStringField(args, "task");
  return readStringField(args, "query");
}

function normalizeStartTaskAgent(raw: unknown): string | undefined {
  if (raw === undefined) return "Task";
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "task" || normalized === "task-subagent") return "Task";
  if (normalized === "finder") return "finder";
  if (normalized === "librarian") return "librarian";
  return undefined;
}

function startTaskParamsFromArgs(args: unknown, agent: string): unknown {
  if (!isRecord(args)) return undefined;
  if (args.params !== undefined) return args.params;
  if (agent === "Task") {
    return { prompt: args.prompt, description: args.description };
  }
  const prompt = readStringField(args, "prompt");
  return prompt ? { query: prompt } : undefined;
}

function startTaskPromptFromArgs(args: unknown, agent: string): string | undefined {
  const params = startTaskParamsFromArgs(args, agent);
  if (agent === "Task") return readStringField(params, "prompt") ?? readStringField(args, "prompt");
  return readStringField(params, "query") ?? readStringField(args, "prompt");
}

function startTaskDescriptionFromArgs(args: unknown, agent: string, prompt: string | undefined): string | undefined {
  const params = startTaskParamsFromArgs(args, agent);
  return readStringField(args, "description")
    ?? (agent === "Task" ? readStringField(params, "description") : undefined)
    ?? `${agent}: ${prompt ? compactOneLine(prompt, 80) : "background run"}`;
}

function startTaskDisplayFromArgs(args: unknown): { details: BackgroundTaskDetails; collapsed?: string; expanded?: string } | undefined {
  if (!isRecord(args)) return undefined;
  const agent = normalizeStartTaskAgent(args.agent);
  if (!agent) return undefined;
  const expanded = startTaskPromptFromArgs(args, agent);
  const collapsed = startTaskDescriptionFromArgs(args, agent, expanded);
  return {
    details: {
      worker: "mmr-subagents.async-task",
      tool: "start_task",
      agent,
      status: "running",
      description: collapsed,
      ...(expanded !== undefined ? { prompt: expanded } : {}),
    },
    collapsed,
    expanded,
  };
}

function parseArgsPreview(preview: string | undefined): unknown {
  if (!preview) return undefined;
  try {
    return JSON.parse(preview);
  } catch {
    return undefined;
  }
}

function unescapeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}

function readPreviewStringField(preview: string | undefined, key: string): string | undefined {
  if (!preview) return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`).exec(preview);
  const value = match?.[1];
  if (value === undefined) return undefined;
  const decoded = unescapeJsonStringFragment(value).trim();
  return decoded.length > 0 ? decoded : undefined;
}

function readPreviewNumberField(preview: string | undefined, key: string): number | undefined {
  if (!preview) return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(preview);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function readPreviewBooleanField(preview: string | undefined, key: string): boolean | undefined {
  if (!preview) return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*(true|false)`).exec(preview);
  if (!match?.[1]) return undefined;
  return match[1] === "true";
}

function addStringArg(args: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined) args[key] = value;
}

function addNumberArg(args: Record<string, unknown>, key: string, value: number | undefined): void {
  if (value !== undefined) args[key] = value;
}

function addBooleanArg(args: Record<string, unknown>, key: string, value: boolean | undefined): void {
  if (value !== undefined) args[key] = value;
}

function extractedArgsFromPreview(toolName: string, preview: string | undefined): Record<string, unknown> | undefined {
  if (!preview) return undefined;
  const args: Record<string, unknown> = {};
  if (toolName === "read") {
    addStringArg(args, "path", readPreviewStringField(preview, "path") ?? readPreviewStringField(preview, "file_path"));
    addNumberArg(args, "offset", readPreviewNumberField(preview, "offset"));
    addNumberArg(args, "limit", readPreviewNumberField(preview, "limit"));
  } else if (toolName === "grep") {
    addStringArg(args, "pattern", readPreviewStringField(preview, "pattern"));
    addStringArg(args, "path", readPreviewStringField(preview, "path"));
    addStringArg(args, "glob", readPreviewStringField(preview, "glob"));
    addBooleanArg(args, "ignoreCase", readPreviewBooleanField(preview, "ignoreCase"));
    addBooleanArg(args, "literal", readPreviewBooleanField(preview, "literal"));
    addNumberArg(args, "context", readPreviewNumberField(preview, "context"));
    addNumberArg(args, "limit", readPreviewNumberField(preview, "limit"));
  } else if (toolName === "find") {
    addStringArg(args, "path", readPreviewStringField(preview, "path"));
    addStringArg(args, "pattern", readPreviewStringField(preview, "pattern"));
  } else if (toolName === "bash") {
    addStringArg(args, "command", readPreviewStringField(preview, "command"));
  } else if (toolName === "ls") {
    addStringArg(args, "path", readPreviewStringField(preview, "path"));
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

function structuredArgsFromPreview(toolName: string, preview: string | undefined): Record<string, unknown> | undefined {
  const parsed = parseArgsPreview(preview);
  if (isRecord(parsed)) return parsed;
  return extractedArgsFromPreview(toolName, preview);
}

function shortenPath(filePath: string): string {
  const home = homedir();
  if (home && filePath === home) return "~";
  if (home && filePath.startsWith(`${home}/`)) return `~${filePath.slice(home.length)}`;
  return filePath;
}

function formatLineRange(args: Record<string, unknown>): string {
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : undefined;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : undefined;
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  return end !== undefined && end !== start ? `:${start}-${end}` : `:${start}`;
}

function quoteForDisplay(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function formatToolArguments(item: Extract<MmrWorkerTrailItem, { type: "tool" }>): string {
  // Prefer structured args if available; fall back to parsing preview for legacy trails
  const parsed = isRecord(item.args) ? item.args : structuredArgsFromPreview(item.toolName, item.argsPreview);
  if (isRecord(parsed)) {
    if (item.toolName === "read") {
      const rawPath = readStringField(parsed, "path") ?? readStringField(parsed, "file_path");
      return rawPath ? `${shortenPath(rawPath)}${formatLineRange(parsed)}` : (item.argsPreview ?? "");
    }
    if (item.toolName === "bash") {
      return readStringField(parsed, "command") ?? item.argsPreview ?? "";
    }
    if (item.toolName === "grep") {
      const pattern = readStringField(parsed, "pattern");
      const path = readStringField(parsed, "path") ?? readStringField(parsed, "include");
      return [pattern ? quoteForDisplay(pattern) : undefined, path ? shortenPath(path) : undefined]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" ");
    }
    if (item.toolName === "find") {
      const path = readStringField(parsed, "path");
      const pattern = readStringField(parsed, "pattern");
      return [path ? shortenPath(path) : undefined, pattern ? quoteForDisplay(pattern) : undefined]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" ");
    }
  }
  return item.argsPreview ?? "";
}

function imageAttachmentText(count: number | undefined): string | undefined {
  if (!count || count <= 0) return undefined;
  return `${count} image${count === 1 ? "" : "s"} attached`;
}

function addImageAttachmentNote(
  container: Container,
  count: number | undefined,
  theme: SubagentTheme,
  paddingX = 1,
): void {
  const images = imageAttachmentText(count);
  if (images) container.addChild(new Text(theme.fg("muted", images), paddingX, 0));
}

function normalizedForMatch(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function stripWorkerPromptPrefixes(value: string): string {
  let stripped = value.trim();
  while (/^Task:\s*/i.test(stripped)) {
    stripped = stripped.replace(/^Task:\s*/i, "");
  }
  return stripped;
}

function workerPromptFromArgs(
  toolName: string,
  details: SubagentProgressDetails | undefined,
  context: RenderContextLike | undefined,
): string | undefined {
  const args = context?.args;
  if (toolName === "Task") return readStringField(args, "prompt") ?? details?.prompt;
  if (toolName === "oracle") return readStringField(args, "task") ?? details?.task;
  return readStringField(args, "query") ?? details?.query;
}

function isWorkerPromptEcho(text: string, workerPrompt: string | undefined): boolean {
  const prompt = normalizedForMatch(stripWorkerPromptPrefixes(workerPrompt ?? ""));
  if (!prompt) return false;
  const candidate = normalizedForMatch(stripWorkerPromptPrefixes(text));
  if (candidate === prompt) return true;
  return candidate.startsWith(`${prompt} Context:`) || candidate.startsWith(`${prompt} Attached files:`);
}

function isDuplicateFinalOutput(text: string, output: string): boolean {
  const trailText = normalizedForMatch(text);
  const finalText = normalizedForMatch(output);
  if (!trailText || !finalText) return false;
  if (trailText === finalText) return true;
  return trailText.endsWith("…") && finalText.startsWith(trailText.slice(0, -1).trim());
}

function finalAssistantTrailIndex(trail: readonly MmrWorkerTrailItem[], output: string): number | undefined {
  if (!output.trim()) return undefined;
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const item = trail[index];
    if (item?.type !== "assistant") continue;
    return isDuplicateFinalOutput(item.text, output) ? index : undefined;
  }
  return undefined;
}

function addMarkdownBlock(
  container: Container,
  text: string | undefined,
  theme: SubagentTheme,
  options: { color?: string; italic?: boolean; paddingX?: number } = {},
): boolean {
  const body = text?.trim();
  if (!body) return false;
  const color = options.color;
  container.addChild(new Markdown(
    body,
    options.paddingX ?? 1,
    0,
    getMarkdownTheme(),
    {
      ...(color ? { color: (value: string) => theme.fg(color, value) } : {}),
      ...(options.italic ? { italic: true } : {}),
    },
  ));
  return true;
}

function taskPreview(text: string, expanded: boolean, maxLines = 10): { body: string; hint?: string } {
  const body = text.trim();
  if (expanded || !body) return { body };
  const lines = body.split(/\r?\n/);
  if (lines.length <= maxLines) return { body, hint: "(ctrl+o to expand)" };
  const visibleLines = lines.slice(0, maxLines).join("\n").trimEnd();
  return {
    body: visibleLines,
    hint: `... (${lines.length - maxLines} more lines, ${lines.length} total, ctrl+o to expand)`,
  };
}

function normalizedTaskBody(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? text;
}

function taskPreviewForDisplay(
  collapsedText: string | undefined,
  expandedText: string | undefined,
  expanded: boolean,
  maxLines = 10,
): { body: string; hint?: string } {
  const collapsed = collapsedText?.trim();
  const full = expandedText?.trim();
  if (expanded) return taskPreview(full ?? collapsed ?? "", true, maxLines);
  if (collapsed && full && normalizedTaskBody(collapsed) !== normalizedTaskBody(full)) {
    return { body: collapsed, hint: "(ctrl+o to expand)" };
  }
  if (collapsed) return taskPreview(collapsed, false, maxLines);
  if (!full) return { body: "" };
  const summary = compactOneLine(firstNonEmptyLine(full));
  if (normalizedTaskBody(summary) !== normalizedTaskBody(full)) {
    return { body: summary, hint: "(ctrl+o to expand)" };
  }
  return taskPreview(full, false, maxLines);
}

function addTaskBox(
  container: Container,
  toolName: string,
  details: SubagentProgressDetails | undefined,
  operation: string | undefined,
  expanded: boolean,
  status: RenderStatus,
  theme: SubagentTheme,
  expandedOperation = operation,
): boolean {
  const box = new Box(1, 1, statusBgFn(status, theme));
  box.addChild(new Text(renderHeaderLine(toolName, status, details, theme), 0, 0));
  const preview = taskPreviewForDisplay(operation, expandedOperation, expanded);
  const hasOperation = addMarkdownBlock(box, preview.body, theme, { paddingX: 1 });
  if (preview.hint) box.addChild(new Text(theme.fg("muted", preview.hint), 1, 0));
  const hasDiagnostic = addDiagnostic(box, diagnosticMessage(details, status), status, theme);
  container.addChild(box);
  return hasOperation || hasDiagnostic;
}

function addFallbackNoticeBlock(container: Container, notice: string | undefined, theme: SubagentTheme): boolean {
  const body = notice?.trim();
  if (!body) return false;
  container.addChild(new Spacer(1));
  return addMarkdownBlock(container, body, theme, { color: "warning", paddingX: 1 });
}

function addFinalOutputBox(container: Container, output: string, theme: SubagentTheme): boolean {
  const body = output.trim();
  if (!body) return false;
  const box = new Box(1, 1, successBgFn(theme));
  addMarkdownBlock(box, body, theme, { paddingX: 1 });
  container.addChild(box);
  return true;
}

function renderUserTrailComponent(item: Extract<MmrWorkerTrailItem, { type: "user" }>, theme: SubagentTheme): Component | undefined {
  const text = item.text.trim();
  if (!text && !item.imageCount) return undefined;
  try {
    if (!item.imageCount) return new UserMessageComponent(text, getMarkdownTheme());
    const container = new Container();
    if (text) container.addChild(new UserMessageComponent(text, getMarkdownTheme()));
    addImageAttachmentNote(container, item.imageCount, theme);
    return container;
  } catch {
    const container = new Container();
    container.addChild(new Spacer(1));
    const addedText = addMarkdownBlock(container, item.text, theme, { color: "userMessageText" });
    addImageAttachmentNote(container, item.imageCount, theme);
    return addedText || item.imageCount ? container : undefined;
  }
}

function renderAssistantTrailComponent(text: string, theme: SubagentTheme, thinking = false): Component | undefined {
  const body = text.trim();
  if (!body) return undefined;
  try {
    const content = thinking
      ? [{ type: "thinking" as const, thinking: body }]
      : [{ type: "text" as const, text: body }];
    const message: AssistantMessageInput = { role: "assistant", content } as AssistantMessageInput;
    return new AssistantMessageComponent(message, false, getMarkdownTheme());
  } catch {
    const container = new Container();
    container.addChild(new Spacer(1));
    const added = addMarkdownBlock(container, text, theme, thinking ? { color: "thinkingText", italic: true } : {});
    return added ? container : undefined;
  }
}

function genericToolComponent(
  toolName: string | undefined,
  argsPreview: string | undefined,
  output: string | undefined,
  isError: boolean | undefined,
  theme: SubagentTheme,
  imageCount?: number,
): Component | undefined {
  const name = toolName?.trim();
  const body = output?.trim();
  if (!name && !argsPreview && !body && !imageCount) return undefined;
  const container = new Container();
  container.addChild(new Spacer(1));
  const head = [
    name ? theme.fg("toolTitle", theme.bold(name)) : undefined,
    argsPreview ? theme.fg("accent", compactOneLine(argsPreview, 180)) : undefined,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
  if (head) container.addChild(new Text(head, 1, 0));
  if (body) container.addChild(new Text(theme.fg(isError ? "error" : "toolOutput", body), 1, 0));
  addImageAttachmentNote(container, imageCount, theme);
  return container;
}

function renderToolTrailComponent(
  item: Extract<MmrWorkerTrailItem, { type: "tool" }>,
  theme: SubagentTheme,
  context: RenderContextLike | undefined,
): Component | undefined {
  // Prefer structured args if available; fall back to parsing preview for legacy trails
  const parsedArgs = isRecord(item.args) ? item.args : structuredArgsFromPreview(item.toolName, item.argsPreview);
  if (item.argsPreview && !isRecord(parsedArgs)) {
    return genericToolComponent(
      item.toolName,
      formatToolArguments(item),
      item.status === "running" ? item.updatePreview : item.resultPreview ?? item.updatePreview,
      item.status === "failed" || item.isError === true,
      theme,
    );
  }

  try {
    const component = new ToolExecutionComponent(
      item.toolName,
      item.toolCallId,
      isRecord(parsedArgs) ? parsedArgs : undefined,
      { showImages: context?.showImages ?? false },
      undefined,
      NOOP_TUI,
      context?.cwd ?? process.cwd(),
    );
    component.setExpanded(true);
    component.markExecutionStarted();
    const resultText = item.status === "running" ? item.updatePreview : item.resultPreview ?? item.updatePreview;
    if (item.status !== "running" || resultText) {
      component.updateResult(
        {
          content: resultText ? [{ type: "text", text: resultText }] : [],
          isError: item.status === "failed" || item.isError === true,
        },
        item.status === "running",
      );
    }
    return component;
  } catch {
    return genericToolComponent(
      item.toolName,
      formatToolArguments(item),
      item.status === "running" ? item.updatePreview : item.resultPreview ?? item.updatePreview,
      item.status === "failed" || item.isError === true,
      theme,
    );
  }
}

function renderToolResultTrailComponent(
  item: Extract<MmrWorkerTrailItem, { type: "toolResult" }>,
  theme: SubagentTheme,
  context: RenderContextLike | undefined,
): Component | undefined {
  if (!item.toolName) return genericToolComponent(undefined, undefined, item.text, item.isError, theme, item.imageCount);
  try {
    const component = new ToolExecutionComponent(
      item.toolName,
      item.toolCallId ?? `tool-result-${item.toolName}`,
      undefined,
      { showImages: context?.showImages ?? false },
      undefined,
      NOOP_TUI,
      context?.cwd ?? process.cwd(),
    );
    component.setExpanded(true);
    component.markExecutionStarted();
    component.updateResult(
      {
        content: item.text ? [{ type: "text", text: item.text }] : [],
        isError: item.isError === true,
      },
      false,
    );
    return component;
  } catch {
    return genericToolComponent(item.toolName, undefined, item.text, item.isError, theme, item.imageCount);
  }
}

function renderBashExecutionTrailComponent(
  item: Extract<MmrWorkerTrailItem, { type: "bashExecution" }>,
  theme: SubagentTheme,
): Component | undefined {
  if (!item.command && !item.output) return undefined;
  if (!item.command) return genericToolComponent("bash", undefined, item.output, item.exitCode !== 0, theme);
  try {
    const component = new BashExecutionComponent(item.command, NOOP_TUI);
    component.setExpanded(true);
    if (item.output) component.appendOutput(item.output);
    component.setComplete(item.exitCode, item.cancelled === true);
    return component;
  } catch {
    return genericToolComponent("bash", item.command, item.output, item.exitCode !== 0, theme);
  }
}

function renderLabeledMarkdownComponent(
  label: string,
  body: string | undefined,
  theme: SubagentTheme,
  detail?: string,
): Component | undefined {
  const container = new Container();
  container.addChild(new Spacer(1));
  const labelText = theme.fg("customMessageLabel", theme.bold(`[${label}]`));
  container.addChild(new Text(detail ? `${labelText} ${theme.fg("customMessageText", detail)}` : labelText, 1, 0));
  const addedBody = addMarkdownBlock(container, body, theme, { color: "customMessageText" });
  return addedBody || detail ? container : undefined;
}

function renderSkillTrailComponent(
  item: Extract<MmrWorkerTrailItem, { type: "skillInvocation" }>,
  theme: SubagentTheme,
): Component | undefined {
  const name = item.name?.trim() || "skill";
  const content = item.text?.trim() ?? "";
  if (!name && !content) return undefined;
  try {
    const component = new SkillInvocationMessageComponent({
      name,
      location: item.location ?? "",
      content,
      userMessage: undefined,
    } satisfies SkillBlockInput, getMarkdownTheme());
    component.setExpanded(true);
    return component;
  } catch {
    return renderLabeledMarkdownComponent("skill", item.text, theme, item.name);
  }
}

function renderCompactionTrailComponent(
  item: Extract<MmrWorkerTrailItem, { type: "compactionSummary" }>,
  theme: SubagentTheme,
): Component | undefined {
  try {
    const component = new CompactionSummaryMessageComponent({
      role: "compactionSummary",
      summary: item.summary,
      tokensBefore: item.tokensBefore ?? 0,
      timestamp: 0,
    } satisfies CompactionSummaryMessageInput, getMarkdownTheme());
    component.setExpanded(true);
    return component;
  } catch {
    return renderLabeledMarkdownComponent(
      "compaction",
      item.summary,
      theme,
      item.tokensBefore !== undefined ? `Compacted from ${formatTokens(item.tokensBefore)} tokens` : "Compaction summary",
    );
  }
}

function renderBranchTrailComponent(
  item: Extract<MmrWorkerTrailItem, { type: "branchSummary" }>,
  theme: SubagentTheme,
): Component | undefined {
  try {
    const component = new BranchSummaryMessageComponent({
      role: "branchSummary",
      summary: item.summary,
      fromId: "subagent-worker",
      timestamp: 0,
    } satisfies BranchSummaryMessageInput, getMarkdownTheme());
    component.setExpanded(true);
    return component;
  } catch {
    return renderLabeledMarkdownComponent("branch", item.summary, theme, "Branch summary");
  }
}

function renderCustomTrailComponent(
  item: Extract<MmrWorkerTrailItem, { type: "custom" }>,
  theme: SubagentTheme,
): Component | undefined {
  const customType = item.customType?.trim() || "custom";
  const text = item.text?.trim() ?? "";
  if (!customType && !text && !item.imageCount) return undefined;
  try {
    const content = item.imageCount && !text ? `${item.imageCount} image${item.imageCount === 1 ? "" : "s"} attached` : text;
    return new CustomMessageComponent({
      role: "custom",
      customType,
      content,
      display: true,
      timestamp: 0,
    } satisfies CustomMessageInput, undefined, getMarkdownTheme());
  } catch {
    return renderLabeledMarkdownComponent(customType, item.text, theme);
  }
}

function renderSingleTrailComponent(
  item: MmrWorkerTrailItem,
  theme: SubagentTheme,
  context: RenderContextLike | undefined,
): Component | undefined {
  switch (item.type) {
    case "user":
      return renderUserTrailComponent(item, theme);
    case "assistant":
      return renderAssistantTrailComponent(item.text, theme);
    case "thinking":
      return renderAssistantTrailComponent(item.text, theme, true);
    case "tool":
      return renderToolTrailComponent(item, theme, context);
    case "toolResult":
      return renderToolResultTrailComponent(item, theme, context);
    case "bashExecution":
      return renderBashExecutionTrailComponent(item, theme);
    case "compactionSummary":
      return renderCompactionTrailComponent(item, theme);
    case "branchSummary":
      return renderBranchTrailComponent(item, theme);
    case "custom":
      return renderCustomTrailComponent(item, theme);
    case "skillInvocation":
      return renderSkillTrailComponent(item, theme);
    default: {
      // Compile-time exhaustiveness: new MmrWorkerTrailItem variants must add a
      // case above instead of silently rendering nothing.
      const _exhaustive: never = item;
      void _exhaustive;
      return undefined;
    }
  }
}

function addTrailComponents(
  container: Container,
  trail: readonly MmrWorkerTrailItem[],
  output: string,
  theme: SubagentTheme,
  context: RenderContextLike | undefined,
  workerPrompt: string | undefined,
  suppressDuplicateFinalOutput: boolean,
): boolean {
  let added = false;
  const duplicateFinalIndex = suppressDuplicateFinalOutput ? finalAssistantTrailIndex(trail, output) : undefined;
  for (let index = 0; index < trail.length; index += 1) {
    const item = trail[index];
    if (!item) continue;
    if (item.type === "user" && isWorkerPromptEcho(item.text, workerPrompt)) continue;
    if (index === duplicateFinalIndex) continue;
    const component = renderSingleTrailComponent(item, theme, context);
    if (!component) continue;
    container.addChild(component);
    added = true;
  }
  return added;
}

function renderHeaderLine(
  toolName: string,
  status: RenderStatus,
  details: SubagentProgressDetails | undefined,
  theme: SubagentTheme,
): string {
  const model = stripProvider(details?.reportedModel ?? details?.model);
  const title = formatTitle(toolName, model, theme);
  return `${title}  ${theme.fg(statusColor(status), statusLabel(status))}`;
}

function backgroundTaskRenderStatus(status: string | undefined): RenderStatus | undefined {
  if (status === "running" || status === "cancelling") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "cancelled") return "failed";
  return undefined;
}

/**
 * One Pi-native status glyph for background tasks, mirroring the working
 * indicator / task-list language: a braille loader frame for in-flight work,
 * `✓` succeeded, `✕` failed, `–` cancelled. Static (result and board rows
 * are poll snapshots, not animated). Kept as a local constant — pi-tui does
 * not export its loader frames and cross-extension coupling is unwarranted
 * for a single glyph.
 */
const PI_LOADER_GLYPH = "⠋";

function backgroundStatusGlyph(status: string | undefined): string {
  if (status === "running" || status === "cancelling") return PI_LOADER_GLYPH;
  if (status === "succeeded") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "–";
  return "•";
}

function backgroundStatusColor(status: string | undefined): string {
  if (status === "running" || status === "cancelling") return "warning";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  // cancelled / unknown: neutral. A user-initiated cancel is not an error.
  return "muted";
}

function backgroundStatusBgFn(
  status: string | undefined,
  theme: SubagentTheme,
): (text: string) => string {
  if (status === "succeeded") return (text) => theme.bg?.("toolSuccessBg", text) ?? text;
  if (status === "failed") return (text) => theme.bg?.("toolErrorBg", text) ?? text;
  if (status === "running" || status === "cancelling") {
    return (text) => theme.bg?.("toolPendingBg", text) ?? text;
  }
  // cancelled / unknown: neutral background so an intentional cancel never
  // reads as a hard failure.
  return (text) => text;
}

function backgroundTaskStatusLabel(status: string | undefined): string {
  // The `background` badge already conveys placement, so the status word does
  // not repeat it ("running", not "running in background").
  if (status === "running") return "running";
  if (status === "cancelling") return "cancelling";
  if (status === "succeeded") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return status ?? "background";
}

function backgroundStatusBadge(
  status: string | undefined,
  theme: SubagentTheme,
): string {
  const color = backgroundStatusColor(status);
  return `${theme.fg(color, backgroundStatusGlyph(status))} ${theme.fg(color, backgroundTaskStatusLabel(status))}`;
}

function backgroundTaskHeaderLine(
  details: BackgroundTaskDetails,
  model: string | undefined,
  theme: SubagentTheme,
): string {
  const title = formatTitle(details.agent ?? "background task", model, theme);
  const badge = theme.fg("muted", "background");
  const outcome = details.terminalOutcome === "partial" ? ` ${theme.fg("warning", "partial")}` : "";
  return `${title} ${theme.fg("muted", "•")} ${badge}  ${backgroundStatusBadge(details.status, theme)}${outcome}`;
}

function backgroundTaskDisplayText(
  details: BackgroundTaskDetails,
  subDetails: SubagentProgressDetails,
  startDisplay: { collapsed?: string; expanded?: string } | undefined,
): { collapsed?: string; expanded?: string } {
  const expanded = details.prompt
    ?? startDisplay?.expanded
    ?? subDetails.query
    ?? subDetails.prompt
    ?? subDetails.task
    ?? subDetails.description
    ?? details.description;
  const collapsed = details.description
    ?? startDisplay?.collapsed
    ?? subDetails.description
    ?? subDetails.query
    ?? subDetails.task
    ?? subDetails.prompt
    ?? expanded;
  return { collapsed, expanded };
}

const BACKGROUND_STATUS_VALUES: ReadonlySet<string> = new Set([
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);
const BACKGROUND_FRESHNESS_VALUES: ReadonlySet<string> = new Set([
  "healthy",
  "stalled",
  "dead",
  "terminal",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Validate only the fields the board renderer reads. The producer always emits
// the full entry; this localized narrowing keeps a malformed/replayed payload
// from reaching the row formatter (which would mis-render or throw).
function isBackgroundTaskBoardEntry(value: unknown): value is MmrAsyncTaskBoardEntry {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.agent === "string" &&
    typeof value.description === "string" &&
    typeof value.status === "string" &&
    BACKGROUND_STATUS_VALUES.has(value.status) &&
    typeof value.freshness === "string" &&
    BACKGROUND_FRESHNESS_VALUES.has(value.freshness)
  );
}

function isBackgroundTaskBoard(value: unknown): value is MmrAsyncTaskBoard {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.counts)) return false;
  const counts = value.counts;
  if (
    !isFiniteNumber(counts.active) ||
    !isFiniteNumber(counts.stalled) ||
    !isFiniteNumber(counts.finished)
  ) {
    return false;
  }
  return (
    Array.isArray(value.active) && value.active.every(isBackgroundTaskBoardEntry) &&
    Array.isArray(value.stalled) && value.stalled.every(isBackgroundTaskBoardEntry) &&
    Array.isArray(value.finished) && value.finished.every(isBackgroundTaskBoardEntry)
  );
}

function backgroundBoardEntryLine(entry: MmrAsyncTaskBoardEntry, theme: SubagentTheme): string {
  const color = backgroundStatusColor(entry.status);
  const glyph = theme.fg(color, backgroundStatusGlyph(entry.status));
  const id = theme.fg("accent", entry.taskId);
  const agent = theme.fg("muted", entry.agent);
  const desc = entry.description
    ? ` ${theme.fg("muted", `"${compactOneLine(entry.description, 60)}"`)}`
    : "";
  const fresh = entry.freshness !== "healthy" && entry.freshness !== "terminal"
    ? ` ${theme.fg(entry.freshness === "dead" ? "error" : "warning", `[${entry.freshness}]`)}`
    : "";
  const group = entry.groupId ? ` ${theme.fg("dim", entry.groupId)}` : "";
  const partial = entry.terminalOutcome === "partial" ? ` ${theme.fg("warning", "[partial]")}` : "";
  return `  ${glyph} ${id} ${agent}${desc}${group}${partial}${fresh}`;
}

/**
 * Compact grouped board for `task_poll` with no task id. Renders the same
 * structured counts/sections the model receives, but as a glyph-led TUI board
 * instead of a plain-text dump. Returns undefined for malformed/legacy board
 * payloads so the caller can fall back to the text content.
 */
function renderBackgroundTaskBoard(value: unknown, theme: SubagentTheme): Component | undefined {
  if (!isBackgroundTaskBoard(value)) return undefined;
  const board = value;
  const container = new Container();
  const total = board.counts.active + board.counts.stalled + board.counts.finished;
  const headGlyph = board.counts.active > 0
    ? theme.fg("warning", PI_LOADER_GLYPH)
    : theme.fg("muted", "•");
  const counts = theme.fg(
    "muted",
    `${board.counts.active} active • ${board.counts.stalled} stalled • ${board.counts.finished} finished`,
  );
  container.addChild(
    new Text(`${theme.fg("toolTitle", theme.bold("background tasks"))}  ${headGlyph} ${counts}`, 1, 0),
  );
  if (total === 0) {
    container.addChild(new Text(theme.fg("muted", "No background tasks in this session."), 1, 0));
    return container;
  }
  const section = (title: string, entries: readonly MmrAsyncTaskBoardEntry[]): void => {
    if (entries.length === 0) return;
    container.addChild(new Text(theme.fg("dim", title), 1, 0));
    for (const entry of entries) {
      container.addChild(new Text(backgroundBoardEntryLine(entry, theme), 1, 0));
    }
  };
  section("Active", board.active);
  section("Stalled", board.stalled);
  section("Finished", board.finished);
  return container;
}

function addDiagnostic(
  container: Container,
  message: string | undefined,
  status: RenderStatus,
  theme: SubagentTheme,
): boolean {
  if (!message) return false;
  // A preserved provider `errorMessage` on a non-failed run (e.g. a
  // transient 429 before a usable final answer) is informational, not a
  // failure, so render it as a warning rather than an error.
  const color = status === "failed" ? "error" : "warning";
  container.addChild(new Text(theme.fg(color, compactOneLine(message)), 0, 0));
  return true;
}

function diagnosticMessage(details: SubagentProgressDetails | undefined, status: RenderStatus): string | undefined {
  // Diagnostic precedence: spawn-error is the most specific and most
  // user-actionable (typically a missing/broken `pi` binary on PATH),
  // so surface it explicitly before the generic errorMessage that the
  // runner mirrors from the same Error.
  if (details?.spawnError) return `Spawn failed: ${details.spawnError}`;
  if (details?.subagentActivationError) return details.subagentActivationError;
  if (details?.errorMessage) return details.errorMessage;
  if (status === "failed" && !isSuccessfulStopReason(details?.stopReason)) return details?.stopReason ?? "Worker failed.";
  return undefined;
}

function renderState(context: RenderContextLike | undefined): Record<string, unknown> | undefined {
  return isRecord(context?.state) ? context.state : undefined;
}

function rememberCallComponent(context: RenderContextLike | undefined, component: Component): void {
  const state = renderState(context);
  if (state) state[CALL_COMPONENT_STATE_KEY] = component;
}

function clearRenderedCall(context: RenderContextLike | undefined): void {
  const component = renderState(context)?.[CALL_COMPONENT_STATE_KEY];
  if (component instanceof Text) component.setText("");
  else if (component instanceof Container) component.clear();
  else if (component instanceof Box) component.clear();
}

function markResultRendered(context: RenderContextLike | undefined): void {
  const state = renderState(context);
  if (state) state[RESULT_RENDERED_STATE_KEY] = true;
}

function resultAlreadyRendered(context: RenderContextLike | undefined): boolean {
  return renderState(context)?.[RESULT_RENDERED_STATE_KEY] === true;
}

export function renderMmrBackgroundTaskCall(
  toolName: string,
  args: unknown,
  theme: SubagentTheme,
  context?: RenderContextLike,
): Component {
  if (toolName !== "start_task") return new Container();
  const display = startTaskDisplayFromArgs(args);
  if (!display) return new Container();
  const box = new Box(1, 1, backgroundStatusBgFn("running", theme));
  box.addChild(new Text(backgroundTaskHeaderLine(display.details, undefined, theme), 0, 0));
  const preview = taskPreviewForDisplay(display.collapsed, display.expanded, context?.expanded === true);
  addMarkdownBlock(box, preview.body, theme, { paddingX: 1 });
  if (preview.hint) box.addChild(new Text(theme.fg("muted", preview.hint), 1, 0));
  rememberCallComponent(context, box);
  return box;
}

export function renderMmrBackgroundTaskResult(
  _toolName: string,
  result: AgentToolResult<unknown>,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: SubagentTheme,
  context?: RenderContextLike,
): Component {
  const details = result.details as BackgroundTaskDetails | undefined;
  const output = textContent(result).trim();

  if (details?.board !== undefined) {
    const boardComponent = renderBackgroundTaskBoard(details.board, theme);
    if (boardComponent) return boardComponent;
    const container = new Container();
    addMarkdownBlock(container, output, theme, { paddingX: 1 });
    return container;
  }

  if (details?.group !== undefined) {
    const container = new Container();
    addMarkdownBlock(container, output, theme, { paddingX: 1 });
    return container;
  }

  if (details?.worker !== "mmr-subagents.async-task") {
    const container = new Container();
    addMarkdownBlock(container, output, theme, { paddingX: 1 });
    return container;
  }

  if (details.tool === "start_task") clearRenderedCall(context);

  const renderStatus = backgroundTaskRenderStatus(details.status);
  if (!renderStatus || !details.taskId || !details.agent) {
    const container = new Container();
    addMarkdownBlock(container, output || details.errorMessage, theme, { paddingX: 1 });
    return container;
  }

  // Reuse the subagent rendering building blocks so a polled background result
  // matches a blocking subagent (model in the header, Markdown task body,
  // trail, usage line), while keeping background-specific status semantics
  // (neutral cancelled, the `background` badge).
  const subDetails = (isRecord(details.final) ? details.final : {}) as SubagentProgressDetails;
  const model = stripProvider(subDetails.reportedModel ?? subDetails.model ?? details.resolvedModel);
  const contextWindow = subDetails.contextWindow ?? details.contextWindow;
  const expanded = options.expanded === true;
  const startDisplay = details.tool === "start_task" ? startTaskDisplayFromArgs(context?.args) : undefined;
  const operation = backgroundTaskDisplayText(details, subDetails, startDisplay);

  const container = new Container();
  const box = new Box(1, 1, backgroundStatusBgFn(details.status, theme));
  box.addChild(new Text(backgroundTaskHeaderLine(details, model, theme), 0, 0));
  const preview = taskPreviewForDisplay(operation.collapsed, operation.expanded, expanded);
  addMarkdownBlock(box, preview.body, theme, { paddingX: 1 });
  if (preview.hint) box.addChild(new Text(theme.fg("muted", preview.hint), 1, 0));
  // Gate the error diagnostic on the raw status, not the coarse renderStatus
  // (which folds cancelled into failed). A user-initiated cancel is neutral and
  // must not surface an error-colored diagnostic.
  if (details.errorMessage && details.status === "failed") {
    addDiagnostic(box, details.errorMessage, renderStatus, theme);
  }
  container.addChild(box);

  const cleanFinal = details.finalOutput?.trim() ?? "";
  const trail = subDetails.trail ?? [];
  if (expanded && trail.length > 0) {
    container.addChild(new Spacer(1));
    addTrailComponents(container, trail, cleanFinal, theme, context, operation.expanded ?? operation.collapsed, true);
  }

  if (cleanFinal && renderStatus !== "running") {
    container.addChild(new Spacer(1));
    addFinalOutputBox(container, cleanFinal, theme);
  }

  if (renderStatus !== "running" && (subDetails.usage || model)) {
    container.addChild(new Spacer(1));
    container.addChild(
      new WorkerStatusLineComponent(details.agent, subDetails.usage, contextWindow, model, theme),
    );
  }

  return container;
}

function asyncTaskCompletionHeaderLine(
  details: AsyncTaskCompletionDetails | undefined,
  theme: SubagentTheme,
): string {
  const title = theme.fg("toolTitle", theme.bold("background task"));
  const badge = theme.fg("muted", "finished");
  return `${title} ${theme.fg("muted", "•")} ${badge}  ${backgroundStatusBadge(details?.status, theme)}`;
}

/**
 * Renderer for the `mmr-subagents.async-task-completion` push message.
 *
 * The message `content` stays the model-facing `<task-notification>` XML
 * (the agent consumes it next turn); this renderer draws the human-facing
 * row from the structured `details` instead of dumping that XML into the
 * transcript. Returning `undefined` (e.g. malformed or legacy details)
 * makes the host fall back to its default custom-message box.
 */
export const renderAsyncTaskCompletionMessage: MessageRenderer<AsyncTaskCompletionDetails> = (
  message,
  _options,
  theme,
) => {
  try {
    const details = message.details;
    const box = new Box(1, 1, backgroundStatusBgFn(details?.status, theme));
    box.addChild(new Text(asyncTaskCompletionHeaderLine(details, theme), 0, 0));
    addMarkdownBlock(box, details?.description, theme, { paddingX: 1 });
    addMarkdownBlock(box, details?.outcomeText, theme, { paddingX: 1 });
    const taskId = details?.taskId?.trim();
    if (taskId) {
      box.addChild(new Text(theme.fg("muted", `task_poll({task_id:"${taskId}"})`), 0, 0));
    }
    const container = new Container();
    container.addChild(box);
    return container;
  } catch {
    return undefined;
  }
};

export function renderMmrSubagentCall(
  toolName: string,
  args: unknown,
  theme: SubagentTheme,
  context?: RenderContextLike,
): Component {
  if (context?.isPartial === false || resultAlreadyRendered(context)) return new Container();
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const label = operationLabelFromArgs(toolName, args);
  const component = context?.lastComponent instanceof Box ? context.lastComponent : new Box(1, 1, statusBgFn("running", theme));
  component.setBgFn(statusBgFn("running", theme));
  component.clear();
  component.addChild(new Text(title, 0, 0));
  if (label?.trim()) {
    addMarkdownBlock(component, label, theme, { paddingX: 1 });
  }
  rememberCallComponent(context, component);
  return component;
}

export function renderMmrSubagentResult(
  toolName: string,
  result: AgentToolResult<unknown>,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: SubagentTheme,
  context?: RenderContextLike,
): Component {
  const details = result.details as SubagentProgressDetails | undefined;
  const output = textContent(result).trim();
  const expanded = options.expanded === true;
  const isPartial = options.isPartial === true;
  const model = stripProvider(details?.reportedModel ?? details?.model);
  const status = statusFromDetails(details, isPartial, context);
  const operation = operationLabel(toolName, details, context);
  const expandedOperation = expandedOperationLabel(toolName, details, context);
  const container = new Container();
  clearRenderedCall(context);
  markResultRendered(context);

  const hasTaskBody = addTaskBox(container, toolName, details, operation, expanded, status, theme, expandedOperation);
  addFallbackNoticeBlock(container, details?.fallbackNotice, theme);

  if (!expanded) {
    if (!isPartial && output) {
      container.addChild(new Spacer(1));
      addFinalOutputBox(container, output, theme);
    }
    if (!isPartial && (details?.usage || model)) {
      container.addChild(new Spacer(1));
      container.addChild(new WorkerStatusLineComponent(toolName, details?.usage, details?.contextWindow, model, theme));
    }
    return container;
  }

  const trail = details?.trail ?? [];
  const hasTrail = addTrailComponents(
    container,
    trail,
    output,
    theme,
    context,
    workerPromptFromArgs(toolName, details, context),
    !isPartial,
  );

  if (!isPartial && output) {
    if (hasTrail || hasTaskBody) container.addChild(new Spacer(1));
    addFinalOutputBox(container, output, theme);
  }

  if (!isPartial && (details?.usage || model)) {
    container.addChild(new Spacer(1));
    container.addChild(new WorkerStatusLineComponent(toolName, details?.usage, details?.contextWindow, model, theme));
  }

  return container;
}
