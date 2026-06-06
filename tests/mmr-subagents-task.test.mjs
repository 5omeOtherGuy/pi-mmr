import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const TASK_MODULE = "extensions/mmr-subagents/task.ts";
const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";
const PROMPTS_MODULE = "extensions/mmr-subagents/prompts.ts";
const ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";

function makeWorkerResult(overrides = {}) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    finalOutput: "done",
    truncatedFinalOutput: "done",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
    prompt: "",
    cwd: "",
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    trail: [],
    ...overrides,
  };
}

/**
 * Deterministic resolver stub used by tests that exercise the Task tool's
 * runner-facing surface. Production code uses
 * `resolveMmrSubagentInvocation` against the parent ctx's model registry;
 * tests inject this stub via the `resolveInvocation` dep so they do not
 * need to build a full `MmrModelRegistryLike` for every case.
 */
const DEFAULT_TASK_WORKER_TOOLS = Object.freeze([
  "read", "bash", "edit", "write",
  "read_web_page", "web_search",
  "finder", "skill", "task_list",
]);
function stubTaskInvocation(overrides = {}) {
  return () => ({
    ok: true,
    profile: { name: "task-subagent" },
    promptRoute: "mode-derived",
    parentMode: overrides.parentMode ?? "smart",
    promptBaseMode: overrides.promptBaseMode ?? overrides.parentMode ?? "smart",
    selected: {
      provider: overrides.provider ?? "claude-subscription",
      model: overrides.model ?? "claude-opus-4-8",
      thinkingLevel: overrides.thinkingLevel ?? "low",
      registeredModel: {
        provider: overrides.provider ?? "claude-subscription",
        id: overrides.model ?? "claude-opus-4-8",
      },
    },
    modelArg: overrides.modelArg
      ?? `${overrides.provider ?? "claude-subscription"}/${overrides.model ?? "claude-opus-4-8"}`,
    workerTools: overrides.workerTools ?? DEFAULT_TASK_WORKER_TOOLS,
    tools: overrides.workerTools ?? DEFAULT_TASK_WORKER_TOOLS,
    toolResolution: {
      intendedTools: overrides.workerTools ?? DEFAULT_TASK_WORKER_TOOLS,
      deniedTools: ["Task", "oracle", "librarian", "handoff"],
      omittedTools: [],
    },
    candidates: [],
    diagnostics: [],
  });
}

const BASE_PARENT_PROMPT = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "",
  "Available tools:",
  "- read: Parent read tool.",
  "- bash: Parent shell tool.",
  "- Task: Parent task tool.",
  "",
  "Guidelines:",
  "- Parent guideline.",
  "",
  "Pi documentation (read only when needed):",
  "- Parent docs.",
  "",
  "Tail content.",
].join("\n");

beforeEach(async () => {
  const assembly = await importSource(ASSEMBLY_MODULE);
  const prompts = await importSource(PROMPTS_MODULE);
  assembly.clearMmrSubagentPromptBuilders();
  prompts.registerMmrSubagentsPromptBuilders();
});

after(cleanupLoadedSource);

describe("task-subagent profile", () => {
  it("registers a mode-derived task-subagent profile with the task worker tool surface", async () => {
    const { getMmrSubagentProfile, listMmrSubagentProfiles } = await importSource(PROFILES_MODULE);
    const profile = getMmrSubagentProfile("task-subagent");
    assert.ok(profile, "task-subagent profile must be registered");
    assert.ok(listMmrSubagentProfiles().includes("task-subagent"));
    assert.equal(profile.displayName, "Task Subagent");
    assert.equal(profile.promptRoute, "mode-derived");
    assert.equal(profile.baseMode, "from-parent");
    assert.equal(profile.promptBuilder, "task-subagent");
    // Per spec §5: MCP/toolbox stay false in this slice; recursive/advisory
    // plus toolbox/MCP escape hatches are listed in denyTools rather than
    // relying on their absence from the intended tools list.
    assert.equal(profile.allowMcp, false);
    assert.equal(profile.allowToolbox, false);
    assert.deepEqual(
      [...profile.tools],
      ["read", "bash", "edit", "write", "read_web_page", "web_search", "finder", "skill", "task_list"],
    );
    assert.ok(Array.isArray(profile.denyTools), "task-subagent must declare an explicit denyTools list");
    assert.deepEqual(
      [...profile.denyTools].sort(),
      ["Task", "apply_patch", "handoff", "librarian", "oracle", "read_mcp_resource", "start_task", "task_cancel", "task_poll", "task_wait"],
    );
    for (const recursive of ["Task", "oracle", "librarian", "handoff"]) {
      assert.equal(profile.tools.includes(recursive), false, `${recursive} must not be in the task worker allowlist`);
      assert.equal(profile.denyTools.includes(recursive), true, `${recursive} must be in the task worker denyTools`);
    }
  });
});

describe("Task worker prompt builder", () => {
  it("registers a task-subagent worker-role builder through mmr-subagents prompts", async () => {
    const { assembleMmrSubagentSurface } = await importSource(ASSEMBLY_MODULE);
    const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
    const profile = getMmrSubagentProfile("task-subagent");
    const result = assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "BASE",
      activeToolManifest: [],
      cwd: "/tmp/repo",
      parentMode: "smart",
    });
    assert.match(result.systemPrompt, /Task Worker Role/);
    assert.match(result.systemPrompt, /bounded task/i);
    assert.match(result.systemPrompt, /parent/i);
    assert.match(result.systemPrompt, /Outcome:/);
    assert.match(result.systemPrompt, /Validation/);
  });
});

describe("Task tool", () => {
  it("exposes the expected schema and model-visible guidance", async () => {
    const { createTaskTool, TASK_TOOL_NAME, TASK_PARAMETERS_SCHEMA } = await importSource(TASK_MODULE);
    const tool = createTaskTool({ runner: { async run() { return makeWorkerResult(); } } });
    assert.equal(TASK_TOOL_NAME, "Task");
    assert.equal(tool.name, "Task");
    assert.equal(typeof tool.renderResult, "function");
    assert.equal(tool.parameters, TASK_PARAMETERS_SCHEMA);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["capabilityProfile", "description", "prompt"]);
    assert.deepEqual(tool.parameters.required, ["prompt", "description"]);
    assert.deepEqual(tool.parameters.properties.capabilityProfile.anyOf.map((entry) => entry.const), ["read-only", "read-write"]);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.match(tool.description, /bounded/i);
    assert.match(tool.description, /subagent|worker/i);
    assert.ok(tool.promptGuidelines.some((line) => /when not to use/i.test(line)));
  });

  it("runs the injected subagent runner with the task-subagent profile and worker role prompt", async () => {
    const { createTaskTool, TASK_WORKER_TOOLS } = await importSource(TASK_MODULE);
    const calls = [];
    const tool = createTaskTool({
      runner: {
        async run(options) {
          calls.push(options);
          return makeWorkerResult({ finalOutput: "worker finished", truncatedFinalOutput: "worker finished" });
        },
      },
      // Tests stub the resolver so the runner sees the resolved modelArg and
      // tool list without needing a full MmrModelRegistryLike on ctx.
      resolveInvocation: stubTaskInvocation({
        provider: "openai-codex",
        model: "gpt-5.5",
        thinkingLevel: "medium",
      }),
    });
    const result = await tool.execute(
      "call-1",
      { prompt: "Inspect the task path", description: "Inspect task path" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profileName, "task-subagent");
    assert.equal(calls[0].parentMode, "smart");
    assert.equal(calls[0].prompt, "Inspect the task path");
    assert.equal(calls[0].cwd, "/tmp/repo");
    assert.deepEqual([...calls[0].tools], [...TASK_WORKER_TOOLS]);
    assert.match(calls[0].systemPrompt, /Task Worker Role/);
    assert.equal(calls[0].model, "openai-codex/gpt-5.5");
    assert.match(result.content[0].text, /worker finished/);
    assert.equal(result.details.worker, "mmr-subagents.Task");
    assert.equal(result.details.description, "Inspect task path");
    assert.deepEqual([...result.details.workerTools], [...TASK_WORKER_TOOLS]);
    assert.equal(result.details.model, "openai-codex/gpt-5.5");
  });

  it("threads capabilityProfile into the invocation resolver", async () => {
    const { createTaskTool } = await importSource(TASK_MODULE);
    const inputs = [];
    const tool = createTaskTool({
      resolveInvocation(input) {
        inputs.push(input);
        return stubTaskInvocation({ workerTools: ["read", "bash"] })();
      },
      runner: {
        async run() {
          return makeWorkerResult();
        },
      },
      buildSystemPrompt: () => "WORKER PROMPT",
    });

    const result = await tool.execute(
      "call-1",
      { prompt: "Run a command", description: "narrow", capabilityProfile: "read-write" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );

    assert.equal(result.details.status, "success");
    assert.equal(inputs[0].capabilityProfile, "read-write");
    assert.ok(!("allowPrivilegedProfiles" in inputs[0]), "privileged-gate plumbing must not be threaded into the resolver input");
  });

  it("assembles a mode-derived worker prompt from the parent prompt and filtered active tools", async () => {
    const { createTaskTool } = await importSource(TASK_MODULE);
    const calls = [];
    const pi = {
      getActiveTools: () => ["read", "bash", "Task"],
      getAllTools: () => [
        { name: "read", description: "Read files.", parameters: {} },
        { name: "bash", description: "Run shell commands.", parameters: {} },
        { name: "Task", description: "Spawn workers.", parameters: {} },
      ],
    };
    const tool = createTaskTool({
      pi,
      getBaseSystemPrompt: () => BASE_PARENT_PROMPT,
      resolveInvocation: stubTaskInvocation(),
      runner: {
        async run(options) {
          calls.push(options);
          return makeWorkerResult();
        },
      },
    });
    await tool.execute("call-1", { prompt: "Do it", description: "Do it" }, undefined, undefined, { cwd: "/tmp/repo" });
    assert.equal(calls.length, 1);
    assert.match(calls[0].systemPrompt, /<mmr_mode name="smart">/);
    assert.match(calls[0].systemPrompt, /Available tools:\n- read: Read files\.\n- bash: Run shell commands\./);
    assert.doesNotMatch(calls[0].systemPrompt, /- Task: Spawn workers\./);
    assert.match(calls[0].systemPrompt, /## Task Worker Role/);
  });

  it("filters the worker prompt's Available tools block by invocation.workerTools, not parent-active or profile tools", async () => {
    // P0.5 (consolidate-subagent-resolvers): the assembled worker prompt's
    // "Available tools:" block must list only the tools the worker will
    // actually have at the child Pi process. Three sets converge here:
    //   - parent active tools (host may carry extras: Task itself, oracle,
    //     etc.) — not visible to the worker.
    //   - profile.tools (intent allowlist incl. tools that may be deferred).
    //   - workerTools (deny-aware, registered-tool intersection) — the
    //     authoritative set the worker is spawned with.
    // The prompt must describe `workerTools` exactly so the model does
    // not believe it can call deny-listed or unregistered tools.
    const { createTaskTool } = await importSource(TASK_MODULE);
    const calls = [];
    const pi = {
      getActiveTools: () => ["read", "bash", "edit", "write", "web_search", "Task", "oracle"],
      getAllTools: () => [
        { name: "read", description: "Read files.", parameters: {} },
        { name: "bash", description: "Run shell commands.", parameters: {} },
        { name: "edit", description: "Edit files.", parameters: {} },
        { name: "write", description: "Write files.", parameters: {} },
        { name: "web_search", description: "Search the web.", parameters: {} },
        { name: "Task", description: "Spawn workers.", parameters: {} },
        { name: "oracle", description: "Consult oracle.", parameters: {} },
      ],
    };
    const tool = createTaskTool({
      pi,
      getBaseSystemPrompt: () => BASE_PARENT_PROMPT,
      resolveInvocation: stubTaskInvocation({
        // Workers see only this deny-aware, registered-tool intersection;
        // it deliberately omits `web_search` (unregistered/disabled in a
        // realistic deployment) plus the recursive parent-active tools.
        workerTools: ["read", "bash", "edit"],
      }),
      runner: {
        async run(options) {
          calls.push(options);
          return makeWorkerResult();
        },
      },
    });
    await tool.execute(
      "call-1",
      { prompt: "Investigate", description: "Investigate" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );
    assert.equal(calls.length, 1);
    const prompt = calls[0].systemPrompt;
    // Worker-visible tools that should be present in the assembled prompt.
    assert.match(prompt, /- read: Read files\./);
    assert.match(prompt, /- bash: Run shell commands\./);
    assert.match(prompt, /- edit: Edit files\./);
    // Recursive/advisory tools must not leak through, even though they
    // are in parent active tools and in `pi.getAllTools()`.
    assert.doesNotMatch(prompt, /- Task: Spawn workers\./);
    assert.doesNotMatch(prompt, /- oracle:/);
    // Profile-intent tools that are not in workerTools (e.g. dropped by
    // the registered-tools intersection at the parent) must also be
    // absent from the prompt.
    assert.doesNotMatch(prompt, /- web_search:/);
    // Profile-intent tools not actually registered at the parent host
    // must be absent (e.g. `write` is registered above but not in the
    // stubbed workerTools).
    assert.doesNotMatch(prompt, /- write: Write files\./);
  });

  it("resolves invocation end-to-end via defaultResolveTaskInvocation when no resolveInvocation stub is provided", async () => {
    // Most Task tests inject a `resolveInvocation` stub to avoid building
    // a full `MmrModelRegistryLike` and `pi.getAllTools()` surface for
    // each case. This integration check covers the production wiring:
    // ctx.modelRegistry → resolveCtxModelRegistry →
    // resolveMmrSubagentInvocation, pi.getAllTools() → resolveRegisteredTools
    // → invocation.workerTools, and getMmrModeStateSnapshot() → parentMode
    // → invocation.promptBaseMode. It catches regressions where one of
    // those default seams is broken even though every stubbed test
    // passes.
    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    const { createTaskTool, TASK_SUBAGENT_PROFILE } = await importSource(TASK_MODULE);
    // Build a minimal MmrModelRegistryLike that satisfies the resolver's
    // route resolution against the task-subagent profile's pinned model
    // preferences. claude-opus-4-8 is the primary route per spec
    // §6.2; the helper used by the resolver looks it up via find().
    const registeredClaude = {
      provider: "claude-subscription",
      id: "claude-opus-4-8",
      authenticated: true,
    };
    const modelRegistry = {
      getAll: () => [registeredClaude],
      find: (provider, id) => provider === "claude-subscription" && id === "claude-opus-4-8"
        ? registeredClaude
        : undefined,
      getAvailable: () => ["claude-subscription/claude-opus-4-8"],
    };
    // Pi host registers a subset of the task-subagent profile's tools;
    // workerTools should be (profile.tools \ deny) ∩ registered.
    const pi = {
      getActiveTools: () => ["read", "bash", "edit", "write", "task_list"],
      getAllTools: () => [
        { name: "read", description: "Read files.", parameters: {} },
        { name: "bash", description: "Run shell commands.", parameters: {} },
        { name: "edit", description: "Edit files.", parameters: {} },
        { name: "write", description: "Write files.", parameters: {} },
        { name: "task_list", description: "Manage task list.", parameters: {} },
        // Recursive parent tool that must be removed by denyTools.
        { name: "Task", description: "Spawn workers.", parameters: {} },
      ],
    };
    // Set a Task-enabled parent mode so resolveParentMode() returns a
    // concrete MmrModeKey and the from-parent profile resolves promptBase.
    runtime.setMmrModeState({
      mode: "smart",
      sourceProfile: "smart",
      promptRoute: "default",
      modelChosen: true,
      thinkingChosen: false,
      toolsChosen: true,
      modelDiagnostic: undefined,
      toolDiagnostics: [],
      missingModelRoutes: [],
      missingTools: [],
      gatedTools: [],
      disabledTools: [],
      availabilityNotes: [],
    });
    const calls = [];
    try {
      const tool = createTaskTool({
        pi,
        getBaseSystemPrompt: () => BASE_PARENT_PROMPT,
        // resolveInvocation deliberately omitted — use the production default.
        runner: {
          async run(options) {
            calls.push(options);
            return makeWorkerResult();
          },
        },
      });
      const result = await tool.execute(
        "call-1",
        { prompt: "Investigate the auth flow", description: "Investigate auth" },
        undefined,
        undefined,
        { cwd: "/tmp/repo", modelRegistry },
      );
      assert.equal(calls.length, 1, "runner must be called exactly once via the default resolver path");
      assert.equal(calls[0].profileName, TASK_SUBAGENT_PROFILE);
      // Worker tools = (profile.tools \ {Task,oracle,librarian,handoff}) ∩ registered.
      // Profile has 10 tools, registered has 5 (minus Task which is denied).
      assert.deepEqual(
        [...calls[0].tools].sort(),
        ["bash", "edit", "read", "task_list", "write"],
        "workerTools must be the deny-aware, registered-tool intersection",
      );
      // Recursive tool must not leak through the resolver.
      assert.equal(calls[0].tools.includes("Task"), false);
      // Model route resolved through ctx.modelRegistry.
      assert.equal(calls[0].model, "claude-subscription/claude-opus-4-8");
      // Worker prompt assembled via parent-mode-aware path and includes
      // exactly the resolved workerTools, not the parent active set.
      assert.match(calls[0].systemPrompt, /<mmr_mode name="smart">/);
      assert.match(calls[0].systemPrompt, /- read: Read files\./);
      assert.match(calls[0].systemPrompt, /- task_list: Manage task list\./);
      assert.doesNotMatch(calls[0].systemPrompt, /- Task: Spawn workers\./);
      // Tool result surfaces success.
      assert.equal(result.details.status, "success");
    } finally {
      runtime.setMmrModeState(undefined);
    }
  });

  it("includes workerTools that are registered but not in the parent's active set (P1.a: no under-advertising)", async () => {
    // Before P1.a the worker prompt was built by filtering `pi.getAllTools()`
    // through `pi.getActiveTools()` first; tools that were registered
    // at the host but not currently active in the parent mode were
    // omitted from the worker's `Available tools:` block even though
    // `workerTools` (deny-aware ∩ registered) included them. The worker
    // could call them at runtime but its system prompt never described
    // them, producing silent under-advertising. The fix builds the
    // manifest from `workerTools` directly so the prompt matches the
    // worker's true runtime tool surface.
    const { createTaskTool } = await importSource(TASK_MODULE);
    const calls = [];
    const pi = {
      // Parent is in a mode that does not currently expose `edit`, but
      // `edit` is still registered in the host. The worker's workerTools
      // set includes it because it is in the task-subagent profile, not
      // denied, and registered.
      getActiveTools: () => ["read", "bash", "Task"],
      getAllTools: () => [
        { name: "read", description: "Read files.", parameters: {} },
        { name: "bash", description: "Run shell commands.", parameters: {} },
        { name: "edit", description: "Edit files.", parameters: {} },
        { name: "Task", description: "Spawn workers.", parameters: {} },
      ],
    };
    const tool = createTaskTool({
      pi,
      getBaseSystemPrompt: () => BASE_PARENT_PROMPT,
      resolveInvocation: stubTaskInvocation({
        workerTools: ["read", "bash", "edit"],
      }),
      runner: {
        async run(options) {
          calls.push(options);
          return makeWorkerResult();
        },
      },
    });
    await tool.execute(
      "call-1",
      { prompt: "Look at the screenshot", description: "Look" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );
    assert.equal(calls.length, 1);
    const prompt = calls[0].systemPrompt;
    assert.match(prompt, /- edit: Edit files\./,
      "edit must appear in the worker prompt because it is in workerTools, even though it is not in the parent's active set");
    assert.match(prompt, /- read: Read files\./);
    assert.match(prompt, /- bash: Run shell commands\./);
    assert.doesNotMatch(prompt, /- Task: Spawn workers\./);
  });

  it("forwards runner progress as a Pi tool update with renderable child-tool activity", async () => {
    const { createTaskTool } = await importSource(TASK_MODULE);
    let capturedUpdate;
    const tool = createTaskTool({
      resolveInvocation: stubTaskInvocation(),
      runner: {
        async run(options) {
          options.onProgress?.({
            messages: [],
            finalOutput: "working",
            truncatedFinalOutput: "working",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            trail: [
              {
                type: "tool",
                toolCallId: "tool-1",
                toolName: "bash",
                status: "running",
                argsPreview: "npm test",
              },
            ],
          });
          return makeWorkerResult({
            trail: [
              {
                type: "tool",
                toolCallId: "tool-1",
                toolName: "bash",
                status: "completed",
                argsPreview: "npm test",
                resultPreview: "pass",
              },
            ],
          });
        },
      },
    });
    await tool.execute(
      "call-1",
      { prompt: "Run tests", description: "Run tests" },
      undefined,
      (partial) => { capturedUpdate = partial; },
      { cwd: "/tmp/repo" },
    );
    assert.ok(capturedUpdate, "execute must forward a progress update when the runner emits one");
    assert.match(capturedUpdate.content[0].text, /working/);
    const bashTrailItem = capturedUpdate.details.trail.find((item) => item.type === "tool" && item.toolName === "bash");
    assert.ok(bashTrailItem, "forwarded progress trail should include the running bash tool entry");
    assert.equal(bashTrailItem.status, "running");

    const fakeTheme = {
      fg(_color, text) { return text; },
      bold(text) { return text; },
    };
    const collapsed = tool.renderResult(
      capturedUpdate,
      { expanded: false, isPartial: true },
      fakeTheme,
      { args: { prompt: "Run tests", description: "Run tests" }, showImages: false, isError: false },
    ).render(200).join("\n");
    assert.match(collapsed, /running\.\.\./i);
    assert.doesNotMatch(collapsed, /[▸▾◐●⚠]/);
    assert.match(collapsed, /Ctrl\+O/i);
    assert.doesNotMatch(collapsed, /bash/);
    assert.doesNotMatch(collapsed, /npm test/);

    const expanded = tool.renderResult(
      capturedUpdate,
      { expanded: true, isPartial: true },
      fakeTheme,
      { args: { prompt: "Run tests", description: "Run tests" }, showImages: false, isError: false },
    ).render(200).join("\n");
    assert.match(expanded, /Task/);
    assert.match(expanded, /bash/);
    assert.match(expanded, /running\.\.\./);
    assert.match(expanded, /npm test/);
  });

  it("surfaces worker activation failures without treating empty output as success", async () => {
    const { createTaskTool } = await importSource(TASK_MODULE);
    const tool = createTaskTool({
      resolveInvocation: stubTaskInvocation(),
      runner: {
        async run() {
          return makeWorkerResult({
            finalOutput: "",
            truncatedFinalOutput: "",
            exitCode: 0,
            stderr: "pi-mmr: subagent activation failed: Unknown subagent profile\n",
            subagentActivationError: "Unknown subagent profile",
            errorMessage: "subagent activation failed: Unknown subagent profile",
          });
        },
      },
    });
    const result = await tool.execute("call-1", { prompt: "Do it", description: "Do it" }, undefined, undefined, { cwd: "/tmp/repo" });
    assert.match(result.content[0].text, /subagent activation failed/i);
    assert.match(result.content[0].text, /Unknown subagent profile/);
    assert.equal(result.details.subagentActivationError, "Unknown subagent profile");
    assert.match(result.details.errorMessage, /subagent activation failed/i);
  });

  it("surfaces a no-agent-start diagnostic when the child exits before agent_start", async () => {
    // Regression guard. If a sibling extension's `input` handler returns
    // { action: "handled" } in non-interactive mode, the child Pi process
    // exits 0 with no usable text AND agent_start never fires. Task must
    // not pass through the cheerful empty-output fallback; the new
    // `no-agent-start` outcome surfaces a directed diagnostic, includes
    // the stderr tail, and sets `details.status` to `no-agent-start`.
    const { createTaskTool } = await importSource(TASK_MODULE);
    const tool = createTaskTool({
      resolveInvocation: stubTaskInvocation(),
      runner: {
        async run() {
          return makeWorkerResult({
            finalOutput: "",
            truncatedFinalOutput: "",
            exitCode: 0,
            stderr: "some-other-extension: blocked the prompt to prevent accidental billing.",
            errorMessage: undefined,
            agentStarted: false,
          });
        },
      },
    });
    const result = await tool.execute("call-1", { prompt: "Do it", description: "Do it" }, undefined, undefined, { cwd: "/tmp/repo" });
    assert.match(result.content[0].text, /exited before the agent loop started/);
    assert.match(result.content[0].text, /another Pi extension's input handler/);
    assert.match(result.content[0].text, /some-other-extension: blocked the prompt/);
    assert.doesNotMatch(result.content[0].text, /no final output/);
    assert.equal(result.details.status, "no-agent-start");
  });

  it("rejects missing blank wrong-type and extra Task parameters without spawning", async () => {
    // Behavioral pin: Task parameter validation
    // order: shape → extra props → prompt (type/blank/cap) → description
    // (type/blank/cap/control-chars). Every rejection must surface as
    // status:"validation-error" with no runner call.
    const { createTaskTool, TASK_PROMPT_MAX_BYTES, TASK_DESCRIPTION_MAX_BYTES } = await importSource(TASK_MODULE);
    let runnerCalls = 0;
    const tool = createTaskTool({
      resolveInvocation: stubTaskInvocation(),
      runner: {
        async run() {
          runnerCalls += 1;
          return makeWorkerResult();
        },
      },
    });
    const cases = [
      { params: null,                                                       wantMatch: /object with `prompt`/ },
      { params: "not-an-object",                                             wantMatch: /object with `prompt`/ },
      { params: [],                                                          wantMatch: /object with `prompt`/ },
      { params: { prompt: "p", description: "d", extraKey: 1 },              wantMatch: /extra parameter "extraKey"/ },
      { params: { description: "d" },                                        wantMatch: /Task\.prompt is required/ },
      { params: { prompt: "", description: "d" },                            wantMatch: /Task\.prompt is required/ },
      { params: { prompt: "   ", description: "d" },                         wantMatch: /Task\.prompt is required/ },
      { params: { prompt: 7, description: "d" },                             wantMatch: /Task\.prompt is required/ },
      { params: { prompt: "p" },                                             wantMatch: /Task\.description is required/ },
      { params: { prompt: "p", description: "" },                            wantMatch: /Task\.description is required/ },
      { params: { prompt: "p", description: "  " },                          wantMatch: /Task\.description is required/ },
      { params: { prompt: "p", description: 7 },                             wantMatch: /Task\.description is required/ },
      { params: { prompt: "a".repeat(TASK_PROMPT_MAX_BYTES + 1), description: "d" }, wantMatch: /Task\.prompt exceeds/ },
      { params: { prompt: "p", description: "a".repeat(TASK_DESCRIPTION_MAX_BYTES + 1) }, wantMatch: /Task\.description exceeds/ },
      { params: { prompt: "p", description: "d\u0007" },                     wantMatch: /control characters/ },
    ];
    for (const { params, wantMatch } of cases) {
      const result = await tool.execute("call-x", params, undefined, undefined, { cwd: "/tmp/repo" });
      assert.equal(result.details.status, "validation-error", `case ${JSON.stringify(params)} must yield validation-error`);
      assert.match(result.content[0].text, /Task: invalid parameters/);
      assert.match(result.details.errorMessage, wantMatch);
    }
    assert.equal(runnerCalls, 0, "validation failures must not invoke the runner");
  });

  it("applies Task result error precedence deterministically", async () => {
    // Behavioral pin (Task outcome classifier):
    // exact precedence order from spawn-error → activation → aborted →
    // signal/non-zero+empty → empty-output → success (incl. non-zero+text).
    const { classifyTaskOutcome, hasUsableTaskFinalText } = await importSource(TASK_MODULE);

    // Usable-text predicate (truncated > raw).
    assert.equal(hasUsableTaskFinalText({ finalOutput: "", truncatedFinalOutput: "   " }), false);
    assert.equal(hasUsableTaskFinalText({ finalOutput: "raw", truncatedFinalOutput: "" }), true);
    assert.equal(hasUsableTaskFinalText({ finalOutput: "full", truncatedFinalOutput: "part" }), true);

    const base = {
      spawnError: undefined,
      subagentActivationError: undefined,
      aborted: false,
      signal: null,
      exitCode: 0,
      finalOutput: "",
      truncatedFinalOutput: "",
    };

    // 1. spawn-error wins over activation marker.
    assert.equal(
      classifyTaskOutcome({ ...base, spawnError: "x", subagentActivationError: "y", aborted: true, exitCode: 1, truncatedFinalOutput: "text" }),
      "spawn-error",
    );
    // 2. activation-error wins over aborted and over usable text.
    assert.equal(
      classifyTaskOutcome({ ...base, subagentActivationError: "y", aborted: true, truncatedFinalOutput: "text" }),
      "activation-error",
    );
    // 3. aborted wins over signal/non-zero exit.
    assert.equal(
      classifyTaskOutcome({ ...base, aborted: true, signal: "SIGTERM", exitCode: 1 }),
      "aborted",
    );
    // 4. signal-killed with no usable text → worker-error.
    assert.equal(
      classifyTaskOutcome({ ...base, signal: "SIGKILL" }),
      "worker-error",
    );
    // 5. non-zero exit with no usable text → worker-error.
    assert.equal(
      classifyTaskOutcome({ ...base, exitCode: 7 }),
      "worker-error",
    );
    // 6. zero exit, no text, agent ran → empty-output.
    assert.equal(
      classifyTaskOutcome({ ...base, exitCode: 0, agentStarted: true }),
      "empty-output",
    );
    // 6b. zero exit, no text, agent never started → no-agent-start.
    //    Signals a sibling extension's input hook swallowed the prompt;
    //    distinct from "agent ran and produced nothing".
    assert.equal(
      classifyTaskOutcome({ ...base, exitCode: 0, agentStarted: false }),
      "no-agent-start",
    );
    // 7. non-zero exit WITH usable text → success (spec: exit info preserved
    //    in details, but the parent gets the worker's text).
    assert.equal(
      classifyTaskOutcome({ ...base, exitCode: 1, truncatedFinalOutput: "partial" }),
      "success",
    );
    // 8. signal-killed WITH usable text → success.
    assert.equal(
      classifyTaskOutcome({ ...base, signal: "SIGTERM", finalOutput: "some" }),
      "success",
    );
    // 9. clean exit with text → success.
    assert.equal(
      classifyTaskOutcome({ ...base, truncatedFinalOutput: "done" }),
      "success",
    );
  });

  it("marks aborted Task runs as cancellation errors with exit signal details", async () => {
    const { createTaskTool } = await importSource(TASK_MODULE);
    const tool = createTaskTool({
      resolveInvocation: stubTaskInvocation(),
      runner: {
        async run() {
          return makeWorkerResult({
            finalOutput: "",
            truncatedFinalOutput: "",
            aborted: true,
            signal: "SIGTERM",
            exitCode: null,
          });
        },
      },
    });
    const result = await tool.execute("call-1", { prompt: "Do it", description: "Do it" }, undefined, undefined, { cwd: "/tmp/repo" });
    assert.equal(result.details.status, "aborted");
    assert.equal(result.details.aborted, true);
    assert.equal(result.details.signal, "SIGTERM");
    assert.match(result.content[0].text, /cancelled/i);
  });

  it("classifies structured runner spawn failures (MmrWorkerResult.spawnError) as spawn-error", async () => {
    // Behavioral pin: spawn-error must take precedence over partial output (rule 2):
    // runner spawn failures may settle as a structured MmrWorkerResult
    // (exitCode: 1, spawnError set) instead of throwing. Task must
    // classify those as `spawn-error` before any other rule, including
    // when the worker accidentally produced partial text.
    const { createTaskTool } = await importSource(TASK_MODULE);
    const tool = createTaskTool({
      resolveInvocation: stubTaskInvocation(),
      runner: {
        async run() {
          return makeWorkerResult({
            finalOutput: "partial",
            truncatedFinalOutput: "partial",
            exitCode: 1,
            errorMessage: "spawn ENOENT",
            spawnError: "spawn ENOENT",
          });
        },
      },
    });
    const result = await tool.execute(
      "call-1",
      { prompt: "Do it", description: "Do it" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );
    assert.equal(result.details.status, "spawn-error");
    assert.equal(result.details.spawnError, "spawn ENOENT");
    assert.match(result.details.errorMessage, /spawn ENOENT/);
  });

  it("maps runner throws to spawn-error without leaking the exception", async () => {
    const { createTaskTool } = await importSource(TASK_MODULE);
    const tool = createTaskTool({
      resolveInvocation: stubTaskInvocation(),
      runner: {
        async run() {
          throw new Error("ENOENT spawn pi");
        },
      },
    });
    const result = await tool.execute("call-1", { prompt: "Do it", description: "Do it" }, undefined, undefined, { cwd: "/tmp/repo" });
    assert.equal(result.details.status, "spawn-error");
    assert.match(result.content[0].text, /Task: worker failed to spawn/);
    assert.match(result.details.errorMessage, /ENOENT spawn pi/);
  });

  it("fails closed before spawn when the resolved Task worker tool set is empty", async () => {
    // Spec §5 fail-closed: when workerTools is empty after deny + registered
    // intersection, return status:worker-error and do not spawn.
    const { createTaskTool } = await importSource(TASK_MODULE);
    let runnerCalls = 0;
    const tool = createTaskTool({
      resolveInvocation: () => ({
        ok: false,
        profile: { name: "task-subagent" },
        code: "tools.empty",
        message: 'Subagent "task-subagent" has no available worker tools after deny + registered intersection.',
        tools: [],
        promptRoute: "mode-derived",
        candidates: [],
        diagnostics: [],
        parentMode: "smart",
        promptBaseMode: "smart",
        workerTools: [],
        toolResolution: { intendedTools: [], deniedTools: ["Task", "oracle", "librarian", "handoff"], omittedTools: [] },
      }),
      runner: {
        async run() {
          runnerCalls += 1;
          return makeWorkerResult();
        },
      },
    });
    const result = await tool.execute("call-1", { prompt: "Do it", description: "Do it" }, undefined, undefined, { cwd: "/tmp/repo" });
    assert.equal(result.details.status, "worker-error");
    assert.match(result.content[0].text, /Task worker has no available tools/);
    assert.equal(runnerCalls, 0, "empty worker tool set must not spawn the runner");
  });

  it("reads settings-driven subagentModelPreferences on every execute, matching the child activation path (F5)", async () => {
    // Behavioral pin: settings
    // may override modelPreferences (only). Parent and child must read
    // the same source so they agree on the resolved model; before F5,
    // the child path read loadMmrCoreSettings on every activation while
    // the Task tool relied on a registration-time deps injection and
    // ignored settings unless the test caller explicitly threaded them
    // through.
    const { createTaskTool, TASK_SUBAGENT_PROFILE } = await importSource(TASK_MODULE);
    const captured = [];
    let loadCalls = 0;
    const tool = createTaskTool({
      // Inject a deterministic settings loader so the test doesn't touch
      // the filesystem; the production default delegates to
      // loadMmrCoreSettings(cwd).settings.subagentModelPreferences.
      loadSubagentModelPreferences: (cwd) => {
        loadCalls += 1;
        captured.push(cwd);
        return {
          [TASK_SUBAGENT_PROFILE]: [
            { model: "gpt-5.5", thinkingLevel: "medium" },
          ],
        };
      },
      // Stub the resolver so we can observe the resolved modelPreferencesOverride
      // forwarded by the default Task invocation closure.
      resolveInvocation: (input) => {
        captured.push(input.modelPreferencesOverride);
        return {
          ok: true,
          profile: { name: TASK_SUBAGENT_PROFILE },
          promptRoute: "mode-derived",
          parentMode: input.parentMode,
          promptBaseMode: input.parentMode ?? "smart",
          selected: {
            provider: "openai-codex",
            model: "gpt-5.5",
            thinkingLevel: "medium",
            registeredModel: { provider: "openai-codex", id: "gpt-5.5" },
          },
          modelArg: "openai-codex/gpt-5.5",
          workerTools: DEFAULT_TASK_WORKER_TOOLS,
          tools: DEFAULT_TASK_WORKER_TOOLS,
          toolResolution: { intendedTools: DEFAULT_TASK_WORKER_TOOLS, deniedTools: ["Task","oracle","librarian","handoff"], omittedTools: [] },
          candidates: [],
          diagnostics: [],
        };
      },
      runner: { async run() { return makeWorkerResult(); } },
    });
    await tool.execute(
      "call-1",
      { prompt: "Inspect", description: "Inspect" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );
    assert.equal(loadCalls, 1, "Task must read settings exactly once per execute");
    assert.equal(captured[0], "/tmp/repo", "settings loader must be called with ctx.cwd");
    assert.deepEqual(
      captured[1],
      [{ model: "gpt-5.5", thinkingLevel: "medium" }],
      "resolveInvocation must receive modelPreferencesOverride from settings",
    );
  });

  it("prefers an explicit TaskToolDeps.modelPreferencesOverride over settings (programmatic override wins)", async () => {
    // When a caller explicitly injects deps.modelPreferencesOverride
    // (programmatic seam used by tests and future host integrations),
    // settings are not consulted; the explicit override wins.
    const { createTaskTool, TASK_SUBAGENT_PROFILE } = await importSource(TASK_MODULE);
    let loadCalls = 0;
    let observedOverride;
    const tool = createTaskTool({
      modelPreferencesOverride: [{ model: "claude-opus-4-8" }],
      loadSubagentModelPreferences: () => {
        loadCalls += 1;
        return {
          [TASK_SUBAGENT_PROFILE]: [
            { model: "gpt-5.5", thinkingLevel: "medium" },
          ],
        };
      },
      resolveInvocation: (input) => {
        observedOverride = input.modelPreferencesOverride;
        return stubTaskInvocation()();
      },
      runner: { async run() { return makeWorkerResult(); } },
    });
    await tool.execute(
      "call-1",
      { prompt: "Inspect", description: "Inspect" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );
    assert.equal(loadCalls, 0, "explicit override must skip the settings read");
    assert.deepEqual(observedOverride, [{ model: "claude-opus-4-8" }]);
  });

  it("fails closed when no Task-enabled parent mode is active (resolveParentMode no longer hides 'free' or missing as smart)", async () => {
    // Spec §6.1: when the parent has no Task-enabled mode (e.g. `free`
    // or missing), the invocation resolver must emit
    // `prompt-base.unresolved`; Task surfaces that as an activation-style
    // failure and does not spawn. Previously, `resolveParentMode` mapped
    // free/missing to "smart", bypassing the resolver's fail-closed path.
    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    runtime.setMmrModeState(undefined);
    const { createTaskTool } = await importSource(TASK_MODULE);
    let runnerCalls = 0;
    const seenParentModes = [];
    const tool = createTaskTool({
      resolveInvocation: (input) => {
        seenParentModes.push(input.parentMode);
        return {
          ok: false,
          profile: { name: "task-subagent" },
          code: "prompt-base.unresolved",
          message: 'Subagent "task-subagent" is mode-derived (baseMode "from-parent") but no Task-enabled parent mode is active.',
          tools: [],
          promptRoute: "mode-derived",
          candidates: [],
          diagnostics: [],
          workerTools: [],
          toolResolution: {
            intendedTools: [],
            deniedTools: ["Task", "oracle", "librarian", "handoff"],
            omittedTools: [],
          },
        };
      },
      runner: {
        async run() {
          runnerCalls += 1;
          return makeWorkerResult();
        },
      },
    });
    const result = await tool.execute(
      "call-1",
      { prompt: "Do it", description: "Do it" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );
    assert.equal(
      seenParentModes[0],
      undefined,
      "resolveParentMode must forward `undefined` to the resolver when no Task-enabled mode is active, not 'smart'",
    );
    assert.equal(result.details.status, "worker-error");
    assert.match(result.content[0].text, /Task-enabled parent mode/);
    assert.equal(runnerCalls, 0, "prompt-base.unresolved must not spawn the runner");
  });

  it("spawns Task workers with system-prompt replacement and exact tool allowlist", async () => {
    // Behavioral pin: Task system-prompt delivery (replace, no context files, no skills):
    // Task uses --system-prompt (replacement) with --no-context-files
    // --no-skills so the assembled worker prompt is the only model-visible
    // system prompt.
    const { createTaskTool, TASK_WORKER_TOOLS } = await importSource(TASK_MODULE);
    const { buildMmrWorkerArgs } = await importSource("extensions/mmr-subagents/runner.ts");
    const calls = [];
    const tool = createTaskTool({
      resolveInvocation: stubTaskInvocation({
        parentMode: "rush",
        promptBaseMode: "rush",
        provider: "openai-codex",
        model: "gpt-5.5",
        thinkingLevel: "off",
      }),
      runner: {
        async run(options) {
          calls.push(options);
          return makeWorkerResult({ finalOutput: "ok", truncatedFinalOutput: "ok" });
        },
      },
    });
    await tool.execute(
      "call-1",
      { prompt: "Investigate", description: "Investigate" },
      undefined,
      undefined,
      { cwd: "/tmp/repo" },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].systemPromptDelivery, "replace");
    assert.equal(calls[0].parentMode, "rush");
    assert.deepEqual([...calls[0].tools], [...TASK_WORKER_TOOLS]);
    assert.equal(calls[0].model, "openai-codex/gpt-5.5");

    // The runner-facing args builder must surface the replacement flags
    // for a Task-shaped options bag.
    const builtArgs = buildMmrWorkerArgs(
      {
        profileName: "task-subagent",
        prompt: "Investigate",
        parentMode: "rush",
        model: "openai-codex/gpt-5.5",
        tools: [...TASK_WORKER_TOOLS],
        systemPromptDelivery: "replace",
      },
      "/tmp/system-prompt.md",
    );
    assert.equal(
      builtArgs.includes("--system-prompt"),
      true,
      "Task replacement must use --system-prompt",
    );
    assert.equal(
      builtArgs.includes("--append-system-prompt"),
      false,
      "Task replacement must NOT use --append-system-prompt",
    );
    assert.equal(builtArgs.includes("--no-context-files"), true);
    assert.equal(builtArgs.includes("--no-skills"), true);
    const parentModeIndex = builtArgs.indexOf("--mmr-parent-mode");
    assert.notEqual(parentModeIndex, -1, "Task must pass parent-mode metadata to the child");
    assert.equal(builtArgs[parentModeIndex + 1], "rush");
    const toolsIndex = builtArgs.indexOf("--tools");
    assert.notEqual(toolsIndex, -1, "--tools must be present");
    assert.equal(
      builtArgs[toolsIndex + 1],
      [...TASK_WORKER_TOOLS].join(","),
      "--tools must list workerTools verbatim",
    );
  });

  it("serializes an empty tools array as an explicit `--tools \"\"` ceiling, but omits the flag when tools is undefined", async () => {
    const { buildMmrWorkerArgs } = await importSource("extensions/mmr-subagents/runner.ts");

    // Empty array: the runner explicitly asked for no tools, so the child
    // must receive `--tools ""` (an empty ceiling) instead of falling back to
    // its own profile-resolved set. This closes a least-privilege gap where a
    // parent-reduced-to-empty tool set would otherwise let the child
    // self-resolve a broader set.
    const emptyArgs = buildMmrWorkerArgs({ profileName: "sa__x", prompt: "p", tools: [] });
    const emptyIndex = emptyArgs.indexOf("--tools");
    assert.notEqual(emptyIndex, -1, "empty tools array must still emit --tools");
    assert.equal(emptyArgs[emptyIndex + 1], "", "empty tools array serializes as --tools \"\"");

    // Undefined: caller (e.g. finder/oracle) wants the child to self-resolve;
    // no --tools flag is emitted.
    const undefinedArgs = buildMmrWorkerArgs({ profileName: "finder", prompt: "p" });
    assert.equal(undefinedArgs.includes("--tools"), false, "omitted tools must not emit --tools");
  });
});

describe("Task blocking-vs-background guidance", () => {
  it("states Task is blocking and routes background/fan-out to start_task", async () => {
    const { createTaskTool } = await importSource(TASK_MODULE);
    const tool = createTaskTool({ runner: { async run() { return makeWorkerResult(); } } });
    assert.match(tool.description, /blocking/i, "Task description must state it is blocking");
    assert.match(tool.description, /start_task/, "Task description must name start_task as the background path");
    assert.doesNotMatch(
      tool.description,
      /Run workers in parallel only for independent read-only work/i,
      "Task must not teach blocking-parallel as the fan-out mechanism",
    );
    assert.ok(
      tool.promptGuidelines.some(
        (g) => /start_task/.test(g) && /background|parallel|fan[ -]?out/i.test(g),
      ),
      "a Task guideline must route background/parallel orchestration to start_task",
    );
  });
});
