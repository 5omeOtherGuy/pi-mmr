import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import {
  buildTaskFinalResult,
  type TaskToolDeps,
} from "./task.js";
import type { FinderToolDeps } from "./finder.js";
import type { LibrarianToolDeps } from "./librarian.js";
import type {
  MmrPreparedWorkerRun,
  MmrPreparedWorkerRunResult,
} from "./worker-tool-factory.js";
import {
  getMmrBackgroundAgent,
  inferToolErrorMessage,
  type MmrBackgroundAgentDescriptor,
} from "./background-agents.js";
import {
  ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
  type AsyncTaskCompletionDetails,
  type BackgroundCardExtras,
  refreshBackgroundTaskWidget,
  renderAsyncTaskCompletionMessage,
  renderMmrBackgroundTaskCall,
  renderMmrBackgroundTaskResult,
} from "./progress-rendering.js";
import {
  getMmrAsyncTaskRegistry,
  type MmrAsyncTaskGroupSnapshot,
  type MmrAsyncTaskRegistry,
  type MmrAsyncTaskInternalSnapshot,
  type StartAsyncTaskArgs,
} from "./async-task-registry.js";

import {
  ASYNC_TASK_AGENT_NAMES,
  ASYNC_TASK_GUIDELINES,
  ASYNC_TASK_TOOL_NAMES,
  MMR_SUBAGENTS_ASYNC_PUSH_ENV,
  PULL_NOTICE_MAX_ITEMS,
  buildStartTaskDescription,
  buildStartTaskParameters,
  START_TASK_TOOL_NAME,
  TASK_CANCEL_PARAMETERS,
  TASK_CANCEL_TOOL_NAME,
  TASK_POLL_PARAMETERS,
  TASK_POLL_TOOL_NAME,
  TASK_WAIT_PARAMETERS,
  TASK_WAIT_TOOL_NAME,
  validateAsyncToolParams,
  type AsyncTaskAgentName,
  type AsyncTaskFleetGroupDetails,
  type AsyncTaskFleetRow,
  type AsyncTaskToolDetails,
} from "./async-task-tool-schemas.js";
import {
  registerMmrBackgroundCardExtras,
  registerMmrBackgroundDispatcher,
} from "./background-dispatch.js";
import {
  createAsyncTaskDeliveryMessage,
  detailsContextFromSnapshot,
  escapeXmlAttr,
  extractTrailFromToolResult,
  formatAsyncTaskDeliveryNoticeSafely,
  groupNotFoundResult,
  groupResult,
  invalidAsyncControlResult,
  nonNormalOutcomeText,
  normalizeMember,
  notFoundResult,
  parseFleet,
  parseStartParams,
  parseTaskOrGroupControl,
  type ParsedMember,
  projectSnapshot,
  renderBoard,
  summarizeTrail,
  validationResult,
} from "./async-task-tool-format.js";
import { resolveMmrWorkerSessionKey } from "./worker-host.js";

export {
  ASYNC_TASK_AGENT_NAMES,
  ASYNC_TASK_TOOL_NAMES,
  MMR_SUBAGENTS_ASYNC_PUSH_ENV,
  START_TASK_TOOL_NAME,
  TASK_CANCEL_TOOL_NAME,
  TASK_POLL_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
};
export type { AsyncTaskAgentName, AsyncTaskToolDetails };

export interface AsyncTaskToolDeps extends TaskToolDeps {
  /** Registry seam; defaults to the process singleton. */
  registry?: MmrAsyncTaskRegistry;
  /** Deterministic session key override for tests. */
  sessionKey?: string;
  /** Tool-specific seams used when start_task launches the finder agent. */
  finderDeps?: FinderToolDeps;
  /** Tool-specific seams used when start_task launches the librarian agent. */
  librarianDeps?: LibrarianToolDeps;
  /** Tool-specific seams used when start_task launches the Task agent. */
  taskDeps?: TaskToolDeps;
  /**
   * Session-level ceiling: whether the at-most-once completion push is
   * PERMITTED at all this session. Default ON. A caller can opt an
   * individual task out with `start_task({ notify: false })`. Wired from
   * the `MMR_SUBAGENTS_ASYNC_PUSH` environment gate in `index.ts`.
   */
  enableCompletionPush?: boolean;
  /**
   * Schedules the deferred launch of a fleet's `ready` members. Default is a
   * ref'd `setTimeout(fn, 0)`, so the declaration result (and the ready card)
   * is committed before the workers start, while still guaranteeing the launch
   * runs even in a short-lived process. Injectable for deterministic tests.
   */
  launchScheduler?: (fn: () => void) => void;
}

/**
 * Best-effort: mirror the registry board onto the pinned background-agent
 * widget. Never throws into a tool call — a widget failure must not demote a
 * successful background-task operation.
 */
function refreshAsyncTaskWidget(
  ctx: ExtensionContext | undefined,
  registry: MmrAsyncTaskRegistry,
  sessionKey: string,
): void {
  try {
    refreshBackgroundTaskWidget(ctx, registry.listTasks(sessionKey), (groupId) =>
      registry.getGroup(sessionKey, groupId),
    );
  } catch {
    // UI mirror only; ignore.
  }
}

/**
 * Live-state resolvers for the inline background card, reading the SAME registry
 * the aboveEditor widget uses. The card stays invisible while the run is in
 * flight (live state lives only in the widget) and reads these resolvers to
 * detect when the run has settled, then latches a static completed snapshot.
 * The card reads the session partition from `details.sessionKey`; both lookups
 * are copy-on-read and bounded by the running-task cap.
 */
function backgroundCardExtras(registry: MmrAsyncTaskRegistry): BackgroundCardExtras {
  return {
    resolveBoard: (sessionKey) => registry.listTasks(sessionKey),
    resolveGroup: (sessionKey, groupId) => registry.getGroup(sessionKey, groupId),
  };
}

function resolveSessionKey(ctx: ExtensionContext | undefined, deps: AsyncTaskToolDeps): string {
  // ONE sessionKey resolution shared with the blocking worker tools (the
  // factory's register-and-await path) via worker-host.
  return resolveMmrWorkerSessionKey(ctx, deps.sessionKey);
}

function baseToolDeps(deps: AsyncTaskToolDeps): Record<string, unknown> {
  const {
    registry: _registry,
    sessionKey: _sessionKey,
    enableCompletionPush: _enableCompletionPush,
    finderDeps: _finderDeps,
    librarianDeps: _librarianDeps,
    taskDeps: _taskDeps,
    ...base
  } = deps;
  return base as Record<string, unknown>;
}

function buildCompletionNotifier(
  pi: AsyncTaskToolDeps["pi"],
): ((snapshot: MmrAsyncTaskInternalSnapshot) => void) | undefined {
  const sendMessage = (pi as { sendMessage?: ExtensionAPI["sendMessage"] } | undefined)?.sendMessage;
  if (typeof sendMessage !== "function") return undefined;
  return (snapshot) => {
    const outcomeText = nonNormalOutcomeText(snapshot);
    sendMessage(
      {
        customType: ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
        content:
          `<task-notification task_id="${escapeXmlAttr(snapshot.taskId)}" status="${snapshot.status}" delivery="announced">\n` +
          `Background task "${escapeXmlAttr(snapshot.description)}" finished with status ${snapshot.status}.\n` +
          (outcomeText ? `Non-normal outcome: ${escapeXmlAttr(outcomeText)}\n` : "") +
          `If this task's final result is not already present in the transcript, call task_poll({task_id:"${escapeXmlAttr(snapshot.taskId)}"}) once to retrieve it.\n` +
          `If task_poll or task_wait already returned this task's terminal result, this notification is stale; no action, repeat polling, or answer rewrite is needed.\n` +
          `</task-notification>`,
        // The persistent background-agent widget and the eventual task_poll
        // result own the human-facing surface; this push is model-facing only
        // (display:false) so a finished task is not announced twice.
        display: false,
        details: {
          version: 1,
          kind: ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
          taskId: snapshot.taskId,
          status: snapshot.status,
          description: snapshot.description,
          ...(outcomeText !== undefined ? { outcomeText } : {}),
        } satisfies AsyncTaskCompletionDetails,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
}

function buildGroupCompletionNotifier(
  pi: AsyncTaskToolDeps["pi"],
): ((snapshot: MmrAsyncTaskGroupSnapshot) => void) | undefined {
  const sendMessage = (pi as { sendMessage?: ExtensionAPI["sendMessage"] } | undefined)?.sendMessage;
  if (typeof sendMessage !== "function") return undefined;
  return (snapshot) => {
    sendMessage(
      {
        customType: ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
        content:
          `<task-group-notification group_id="${escapeXmlAttr(snapshot.groupId)}" status="${snapshot.status}" delivery="announced">\n` +
          `Background task group ${escapeXmlAttr(snapshot.groupId)} finished with status ${snapshot.status}.\n` +
          `If this group has not already been observed in the transcript, call task_poll({group_id:"${escapeXmlAttr(snapshot.groupId)}"}) once to list child task_ids.\n` +
          `Then retrieve only child outputs you still need with task_poll({task_id}). If the group or child results were already retrieved, this notification is stale; no action or answer rewrite is needed. A task_wait timeout never cancels children.\n` +
          `</task-group-notification>`,
        display: false,
        details: {
          version: 1,
          kind: ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
          groupId: snapshot.groupId,
          status: snapshot.status,
          description: `group ${snapshot.groupId}`,
        } satisfies AsyncTaskCompletionDetails,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
}

/**
 * Tool-specific seams for one background agent, selected by the descriptor's
 * declared deps key (`finderDeps`/`librarianDeps`/`taskDeps`) instead of an
 * agent-name branch.
 */
function descriptorDeps(deps: AsyncTaskToolDeps, depsKey: string | undefined): Record<string, unknown> {
  if (!depsKey) return {};
  const value = (deps as unknown as Record<string, unknown>)[depsKey];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Validate and prepare one background run for a descriptor: optional schema
 * pre-validation, then the descriptor's `prepareRun` (the SAME preparation
 * path the blocking worker tool uses). Returns either a registry-ready
 * prepared run or a fully shaped pre-spawn failure result — no registry side
 * effect happens either way.
 */
function prepareDescriptorRun(args: {
  descriptor: MmrBackgroundAgentDescriptor;
  deps: AsyncTaskToolDeps;
  params: unknown;
  ctx: ExtensionContext;
  toolCallId: string;
  resultTool: string;
  agent: AsyncTaskAgentName;
}): { prepared: MmrPreparedWorkerRun } | { failure: AgentToolResult<AsyncTaskToolDetails> } {
  const { descriptor } = args;
  if (descriptor.start.parametersSchema) {
    const v = validateAsyncToolParams(descriptor.toolName, descriptor.start.parametersSchema, args.params);
    if (!v.ok) return { failure: validationResult(v.message, args.resultTool) };
  }
  const mergedDeps = { ...baseToolDeps(args.deps), ...descriptorDeps(args.deps, descriptor.start.depsKey) };
  let prep: MmrPreparedWorkerRunResult;
  try {
    prep = descriptor.start.prepareRun(mergedDeps, args.params, args.ctx, { toolCallId: args.toolCallId });
  } catch (err) {
    // Preparers without a structured params failure throw on invalid params
    // (the blocking finder/oracle contract); the background surface maps the
    // throw to its validation result.
    const message = err instanceof Error ? err.message : String(err);
    return { failure: validationResult(message, args.resultTool) };
  }
  if (!prep.ok) {
    // Pre-spawn failure (validation, gate, or resolution): surface the
    // prepared failure's content under the background result shape. No
    // record and no group were created.
    return {
      failure: {
        content: prep.result.content,
        details: {
          worker: "mmr-subagents.async-task",
          tool: args.resultTool,
          agent: args.agent,
          errorMessage: inferToolErrorMessage(prep.result),
        },
      },
    };
  }
  return { prepared: prep.prepared };
}

/**
 * Registry start-args derived from a prepared run. Agents whose params own
 * the run identity (a `descriptionParamKey`, i.e. Task) label the record
 * from the prepared description/prompt; the rest keep the normalized
 * member's summaries (which honor an explicit start_task `description`).
 */
function preparedStartArgs(
  descriptor: MmrBackgroundAgentDescriptor,
  prepared: MmrPreparedWorkerRun,
  member: ParsedMember,
): Omit<StartAsyncTaskArgs, "sessionKey" | "originToolCallId" | "deliveryOptIn"> {
  const paramsOwnIdentity = descriptor.descriptionParamKey !== undefined;
  return {
    agent: descriptor.agent,
    description: paramsOwnIdentity ? prepared.description : member.description,
    prompt: paramsOwnIdentity ? prepared.displayPrompt : member.promptSummary,
    cwd: prepared.cwd,
    workerTools: prepared.workerTools,
    ...(prepared.partialOutputPolicy !== undefined ? { partialOutputPolicy: prepared.partialOutputPolicy } : {}),
    ...(prepared.resolvedModel !== undefined ? { resolvedModel: prepared.resolvedModel } : {}),
    ...(prepared.contextWindow !== undefined ? { contextWindow: prepared.contextWindow } : {}),
    ...(prepared.capabilityProfile !== undefined ? { capabilityProfile: prepared.capabilityProfile } : {}),
    ...(prepared.projectResult !== undefined ? { projectResult: prepared.projectResult } : {}),
    run: prepared.run,
  };
}

interface FleetMemberBuild {
  startArgs: Omit<StartAsyncTaskArgs, "sessionKey" | "originToolCallId" | "deliveryOptIn">;
  prepared: MmrPreparedWorkerRun;
  row: AsyncTaskFleetRow;
}

/**
 * Deprecation notice appended to every successful start_task result. The v2
 * surface is the worker tools' own background parameter; start_task remains a
 * thin compatibility alias for one release.
 */
const START_TASK_DEPRECATION_NOTICE =
  "Note: start_task is deprecated; call the worker tool directly with background: true (e.g. finder({query, background: true})). Parallel background calls can share a group key via the group parameter.";

/**
 * Session-scoped v2 group-key table: maps a caller-chosen `group` key to the
 * registry group it minted, so parallel background calls sharing a key land
 * in one group. Keyed per registry instance; entries are re-validated against
 * the live registry on every use, so a pruned group simply mints a fresh one.
 */
const groupKeyTables = new WeakMap<MmrAsyncTaskRegistry, Map<string, string>>();

function resolveGroupKeyTable(registry: MmrAsyncTaskRegistry): Map<string, string> {
  let table = groupKeyTables.get(registry);
  if (!table) {
    table = new Map();
    groupKeyTables.set(registry, table);
  }
  return table;
}

interface BackgroundStartOptions {
  registry: MmrAsyncTaskRegistry;
  deps: AsyncTaskToolDeps;
  ctx: ExtensionContext;
  toolCallId: string;
  descriptor: MmrBackgroundAgentDescriptor;
  /** Normalized worker member (agent, params, description, promptSummary). */
  member: ParsedMember;
  wantsNotify: boolean;
  /** Legacy start_task grouping: `'new'` or a concrete `group_<hex>` id. */
  legacyGroupId?: string;
  /** Legacy group label (honored when `legacyGroupId` is `'new'`). */
  groupLabel?: string;
  /** v2 caller-chosen group key (the named worker tools' `group` param). */
  groupKey?: string;
  /** The calling tool: result-text prefix and `details.tool` discriminator. */
  resultTool: string;
  /** Extra sentence appended to the success message (start_task deprecation). */
  resultNotice?: string;
}

/**
 * The ONE background-start path. `start_task` (the deprecated alias) and the
 * named worker tools' `background: true` calls both run through here:
 * pre-spawn validation (no record/group on failure), notify wiring, group
 * resolution (legacy `group_id` semantics or the v2 shared `group` key),
 * registry start with cap/dedup rollback, and the start result.
 */
async function executeBackgroundStart(options: BackgroundStartOptions): Promise<AgentToolResult<AsyncTaskToolDetails>> {
  const { registry, deps, ctx, toolCallId, descriptor, member, wantsNotify, resultTool } = options;
  const sessionKey = resolveSessionKey(ctx, deps);
  const onSettle = () => refreshAsyncTaskWidget(ctx, registry, sessionKey);
  // Validate + prepare the worker run BEFORE any registry side effect (group
  // open) so an invalid start cannot mint an orphan group. Every agent goes
  // through ONE preparation seam — the same path the blocking tool uses — so
  // a pre-spawn failure (validation, gate, resolution) returns the prepared
  // failure shape and creates no record and no group.
  const prep = prepareDescriptorRun({
    descriptor,
    deps,
    params: member.params,
    ctx,
    toolCallId,
    resultTool,
    agent: member.agent,
  });
  if ("failure" in prep) return prep.failure;
  const prepared = prep.prepared;
  // Two-layer gate: the session ceiling must permit push AND the caller
  // must not opt this task out. The registry adds at-most-once + a
  // per-session budget on top. Delivery is `followUp` + `triggerTurn`, so a
  // push wakes an idle session or queues immediately behind the active turn
  // instead of riding the next user prompt. The pinned widget is refreshed
  // by `onSettle` on terminal transition, so it stays correct even when the
  // task opts out of (or cannot send) a completion push.
  const automaticDeliveryEnabled = deps.enableCompletionPush !== false;
  const wantsAutomaticDelivery = wantsNotify && automaticDeliveryEnabled;
  const notify = wantsAutomaticDelivery ? buildCompletionNotifier(deps.pi) : undefined;
  const groupNotify = wantsAutomaticDelivery ? buildGroupCompletionNotifier(deps.pi) : undefined;

  // Group resolution. Track whether this call minted a brand-new group, so a
  // later start rejection (e.g. concurrency cap) can roll back only a group
  // this call created — never a pre-existing one.
  let groupPreexisted = false;
  let groupSnapshot: MmrAsyncTaskGroupSnapshot | undefined;
  let openedGroupKey: string | undefined;
  if (options.legacyGroupId !== undefined) {
    groupPreexisted = options.legacyGroupId !== "new"
      ? registry.getGroup(sessionKey, options.legacyGroupId) !== undefined
      : false;
    groupSnapshot = options.legacyGroupId === "new"
      ? registry.openGroup({
          sessionKey,
          deliveryOptIn: wantsAutomaticDelivery,
          ...(options.groupLabel !== undefined ? { label: options.groupLabel } : {}),
          ...(groupNotify !== undefined ? { notify: groupNotify } : {}),
          onSettle,
        })
      : registry.openGroup({
          sessionKey,
          groupId: options.legacyGroupId,
          deliveryOptIn: wantsAutomaticDelivery,
          onSettle,
        });
  } else if (options.groupKey !== undefined) {
    // v2 shared group key: the first call with a key mints the group (and the
    // grouped notification); parallel and later calls sharing the key join it.
    const table = resolveGroupKeyTable(registry);
    const mapKey = `${sessionKey}\u0000${options.groupKey}`;
    const mappedId = table.get(mapKey);
    const existing = mappedId !== undefined ? registry.getGroup(sessionKey, mappedId) : undefined;
    if (existing) {
      groupPreexisted = true;
      groupSnapshot = registry.openGroup({
        sessionKey,
        groupId: existing.groupId,
        deliveryOptIn: wantsAutomaticDelivery,
        onSettle,
      });
    } else {
      groupSnapshot = registry.openGroup({
        sessionKey,
        deliveryOptIn: wantsAutomaticDelivery,
        label: options.groupKey,
        ...(groupNotify !== undefined ? { notify: groupNotify } : {}),
        onSettle,
      });
      table.set(mapKey, groupSnapshot.groupId);
      openedGroupKey = mapKey;
    }
  }
  const groupId = groupSnapshot?.groupId;
  const taskNotify = groupId === undefined ? notify : undefined;
  const rollbackMintedGroup = (): void => {
    if (groupId === undefined || groupPreexisted) return;
    registry.dropEmptyGroup(sessionKey, groupId);
    if (openedGroupKey !== undefined) resolveGroupKeyTable(registry).delete(openedGroupKey);
  };

  const started = registry.startTask({
    sessionKey,
    originToolCallId: toolCallId,
    ...preparedStartArgs(descriptor, prepared, member),
    ...(groupId !== undefined ? { groupId } : {}),
    deliveryOptIn: groupId === undefined ? wantsAutomaticDelivery : false,
    ...(taskNotify !== undefined ? { notify: taskNotify } : {}),
    onSettle,
  });

  if (!started.ok) {
    // Roll back a group this call just minted so a cap rejection cannot
    // leave an empty orphan group; dropEmptyGroup is a no-op on a group
    // that already holds tasks or that pre-existed.
    rollbackMintedGroup();
    const message =
      `${resultTool}: cannot start; ${started.runningCount} background task(s) already running ` +
      `(cap ${started.cap}). Wait for one to finish (task_wait) or stop one (task_cancel) first.`;
    return {
      content: [{ type: "text", text: message }],
      details: { worker: "mmr-subagents.async-task", tool: resultTool, agent: member.agent, errorMessage: message },
    };
  }
  const snapshot = started.snapshot;
  // Renderer-only board reference: details produced after this point carry
  // the partition/task ids so the renderer can resolve live registry state.
  if (!started.deduplicated) {
    prepared.sessionKey = sessionKey;
    prepared.taskId = snapshot.taskId;
  }
  // Idempotent-retry rollback: a deduplicated start returns the pre-existing
  // task, so a group this call just minted would otherwise linger as an empty
  // orphan — now a labeled one. Drop it when the dedup'd task is not in it.
  // Mirrors the cap-rejection rollback above; dropEmptyGroup is a no-op once
  // a group holds tasks or if it pre-existed.
  if (
    started.deduplicated
    && groupId !== undefined
    && !groupPreexisted
    && snapshot.groupId !== groupId
  ) {
    rollbackMintedGroup();
  }
  // Surface the launched agent on the pinned bottom-of-window widget so the
  // transcript card can stay empty (see renderMmrBackgroundTaskResult).
  refreshAsyncTaskWidget(ctx, registry, sessionKey);
  const dedupNote = started.deduplicated ? " (existing task for this call)" : "";
  const groupNote = snapshot.groupId ? ` in group ${snapshot.groupId}` : "";
  const groupDeliveryEnabled = groupSnapshot?.completionPush !== "disabled";
  const deliveryHint = snapshot.groupId
    ? groupDeliveryEnabled
      ? "The group owns automatic completion delivery; use task_poll/task_wait for grouped orchestration or to collect needed child outputs."
      : "Automatic delivery is disabled for this group; use task_poll/task_wait to inspect status and collect needed child outputs."
    : wantsAutomaticDelivery
      ? "Automatic delivery is enabled; use task_poll/task_wait only after an elapsed-time fallback or for multi-worker orchestration."
      : "Automatic delivery is disabled; use task_poll/task_wait to retrieve the result explicitly.";
  const message =
    `${resultTool}: started background worker ${snapshot.taskId}${dedupNote}${groupNote} ("${snapshot.description}", agent ${snapshot.agent}). ` +
    `${deliveryHint} ` +
    `Use task_cancel to stop it. Background tasks are in-memory and lost if the session ends.` +
    (options.resultNotice !== undefined ? ` ${options.resultNotice}` : "");
  // The opener (the call that minted the group) owns the consolidated inline
  // group card; sibling starts in the same group render nothing inline. Guard
  // on the task actually landing in the freshly minted group so a
  // deduplicated retry (whose group we rolled back) does not claim openership.
  const mintedGroup = options.legacyGroupId === "new" || openedGroupKey !== undefined;
  const groupOpener = groupId !== undefined && mintedGroup && snapshot.groupId === groupId;
  return {
    content: [{ type: "text", text: message }],
    details: {
      worker: "mmr-subagents.async-task",
      tool: resultTool,
      ...(resultTool !== START_TASK_TOOL_NAME ? { backgroundStart: true } : {}),
      agent: snapshot.agent as AsyncTaskAgentName,
      taskId: snapshot.taskId,
      sessionKey,
      ...(snapshot.groupId !== undefined ? { groupId: snapshot.groupId } : {}),
      ...(groupOpener ? { groupOpener: true } : {}),
      status: snapshot.status,
      ...(snapshot.terminalOutcome !== undefined ? { terminalOutcome: snapshot.terminalOutcome } : {}),
      freshness: snapshot.freshness,
      description: snapshot.description,
      prompt: snapshot.prompt,
      ...(snapshot.resolvedModel !== undefined ? { resolvedModel: snapshot.resolvedModel } : {}),
      ...(snapshot.contextWindow !== undefined ? { contextWindow: snapshot.contextWindow } : {}),
    },
  };
}

export function createStartTaskTool(deps: AsyncTaskToolDeps = {}): ToolDefinition {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  const cardExtras = backgroundCardExtras(registry);

  /**
   * Prepare one fleet member (validate + resolve its run thunk) WITHOUT any
   * registry side effect, so an invalid member fails the whole fleet before a
   * single task or group is created. Mirrors the single-task pre-spawn contract.
   */
  const buildMember = (
    member: ParsedMember,
    memberToolCallId: string,
    ctx: ExtensionContext,
  ): FleetMemberBuild | { error: string } => {
    const descriptor = getMmrBackgroundAgent(member.agent);
    if (!descriptor) return { error: `unknown background agent "${member.agent}".` };
    if (descriptor.start.parametersSchema) {
      const v = validateAsyncToolParams(descriptor.toolName, descriptor.start.parametersSchema, member.params);
      if (!v.ok) return { error: v.message };
    }
    const mergedDeps = { ...baseToolDeps(deps), ...descriptorDeps(deps, descriptor.start.depsKey) };
    let prep: MmrPreparedWorkerRunResult;
    try {
      prep = descriptor.start.prepareRun(mergedDeps, member.params, ctx, { toolCallId: memberToolCallId });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (!prep.ok) {
      return { error: inferToolErrorMessage(prep.result) ?? `invalid ${descriptor.agent} parameters` };
    }
    const prepared = prep.prepared;
    const startArgs = preparedStartArgs(descriptor, prepared, member);
    return {
      startArgs,
      prepared,
      row: {
        taskId: "",
        agent: descriptor.agent,
        description: startArgs.description,
        ...(prepared.resolvedModel !== undefined ? { resolvedModel: prepared.resolvedModel } : {}),
        ...(prepared.capabilityProfile !== undefined ? { capabilityProfile: prepared.capabilityProfile } : {}),
      },
    };
  };

  /**
   * Execute the `start_task.fleet` form: validate + prepare every member,
   * reject the whole fan-out if it would exceed the cap, create all members
   * `ready` (rendered up front), then schedule a single deferred launch that
   * flips them to `running` together.
   */
  const executeFleet = async (
    toolCallId: string,
    rawParams: unknown,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<AsyncTaskToolDetails>> => {
    const sessionKey = resolveSessionKey(ctx, deps);
    const onSettle = () => refreshAsyncTaskWidget(ctx, registry, sessionKey);
    const validated = validateAsyncToolParams(START_TASK_TOOL_NAME, buildStartTaskParameters(), rawParams);
    if (!validated.ok) return validationResult(validated.message);
    const plan = parseFleet(rawParams);
    if ("error" in plan) return validationResult(plan.error);

    // Atomic capacity gate: reject the whole fleet up front so it never creates
    // a partial set that trips the per-task cap mid-way.
    const { runningCount, cap } = registry.getRunningCapacity(sessionKey);
    if (runningCount + plan.totalMembers > cap) {
      const message =
        `start_task: cannot start a fleet of ${plan.totalMembers}; ${runningCount} background task(s) already running ` +
        `(cap ${cap}). Wait for some to finish (task_wait) or stop some (task_cancel) first.`;
      return {
        content: [{ type: "text", text: message }],
        details: { worker: "mmr-subagents.async-task", tool: START_TASK_TOOL_NAME, errorMessage: message },
      };
    }

    // Prepare every member before any side effect; an invalid member fails the
    // whole fleet with no records/groups created.
    const prepared: FleetMemberBuild[][] = [];
    for (let gi = 0; gi < plan.groups.length; gi += 1) {
      const built: FleetMemberBuild[] = [];
      for (let mi = 0; mi < plan.groups[gi].members.length; mi += 1) {
        const result = buildMember(plan.groups[gi].members[mi], `${toolCallId}#g${gi}m${mi}`, ctx);
        if ("error" in result) return validationResult(`fleet.groups[${gi}].members[${mi}]: ${result.error}`);
        built.push(result);
      }
      prepared.push(built);
    }

    const wantsAutomaticDelivery = plan.wantsNotify && deps.enableCompletionPush !== false;
    const fleetGroups: AsyncTaskFleetGroupDetails[] = [];
    const allTaskIds: string[] = [];
    for (let gi = 0; gi < plan.groups.length; gi += 1) {
      const group = plan.groups[gi];
      const groupNotify = wantsAutomaticDelivery ? buildGroupCompletionNotifier(deps.pi) : undefined;
      const snap = registry.openGroup({
        sessionKey,
        deliveryOptIn: wantsAutomaticDelivery,
        ...(group.label !== undefined ? { label: group.label } : {}),
        ...(groupNotify !== undefined ? { notify: groupNotify } : {}),
        onSettle,
      });
      const rows: AsyncTaskFleetRow[] = [];
      const taskIds: string[] = [];
      for (let mi = 0; mi < group.members.length; mi += 1) {
        const build = prepared[gi][mi];
        const started = registry.startTask({
          sessionKey,
          originToolCallId: `${toolCallId}#g${gi}m${mi}`,
          launchMode: "manual",
          groupId: snap.groupId,
          deliveryOptIn: false,
          onSettle,
          ...build.startArgs,
        });
        if (!started.ok) {
          // Unreachable after the capacity gate, but never leave a partial fleet:
          // cancel what we created and drop the empty groups.
          for (const id of allTaskIds) await registry.cancelTask({ sessionKey, taskId: id });
          for (const created of fleetGroups) registry.dropEmptyGroup(sessionKey, created.groupId);
          registry.dropEmptyGroup(sessionKey, snap.groupId);
          const message =
            `start_task: cannot start a fleet of ${plan.totalMembers}; ${started.runningCount} background task(s) already running (cap ${started.cap}).`;
          return {
            content: [{ type: "text", text: message }],
            details: { worker: "mmr-subagents.async-task", tool: START_TASK_TOOL_NAME, errorMessage: message },
          };
        }
        const taskId = started.snapshot.taskId;
        if (!started.deduplicated) {
          build.prepared.sessionKey = sessionKey;
          build.prepared.taskId = taskId;
        }
        taskIds.push(taskId);
        allTaskIds.push(taskId);
        rows.push({ ...build.row, taskId });
      }
      fleetGroups.push({ groupId: snap.groupId, ...(group.label !== undefined ? { label: group.label } : {}), taskIds, rows });
    }

    // The ready fleet is fully declared; render it before any worker starts.
    refreshAsyncTaskWidget(ctx, registry, sessionKey);

    // Ref'd on purpose: a ready fleet must launch even in a short-lived/headless
    // run that would otherwise exit before an unref'd tick fired, which would
    // strand every member in `ready` forever. The hold is a single 0ms tick.
    const schedule = deps.launchScheduler ?? ((fn: () => void) => {
      setTimeout(fn, 0);
    });
    schedule(() => {
      for (const taskId of allTaskIds) registry.launchTask(sessionKey, taskId);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
    });

    const message =
      `start_task: set up ${plan.totalMembers} background worker(s) across ${plan.groups.length} group(s); launching now. ` +
      `The live card is the status; poll only the child outputs you need after completion.`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        worker: "mmr-subagents.async-task",
        tool: START_TASK_TOOL_NAME,
        sessionKey,
        fleet: { version: 1, totalTasks: plan.totalMembers, groups: fleetGroups },
      },
    };
  };

  return {
    name: START_TASK_TOOL_NAME,
    label: START_TASK_TOOL_NAME,
    // Description and schema are derived from the live background-agent set
    // at registration; execute() re-derives the schema so an agent registered
    // after this tool (activation order is not guaranteed) still validates.
    description: buildStartTaskDescription(),
    promptSnippet: "Start a bounded subagent worker in the background and return an opaque task_id",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: buildStartTaskParameters(),
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrBackgroundTaskCall(START_TASK_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrBackgroundTaskResult(START_TASK_TOOL_NAME, result, options, theme, context, cardExtras);
    },
    async execute(toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      // Fleet form: declare every group/member up front (ready) and render all
      // group cards before any worker starts, then launch them together on a
      // deferred tick. Branch before the single-task parse, which has no agent.
      if (typeof rawParams === "object" && rawParams !== null && "fleet" in rawParams) {
        return executeFleet(toolCallId, rawParams, ctx);
      }
      // Semantic checks first so agent/Task-only guidance the schema cannot
      // express wins (e.g. "Oracle is always blocking"); the shared schema then
      // enforces structure (unknown keys, notify boolean, capabilityProfile
      // enum, group_id pattern).
      const parsed = parseStartParams(rawParams);
      if ("error" in parsed) return validationResult(parsed.error);
      const validated = validateAsyncToolParams(START_TASK_TOOL_NAME, buildStartTaskParameters(), rawParams);
      if (!validated.ok) return validationResult(validated.message);
      const descriptor = getMmrBackgroundAgent(parsed.agent);
      if (!descriptor) return validationResult(`unknown background agent "${parsed.agent}".`);
      return executeBackgroundStart({
        registry,
        deps,
        ctx,
        toolCallId,
        descriptor,
        member: parsed,
        wantsNotify: parsed.wantsNotify,
        ...(parsed.groupId !== undefined ? { legacyGroupId: parsed.groupId } : {}),
        ...(parsed.groupLabel !== undefined ? { groupLabel: parsed.groupLabel } : {}),
        resultTool: START_TASK_TOOL_NAME,
        resultNotice: START_TASK_DEPRECATION_NOTICE,
      });
    },
  } satisfies ToolDefinition;
}

export function createTaskPollTool(deps: AsyncTaskToolDeps = {}): ToolDefinition {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  const cardExtras = backgroundCardExtras(registry);
  return {
    name: TASK_POLL_TOOL_NAME,
    label: TASK_POLL_TOOL_NAME,
    description: [
      "Poll one background task by task_id, or omit task_id to list all background tasks for this session.",
      "Returns the latest progress for a running task or the final result for a finished one.",
    ].join("\n"),
    promptSnippet: "Poll one background task by task_id, or list all background tasks for this session",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: TASK_POLL_PARAMETERS,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrBackgroundTaskCall(TASK_POLL_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrBackgroundTaskResult(TASK_POLL_TOOL_NAME, result, options, theme, context, cardExtras);
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const validated = validateAsyncToolParams(TASK_POLL_TOOL_NAME, TASK_POLL_PARAMETERS, rawParams);
      if (!validated.ok) return invalidAsyncControlResult(TASK_POLL_TOOL_NAME, validated.message);
      const control = parseTaskOrGroupControl(rawParams);
      if (control.error) return invalidAsyncControlResult(TASK_POLL_TOOL_NAME, control.error);
      if (control.groupId) {
        const group = registry.getGroup(sessionKey, control.groupId, { observe: true });
        if (!group) return groupNotFoundResult(TASK_POLL_TOOL_NAME, control.groupId);
        refreshAsyncTaskWidget(ctx, registry, sessionKey);
        return groupResult(TASK_POLL_TOOL_NAME, group, undefined, sessionKey);
      }
      if (!control.taskId) {
        const board = registry.listTasks(sessionKey);
        refreshBackgroundTaskWidget(ctx, board, (groupId) => registry.getGroup(sessionKey, groupId));
        return {
          content: [{ type: "text", text: renderBoard(board) }],
          details: { worker: "mmr-subagents.async-task", tool: TASK_POLL_TOOL_NAME, board },
        };
      }
      const snapshot = registry.getTask(sessionKey, control.taskId);
      if (!snapshot) return notFoundResult(TASK_POLL_TOOL_NAME, control.taskId);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      return projectSnapshot(TASK_POLL_TOOL_NAME, snapshot);
    },
  } satisfies ToolDefinition;
}

export function createTaskWaitTool(deps: AsyncTaskToolDeps = {}): ToolDefinition {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  const cardExtras = backgroundCardExtras(registry);
  return {
    name: TASK_WAIT_TOOL_NAME,
    label: TASK_WAIT_TOOL_NAME,
    description: [
      "Wait up to timeout_ms for a background task to finish, then return its current state.",
      "A timeout is NOT a failure and does NOT cancel the worker — poll or wait again.",
    ].join("\n"),
    promptSnippet: "Wait briefly for a background task to finish without cancelling it on timeout",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: TASK_WAIT_PARAMETERS,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrBackgroundTaskCall(TASK_WAIT_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrBackgroundTaskResult(TASK_WAIT_TOOL_NAME, result, options, theme, context, cardExtras);
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const validated = validateAsyncToolParams(TASK_WAIT_TOOL_NAME, TASK_WAIT_PARAMETERS, rawParams);
      if (!validated.ok) return invalidAsyncControlResult(TASK_WAIT_TOOL_NAME, validated.message);
      const control = parseTaskOrGroupControl(rawParams);
      if (control.error) return invalidAsyncControlResult(TASK_WAIT_TOOL_NAME, control.error);
      if (!control.taskId && !control.groupId) return invalidAsyncControlResult(TASK_WAIT_TOOL_NAME, "task_wait requires task_id or group_id.");
      const timeoutMs = validated.value.timeout_ms;
      if (control.groupId) {
        const result = await registry.waitForGroup({
          sessionKey,
          groupId: control.groupId,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        if (!result.found || !result.snapshot) return groupNotFoundResult(TASK_WAIT_TOOL_NAME, control.groupId);
        refreshAsyncTaskWidget(ctx, registry, sessionKey);
        return groupResult(TASK_WAIT_TOOL_NAME, result.snapshot, result.timedOut, sessionKey);
      }
      const taskId = control.taskId;
      if (!taskId) return invalidAsyncControlResult(TASK_WAIT_TOOL_NAME, "task_wait requires task_id or group_id.");
      const result = await registry.waitForTask({
        sessionKey,
        taskId,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      if (!result.found || !result.snapshot) return notFoundResult(TASK_WAIT_TOOL_NAME, taskId);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      return projectSnapshot(TASK_WAIT_TOOL_NAME, result.snapshot, { timedOut: result.timedOut });
    },
  } satisfies ToolDefinition;
}

export function createTaskCancelTool(deps: AsyncTaskToolDeps = {}): ToolDefinition {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  const cardExtras = backgroundCardExtras(registry);
  return {
    name: TASK_CANCEL_TOOL_NAME,
    label: TASK_CANCEL_TOOL_NAME,
    description: [
      "Cancel a background task by task_id. Aborts the worker process and returns its final cancellation status.",
      "Cancelling an already-finished task is a safe no-op that returns its terminal state.",
    ].join("\n"),
    promptSnippet: "Cancel a background task by task_id",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: TASK_CANCEL_PARAMETERS,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrBackgroundTaskCall(TASK_CANCEL_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrBackgroundTaskResult(TASK_CANCEL_TOOL_NAME, result, options, theme, context, cardExtras);
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const validated = validateAsyncToolParams(TASK_CANCEL_TOOL_NAME, TASK_CANCEL_PARAMETERS, rawParams);
      if (!validated.ok) return invalidAsyncControlResult(TASK_CANCEL_TOOL_NAME, validated.message);
      const control = parseTaskOrGroupControl(rawParams);
      if (control.error) return invalidAsyncControlResult(TASK_CANCEL_TOOL_NAME, control.error);
      if (!control.taskId && !control.groupId) return invalidAsyncControlResult(TASK_CANCEL_TOOL_NAME, "task_cancel requires task_id or group_id.");
      const reason = validated.value.reason;
      if (control.groupId) {
        const group = await registry.cancelGroup({
          sessionKey,
          groupId: control.groupId,
          ...(reason !== undefined ? { reason } : {}),
        });
        if (!group) return groupNotFoundResult(TASK_CANCEL_TOOL_NAME, control.groupId);
        refreshAsyncTaskWidget(ctx, registry, sessionKey);
        return groupResult(TASK_CANCEL_TOOL_NAME, group, undefined, sessionKey);
      }
      const taskId = control.taskId;
      if (!taskId) return invalidAsyncControlResult(TASK_CANCEL_TOOL_NAME, "task_cancel requires task_id or group_id.");
      const snapshot = await registry.cancelTask({
        sessionKey,
        taskId,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (!snapshot) return notFoundResult(TASK_CANCEL_TOOL_NAME, taskId);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      // Project the same subagent details poll/wait carry so a cancelled card
      // shows the worker model/usage/trail like a blocking subagent.
      const finalDetails = snapshot.finalToolResult
        ? snapshot.finalToolResult.details
        : snapshot.finalResult
          ? buildTaskFinalResult(snapshot.finalResult, detailsContextFromSnapshot(snapshot)).details
          : undefined;
      const trail = snapshot.finalResult?.trail
        ?? snapshot.latestProgress?.trail
        ?? extractTrailFromToolResult(snapshot.finalToolResult)
        ?? extractTrailFromToolResult(snapshot.latestToolResult);
      const summary = summarizeTrail(trail);
      const settledNote =
        snapshot.status === "cancelling"
          ? " The worker has not stopped yet; poll task_poll to confirm it terminates."
          : "";
      const finalOutput = `${summary}${settledNote}`.trim();
      return {
        content: [
          { type: "text", text: `task_cancel: ${snapshot.agent} task ${snapshot.taskId} ${snapshot.status}. ${summary}${settledNote}` },
        ],
        details: {
          worker: "mmr-subagents.async-task",
          tool: TASK_CANCEL_TOOL_NAME,
          agent: snapshot.agent as AsyncTaskAgentName,
          taskId: snapshot.taskId,
          status: snapshot.status,
          freshness: snapshot.freshness,
          description: snapshot.description,
          prompt: snapshot.prompt,
          ...(finalDetails !== undefined ? { final: finalDetails } : {}),
          ...(finalOutput.length > 0 ? { finalOutput } : {}),
        },
      };
    },
  } satisfies ToolDefinition;
}

/**
 * Register the four async task tools as MMR-owned Pi tools. Returns the
 * registered definitions for tests/inspection.
 */
export function registerAsyncTaskTools(pi: ExtensionAPI, deps: AsyncTaskToolDeps = {}): ToolDefinition[] {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  const withPi: AsyncTaskToolDeps = { ...deps, pi, registry };
  const definitions = [
    createStartTaskTool(withPi),
    createTaskPollTool(withPi),
    createTaskWaitTool(withPi),
    createTaskCancelTool(withPi),
  ];
  // v2 surface: the named worker tools' background/group/notify params
  // delegate here. The dispatcher shares the SAME start path (and registry)
  // as start_task, so a background finder call and start_task({agent:
  // "finder"}) are one code path; the card extras let the named tools'
  // renderer read the live registry for the spawn card.
  registerMmrBackgroundDispatcher(async (input) => {
    const descriptor = getMmrBackgroundAgent(input.agent);
    if (!descriptor) {
      return validationResult(`unknown background agent "${input.agent}".`, input.agent);
    }
    const member = normalizeMember({ agent: input.agent, params: input.params });
    if ("error" in member) return validationResult(member.error, input.agent);
    return executeBackgroundStart({
      registry,
      deps: withPi,
      ctx: input.ctx,
      toolCallId: input.toolCallId,
      descriptor,
      member,
      wantsNotify: input.notify !== false,
      ...(input.group !== undefined ? { groupKey: input.group } : {}),
      resultTool: input.agent,
    });
  });
  registerMmrBackgroundCardExtras(backgroundCardExtras(registry));
  for (const definition of definitions) {
    registerMmrOwnedTool(definition.name);
    pi.registerTool(definition);
  }
  // Render the async-task completion push as a compact status row instead of
  // dumping its model-facing `<task-notification>` XML into the transcript.
  // Feature-detected so headless/JSON hosts without a renderer pipeline are
  // unaffected (the message still delivers; only its TUI shape changes).
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(ASYNC_TASK_COMPLETION_CUSTOM_TYPE, renderAsyncTaskCompletionMessage);
  }
  if (typeof pi.on === "function") {
    pi.on("agent_start", (_event, ctx) => {
      const sessionKey = resolveSessionKey(ctx, withPi);
      registry.setSessionAgentActive(sessionKey, true);
    });
    pi.on("agent_end", (_event, ctx) => {
      const sessionKey = resolveSessionKey(ctx, withPi);
      registry.setSessionAgentActive(sessionKey, false);
      registry.flushIdleDeliveries(sessionKey);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
    });
    pi.on("context", async (event, ctx) => {
      const sessionKey = resolveSessionKey(ctx, withPi);
      const claim = registry.claimPendingForContext(sessionKey, PULL_NOTICE_MAX_ITEMS);
      if (claim.items.length === 0) return undefined;
      const text = formatAsyncTaskDeliveryNoticeSafely(claim);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      return { messages: [...event.messages, createAsyncTaskDeliveryMessage(text)] };
    });
    pi.on("session_shutdown", (_event, ctx) => {
      const sessionKey = resolveSessionKey(ctx, withPi);
      registry.shutdownSession(sessionKey, "session_shutdown");
    });
  }
  return definitions;
}
