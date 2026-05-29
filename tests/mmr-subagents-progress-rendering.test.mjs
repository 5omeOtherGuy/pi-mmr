import assert from "node:assert/strict";
import { homedir } from "node:os";
import { after, describe, it } from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

initTheme(undefined, false);

after(cleanupLoadedSource);

const PROGRESS_RENDERING_MODULE = "extensions/mmr-subagents/progress-rendering.ts";

const fakeTheme = {
  fg(_color, text) { return text; },
  bold(text) { return text; },
  italic(text) { return text; },
};

function renderText(component) {
  return component.render(240).join("\n");
}

function renderLines(component, width = 240) {
  return component.render(width);
}

function stripAnsi(text) {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "");
}

function visibleTextWidth(text) {
  return stripAnsi(text).length;
}

function normalize(text) {
  return stripAnsi(text).replace(/[ \t]+/g, " ");
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function makeContext(args = {}, overrides = {}) {
  return {
    args,
    state: {},
    cwd: `${homedir()}/projects/repo`,
    showImages: false,
    isError: false,
    executionStarted: true,
    argsComplete: true,
    ...overrides,
  };
}

const noopTui = { requestRender() {} };

function renderToolExecutionFrame(toolName, args, result, options = {}) {
  const { renderMmrSubagentCall, renderMmrSubagentResult } = options.renderers;
  const component = new ToolExecutionComponent(
    toolName,
    `${toolName}-call-1`,
    args,
    { showImages: false },
    {
      name: toolName,
      renderCall(callArgs, theme, context) {
        return renderMmrSubagentCall(toolName, callArgs, theme, context);
      },
      renderResult(toolResult, renderOptions, theme, context) {
        return renderMmrSubagentResult(toolName, toolResult, renderOptions, theme, context);
      },
    },
    noopTui,
    `${homedir()}/projects/repo`,
  );
  component.setExpanded(options.expanded ?? true);
  component.markExecutionStarted();
  component.updateResult(result, options.isPartial ?? true);
  return normalize(renderText(component));
}

function childTypes(component) {
  return Array.isArray(component.children) ? component.children.map((child) => child.constructor.name) : [];
}

function hasChildType(component, typeName) {
  return childTypes(component).includes(typeName);
}

function firstTextColumn(lines, snippet) {
  const line = lines.map(stripAnsi).find((candidate) => candidate.includes(snippet));
  assert.ok(line, `expected rendered output to include ${JSON.stringify(snippet)} in:\n${lines.map(stripAnsi).join("\n")}`);
  return line.match(/^ */)[0].length;
}

function collectComponentTypes(component, types = []) {
  if (!component || typeof component !== "object") return types;
  types.push(component.constructor.name);
  if (Array.isArray(component.children)) {
    for (const child of component.children) collectComponentTypes(child, types);
  }
  return types;
}

function countComponentType(component, typeName) {
  return collectComponentTypes(component).filter((name) => name === typeName).length;
}

function makeResult(overrides = {}) {
  const home = homedir();
  return {
    content: [{ type: "text", text: "Key failure-handling lives in the worker runner." }],
    details: {
      usage: { input: 100_000, output: 3500, cacheRead: 305_000, cacheWrite: 0, cost: 0.114, contextTokens: 95_000, turns: 7 },
      reportedModel: "openai-codex/gpt-5.4-mini",
      exitCode: 0,
      signal: null,
      aborted: false,
      stopReason: "end_turn",
      trail: [
        { type: "assistant", text: "Now read finder.ts buildFinalContent:" },
        {
          type: "tool",
          toolCallId: "read-1",
          toolName: "read",
          status: "completed",
          argsPreview: JSON.stringify({ path: `${home}/projects/repo/src/extensions/mmr-subagents/finder.ts`, offset: 430, limit: 160 }),
          resultPreview: "read result preview from finder.ts",
        },
        {
          type: "assistant",
          text: "I'm seeing the core issue now — the wrapper must report the worker failure before normal output.",
        },
        {
          type: "tool",
          toolCallId: "grep-1",
          toolName: "grep",
          status: "completed",
          argsPreview: '{"pattern":"activation failure marker","path":"tests"}',
          resultPreview: "grep result preview from tests",
        },
      ],
    },
    ...overrides,
  };
}

describe("renderMmrSubagentCall", () => {
  it("renders beautified Markdown task bodies in a native-style box before a worker result owns the row", async () => {
    const { renderMmrSubagentCall } = await importSource(PROGRESS_RENDERING_MODULE);
    const cases = [
      { toolName: "finder", args: { query: "# Scope\n\n- read `progress-rendering.ts`\n- keep list indentation" } },
      { toolName: "oracle", args: { task: "Review compaction thresholds\n\n1. Check cut points" } },
      { toolName: "Task", args: { description: "Inspect task path", prompt: "Inspect task path\n\n- run tests" } },
    ];

    for (const testCase of cases) {
      const component = renderMmrSubagentCall(testCase.toolName, testCase.args, fakeTheme);
      const rendered = stripAnsi(renderText(component));

      assert.equal(component.constructor.name, "Box");
      assert.equal(countComponentType(component, "Markdown"), 1, `${testCase.toolName} call body should render Markdown inside the box`);
      assert.match(rendered, new RegExp(`^\\s*${testCase.toolName}`, "m"));
    }
  });

  it("hides the completed call header so the result header is not duplicated", async () => {
    const { renderMmrSubagentCall } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentCall(
      "finder",
      { query: "Find ToolExecutionComponent" },
      fakeTheme,
      makeContext({ query: "Find ToolExecutionComponent" }, { isPartial: false }),
    );

    assert.equal(renderText(component), "");
  });
});

describe("ToolExecutionComponent integration", () => {
  it("lets the result renderer own partial rows and suppresses worker prompt echoes for every subagent", async () => {
    const renderers = await importSource(PROGRESS_RENDERING_MODULE);
    const objective = "Complete post-merge audit of subagent trail rendering after PR #45";
    const cases = [
      {
        toolName: "finder",
        args: { query: objective },
        userTrail: `Task: ${objective}`,
      },
      {
        toolName: "oracle",
        args: { task: objective, context: "Check finder, oracle, and Task." },
        userTrail: `Task: Task: ${objective}\n\nContext:\nCheck finder, oracle, and Task.`,
      },
      {
        toolName: "Task",
        args: { prompt: objective, description: objective },
        userTrail: `Task: ${objective}`,
      },
    ];

    for (const testCase of cases) {
      const rendered = renderToolExecutionFrame(
        testCase.toolName,
        testCase.args,
        {
          content: [{ type: "text", text: "partial worker output" }],
          details: {
            reportedModel: "openai-codex/gpt-5.5",
            exitCode: null,
            signal: null,
            aborted: false,
            stopReason: "end_turn",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            trail: [
              { type: "user", text: testCase.userTrail },
              { type: "assistant", text: "Inspecting the renderer." },
            ],
          },
        },
        { renderers, expanded: true, isPartial: true },
      );

      assert.equal(
        countOccurrences(rendered, objective),
        1,
        `${testCase.toolName} should render the objective once in the composed Pi tool row:\n${rendered}`,
      );
      assert.doesNotMatch(rendered, /Task:\s*Task:/i, `${testCase.toolName} should suppress double Task: prompt echoes`);
      assert.match(rendered, /Inspecting the renderer\./);
      assert.doesNotMatch(rendered, /partial worker output/);
    }
  });
});

describe("renderMmrSubagentResult", () => {
  it("keeps collapsed partial progress compact without hand-rolled shell glyphs", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "finder",
      makeResult({ content: [{ type: "text", text: "partial worker output" }] }),
      { expanded: false, isPartial: true },
      fakeTheme,
    );
    const rendered = normalize(renderText(component));

    assert.equal(component.constructor.name, "Container");
    assert.deepEqual(childTypes(component), ["Box"]);
    assert.match(rendered, /finder • gpt-5\.4-mini/);
    assert.match(rendered, /running/i);
    assert.doesNotMatch(rendered, /[▸▾◐●⚠]/);
    assert.doesNotMatch(rendered, /Ctrl\+O/i);
    assert.doesNotMatch(rendered, /read completed/);
    assert.doesNotMatch(rendered, /grep completed/);
    assert.doesNotMatch(rendered, /partial worker output/);
  });

  it("keeps collapsed completed results to one header plus the worker objective", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const query = "Find where pi-mmr handles subagent invocation behavior in the repository.\nSearch under src and tests for Task-like worker calls.";
    const component = renderMmrSubagentResult(
      "finder",
      makeResult(),
      { expanded: false, isPartial: false },
      fakeTheme,
      makeContext({ query }),
    );
    const rendered = normalize(renderText(component));

    assert.equal(component.constructor.name, "Container");
    assert(hasChildType(component, "Box"), "collapsed completed operation body should be boxed like a native Pi tool call");
    assert.match(rendered, /finder • gpt-5\.4-mini\s+completed/i);
    assert.match(rendered, /Find where pi-mmr handles subagent invocation behavior/);
    assert.match(rendered, /Search under src and tests/);
    assert.equal(countOccurrences(rendered, "finder"), 2);
    assert.doesNotMatch(rendered, /Query:/);
    assert.doesNotMatch(rendered, /[▸▾◐●⚠]/);
    assert.match(rendered, /ctrl\+o to expand/i);
    assert.doesNotMatch(rendered, /read completed/);
    assert.doesNotMatch(rendered, /grep completed/);
    assert.match(rendered, /Key failure-handling lives/);
  });

  it("uses shared running/completed labels for every subagent row", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const base = makeResult({
      content: [{ type: "text", text: "Repository evidence." }],
      details: {
        ...makeResult().details,
        reportedModel: "claude-subscription/claude-opus-4-6",
        trail: [],
      },
    });
    const cases = [
      { toolName: "finder", args: { query: "Find renderer labels" }, oldRunning: /Searching codebase/, oldCompleted: /Searched codebase/ },
      { toolName: "oracle", args: { task: "Review renderer labels" }, oldRunning: /Oracle exploring/, oldCompleted: /Oracle has spoken/ },
      { toolName: "Task", args: { description: "Inspect renderer labels", prompt: "Inspect renderer labels" }, oldRunning: /Subagent working/, oldCompleted: /Subagent finished/ },
      { toolName: "librarian", args: { query: "Explain acme\/repo routing" }, oldRunning: /Librarian researching/, oldCompleted: /Librarian researched/ },
    ];

    for (const testCase of cases) {
      const running = renderMmrSubagentResult(
        testCase.toolName,
        base,
        { expanded: false, isPartial: true },
        fakeTheme,
        makeContext(testCase.args),
      );
      const completed = renderMmrSubagentResult(
        testCase.toolName,
        base,
        { expanded: false, isPartial: false },
        fakeTheme,
        makeContext(testCase.args),
      );

      const runningText = normalize(renderText(running));
      const completedText = normalize(renderText(completed));

      assert.match(runningText, /running\.\.\./i, `${testCase.toolName} running row should use the shared active label`);
      assert.doesNotMatch(runningText, testCase.oldRunning, `${testCase.toolName} running row should not use the old subagent-specific label`);
      assert.match(completedText, /completed/i, `${testCase.toolName} completed row should use the shared complete label`);
      assert.doesNotMatch(completedText, /task completed/i, `${testCase.toolName} completed row should not use the old generic task wording`);
      assert.doesNotMatch(completedText, testCase.oldCompleted, `${testCase.toolName} completed row should not use the old subagent-specific label`);
    }
  });

  it("renders worker usage as a Pi-style aligned statusline", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "finder",
      {
        content: [{ type: "text", text: "Statusline evidence." }],
        details: {
          reportedModel: "google/gemini-3.5-flash",
          exitCode: 0,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          contextWindow: 300_000,
          usage: { input: 106_000, output: 1_200, cacheRead: 1_500_000, cacheWrite: 0, cost: 0.1703, contextTokens: 69_000, turns: 9 },
          trail: [],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      makeContext({ query: "Find statusline rendering" }),
    );
    const width = 100;
    const lastLine = renderLines(component, width).at(-1);
    const left = "9 turns ↑106k ↓1.2k R1.5M 23.0%/300k";
    const right = "gemini-3.5-flash • finder";

    assert.equal(lastLine, `${left}${" ".repeat(width - visibleTextWidth(left) - visibleTextWidth(right))}${right}`);
    assert.equal(visibleTextWidth(lastLine), width);
    assert.doesNotMatch(lastLine, /\$0\.1703|ctx:/);
  });

  it("truncates the worker statusline to the rendered width", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "oracle",
      {
        content: [{ type: "text", text: "Narrow statusline." }],
        details: {
          reportedModel: "openai-codex/gpt-5.5-with-a-very-long-suffix",
          exitCode: 0,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          contextWindow: 400_000,
          usage: { input: 106_000, output: 1_200, cacheRead: 1_500_000, cacheWrite: 0, cost: 0.1703, contextTokens: 92_000, turns: 9 },
          trail: [],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      makeContext({ task: "Check statusline rendering" }),
    );
    const width = 42;
    const lastLine = renderLines(component, width).at(-1) ?? "";

    assert.ok(visibleTextWidth(lastLine) <= width, `statusline exceeded ${width} columns: ${JSON.stringify(lastLine)}`);
    assert.match(lastLine, /9 turns ↑106k/);
    assert.doesNotMatch(lastLine, /\$0\.1703|ctx:/);
  });

  it("renders provider stopReason=stop as a successful completed task with Markdown task body and final output", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const base = makeResult();
    const component = renderMmrSubagentResult(
      "finder",
      {
        ...base,
        content: [{ type: "text", text: "Worker found the requested evidence." }],
        details: {
          ...base.details,
          reportedModel: "google/gemini-3.5-flash",
          stopReason: "stop",
          trail: [],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      { args: { query: "Find worker status rendering" }, showImages: false, isError: false },
    );
    const rendered = normalize(renderText(component));

    assert.equal(component.constructor.name, "Container");
    assert.equal(countComponentType(component, "Markdown"), 2, "operation and final output should both render as boxed Markdown");
    assert.match(rendered, /finder • gemini-3\.5-flash/);
    assert.match(rendered, /completed/i);
    assert.match(rendered, /Find worker status rendering/);
    assert.match(rendered, /Worker found the requested evidence/);
    assert.doesNotMatch(rendered, /[▸▾◐●⚠]/);
    assert.doesNotMatch(rendered, /stopped/i);
  });

  it("aligns task body, assistant trail text, and final output to Pi message indentation", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "finder",
      {
        content: [{ type: "text", text: "Final body paragraph.\n\n- final bullet" }],
        details: {
          reportedModel: "google/gemini-3.5-flash",
          exitCode: 0,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
          trail: [{ type: "assistant", text: "Assistant trail paragraph." }],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      makeContext({ query: "Task body paragraph.\n\n- task bullet" }),
    );
    const lines = renderLines(component, 120);
    const taskColumn = firstTextColumn(lines, "Task body paragraph.");
    const assistantColumn = firstTextColumn(lines, "Assistant trail paragraph.");
    const finalColumn = firstTextColumn(lines, "Final body paragraph.");

    assert.equal(taskColumn, finalColumn);
    assert.ok(assistantColumn < taskColumn, "boxed task/output content should be inset relative to expanded transcript content");
  });

  it("renders a Pi-style agent loop with model, objective, assistant text, child tools, final output, and usage", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "finder",
      makeResult(),
      { expanded: true, isPartial: false },
      fakeTheme,
      makeContext({ query: "Evaluating interface name collision" }),
    );
    const rendered = normalize(renderText(component));

    assert.equal(component.constructor.name, "Container");
    assert(hasChildType(component, "Spacer"));
    assert.equal(countComponentType(component, "Markdown") >= 1, true);
    assert.match(rendered, /finder • gpt-5\.4-mini/);
    assert.match(rendered, /completed/i);
    assert.match(rendered, /Evaluating interface name collision/);
    assert.match(rendered, /Now read finder\.ts buildFinalContent:/);
    assert.match(rendered, /read .*~\/projects\/repo\/src\/extensions\/mmr-subagents\/finder\.ts:430-589/);
    assert.match(rendered, /read result preview from finder\.ts/);
    assert.match(rendered, /I'm seeing the core issue now/);
    assert.match(rendered, /grep .*activation failure marker.*tests/);
    assert.match(rendered, /grep result preview from tests/);
    assert.match(rendered, /Key failure-handling lives in the worker runner/);
    assert.match(rendered, /7 turns/);
    assert.match(rendered, /gpt-5\.4-mini/);
    assert.doesNotMatch(rendered, /[▸▾◐●⚠]/);
    assert.doesNotMatch(rendered, /→ toolCall/);
    assert.doesNotMatch(rendered, /toolResult/);
    assert.doesNotMatch(rendered, /^\s*assistant\b/m);
    assert.doesNotMatch(rendered, /^\s*user\b/m);
  });

  it("renders native child-tool calls even when long args previews were truncated mid-JSON", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const home = homedir();
    const component = renderMmrSubagentResult(
      "oracle",
      {
        content: [{ type: "text", text: "Use the renderCall hooks." }],
        details: {
          reportedModel: "openai-codex/gpt-5.5",
          exitCode: 0,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          trail: [
            {
              type: "tool",
              toolCallId: "grep-1",
              toolName: "grep",
              status: "completed",
              argsPreview: `{"pattern":"renderCall","path":"${home}/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools","glob":"**/*.js","context":3,"limi…`,
              resultPreview: "ls.js:154: renderCall(args, theme, context) {",
            },
            {
              type: "tool",
              toolCallId: "read-1",
              toolName: "read",
              status: "completed",
              argsPreview: `{"path":"${home}/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js","offset":250,"limi…`,
              resultPreview: "// User-specified limit stopped early",
            },
            {
              type: "tool",
              toolCallId: "find-1",
              toolName: "find",
              status: "completed",
              argsPreview: '{"pattern":"*.ts","path":"src","limi…',
              resultPreview: "src/index.ts",
            },
            {
              type: "tool",
              toolCallId: "bash-1",
              toolName: "bash",
              status: "completed",
              argsPreview: '{"command":"npm test -- --runInBand","timeout":120,"limi…',
              resultPreview: "all green",
            },
            {
              type: "tool",
              toolCallId: "ls-1",
              toolName: "ls",
              status: "completed",
              argsPreview: '{"path":"src/extensions","limi…',
              resultPreview: "mmr-subagents/",
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      makeContext({ task: "Inspect native renderers" }),
    );
    const rendered = normalize(renderText(component));

    assert.match(rendered, /grep[\s\S]*\/renderCall\/[\s\S]*\(\*\*\/\*\.js\)/);
    assert.match(rendered, /ls\.js:154: renderCall\(args, theme, context\)/);
    assert.match(rendered, /read[\s\S]*read\.js:250/);
    assert.match(rendered, /User-specified limit stopped early/);
    assert.match(rendered, /find[\s\S]*\*\.ts[\s\S]*src/);
    assert.match(rendered, /src\/index\.ts/);
    assert.match(rendered, /\$ npm test -- --runInBand/);
    assert.match(rendered, /all green/);
    assert.match(rendered, /ls[\s\S]*src\/extensions/);
    assert.match(rendered, /mmr-subagents\//);
    assert.doesNotMatch(rendered, /\{"pattern"/);
    assert.doesNotMatch(rendered, /\{"path"/);
    assert.doesNotMatch(rendered, /\{"command"/);
  });

  it("suppresses a duplicate final assistant trail item and renders the final Markdown once", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const finalMarkdown = "pi-mmr manages subagent/worker invocations across mmr-core and mmr-subagents.";
    const component = renderMmrSubagentResult(
      "finder",
      {
        content: [{ type: "text", text: finalMarkdown }],
        details: {
          reportedModel: "google/gemini-3.5-flash",
          exitCode: 0,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
          trail: [
            { type: "user", text: "Task: Find subagent invocation behavior" },
            { type: "assistant", text: "I need to inspect the renderer first." },
            { type: "assistant", text: finalMarkdown },
          ],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      makeContext({ query: "Find subagent invocation behavior" }),
    );
    const rendered = normalize(renderText(component));

    assert.match(rendered, /I need to inspect the renderer first/);
    assert.equal(countOccurrences(rendered, "manages subagent/worker invocations"), 1);
    assert.doesNotMatch(rendered, /^\s*Task: Find subagent invocation behavior/m);
  });

  it("keeps matching assistant trail text visible while partial progress is still streaming", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const streamingText = "I found the renderer path and am checking oracle next.";
    const component = renderMmrSubagentResult(
      "oracle",
      {
        content: [{ type: "text", text: streamingText }],
        details: {
          reportedModel: "openai-codex/gpt-5.5",
          exitCode: null,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          trail: [{ type: "assistant", text: streamingText }],
        },
      },
      { expanded: true, isPartial: true },
      fakeTheme,
      { args: { task: "Audit all subagents" }, showImages: false, isError: false },
    );
    const rendered = normalize(renderText(component));

    assert.equal(countOccurrences(rendered, streamingText), 1);
  });

  it("omits final Markdown output while partial progress is still streaming", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "finder",
      makeResult({ content: [{ type: "text", text: "partial worker output" }] }),
      { expanded: true, isPartial: true },
      fakeTheme,
      { args: { query: "Streaming query" }, showImages: false, isError: false },
    );
    const rendered = normalize(renderText(component));

    assert.equal(component.constructor.name, "Container");
    assert.match(rendered, /Streaming query/);
    assert.match(rendered, /Now read finder\.ts buildFinalContent:/);
    assert.doesNotMatch(rendered, /partial worker output/);
  });

  it("renders worker transcript roles as Pi-style content blocks in expanded trails", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "Task",
      {
        content: [{ type: "text", text: "worker finished" }],
        details: {
          reportedModel: "openai-codex/gpt-5.5",
          exitCode: 0,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          trail: [
            { type: "user", text: "Please inspect auth flow", imageCount: 1 },
            { type: "skillInvocation", name: "tdd-workflow", location: "/skills/tdd/SKILL.md", text: "Use tests before edits" },
            { type: "assistant", text: "I'll inspect the route." },
            { type: "thinking", text: "Need to locate the handler first." },
            {
              type: "tool",
              toolCallId: "read-1",
              toolName: "read",
              status: "completed",
              argsPreview: JSON.stringify({ path: "/tmp/repo/src/auth.ts", offset: 5, limit: 2 }),
              resultPreview: "read result preview line",
            },
            { type: "toolResult", toolCallId: "search-1", toolName: "web_search", text: "2 results", isError: false },
            { type: "bashExecution", command: "npm test", output: "pass", exitCode: 0, cancelled: false, truncated: false },
            { type: "compactionSummary", summary: "Reduced prior context", tokensBefore: 12_000 },
            { type: "branchSummary", summary: "Side branch changed tests" },
            { type: "custom", customType: "notice", text: "extension payload" },
          ],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      makeContext({ prompt: "Inspect auth" }),
    );
    const rendered = normalize(renderText(component));

    assert.match(rendered, /Please inspect auth flow/);
    assert.match(rendered, /1 image/);
    assert.match(rendered, /\[skill\][\s\S]*tdd-workflow/);
    assert.match(rendered, /Use tests before edits/);
    assert.match(rendered, /I'll inspect the route/);
    assert.match(rendered, /Need to locate the handler/);
    assert.match(rendered, /read .*src\/auth\.ts:5-6/);
    assert.match(rendered, /read result preview line/);
    assert.match(rendered, /web_search[\s\S]*2 results/);
    assert.match(rendered, /\$ npm test/);
    assert.match(rendered, /pass/);
    assert.match(rendered, /\[compaction\]/);
    assert.match(rendered, /Reduced prior context/);
    assert.match(rendered, /\[branch\]/);
    assert.match(rendered, /Side branch changed tests/);
    assert.match(rendered, /notice/);
    assert.match(rendered, /extension payload/);
    const componentTypes = collectComponentTypes(component);
    assert(componentTypes.includes("UserMessageComponent"), "user trail items should use Pi's native user-message component");
    assert(componentTypes.includes("AssistantMessageComponent"), "assistant/thinking trail items should use Pi's native assistant-message component");
    assert(componentTypes.includes("SkillInvocationMessageComponent"), "skill trail items should use Pi's native skill component");
    assert(componentTypes.includes("CompactionSummaryMessageComponent"), "compaction trail items should use Pi's native compaction component");
    assert(componentTypes.includes("BranchSummaryMessageComponent"), "branch trail items should use Pi's native branch component");
    assert(componentTypes.includes("CustomMessageComponent"), "custom trail items should use Pi's native custom-message component");
    assert.match(rendered, /worker finished/);
    assert.doesNotMatch(rendered, /→ toolCall/);
    assert.doesNotMatch(rendered, /toolResult/);
    assert.doesNotMatch(rendered, /^\s*user\b/m);
    assert.doesNotMatch(rendered, /^\s*assistant\b/m);
    assert.doesNotMatch(rendered, /^\s*thinking\b/m);
  });

  it("renders Task runs as success when details.status === 'success' even with non-zero exit", async () => {
    // Behavioral pin (Task outcome classifier): Task
    // classifies non-zero exit WITH usable final text as success. The
    // progress renderer must trust the producing tool's `details.status`
    // instead of recomputing failure from raw `exitCode` alone. The
    // Pi-TUI tool frame draws status glyphs; the inner text only carries
    // the human-readable label.
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const rendered = renderText(renderMmrSubagentResult(
      "Task",
      {
        content: [{ type: "text", text: "worker delivered partial-but-usable result" }],
        details: {
          worker: "mmr-subagents.Task",
          status: "success",
          reportedModel: "openai-codex/gpt-5.5",
          exitCode: 1,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
          trail: [],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      { args: { prompt: "Inspect", description: "Inspect" }, showImages: false, isError: false },
    ));
    assert.match(rendered, /completed/i);
    assert.doesNotMatch(rendered, /failed/i);
    assert.doesNotMatch(rendered, /[▸▾◐●⚠]/);
  });

  it("renders Task runs as failed when details.status indicates a worker-error even with usable output bytes", async () => {
    // Inverse of the success case: when Task signals a worker-error
    // (e.g. signal-killed with no usable text), the renderer must not
    // mark the row succeeded just because `exitCode === 0` happens to
    // be unset.
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const rendered = renderText(renderMmrSubagentResult(
      "Task",
      {
        content: [{ type: "text", text: "Task: worker exited with code null." }],
        details: {
          worker: "mmr-subagents.Task",
          status: "worker-error",
          reportedModel: "openai-codex/gpt-5.5",
          exitCode: null,
          signal: "SIGKILL",
          aborted: false,
          stopReason: "end_turn",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          trail: [],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      { args: { prompt: "x", description: "x" }, showImages: false, isError: false },
    ));
    assert.match(rendered, /failed/i);
    assert.doesNotMatch(rendered, /task completed/i);
    assert.doesNotMatch(rendered, /[▸▾◐●⚠]/);
  });

  it("uses failed status text and diagnostics for unsuccessful worker runs without status glyphs", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "finder",
      makeResult({
        details: {
          reportedModel: "google/gemini-3.5-flash",
          exitCode: 1,
          signal: null,
          aborted: false,
          errorMessage: "spawn ENOENT",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          trail: [
            { type: "assistant", text: "I need to inspect the runner." },
            { type: "tool", toolCallId: "read-1", toolName: "read", status: "failed", argsPreview: '{"path":"src/runner.ts"}' },
          ],
        },
      }),
      { expanded: true, isPartial: false },
      fakeTheme,
      { args: { query: "Inspect runner" }, showImages: false, isError: true },
    );
    const rendered = normalize(renderText(component));

    assert.match(rendered, /finder • gemini-3\.5-flash/);
    assert.match(rendered, /failed/i);
    assert.match(rendered, /spawn ENOENT/);
    assert.doesNotMatch(rendered, /[▸▾◐●⚠]/);
  });

  it("surfaces details.spawnError as a Spawn failed: diagnostic ahead of generic errorMessage", async () => {
    // The runner mirrors the spawn-error reason into errorMessage so
    // legacy consumers still see it, but the renderer should prefer
    // the structured spawnError field and prefix it so users can
    // distinguish a spawn failure (typically a missing pi binary)
    // from a worker-runtime failure.
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "Task",
      {
        content: [{ type: "text", text: "Task: worker failed to spawn: spawn ENOENT" }],
        details: {
          worker: "mmr-subagents.Task",
          status: "spawn-error",
          reportedModel: "openai-codex/gpt-5.5",
          exitCode: 1,
          signal: null,
          aborted: false,
          spawnError: "spawn ENOENT",
          errorMessage: "spawn ENOENT",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          trail: [],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      { args: { prompt: "Inspect", description: "Inspect" }, showImages: false, isError: true },
    );
    const rendered = normalize(renderText(component));

    assert.match(rendered, /Spawn failed: spawn ENOENT/);
    assert.match(rendered, /failed/i);
    // The `Spawn failed:` diagnostic appears exactly once, and the bare
    // errorMessage is not rendered as a second diagnostic line because
    // spawnError took precedence in the diagnostic chain.
    const diagnosticMatches = rendered.match(/Spawn failed:/g) ?? [];
    assert.equal(diagnosticMatches.length, 1, `expected one Spawn failed: line, got ${diagnosticMatches.length}`);
  });

  it("reads only details.trail; a stray legacy details.toolActivity is ignored", async () => {
    // Regression for the legacy `toolActivity` removal: the renderer
    // must source the expanded trail from `details.trail` only. Any
    // stray `toolActivity` value carried on `details` (e.g. by older
    // host code) must not surface in the rendered output.
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "finder",
      {
        content: [{ type: "text", text: "final worker output" }],
        details: {
          worker: "mmr-subagents.finder",
          reportedModel: "google/gemini-3.5-flash",
          exitCode: 0,
          signal: null,
          aborted: false,
          stopReason: "end_turn",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          trail: [
            { type: "assistant", text: "trail content is the source of truth" },
            { type: "tool", toolCallId: "t-1", toolName: "grep", status: "completed", argsPreview: '{"pattern":"renderer"}' },
          ],
          // Legacy stray field that must be ignored by the renderer.
          toolActivity: [
            {
              toolCallId: "legacy-1",
              toolName: "legacy_tool_name_should_not_render",
              status: "completed",
              argsPreview: '{"legacy":"args"}',
              resultPreview: "legacy result should not appear",
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      { args: { query: "Inspect renderer trail" }, showImages: false, isError: false },
    );
    const rendered = normalize(renderText(component));

    assert.match(rendered, /trail content is the source of truth/);
    assert.match(rendered, /grep .*renderer/);
    assert.doesNotMatch(rendered, /→ toolCall/);
    assert.doesNotMatch(rendered, /legacy_tool_name_should_not_render/);
    assert.doesNotMatch(rendered, /legacy result should not appear/);
  });
});

describe("cthulu R'lyehian streamed-content transform", () => {
  function makeCthuluResult() {
    return {
      content: [{ type: "text", text: "Recommended fix: enforce a global lock ordering." }],
      details: {
        worker: "mmr-subagents.cthulu",
        reportedModel: "claude-subscription/claude-opus-4-8",
        exitCode: 0,
        signal: null,
        aborted: false,
        stopReason: "end_turn",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        trail: [
          { type: "assistant", text: "Investigating the mutex reproduction harness." },
          {
            type: "tool",
            toolCallId: "read-1",
            toolName: "read",
            status: "completed",
            argsPreview: JSON.stringify({ path: "src/lock.ts" }),
            resultPreview: "uniqueResultPreviewMarker",
          },
        ],
      },
    };
  }

  it("renders streamed agent-loop content as a part-incantation/part-English blend, final answer readable", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const component = renderMmrSubagentResult(
      "cthulu",
      makeCthuluResult(),
      { expanded: true, isPartial: false },
      fakeTheme,
      { args: { task: "Resolve the deadlock" }, showImages: false, isError: false },
    );
    const rendered = normalize(renderText(component));
    // Final answer (result content) stays fully readable, never transliterated.
    assert.match(rendered, /Recommended fix: enforce a global lock ordering\./);
    // Trail blend: some long words become incantation...
    assert.doesNotMatch(rendered, /Investigating/);
    assert.doesNotMatch(rendered, /reproduction/);
    // ...while other long words stay in dread English.
    assert.match(rendered, /mutex/);
    assert.match(rendered, /harness/);
    // Tool preview blend: a single long token is cloaked.
    assert.doesNotMatch(rendered, /uniqueResultPreviewMarker/);
    // The task label is blended too (verb cloaked, noun kept), so it is not verbatim.
    assert.doesNotMatch(rendered, /Resolve the deadlock/);
    assert.match(rendered, /deadlock/);
  });

  it("leaves the same content readable for the non-R'lyehian oracle tool", async () => {
    const { renderMmrSubagentResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const result = makeCthuluResult();
    result.details.worker = "mmr-subagents.oracle";
    const component = renderMmrSubagentResult(
      "oracle",
      result,
      { expanded: true, isPartial: false },
      fakeTheme,
      { args: { task: "Resolve the deadlock" }, showImages: false, isError: false },
    );
    const rendered = normalize(renderText(component));
    assert.match(rendered, /Investigating/);
    assert.match(rendered, /Recommended fix: enforce a global lock ordering\./);
  });
});
