import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { getMmrSessionIdentitySnapshot } from "../mmr-core/runtime.js";
import {
  buildSpawnErrorWorkerResult,
  buildTaskFinalResult,
  prepareTaskRun,
  type TaskToolDeps,
} from "../mmr-subagents/task.js";
import {
  createFinderTool,
  FINDER_PARAMETERS_SCHEMA,
  FINDER_TOOL_NAME,
  FINDER_WORKER_TOOLS,
  type FinderToolDeps,
} from "../mmr-subagents/finder.js";
import {
  createLibrarianTool,
  LIBRARIAN_PARAMETERS_SCHEMA,
  LIBRARIAN_TOOL_NAME,
  LIBRARIAN_WORKER_TOOLS,
  type LibrarianToolDeps,
} from "../mmr-subagents/librarian.js";
import {
  ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
  type AsyncTaskCompletionDetails,
  type BackgroundCardExtras,
  renderAsyncTaskCompletionMessage,
  renderMmrBackgroundTaskCall,
  renderMmrBackgroundTaskResult,
} from "../mmr-subagents/progress-rendering.js";
import {
  getMmrAsyncTaskRegistry,
  type MmrAsyncTaskGroupSnapshot,
  type MmrAsyncTaskRegistry,
  type MmrAsyncTaskInternalSnapshot,
  type MmrAsyncTaskRun,
} from "./async-task-registry.js";
import { refreshBackgroundTaskWidget } from "./background-task-widget.js";
import {
  ASYNC_TASK_AGENT_NAMES,
  ASYNC_TASK_GUIDELINES,
  ASYNC_TASK_TOOL_NAMES,
  MMR_SUBAGENTS_ASYNC_PUSH_ENV,
  PULL_NOTICE_MAX_ITEMS,
  START_TASK_DESCRIPTION,
  START_TASK_PARAMETERS,
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
  createAsyncTaskDeliveryMessage,
  detailsContextFromSnapshot,
  escapeXmlAttr,
  extractTrailFromToolResult,
  formatAsyncTaskDeliveryNoticeSafely,
  groupNotFoundResult,
  groupResult,
  inferToolErrorMessage,
  inferToolRunStatus,
  invalidAsyncControlResult,
  nonNormalOutcomeText,
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
import { resolveWorkerCwd } from "../mmr-subagents/worker-host.js";

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
  if (deps.sessionKey) return deps.sessionKey;
  // Prefer the session id from THIS call's context so concurrent sessions in
  // one process never share a partition; fall back to the global identity
  // snapshot, then to cwd.
  try {
    const ctxId = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)
      ?.sessionManager?.getSessionId?.();
    if (typeof ctxId === "string" && ctxId.length > 0) return `sid:${ctxId}`;
  } catch {
    // best-effort
  }
  try {
    const id = getMmrSessionIdentitySnapshot()?.sessionId;
    if (id) return `sid:${id}`;
  } catch {
    // identity is best-effort; fall back to cwd partitioning
  }
  return `cwd:${resolveWorkerCwd(ctx)}`;
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

function createSelectedTool(agent: Exclude<AsyncTaskAgentName, "Task">, deps: AsyncTaskToolDeps): ToolDefinition {
  const base = baseToolDeps(deps);
  if (agent === "finder") return createFinderTool({ ...base, ...(deps.finderDeps ?? {}) } as FinderToolDeps);
  return createLibrarianTool({ ...base, ...(deps.librarianDeps ?? {}) } as LibrarianToolDeps);
}

function workerToolsForAgent(agent: AsyncTaskAgentName, taskTools: readonly string[] = []): readonly string[] {
  if (agent === "Task") return taskTools;
  if (agent === "finder") return FINDER_WORKER_TOOLS;
  return LIBRARIAN_WORKER_TOOLS;
}

interface FleetMemberBuild {
  startArgs: {
    agent: AsyncTaskAgentName;
    description: string;
    prompt: string;
    cwd: string;
    workerTools: readonly string[];
    resolvedModel?: string;
    contextWindow?: number;
    capabilityProfile?: string;
    run: MmrAsyncTaskRun;
  };
  row: AsyncTaskFleetRow;
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
    const m = member;
    if (m.agent === "Task") {
      const taskPrep = prepareTaskRun(m.params, ctx, { ...baseToolDeps(deps), ...(deps.taskDeps ?? {}) } as TaskToolDeps);
      if (!taskPrep.ok) return { error: taskPrep.result.details?.errorMessage ?? "invalid Task parameters" };
      const { params, cwd, detailsContext, runnerOptionsBase, runner } = taskPrep.prepared;
      return {
        startArgs: {
          agent: "Task",
          description: params.description,
          prompt: params.prompt,
          cwd,
          workerTools: detailsContext.workerTools,
          ...(detailsContext.resolvedModel !== undefined ? { resolvedModel: detailsContext.resolvedModel } : {}),
          ...(detailsContext.contextWindow !== undefined ? { contextWindow: detailsContext.contextWindow } : {}),
          ...(params.capabilityProfile !== undefined ? { capabilityProfile: params.capabilityProfile } : {}),
          run: async ({ signal, onProgress }) => {
            try {
              return await runner.run({ ...runnerOptionsBase, signal, onProgress });
            } catch (err) {
              return buildSpawnErrorWorkerResult(err, { prompt: params.prompt, cwd });
            }
          },
        },
        row: {
          taskId: "",
          agent: "Task",
          description: params.description,
          ...(detailsContext.resolvedModel !== undefined ? { resolvedModel: detailsContext.resolvedModel } : {}),
          ...(params.capabilityProfile !== undefined ? { capabilityProfile: params.capabilityProfile } : {}),
        },
      };
    }
    const agent = m.agent;
    const schema = agent === "finder" ? FINDER_PARAMETERS_SCHEMA : LIBRARIAN_PARAMETERS_SCHEMA;
    const toolName = agent === "finder" ? FINDER_TOOL_NAME : LIBRARIAN_TOOL_NAME;
    const v = validateAsyncToolParams(toolName, schema, m.params);
    if (!v.ok) return { error: v.message };
    const tool = createSelectedTool(agent, deps);
    const cwd = resolveWorkerCwd(ctx);
    return {
      startArgs: {
        agent,
        description: m.description,
        prompt: m.promptSummary,
        cwd,
        workerTools: workerToolsForAgent(agent),
        run: async ({ signal, onProgress }) => {
          const result = await tool.execute(`${memberToolCallId}:${agent}`, m.params, signal, (update) => onProgress(update), ctx);
          const status = inferToolRunStatus(result, signal);
          return {
            toolResult: result,
            status,
            terminalOutcome: status === "succeeded" ? "success" : status === "failed" ? "failed" : undefined,
            ...(status === "failed" ? { errorMessage: inferToolErrorMessage(result) } : {}),
          };
        },
      },
      row: { taskId: "", agent, description: m.description },
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
    const validated = validateAsyncToolParams(START_TASK_TOOL_NAME, START_TASK_PARAMETERS, rawParams);
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
    description: START_TASK_DESCRIPTION,
    promptSnippet: "Start a bounded subagent worker in the background and return an opaque task_id",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: START_TASK_PARAMETERS,
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
      const validated = validateAsyncToolParams(START_TASK_TOOL_NAME, START_TASK_PARAMETERS, rawParams);
      if (!validated.ok) return validationResult(validated.message);
      const sessionKey = resolveSessionKey(ctx, deps);
      const onSettle = () => refreshAsyncTaskWidget(ctx, registry, sessionKey);
      // Validate the Task payload BEFORE any registry side effect (group open)
      // so an invalid Task start cannot mint an orphan group. Reuses the
      // blocking Task validation/model-resolution path; a pre-spawn failure
      // returns the same shaped result and creates no record and no group.
      const taskPrep = parsed.agent === "Task"
        ? prepareTaskRun(parsed.params, ctx, { ...baseToolDeps(deps), ...(deps.taskDeps ?? {}) } as TaskToolDeps)
        : undefined;
      if (taskPrep && !taskPrep.ok) {
        return {
          content: taskPrep.result.content,
          details: {
            worker: "mmr-subagents.async-task",
            tool: START_TASK_TOOL_NAME,
            agent: parsed.agent,
            errorMessage: taskPrep.result.details?.errorMessage,
          },
        };
      }
      // Pre-validate selected-agent (finder/librarian) params before any
      // registry side effect too, so an invalid background finder/librarian
      // start fails closed without creating a task or minting a group — the same
      // pre-spawn contract as Task. The run thunk still validates at execution
      // time as defense.
      if (parsed.agent === "finder") {
        const v = validateAsyncToolParams(FINDER_TOOL_NAME, FINDER_PARAMETERS_SCHEMA, parsed.params);
        if (!v.ok) return validationResult(v.message);
      } else if (parsed.agent === "librarian") {
        const v = validateAsyncToolParams(LIBRARIAN_TOOL_NAME, LIBRARIAN_PARAMETERS_SCHEMA, parsed.params);
        if (!v.ok) return validationResult(v.message);
      }
      // Two-layer gate: the session ceiling must permit push AND the caller
      // must not opt this task out. The registry adds at-most-once + a
      // per-session budget on top. Delivery is `followUp` + `triggerTurn`, so a
      // push wakes an idle session or queues immediately behind the active turn
      // instead of riding the next user prompt. The pinned widget is refreshed
      // by `onSettle` on terminal transition, so it stays correct even when the
      // task opts out of (or cannot send) a completion push.
      const automaticDeliveryEnabled = deps.enableCompletionPush !== false;
      const wantsAutomaticDelivery = parsed.wantsNotify && automaticDeliveryEnabled;
      const notify = wantsAutomaticDelivery ? buildCompletionNotifier(deps.pi) : undefined;
      const groupNotify = wantsAutomaticDelivery ? buildGroupCompletionNotifier(deps.pi) : undefined;
      // Track whether we are about to create a brand-new group, so a later
      // start rejection (e.g. concurrency cap) can roll back only a group this
      // call minted — never a pre-existing one.
      const groupPreexisted = parsed.groupId !== undefined && parsed.groupId !== "new"
        ? registry.getGroup(sessionKey, parsed.groupId) !== undefined
        : false;
      const groupSnapshot = parsed.groupId === "new"
        ? registry.openGroup({
            sessionKey,
            deliveryOptIn: wantsAutomaticDelivery,
            ...(parsed.groupLabel !== undefined ? { label: parsed.groupLabel } : {}),
            ...(groupNotify !== undefined ? { notify: groupNotify } : {}),
            onSettle,
          })
        : parsed.groupId !== undefined
          ? registry.openGroup({
              sessionKey,
              groupId: parsed.groupId,
              deliveryOptIn: wantsAutomaticDelivery,
              onSettle,
            })
          : undefined;
      const groupId = groupSnapshot?.groupId;
      const taskNotify = groupId === undefined ? notify : undefined;

      const started = parsed.agent === "Task"
        ? (() => {
            // Invariant: taskPrep is the ok variant here — agent === "Task"
            // implies it was computed and any failure already returned above.
            if (!taskPrep || !taskPrep.ok) throw new Error("unreachable: Task prep validated before group open");
            const { params, cwd, detailsContext, runnerOptionsBase, runner } = taskPrep.prepared;
            return {
              started: registry.startTask({
                sessionKey,
                originToolCallId: toolCallId,
                agent: "Task",
                description: params.description,
                prompt: params.prompt,
                cwd,
                ...(detailsContext.resolvedModel !== undefined ? { resolvedModel: detailsContext.resolvedModel } : {}),
                ...(detailsContext.contextWindow !== undefined ? { contextWindow: detailsContext.contextWindow } : {}),
                workerTools: detailsContext.workerTools,
                ...(params.capabilityProfile !== undefined ? { capabilityProfile: params.capabilityProfile } : {}),
                ...(groupId !== undefined ? { groupId } : {}),
                // The run thunk never throws: a spawn failure is converted into a
                // synthetic spawn-error worker result so the background task
                // finalizes with the SAME `spawn-error` status/shaping as blocking
                // Task (rather than a generic registry error).
                run: async ({ signal, onProgress }) => {
                  try {
                    return await runner.run({ ...runnerOptionsBase, signal, onProgress });
                  } catch (err) {
                    return buildSpawnErrorWorkerResult(err, { prompt: params.prompt, cwd });
                  }
                },
                deliveryOptIn: groupId === undefined ? wantsAutomaticDelivery : false,
                ...(taskNotify !== undefined ? { notify: taskNotify } : {}),
                onSettle,
              }),
            } as const;
          })()
        : (() => {
            const agent = parsed.agent;
            const tool = createSelectedTool(agent, deps);
            const cwd = resolveWorkerCwd(ctx);
            return {
              started: registry.startTask({
                sessionKey,
                originToolCallId: toolCallId,
                agent,
                description: parsed.description,
                prompt: parsed.promptSummary,
                cwd,
                workerTools: workerToolsForAgent(agent),
                ...(groupId !== undefined ? { groupId } : {}),
                run: async ({ signal, onProgress }) => {
                  const result = await tool.execute(
                    `${toolCallId}:${agent}`,
                    parsed.params,
                    signal,
                    (update) => onProgress(update),
                    ctx,
                  );
                  const status = inferToolRunStatus(result, signal);
                  return {
                    toolResult: result,
                    status,
                    terminalOutcome: status === "succeeded" ? "success" : status === "failed" ? "failed" : undefined,
                    ...(status === "failed" ? { errorMessage: inferToolErrorMessage(result) } : {}),
                  };
                },
                deliveryOptIn: groupId === undefined ? wantsAutomaticDelivery : false,
                ...(taskNotify !== undefined ? { notify: taskNotify } : {}),
                onSettle,
              }),
            } as const;
          })();

      if (!started.started.ok) {
        // Roll back a group this call just minted so a cap rejection cannot
        // leave an empty orphan group; dropEmptyGroup is a no-op on a group
        // that already holds tasks or that pre-existed.
        if (groupId !== undefined && !groupPreexisted) registry.dropEmptyGroup(sessionKey, groupId);
        const message =
          `start_task: cannot start; ${started.started.runningCount} background task(s) already running ` +
          `(cap ${started.started.cap}). Wait for one to finish (task_wait) or stop one (task_cancel) first.`;
        return {
          content: [{ type: "text", text: message }],
          details: { worker: "mmr-subagents.async-task", tool: START_TASK_TOOL_NAME, agent: parsed.agent, errorMessage: message },
        };
      }
      const snapshot = started.started.snapshot;
      // Idempotent-retry rollback: a deduplicated start returns the pre-existing
      // task, so a group this call just minted (group_id:"new") would otherwise
      // linger as an empty orphan — now a labeled one. Drop it when the dedup'd
      // task is not in it. Mirrors the cap-rejection rollback above;
      // dropEmptyGroup is a no-op once a group holds tasks or if it pre-existed.
      if (
        started.started.deduplicated
        && groupId !== undefined
        && !groupPreexisted
        && snapshot.groupId !== groupId
      ) {
        registry.dropEmptyGroup(sessionKey, groupId);
      }
      // Surface the launched agent on the pinned bottom-of-window widget so the
      // transcript card can stay empty (see renderMmrBackgroundTaskResult).
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      const dedupNote = started.started.deduplicated ? " (existing task for this call)" : "";
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
        `start_task: started background worker ${snapshot.taskId}${dedupNote}${groupNote} ("${snapshot.description}", agent ${snapshot.agent}). ` +
        `${deliveryHint} ` +
        `Use task_cancel to stop it. Background tasks are in-memory and lost if the session ends.`;
      // The opener (group_id:'new') owns the consolidated inline group card;
      // sibling starts in the same group render nothing inline. Guard on the
      // task actually landing in the freshly minted group so a deduplicated
      // retry (whose group we rolled back) does not claim openership.
      const groupOpener = groupId !== undefined && parsed.groupId === "new" && snapshot.groupId === groupId;
      return {
        content: [{ type: "text", text: message }],
        details: {
          worker: "mmr-subagents.async-task",
          tool: START_TASK_TOOL_NAME,
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
