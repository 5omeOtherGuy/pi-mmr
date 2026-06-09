import {
  type AgentToolResult,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { isRecord } from "../mmr-core/internal/json.js";
import {
  statusBgFn,
  statusFromDetails,
  stripProvider,
  textContent,
  type BackgroundTaskDetails,
  type RenderContextLike,
  type SubagentProgressDetails,
  type SubagentTheme,
} from "./subagent-render-format.js";
import {
  expandedOperationLabel,
  operationLabel,
  operationLabelFromArgs,
  startTaskDisplayFromArgs,
  workerPromptFromArgs,
} from "./tool-argument-display.js";
import {
  addDiagnostic,
  addFallbackNoticeBlock,
  addFinalOutputBox,
  addMarkdownBlock,
  addTaskBox,
  addTrailComponents,
  taskPreviewForDisplay,
  WorkerStatusLineComponent,
} from "./subagent-trail-components.js";
import {
  backgroundStatusBadge,
  backgroundStatusBgFn,
  backgroundTaskDisplayText,
  backgroundTaskHeaderLine,
  backgroundTaskRenderStatus,
  renderBackgroundTaskBoard,
} from "../mmr-async-tasks/background-task-rendering.js";
import {
  currentLoaderFrame,
  groupMembersFromBoard,
  isTerminalRowStatus,
  renderRowLine,
  renderSectionHeader,
  revealedRows,
  singleRowFromBoard,
  synthesizeGroup,
  truncateWidgetLines,
  type RowMetadataLevel,
  type WidgetRow,
  type WidgetSection,
} from "../mmr-async-tasks/background-task-view.js";
import type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskGroupSnapshot,
} from "../mmr-async-tasks/async-task-registry.js";
import type { AsyncTaskFleetDetails, AsyncTaskFleetRow } from "../mmr-async-tasks/async-task-tool-schemas.js";

/**
 * Live-state resolvers for the inline background card. Supplied by the async
 * task tools (which hold the registry) so the card reflects real-time child
 * status; absent on replayed transcripts, where the card falls back to the
 * static `details` snapshot. Mirrors the resolver the aboveEditor widget uses.
 */
export interface BackgroundCardExtras {
  resolveBoard?: (sessionKey: string) => MmrAsyncTaskBoard | undefined;
  resolveGroup?: (sessionKey: string, groupId: string) => MmrAsyncTaskGroupSnapshot | undefined;
}

/**
 * Result of a card `build` thunk: the current lines plus an optional `settled`
 * flag that drives gated spawn cards (see {@link BackgroundCardComponent}).
 */
interface CardBuild {
  lines: readonly string[];
  /**
   * Gated spawn cards only:
   * - `false` — run still in progress; render NOTHING inline.
   * - `true`  — run finished; `lines` are the static completed snapshot.
   * `undefined` — non-gated result card, rendered live every frame.
   */
  settled?: boolean;
}

/**
 * Borderless inline card body: theme-coloured lines truncated to the render
 * width.
 *
 * The lines are produced by a `build` thunk called inside {@link render} on
 * EVERY frame, not baked once at construction. The host's render loop
 * (`requestRender` → `doRender` → `render(width)`) re-invokes a mounted
 * component's `render`, but it does NOT re-run the tool's `renderResult`, so a
 * card that captured live state at construction would freeze.
 *
 * Spawn cards (start_task / fleet declaration / group-opener) are GATED: while
 * the run is in progress the live, animated state lives ONLY in the pinned
 * aboveEditor widget and the inline card renders nothing (`settled === false`).
 * Once the run finishes (`settled === true`) the card LATCHES a static
 * completed snapshot and keeps showing it even after the live board drops the
 * rows. Non-gated result cards (an explicit group task_poll/task_wait/
 * task_cancel) return `settled === undefined` and render live every frame.
 */
class BackgroundCardComponent implements Component {
  private build: (() => CardBuild) | undefined;
  private latched: readonly string[] | undefined;
  constructor(build: () => CardBuild) {
    this.build = build;
  }
  render(width: number): string[] {
    // Once a gated card settles it freezes: keep the completed snapshot even
    // after the live board drops the finished rows.
    if (this.latched !== undefined) return truncateWidgetLines(this.latched, width);
    if (!this.build) return [];
    const { lines, settled } = this.build();
    if (settled === undefined) return truncateWidgetLines(lines, width);
    if (!settled) return [];
    this.latched = lines;
    return truncateWidgetLines(lines, width);
  }
  /** Blank the card so a remembered call card does not duplicate the result. */
  clear(): void {
    this.build = undefined;
    this.latched = undefined;
  }
  invalidate(): void {
    // No cached state beyond the settle latch: the `build` thunk recomputes the
    // lines from the live board on every render(width) call until it latches.
  }
}

/** Synthesize a single display row from a frozen `details` snapshot (replay/no registry). */
function rowFromDetails(details: BackgroundTaskDetails): WidgetRow {
  return {
    taskId: details.taskId ?? "",
    status: details.status ?? "running",
    freshness: "healthy",
    agent: details.agent ?? "background task",
    description: details.description ?? "",
    runtimeMs: 0,
    createdAtMs: 0,
    // Frozen replay snapshot: no live board, so the elapsed chip stays static.
    boardGeneratedAtMs: 0,
    ...(details.terminalOutcome !== undefined ? { terminalOutcome: details.terminalOutcome as WidgetRow["terminalOutcome"] } : {}),
    ...(details.resolvedModel !== undefined ? { resolvedModel: details.resolvedModel } : {}),
    ...(details.contextWindow !== undefined ? { contextWindow: details.contextWindow } : {}),
    ...(details.groupId !== undefined ? { groupId: details.groupId } : {}),
  };
}

function rowsAnyRunning(rows: readonly WidgetRow[]): boolean {
  return rows.some((r) => r.status === "running" || r.status === "cancelling");
}

/** A declared fleet row frozen at `ready` (replay / before the live board has it). */
function fleetRowFromDetails(row: AsyncTaskFleetRow, groupId: string): WidgetRow {
  return {
    taskId: row.taskId,
    status: "ready",
    freshness: "healthy",
    agent: row.agent,
    description: row.description,
    runtimeMs: 0,
    createdAtMs: 0,
    boardGeneratedAtMs: 0,
    deferredLaunch: true,
    groupId,
    ...(row.resolvedModel !== undefined ? { resolvedModel: row.resolvedModel } : {}),
    ...(row.capabilityProfile !== undefined ? { capabilityProfile: row.capabilityProfile } : {}),
  };
}

/**
 * The fleet card: every declared group rendered up front as its own section,
 * decoupled from execution. Each member row is drawn in DECLARED order (by
 * `group.taskIds`, never the running-first reorder) so a row animates in place
 * through ready→running→terminal instead of jumping. Live rows come from the
 * board; a member the live board does not (yet) have falls back to its frozen
 * `ready` declaration, so a freshly-declared fleet — and a replayed transcript
 * with no live registry — both show the full ready card.
 *
 * This is a GATED spawn card: while any member is still in flight the live,
 * animated state lives only in the pinned aboveEditor widget and the inline
 * card renders nothing. Once every member across every group settles, the card
 * latches a static completed snapshot.
 */
function renderBackgroundFleetCard(
  fleet: AsyncTaskFleetDetails,
  sessionKey: string | undefined,
  theme: SubagentTheme,
  extras: BackgroundCardExtras | undefined,
): Component {
  const build = (): CardBuild => {
    const board = sessionKey ? extras?.resolveBoard?.(sessionKey) : undefined;
    const sections: { section: WidgetSection; rows: WidgetRow[] }[] = [];
    for (const group of fleet.groups) {
      const rows = group.rows.map((row) => {
        const live = board && row.taskId ? singleRowFromBoard(board, row.taskId) : undefined;
        return live ?? fleetRowFromDetails(row, group.groupId);
      });
      const snapshot = sessionKey ? extras?.resolveGroup?.(sessionKey, group.groupId) : undefined;
      const synth = synthesizeGroup(rows);
      const label = snapshot?.label ?? group.label ?? synth.label;
      const resolved = {
        status: snapshot?.status ?? synth.status,
        counts: snapshot?.counts ?? synth.counts,
        ...(label !== undefined ? { label } : {}),
      };
      sections.push({ section: { groupId: group.groupId, group: resolved, rows }, rows });
    }
    // Invisible until the whole fleet settles; then a static completed snapshot.
    const allRows = sections.flatMap((s) => s.rows);
    const settled = allRows.length > 0 && allRows.every((r) => isTerminalRowStatus(r.status));
    if (!settled) return { lines: [], settled: false };
    const lines: string[] = [];
    for (const { section, rows } of sections) {
      lines.push(renderSectionHeader(section, theme));
      for (const row of rows) lines.push(renderRowLine(row, theme, undefined, { indent: "  ", metadata: "full" }));
    }
    return { lines, settled: true };
  };
  return new BackgroundCardComponent(build);
}

/**
 * The consolidated borderless group card: one section header plus a row per
 * member, drawn from the live board when a resolver is available, else the
 * static `details.group` counts. Used for the group-opening start_task and for
 * every group task_poll/task_wait/task_cancel result — the verbose model-facing
 * group text never reaches the transcript.
 */
function renderBackgroundGroupCard(
  details: BackgroundTaskDetails,
  theme: SubagentTheme,
  extras: BackgroundCardExtras | undefined,
  gate = false,
): Component {
  const groupId = details.groupId;
  if (!groupId) return new Container();
  const sessionKey = details.sessionKey;
  // Everything live is computed inside the thunk so the card re-resolves the
  // board, reveal, loader frame and elapsed on every render(width) frame.
  const build = (): CardBuild => {
    const board = sessionKey ? extras?.resolveBoard?.(sessionKey) : undefined;
    const members = board ? groupMembersFromBoard(board, groupId) : [];
    const snapshot = (details.group as MmrAsyncTaskGroupSnapshot | undefined)
      ?? (sessionKey ? extras?.resolveGroup?.(sessionKey, groupId) : undefined);
    const group = snapshot
      ? { status: snapshot.status, counts: snapshot.counts, ...(snapshot.label !== undefined ? { label: snapshot.label } : {}) }
      : members.length > 0 ? synthesizeGroup(members) : undefined;
    const section: WidgetSection = { groupId, ...(group ? { group } : {}), rows: members };

    if (gate) {
      // Gated group-opener spawn card: invisible until every member settles,
      // then a static completed snapshot. Live progress lives in the widget.
      const settled = members.length > 0 && members.every((r) => isTerminalRowStatus(r.status));
      if (!settled) return { lines: [], settled: false };
      const lines: string[] = [renderSectionHeader(section, theme)];
      for (const row of members) {
        lines.push(renderRowLine(row, theme, undefined, { indent: "  ", metadata: "full" }));
      }
      return { lines, settled: true };
    }

    // Non-gated explicit group result (task_poll / task_wait / task_cancel):
    // rendered live every frame. Staged reveal keeps a freshly resolved card
    // invisible during the brief settle window, then reveals member rows on the
    // shared cadence; `revealedRows` reveals everything at once when no member
    // is active. During the settle window return NO lines (mounted-but-invisible
    // so a later tick re-runs this thunk) rather than a static Container that
    // would never reappear. Replay / no live registry (members.length === 0)
    // shows the whole card immediately.
    const revealedMembers = members.length > 0 ? revealedRows(members, Date.now()) : members;
    if (members.length > 0 && revealedMembers.length === 0) return { lines: [] };

    const frame = (rowsAnyRunning(members) || group?.status === "running") ? currentLoaderFrame() : undefined;
    const metadata: RowMetadataLevel = "full";
    const lines: string[] = [renderSectionHeader(section, theme)];
    for (const row of revealedMembers) {
      lines.push(renderRowLine(row, theme, frame, { indent: "  ", metadata }));
    }
    if (members.length === 0) {
      // Replay / no live registry: the header carries status + counts; add a
      // muted member-count line so the card is not a lone header.
      const total = snapshot?.counts.total;
      if (typeof total === "number" && total > 0) {
        lines.push(`  ${theme.fg("muted", `${total} task${total === 1 ? "" : "s"}`)}`);
      }
    }
    return { lines };
  };
  return new BackgroundCardComponent(build);
}

/**
 * The single ungrouped background task as one borderless live row: `⠋ finder
 * <desc> · <elapsed> · <model>`, animating ⠋→✓ in place. Reads the live board
 * row when a resolver is available, else the frozen `details` snapshot.
 *
 * This is a GATED spawn card: while the task is in flight the live, animated
 * row lives only in the pinned aboveEditor widget and the inline card renders
 * nothing. Once the task settles, the card latches a static completed row.
 */
function renderBackgroundSingleCard(
  details: BackgroundTaskDetails,
  theme: SubagentTheme,
  extras: BackgroundCardExtras | undefined,
): Component {
  const sessionKey = details.sessionKey;
  const build = (): CardBuild => {
    const board = sessionKey ? extras?.resolveBoard?.(sessionKey) : undefined;
    const row = (board && details.taskId ? singleRowFromBoard(board, details.taskId) : undefined)
      ?? rowFromDetails(details);
    // Invisible until the task settles; then a static completed row.
    if (!isTerminalRowStatus(row.status)) return { lines: [], settled: false };
    return { lines: [renderRowLine(row, theme, undefined, { metadata: "full" })], settled: true };
  };
  return new BackgroundCardComponent(build);
}

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
  taskId?: string;
  groupId?: string;
  status: string;
  description?: string;
  outcomeText?: string;
}

const RESULT_RENDERED_STATE_KEY = "mmrSubagentResultRendered";
const CALL_COMPONENT_STATE_KEY = "mmrSubagentCallComponent";

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
  else if (component instanceof BackgroundCardComponent) component.clear();
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
  // The result card owns the entire staged reveal, so the call renders nothing:
  // suppressing the transient "starting" row keeps it from flashing during the
  // post-spawn prep window before the result card takes over.
  return new Container();
}

export function renderMmrBackgroundTaskResult(
  _toolName: string,
  result: AgentToolResult<unknown>,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: SubagentTheme,
  context?: RenderContextLike,
  extras?: BackgroundCardExtras,
): Component {
  const details = result.details as BackgroundTaskDetails | undefined;
  const output = textContent(result).trim();

  // 0. Fleet declaration (start_task.fleet) → all group cards rendered up front,
  //    decoupled from execution; rows animate ready→running→terminal in place.
  if (details?.fleet !== undefined) {
    clearRenderedCall(context);
    return renderBackgroundFleetCard(
      details.fleet as AsyncTaskFleetDetails,
      details.sessionKey,
      theme,
      extras,
    );
  }

  // 1. No-id board (task_poll list mode) → grouped board view.
  if (details?.board !== undefined) {
    const boardComponent = renderBackgroundTaskBoard(details.board, theme);
    if (boardComponent) return boardComponent;
    const container = new Container();
    addMarkdownBlock(container, output, theme, { paddingX: 1 });
    return container;
  }

  // 2. Group control result (task_poll / task_wait / task_cancel with group_id)
  //    → one consolidated member-list card. The verbose model-facing group text
  //    carried in `content` is intentionally never drawn into the transcript.
  if (details?.group !== undefined) {
    clearRenderedCall(context);
    return renderBackgroundGroupCard(details, theme, extras);
  }

  if (details?.worker !== "mmr-subagents.async-task") {
    const container = new Container();
    addMarkdownBlock(container, output, theme, { paddingX: 1 });
    return container;
  }

  // 3. start_task spawn → GATED inline card: the group section for the
  //    group-opening call, nothing for sibling starts (one card per group), and
  //    a single row when ungrouped. During startup and the run the inline card
  //    is invisible — the live, animated state lives only in the pinned
  //    aboveEditor widget; the card latches a static completed view once the
  //    run settles.
  if (details.tool === "start_task") {
    clearRenderedCall(context);
    if (details.groupId) {
      return details.groupOpener
        ? renderBackgroundGroupCard(details, theme, extras, true)
        : new Container();
    }
    return renderBackgroundSingleCard(details, theme, extras);
  }

  // 4. Single-task task_poll / task_wait / task_cancel → rich result card
  //    (model header, Markdown body, trail, final output, usage line). This is
  //    the result-retrieval surface and is unchanged.
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
    const groupId = details?.groupId?.trim();
    const taskId = details?.taskId?.trim();
    if (groupId) {
      box.addChild(new Text(theme.fg("muted", `task_poll({group_id:"${groupId}"})`), 0, 0));
    } else if (taskId) {
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
