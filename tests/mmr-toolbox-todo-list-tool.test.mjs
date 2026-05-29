// Failing-first (RED) tests for the session-local
// `task_list` tool that replaces the previous workspace-scoped coordination
// prototype.
//
//
// The new tool surface:
//   - tool name stays `task_list` (preserves mmr-core logical routing);
//   - input schema is strictly `{ tasks: [{ content, activeForm, status, subtasks? }] }`;
//   - status is `pending|in_progress|completed`;
//   - whole-list replacement (no merge);
//   - persistence is a `mmr-toolbox.todo-state` CustomEntry on the current
//     Pi session (`pi.appendEntry(TODO_STATE_ENTRY, { version: 2, tasks })`);
//   - when every submitted item is `completed`, the *stored* list is cleared
//     immediately; the tool result still echoes the submitted list.
//
// These tests intentionally fail until `extensions/mmr-toolbox/todo-list.ts`
// and `extensions/mmr-toolbox/todo-list-tool.ts` land and `index.ts` is
// rewired to register the new tool in place of the old one.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

// Wire the mock so `pi.appendEntry(customType, data)` actually appends a
// CustomEntry into the same array the ExtensionContext's session manager
// returns from `getEntries()`. This mirrors Pi's real session log behavior
// closely enough for round-trip tests of the todo tool.
function makeLinkedSession(initialEntries = []) {
  const entries = [...initialEntries];
  let counter = 0;
  function append(customType, data) {
    counter += 1;
    entries.push({
      type: "custom",
      id: `entry-${counter}`,
      ts: new Date(2030, 0, 1, 0, 0, counter).toISOString(),
      customType,
      data,
    });
  }
  function getEntries() { return entries; }
  return { entries, append, getEntries };
}

function makeCtx(session, overrides = {}) {
  return {
    cwd: overrides.cwd ?? "/tmp/pi-mmr-test-cwd",
    hasUI: overrides.hasUI ?? false,
    sessionManager: {
      getEntries: session.getEntries,
      getCwd: () => overrides.cwd ?? "/tmp/pi-mmr-test-cwd",
      getSessionId: () => overrides.sessionId ?? "test-session",
      getSessionName: () => overrides.sessionName,
    },
    ui: { notify() {}, setWidget() {}, theme: { fg: (_n, v) => v, bold: (v) => v } },
    ...overrides,
  };
}

async function loadToolbox() {
  const toolbox = await importSource("extensions/mmr-toolbox/index.ts");
  const { pi, calls, handlers } = createMockPi();
  toolbox.default(pi);
  return { toolbox, pi, calls, handlers };
}

async function loadToolboxLinked() {
  const { pi, handlers } = createMockPi();
  const session = makeLinkedSession();
  // Override the recorder so it pushes into the same session entries array
  // that ctx.sessionManager.getEntries() will surface. This is how the real
  // Pi runtime behaves; the mock keeps them separate by default.
  pi.appendEntry = (customType, data) => session.append(customType, data);
  const toolbox = await importSource("extensions/mmr-toolbox/index.ts");
  toolbox.default(pi);
  return { pi, handlers, session, toolbox };
}

function getTaskListTool(pi) {
  const tool = pi.tools.get("task_list");
  assert.ok(tool, "task_list tool must be registered");
  return tool;
}

async function callTaskList(tool, params, ctx) {
  return tool.execute("call-1", params, undefined, () => {}, ctx);
}

describe("mmr-toolbox task_list — schema (session-local todo)", () => {
  it("exposes only `tasks` at the top level (no `action`, no legacy coordination keys)", async () => {
    const { pi } = await loadToolbox();
    const tool = getTaskListTool(pi);
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.parameters, "task_list must declare a parameter schema");
    assert.equal(tool.parameters.type, "object");
    assert.equal(
      tool.parameters.additionalProperties,
      false,
      "params object must be strict (additionalProperties: false) so legacy keys are rejected",
    );
    const propKeys = Object.keys(tool.parameters.properties ?? {});
    assert.deepEqual(
      propKeys.sort(),
      ["tasks"],
      `task_list params must expose only \`tasks\`; got [${propKeys.join(", ")}]`,
    );
    assert.deepEqual(tool.parameters.required ?? [], ["tasks"]);
  });

  it("each item is a strict object with content, activeForm, status, optional subtasks (no extras)", async () => {
    const { pi } = await loadToolbox();
    const tool = getTaskListTool(pi);
    const items = tool.parameters.properties.tasks?.items;
    assert.ok(items, "tasks array must declare an `items` schema");
    assert.equal(items.type, "object");
    assert.equal(
      items.additionalProperties,
      false,
      "task item must be strict so legacy fields (repoURL, dependsOn, …) are rejected",
    );
    const itemKeys = Object.keys(items.properties ?? {}).sort();
    assert.deepEqual(
      itemKeys,
      ["activeForm", "content", "status", "subtasks"],
      `item must expose only content/activeForm/status/subtasks; got [${itemKeys.join(", ")}]`,
    );
    assert.deepEqual(
      (items.required ?? []).slice().sort(),
      ["activeForm", "content", "status"],
      "all three item fields must be required",
    );
    const statusVariants = items.properties.status.anyOf
      ?? items.properties.status.oneOf
      ?? [items.properties.status];
    const statuses = statusVariants.map((v) => v.const).filter(Boolean).sort();
    assert.deepEqual(
      statuses,
      ["completed", "in_progress", "pending"],
      "status enum must be pending|in_progress|completed (no `open`)",
    );
    // content/activeForm must enforce non-empty strings.
    assert.equal(items.properties.content.type, "string");
    assert.equal(items.properties.activeForm.type, "string");
    const subtasks = items.properties.subtasks;
    assert.ok(subtasks, "task item must expose optional subtasks");
    assert.equal(subtasks.type, "array");
    assert.equal(subtasks.items.type, "object");
    assert.equal(subtasks.items.additionalProperties, false);
    assert.deepEqual(
      Object.keys(subtasks.items.properties ?? {}).sort(),
      ["activeForm", "content", "status"],
      "subtasks expose content/optional activeForm/status only",
    );
    assert.deepEqual(
      (subtasks.items.required ?? []).slice().sort(),
      ["content", "status"],
      "subtask activeForm must be optional",
    );
    assert.ok(
      (items.properties.content.minLength ?? 0) >= 1,
      "content must require minLength >= 1",
    );
    assert.ok(
      (items.properties.activeForm.minLength ?? 0) >= 1,
      "activeForm must require minLength >= 1",
    );
  });

  it("description and prompt copy describe the simple session-local semantics, not coordination", async () => {
    const { pi } = await loadToolbox();
    const tool = getTaskListTool(pi);
    assert.equal(typeof tool.description, "string");
    // Must reference the simple session-todo surface.
    assert.match(tool.description, /content/i);
    assert.match(tool.description, /activeForm/);
    assert.match(tool.description, /pending\s*\|\s*in_progress\s*\|\s*completed/);
    // Must NOT advertise removed actions / fields.
    for (const ghost of [
      /\bclaim\b/i, /\brelease\b/i, /\bsteal\b/i, /\ballRepos\b/i,
      /\brepoURL\b/i, /\bdependsOn\b/i, /\bparentID\b/i, /\bttlMs\b/i,
      /\baction\b\s*[:=]/i, /workspace[- ]scoped/i,
    ]) {
      assert.doesNotMatch(
        tool.description,
        ghost,
        `description must not mention removed surface: ${ghost}`,
      );
    }
    assert.ok(Array.isArray(tool.promptGuidelines));
    const guidelines = tool.promptGuidelines.join("\n");
    assert.match(guidelines, /task_list/);
    assert.doesNotMatch(guidelines, /claim|release|steal|repoURL|dependsOn/i);
  });

  it("prompt copy warns that tasks: [] clears the list and must be explicit", async () => {
    const { pi } = await loadToolbox();
    const tool = getTaskListTool(pi);
    const copy = [
      tool.description,
      ...(Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : []),
    ].join("\n");
    assert.match(copy, /tasks:\s*\[\]/,
      "prompt copy must mention the exact empty-list shape that clears state");
    assert.match(copy, /clear/i,
      "prompt copy must explain the clear behavior");
    assert.match(copy, /explicit/i,
      "prompt copy must warn that empty-list clears require explicit user intent");
  });

  it("prompt copy tells the model to advance subtask status as it works through them", async () => {
    const { pi } = await loadToolbox();
    const tool = getTaskListTool(pi);
    // The status-advancement obligation belongs in the prompt guidelines
    // (the per-call reminder the model actually receives), not just buried
    // in the long-form description. The pinned widget only reflects which
    // subtask is in progress if the model advances subtasks the same way
    // it advances top-level items.
    const guidelines = tool.promptGuidelines ?? [];
    // At least one guideline line must give the model an explicit directive
    // to advance subtask status through the lifecycle, not just describe
    // that subtasks happen to carry a `status` field on the schema.
    const advancementLine = guidelines.find((line) =>
      /subtask/i.test(line)
      && /\b(mark|advance|update|progress|move)\b/i.test(line)
      && /\bin_progress\b/.test(line)
      && /\bcompleted\b/.test(line),
    );
    assert.ok(
      advancementLine,
      `prompt guidelines must include an explicit subtask status-advancement directive (mark subtasks in_progress/completed as work progresses); got:\n${guidelines.map((l) => `  - ${l}`).join("\n")}`,
    );
  });

  it("prompt guidelines require a final pre-response update when active work completes", async () => {
    const { pi } = await loadToolbox();
    const tool = getTaskListTool(pi);
    const guidelines = tool.promptGuidelines ?? [];

    const finalUpdateLine = guidelines.find((line) =>
      /final response/i.test(line)
      && /before (sending|send)/i.test(line)
      && /task_list/i.test(line)
      && /active (work|item)/i.test(line)
      && /completed/i.test(line)
      && /in_progress/i.test(line)
      && /(interim|status update|what remains)/i.test(line),
    );
    assert.ok(
      finalUpdateLine,
      `prompt guidelines must tell the model to update task_list before a final response that completes active work; got:\n${guidelines.map((l) => `  - ${l}`).join("\n")}`,
    );
  });

  it("status enum rejects the legacy `open` value", async () => {
    const { pi } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(makeLinkedSession());
    const result = await callTaskList(
      tool,
      { tasks: [{ content: "Do thing", activeForm: "Doing thing", status: "open" }] },
      ctx,
    );
    assert.equal(result?.isError, true, "schema must reject status='open'");
  });

  it("accepts optional subtasks and renders them as child rows in visible text", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    const tasks = [{
      content: "Implement feature",
      activeForm: "Implementing feature",
      status: "in_progress",
      subtasks: [
        { content: "Add tests", status: "pending" },
        { content: "Run checks", activeForm: "Running checks", status: "in_progress" },
      ],
    }];

    const result = await callTaskList(tool, { tasks }, ctx);

    assert.notEqual(result?.isError, true);
    assert.match(result.content[0].text, /^◐ Implementing feature$/m);
    assert.match(result.content[0].text, /^  ├─ ○ Add tests$/m);
    assert.match(result.content[0].text, /^  └─ ◐ Running checks$/m);
    assert.deepEqual(result.details.newTasks, tasks);
  });
});

describe("mmr-toolbox task_list — strict schema rejects legacy keys", () => {
  const legacyTopLevelKeys = [
    "action", "taskID", "title", "description", "repoURL", "status",
    "dependsOn", "parentID", "limit", "ttlMs", "steal", "allRepos",
    "force", "ready",
  ];
  for (const key of legacyTopLevelKeys) {
    it(`rejects legacy top-level key \`${key}\``, async () => {
      const { pi } = await loadToolboxLinked();
      const tool = getTaskListTool(pi);
      const session = makeLinkedSession();
      const ctx = makeCtx(session);
      const params = {
        tasks: [{ content: "Do thing", activeForm: "Doing thing", status: "pending" }],
        [key]: "legacy-value",
      };
      let result;
      let threw;
      try {
        result = await callTaskList(tool, params, ctx);
      } catch (err) {
        threw = err;
      }
      const rejected = threw !== undefined || result?.isError === true;
      assert.ok(
        rejected,
        `task_list must reject legacy key \`${key}\`; instead it silently accepted with result=${JSON.stringify(result)}`,
      );
      // The persisted list must be unchanged after a rejected call.
      const customEntries = session.entries.filter((e) => e.customType === "mmr-toolbox.todo-state");
      assert.equal(
        customEntries.length,
        0,
        `rejected call must not persist anything; got ${customEntries.length} todo-state entries`,
      );
    });
  }

  const legacyItemKeys = [
    "id", "updatedAt", "repoURL", "dependsOn", "parentID", "owner",
    "claimedBy", "claimedAt", "claimExpiresAt", "createdAt",
  ];
  for (const key of legacyItemKeys) {
    it(`rejects legacy item-level key \`${key}\``, async () => {
      const { pi } = await loadToolboxLinked();
      const tool = getTaskListTool(pi);
      const session = makeLinkedSession();
      const ctx = makeCtx(session);
      const params = {
        tasks: [{
          content: "Do thing",
          activeForm: "Doing thing",
          status: "pending",
          [key]: "legacy-value",
        }],
      };
      let result;
      let threw;
      try { result = await callTaskList(tool, params, ctx); } catch (err) { threw = err; }
      const rejected = threw !== undefined || result?.isError === true;
      assert.ok(rejected, `task_list must reject legacy item key \`${key}\``);
      const customEntries = session.entries.filter((e) => e.customType === "mmr-toolbox.todo-state");
      assert.equal(customEntries.length, 0, "rejected call must not persist");
    });
  }

  it("rejects empty content / empty activeForm", async () => {
    const { pi } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const session = makeLinkedSession();
    const ctx = makeCtx(session);
    for (const bad of [
      { content: "", activeForm: "Doing", status: "pending" },
      { content: "Do", activeForm: "", status: "pending" },
    ]) {
      let result; let threw;
      try { result = await callTaskList(tool, { tasks: [bad] }, ctx); } catch (err) { threw = err; }
      assert.ok(threw !== undefined || result?.isError === true, `expected rejection for ${JSON.stringify(bad)}`);
    }
    assert.equal(
      session.entries.filter((e) => e.customType === "mmr-toolbox.todo-state").length,
      0,
      "rejected calls must not persist",
    );
  });

  it("rejects malformed subtasks", async () => {
    const { pi } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const session = makeLinkedSession();
    const ctx = makeCtx(session);
    for (const badSubtask of [
      { content: "Child", status: "pending", extra: true },
      { content: "", status: "pending" },
      { content: "Child", activeForm: "", status: "pending" },
      { content: "Child", status: "open" },
      { content: "Child", status: "pending", subtasks: [] },
    ]) {
      const result = await callTaskList(tool, {
        tasks: [{
          content: "Parent",
          activeForm: "Doing parent",
          status: "pending",
          subtasks: [badSubtask],
        }],
      }, ctx);
      assert.equal(result?.isError, true, `expected subtask rejection for ${JSON.stringify(badSubtask)}`);
    }
    assert.equal(
      session.entries.filter((e) => e.customType === "mmr-toolbox.todo-state").length,
      0,
      "rejected subtask calls must not persist",
    );
  });
});

describe("mmr-toolbox task_list — persistence as mmr-toolbox.todo-state CustomEntry", () => {
  it("appends a versioned todo-state entry on every accepted write", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    const tasks = [
      { content: "Write tests", activeForm: "Writing tests", status: "in_progress" },
      { content: "Run gate", activeForm: "Running gate", status: "pending" },
    ];
    const result = await callTaskList(tool, { tasks }, ctx);
    assert.notEqual(result?.isError, true, "valid input must not error");

    const todoEntries = session.entries.filter((e) => e.customType === "mmr-toolbox.todo-state");
    assert.equal(todoEntries.length, 1, "exactly one todo-state entry must be appended");
    const data = todoEntries[0].data;
    assert.equal(data?.version, 2, "persisted state must declare version: 2");
    assert.deepEqual(data?.tasks, tasks, "persisted tasks must match submitted list");
  });

  it("visible tool output includes the previous list before replacement", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    await callTaskList(tool, {
      tasks: [
        { content: "Alpha", activeForm: "Doing alpha", status: "in_progress" },
        { content: "Beta", activeForm: "Doing beta", status: "pending" },
      ],
    }, ctx);

    const result = await callTaskList(tool, {
      tasks: [{ content: "Gamma", activeForm: "Doing gamma", status: "pending" }],
    }, ctx);

    const text = result?.content?.[0]?.text ?? "";
    assert.match(text, /1 item\(s\):/,
      "current submitted list should still be visible first");
    assert.match(text, /○ Gamma/,
      "current submitted item should be visible");
    assert.match(text, /Previous list \(2 item\(s\)\):/,
      "visible output should expose details.oldTasks, not only bury it in details");
    assert.match(text, /◐ Doing alpha/,
      "previous in-progress item should use its activeForm in the visible summary");
    assert.match(text, /○ Beta/,
      "previous pending item should be included in the visible summary");
  });

  it("same session: write then read returns the submitted list", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    const tasks = [{ content: "Alpha", activeForm: "Doing alpha", status: "pending" }];
    await callTaskList(tool, { tasks }, ctx);

    // A subsequent read of the latest todo-state entry must show the same list.
    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const latest = findLatestPersistedTodoState(session.getEntries());
    assert.ok(latest, "latest todo-state entry must be discoverable");
    assert.deepEqual(latest.tasks, tasks);
  });

  it("whole-list replacement: removed items disappear (no merge)", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    await callTaskList(tool, {
      tasks: [
        { content: "Alpha", activeForm: "Doing alpha", status: "in_progress" },
        { content: "Beta",  activeForm: "Doing beta",  status: "pending" },
      ],
    }, ctx);
    await callTaskList(tool, {
      tasks: [
        { content: "Beta",  activeForm: "Doing beta",  status: "completed" },
      ],
    }, ctx);

    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const latest = findLatestPersistedTodoState(session.getEntries());
    // The latest call submitted a single-item list with only Beta completed.
    // Because all submitted items are completed, the stored list clears to [].
    assert.deepEqual(
      latest?.tasks,
      [],
      "all-completed submission must clear the stored list",
    );
    // The Alpha item from the first call must not survive into the latest list.
    assert.equal(
      latest?.tasks.some((t) => t.content === "Alpha"),
      false,
      "previous-call items must not persist when the new call omits them",
    );
  });

  it("all-completed write clears stored state but result still echoes the submitted list", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    const tasks = [
      { content: "A", activeForm: "Doing A", status: "completed" },
      { content: "B", activeForm: "Doing B", status: "completed" },
    ];
    const result = await callTaskList(tool, { tasks }, ctx);
    assert.notEqual(result?.isError, true);

    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const latest = findLatestPersistedTodoState(session.getEntries());
    assert.deepEqual(latest?.tasks, [], "stored list must clear when allDone");

    // Result details should still echo what the model submitted, regardless
    // of the persisted state-clear.
    assert.ok(result?.details, "tool result must expose details");
    const echoed = result.details.newTasks ?? result.details.tasks;
    assert.deepEqual(
      echoed,
      tasks,
      "details must echo the submitted (all-completed) list, not the cleared []",
    );
    // Surface the allCompleted signal so callers/UI can distinguish.
    assert.equal(result.details.allCompleted, true);
  });

  it("partial completion does NOT clear the stored list", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    const tasks = [
      { content: "A", activeForm: "Doing A", status: "completed" },
      { content: "B", activeForm: "Doing B", status: "in_progress" },
    ];
    await callTaskList(tool, { tasks }, ctx);
    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const latest = findLatestPersistedTodoState(session.getEntries());
    assert.deepEqual(latest?.tasks, tasks, "partial completion must persist as submitted");
  });

  it("persists optional subtasks in version 2 state", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    const tasks = [{
      content: "Parent",
      activeForm: "Doing parent",
      status: "pending",
      subtasks: [
        { content: "Child A", status: "pending" },
        { content: "Child B", activeForm: "Doing child B", status: "completed" },
      ],
    }];

    await callTaskList(tool, { tasks }, ctx);

    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const latest = findLatestPersistedTodoState(session.getEntries());
    assert.equal(latest?.version, 2);
    assert.deepEqual(latest?.tasks, tasks);
  });

  it("empty `tasks: []` is accepted and persists an empty list (does not error)", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const ctx = makeCtx(session);
    const result = await callTaskList(tool, { tasks: [] }, ctx);
    assert.notEqual(result?.isError, true, "empty list must be a valid submission");
    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const latest = findLatestPersistedTodoState(session.getEntries());
    assert.deepEqual(latest?.tasks, []);
  });
});

describe("mmr-toolbox task_list — persisted-state helpers (mirror mmr-core.mode-state)", () => {
  it("exports TODO_STATE_ENTRY and TODO_STATE_VERSION constants", async () => {
    const mod = await importSource("extensions/mmr-toolbox/todo-list.ts");
    assert.equal(mod.TODO_STATE_ENTRY, "mmr-toolbox.todo-state");
    assert.equal(mod.TODO_STATE_VERSION, 2);
  });

  it("findLatestPersistedTodoState walks last→first and skips unrelated entries", async () => {
    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const entries = [
      { type: "custom", customType: "mmr-toolbox.todo-state",
        data: { version: 1, tasks: [{ content: "old", activeForm: "olding", status: "pending" }] } },
      { type: "custom", customType: "mmr-core.mode-state", data: { mode: "smart" } },
      { type: "custom", customType: "mmr-toolbox.todo-state",
        data: { version: 1, tasks: [{ content: "new", activeForm: "newing", status: "completed" }] } },
      { type: "session_info", name: "foo" },
    ];
    const latest = findLatestPersistedTodoState(entries);
    assert.ok(latest);
    assert.equal(latest.tasks[0].content, "new");
  });

  it("still parses existing version 1 flat persisted state and ignores v1 subtasks", async () => {
    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const entries = [{
      type: "custom",
      customType: "mmr-toolbox.todo-state",
      data: {
        version: 1,
        tasks: [{
          content: "legacy",
          activeForm: "legacying",
          status: "pending",
          subtasks: [{ content: "ignored", status: "pending" }],
        }],
      },
    }];

    const latest = findLatestPersistedTodoState(entries);

    assert.deepEqual(latest, {
      version: 1,
      tasks: [{ content: "legacy", activeForm: "legacying", status: "pending" }],
    });
  });

  it("findLatestPersistedTodoState rejects future versions (returns undefined for that entry, continues scanning)", async () => {
    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    const entries = [
      { type: "custom", customType: "mmr-toolbox.todo-state",
        data: { version: 1, tasks: [{ content: "v1", activeForm: "v1-ing", status: "pending" }] } },
      { type: "custom", customType: "mmr-toolbox.todo-state",
        data: { version: 99, tasks: [{ content: "future", activeForm: "futuring", status: "pending" }] } },
    ];
    const latest = findLatestPersistedTodoState(entries);
    // Future versions must be rejected; the scanner falls back to the previous v1 entry.
    assert.ok(latest, "expected fallback to the latest accepted-version entry");
    assert.equal(latest.tasks[0].content, "v1");
  });

  it("findLatestPersistedTodoState returns undefined when no entries match", async () => {
    const { findLatestPersistedTodoState } = await importSource(
      "extensions/mmr-toolbox/todo-list.ts",
    );
    assert.equal(findLatestPersistedTodoState([]), undefined);
    assert.equal(
      findLatestPersistedTodoState([{ type: "session_info", name: "x" }]),
      undefined,
    );
  });
});

describe("mmr-toolbox task_list — widget render truncates to TUI width", () => {
  // Regression coverage for width clipping in the session-local widget.
  // Keep each rendered row within the TUI width so a long
  // `content`/`activeForm` cannot overflow the editor frame or crash Pi
  // during startup hydration.

  function makeWidgetCtx(session, overrides = {}) {
    const widgetCalls = [];
    const ctx = makeCtx(session, {
      hasUI: true,
      ui: {
        notify() {},
        setWidget(id, factoryOrLines) {
          widgetCalls.push({ id, factory: factoryOrLines });
        },
        theme: { fg: (_n, v) => v, bold: (v) => `[BOLD]${v}` },
      },
      ...overrides,
    });
    return { ctx, widgetCalls };
  }

  it("render(width) clips long task rows to the supplied TUI width", async () => {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const { ctx, widgetCalls } = makeWidgetCtx(session);

    const longContent = "Long task description ".repeat(20);
    await callTaskList(tool, {
      tasks: [{ content: longContent, activeForm: "Doing the long thing", status: "pending" }],
    }, ctx);

    const last = widgetCalls.at(-1);
    assert.ok(last, "task_list must call setWidget on a successful call (hasUI: true)");
    assert.equal(typeof last.factory, "function",
      "widget must be registered via the factory form so render receives a width");

    const widget = last.factory(undefined, ctx.ui.theme);
    const lines = widget.render(40);

    assert.ok(lines.length > 0, "widget must render at least one line");
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= 40,
        `widget line must fit render width; width=${visibleWidth(line)} line=${JSON.stringify(line)}`,
      );
    }
  });

  it("render(width) is a no-op for non-finite width (legacy callers)", async () => {
    const { pi, session } = await loadToolboxLinked();
    const tool = getTaskListTool(pi);
    const { ctx, widgetCalls } = makeWidgetCtx(session);

    await callTaskList(tool, {
      tasks: [{ content: "Short", activeForm: "Doing short", status: "pending" }],
    }, ctx);

    const widget = widgetCalls.at(-1).factory(undefined, ctx.ui.theme);
    const linesInfinite = widget.render(Number.POSITIVE_INFINITY);
    const linesNaN = widget.render(Number.NaN);
    // Pre-truncation output must be preserved when no finite width is given.
    assert.ok(linesInfinite.some((l) => l.includes("Short")),
      `Infinite width must preserve untrimmed content; got ${JSON.stringify(linesInfinite)}`);
    assert.ok(linesNaN.some((l) => l.includes("Short")),
      `NaN width must preserve untrimmed content; got ${JSON.stringify(linesNaN)}`);
  });
});
