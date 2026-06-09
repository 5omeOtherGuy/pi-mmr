// Session-local todo-list state. Persisted on the active Pi session log via
// `ctx.appendEntry(TODO_STATE_ENTRY, …)` and recovered on read via
// `findLatestPersistedTodoState`. The shape and helper layout intentionally
// mirror `src/extensions/mmr-core/state.ts` so the two persistence layers
// behave identically (allowlist validation, version pinning, last→first
// scan).
//
// Background and Task-agent reuse rationale live under the "Archived
// task-list coordination prototype" block in ROADMAP.md; the previous
// workspace-scoped implementation is preserved on the annotated tag
// `archive/task-list-coordination-prototype-v1`.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TaskListSubtask {
  content: string;
  activeForm?: string;
  status: TodoStatus;
}

export interface TaskListItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
  subtasks?: TaskListSubtask[];
}

export interface PersistedTodoState {
  version: number;
  tasks: TaskListItem[];
}

export const TODO_STATE_ENTRY = "mmr-tasks.todo-state";
export const TODO_STATE_VERSION = 2;
const ACCEPTED_TODO_STATE_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

// Allowlist used to sanitize status values restored from persisted Pi
// entries. The tool schema enforces the same set at the call boundary; mirror
// it here so a hand-edited or corrupted entry cannot propagate invalid values
// into runtime state and widget rendering.
const TODO_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && TODO_STATUSES.has(value as TodoStatus);
}

/**
 * Build the persisted record that the tool writes via `pi.appendEntry`. Items
 * are shallow-copied to defend against caller mutation between the call and
 * the actual persistence flush.
 */
export function toPersistedTodoState(
  tasks: readonly TaskListItem[],
): PersistedTodoState {
  return {
    version: TODO_STATE_VERSION,
    tasks: tasks.map((task) => ({
      content: task.content,
      activeForm: task.activeForm,
      status: task.status,
      ...(task.subtasks && task.subtasks.length > 0
        ? {
            subtasks: task.subtasks.map((subtask) => ({
              content: subtask.content,
              ...(subtask.activeForm !== undefined ? { activeForm: subtask.activeForm } : {}),
              status: subtask.status,
            })),
          }
        : {}),
    })),
  };
}

function isCustomEntryWithData(
  entry: unknown,
): entry is { type: string; customType?: string; data?: unknown } {
  return typeof entry === "object" && entry !== null && "type" in entry;
}

/**
 * Validate the persisted state version.
 *
 * - known versions (currently v1 flat tasks and v2 subtasks) → accept.
 * - anything else (undefined, future numbers, non-numeric values) → reject.
 *
 * Unlike `mmr-core.mode-state`, no legacy pre-versioning records exist for
 * this entry type, so `undefined` is rejected outright.
 */
function validatePersistedVersion(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!ACCEPTED_TODO_STATE_VERSIONS.has(value)) return undefined;
  return value;
}

function parseTaskListSubtask(value: unknown): TaskListSubtask | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    content?: unknown;
    activeForm?: unknown;
    status?: unknown;
  };
  if (typeof candidate.content !== "string" || candidate.content.length === 0) {
    return undefined;
  }
  if (
    candidate.activeForm !== undefined
    && (typeof candidate.activeForm !== "string" || candidate.activeForm.length === 0)
  ) {
    return undefined;
  }
  if (!isTodoStatus(candidate.status)) return undefined;
  return {
    content: candidate.content,
    ...(candidate.activeForm !== undefined ? { activeForm: candidate.activeForm } : {}),
    status: candidate.status,
  };
}

function parseTaskListItem(
  value: unknown,
  options: { allowSubtasks: boolean },
): TaskListItem | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as {
    content?: unknown;
    activeForm?: unknown;
    status?: unknown;
    subtasks?: unknown;
  };
  if (typeof candidate.content !== "string" || candidate.content.length === 0) {
    return undefined;
  }
  if (
    typeof candidate.activeForm !== "string"
    || candidate.activeForm.length === 0
  ) {
    return undefined;
  }
  if (!isTodoStatus(candidate.status)) return undefined;
  let subtasks: TaskListSubtask[] | undefined;
  if (options.allowSubtasks && candidate.subtasks !== undefined) {
    if (!Array.isArray(candidate.subtasks)) return undefined;
    subtasks = [];
    for (const raw of candidate.subtasks) {
      const subtask = parseTaskListSubtask(raw);
      if (!subtask) return undefined;
      subtasks.push(subtask);
    }
  }
  return {
    content: candidate.content,
    activeForm: candidate.activeForm,
    status: candidate.status,
    ...(subtasks && subtasks.length > 0 ? { subtasks } : {}),
  };
}

/**
 * Parse a single persisted-state payload (the `data` field of a Pi custom
 * entry). Returns `undefined` for any structural or version mismatch; the
 * scanner in `findLatestPersistedTodoState` treats that as "skip this entry
 * and keep walking backward".
 */
export function parsePersistedTodoState(
  data: unknown,
): PersistedTodoState | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const candidate = data as { version?: unknown; tasks?: unknown };

  const version = validatePersistedVersion(candidate.version);
  if (version === undefined) return undefined;

  if (!Array.isArray(candidate.tasks)) return undefined;

  const tasks: TaskListItem[] = [];
  for (const raw of candidate.tasks) {
    const item = parseTaskListItem(raw, { allowSubtasks: version >= 2 });
    if (!item) return undefined;
    tasks.push(item);
  }

  return { version, tasks };
}

/**
 * Walk the session entry log from newest to oldest and return the most recent
 * todo-state payload that parses cleanly. Future-version or otherwise invalid
 * entries are skipped, mirroring `findLatestPersistedModeState`.
 */
export function findLatestPersistedTodoState(
  entries: readonly unknown[],
): PersistedTodoState | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!isCustomEntryWithData(entry)) continue;
    if (entry.type !== "custom" || entry.customType !== TODO_STATE_ENTRY) {
      continue;
    }

    const parsed = parsePersistedTodoState(entry.data);
    if (parsed) return parsed;
  }

  return undefined;
}
