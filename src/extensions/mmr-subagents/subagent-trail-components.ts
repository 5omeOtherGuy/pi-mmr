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
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { isRecord } from "../mmr-core/internal/json.js";
import type { MmrWorkerTrailItem, MmrWorkerUsageStats } from "./runner.js";
import {
  compactOneLine,
  diagnosticMessage,
  formatTitle,
  formatTokens,
  formatWorkerStatusLine,
  statusBgFn,
  statusColor,
  statusLabel,
  stripProvider,
  successBgFn,
  type RenderContextLike,
  type RenderStatus,
  type SubagentProgressDetails,
  type SubagentTheme,
} from "./subagent-render-format.js";
import {
  addImageAttachmentNote,
  finalAssistantTrailIndex,
  formatToolArguments,
  isWorkerPromptEcho,
  structuredArgsFromPreview,
} from "./tool-argument-display.js";

type AssistantMessageInput = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
type BranchSummaryMessageInput = ConstructorParameters<typeof BranchSummaryMessageComponent>[0];
type CompactionSummaryMessageInput = ConstructorParameters<typeof CompactionSummaryMessageComponent>[0];
type CustomMessageInput = ConstructorParameters<typeof CustomMessageComponent>[0];
type SkillBlockInput = ConstructorParameters<typeof SkillInvocationMessageComponent>[0];

const NOOP_TUI = {
  requestRender() {
    // Nested transcript components are rendered inside this tool result;
    // the parent component owns invalidation, so child requests are no-ops.
  },
} as unknown as TUI;

export class WorkerStatusLineComponent implements Component {
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

export function addMarkdownBlock(
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

export function taskPreviewForDisplay(
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

export function addDiagnostic(
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

export function addTaskBox(
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

export function addFallbackNoticeBlock(container: Container, notice: string | undefined, theme: SubagentTheme): boolean {
  const body = notice?.trim();
  if (!body) return false;
  container.addChild(new Spacer(1));
  return addMarkdownBlock(container, body, theme, { color: "warning", paddingX: 1 });
}

export function addFinalOutputBox(container: Container, output: string, theme: SubagentTheme): boolean {
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

export function addTrailComponents(
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
