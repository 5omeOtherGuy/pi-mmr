import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const AGENTS_MODULE = "extensions/mmr-workers/background-agents.ts";
const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";
const SCHEMAS_MODULE = "extensions/mmr-workers/async-task-tool-schemas.ts";
const TOOLS_MODULE = "extensions/mmr-workers/async-task-tools.ts";
const REGISTRY_MODULE = "extensions/mmr-workers/async-task-registry.ts";

after(cleanupLoadedSource);

afterEach(async () => {
  const agents = await importSource(AGENTS_MODULE);
  const profiles = await importSource(PROFILES_MODULE);
  agents.clearMmrDynamicBackgroundAgents();
  profiles.clearMmrDynamicSubagentProfiles();
});

function probeProfile(overrides = {}) {
  return {
    name: "sa__probe",
    displayName: "Probe",
    modelPreferences: [],
    tools: ["read"],
    promptRoute: "standalone",
    promptBuilder: "sa__probe",
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
    ...overrides,
  };
}

async function probeDescriptor(tool) {
  const { Type } = await import("typebox");
  const agents = await importSource(AGENTS_MODULE);
  return {
    agent: "sa__probe",
    profileName: "sa__probe",
    toolName: "sa__probe",
    paramsHint: "{task}",
    promptParamKey: "task",
    start: {
      parametersSchema: Type.Object({ task: Type.String() }, { additionalProperties: false }),
      workerTools: ["read"],
      prepareRun: agents.prepareRunFromToolExecute({ tool, agent: "sa__probe", workerTools: ["read"] }),
    },
  };
}

function stubProbeTool(calls) {
  return {
    name: "sa__probe",
    async execute(toolCallId, params) {
      calls.push({ toolCallId, params });
      return {
        content: [{ type: "text", text: `probe done: ${params.task}` }],
        details: { status: "success" },
      };
    },
  };
}

async function registerProbe({ profileOverrides = {}, calls = [] } = {}) {
  const agents = await importSource(AGENTS_MODULE);
  const profiles = await importSource(PROFILES_MODULE);
  profiles.registerMmrSubagentProfile(probeProfile(profileOverrides));
  agents.registerMmrBackgroundAgent(await probeDescriptor(stubProbeTool(calls)));
  return { agents, profiles, calls };
}

describe("background-agent derivation", () => {
  it("derives the built-in agent set from backgroundable profiles, default agent first", async () => {
    const agents = await importSource(AGENTS_MODULE);
    const names = agents.listMmrBackgroundAgents().map((d) => d.agent);
    assert.deepEqual(names, ["Task", "finder", "code_review", "librarian"]);
  });

  it("excludes oracle and history-reader through their backgroundable:false profiles", async () => {
    const agents = await importSource(AGENTS_MODULE);
    const profiles = await importSource(PROFILES_MODULE);
    assert.equal(profiles.getMmrSubagentProfile("oracle")?.backgroundable, false);
    assert.equal(profiles.getMmrSubagentProfile("history-reader")?.backgroundable, false);
    assert.equal(agents.normalizeMmrBackgroundAgentName("oracle"), undefined);
  });

  it("normalizes agent names by public name or profile name, case-insensitively", async () => {
    const agents = await importSource(AGENTS_MODULE);
    assert.equal(agents.normalizeMmrBackgroundAgentName(undefined), "Task");
    assert.equal(agents.normalizeMmrBackgroundAgentName("task"), "Task");
    assert.equal(agents.normalizeMmrBackgroundAgentName("task-subagent"), "Task");
    assert.equal(agents.normalizeMmrBackgroundAgentName("FINDER"), "finder");
    assert.equal(agents.normalizeMmrBackgroundAgentName("nope"), undefined);
  });

  it("hides a registered agent whose profile flips backgroundable to false", async () => {
    const { agents } = await registerProbe({ profileOverrides: { backgroundable: false } });
    const names = agents.listMmrBackgroundAgents().map((d) => d.agent);
    assert.ok(!names.includes("sa__probe"), "a backgroundable:false profile never reaches the agent list");
    assert.equal(agents.normalizeMmrBackgroundAgentName("sa__probe"), undefined);
  });

  it("appends a registered custom agent to the derived schema and description", async () => {
    await registerProbe();
    const schemas = await importSource(SCHEMAS_MODULE);
    const parameters = schemas.buildStartTaskParameters();
    const agentSchema = parameters.properties.agent;
    const literals = agentSchema.anyOf.map((entry) => entry.const);
    assert.deepEqual(literals, ["Task", "finder", "code_review", "librarian", "sa__probe"]);
    assert.match(agentSchema.description, /sa__probe \{task\}/);
    assert.match(parameters.properties.params.description, /for sa__probe use \{task\}/);
    assert.match(schemas.buildStartTaskDescription(), /Task \(default\), finder, code_review, librarian, or sa__probe/);
  });

  it("keeps the module-load schema snapshot byte-stable for the built-in set", async () => {
    const schemas = await importSource(SCHEMAS_MODULE);
    const literals = schemas.START_TASK_PARAMETERS.properties.agent.anyOf.map((entry) => entry.const);
    assert.deepEqual(literals, ["Task", "finder", "code_review", "librarian"]);
    assert.match(
      schemas.START_TASK_PARAMETERS.properties.agent.description,
      /Task \{prompt,description\}, finder \{query\}, code_review \{diff_description,files\?,instructions\?\}, librarian \{query,context\?\}/,
    );
  });
});

describe("start_task with a custom background agent", () => {
  async function makeStartTask(calls) {
    await registerProbe({ calls });
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1" });
    const deps = { registry, sessionKey: "S" };
    return { startTask: tools.createStartTaskTool(deps), poll: tools.createTaskPollTool(deps), registry };
  }

  it("dispatches a custom agent start through its registered descriptor", async () => {
    const calls = [];
    const { startTask, poll } = await makeStartTask(calls);
    const result = await startTask.execute(
      "call-1",
      { agent: "sa__probe", params: { task: "inspect the flux capacitor" } },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.equal(result.details.taskId, "t1");
    assert.equal(result.details.agent, "sa__probe");
    assert.match(result.content[0].text, /agent sa__probe/);
    // The run thunk resolves on a microtask; let it settle, then poll.
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    assert.equal(calls.length, 1, "the custom tool's execute is the run thunk");
    assert.equal(calls[0].params.task, "inspect the flux capacitor");
    const polled = await poll.execute("call-2", { task_id: "t1" }, undefined, undefined, { cwd: "/repo" });
    assert.equal(polled.details.status, "succeeded");
  });

  it("rejects invalid custom-agent params before any registry side effect", async () => {
    const calls = [];
    const { startTask, registry } = await makeStartTask(calls);
    const result = await startTask.execute(
      "call-1",
      { agent: "sa__probe", params: { task: 42 } },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.ok(result.details.errorMessage, "invalid params produce a validation result");
    assert.equal(calls.length, 0);
    assert.equal(registry.listTasks("S").counts.active, 0, "no record is created on a pre-spawn failure");
  });

  it("derives the capabilityProfile gate from the profile flag, not the agent name", async () => {
    const calls = [];
    const { startTask } = await makeStartTask(calls);
    const result = await startTask.execute(
      "call-1",
      { agent: "sa__probe", params: { task: "x" }, capabilityProfile: "read-only" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.match(result.details.errorMessage ?? "", /capabilityProfile is only supported for the Task agent/);
    assert.equal(calls.length, 0);
  });

  it("lists the custom agent in the unknown-agent error once registered", async () => {
    await registerProbe();
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const startTask = tools.createStartTaskTool({ registry: createMmrAsyncTaskRegistry({ idFactory: () => "t1" }), sessionKey: "S" });
    const result = await startTask.execute("call-1", { agent: "bogus", params: { task: "x" } }, undefined, undefined, { cwd: "/repo" });
    assert.match(result.details.errorMessage ?? "", /agent must be one of: Task, finder, code_review, librarian, sa__probe\./);
  });
});
