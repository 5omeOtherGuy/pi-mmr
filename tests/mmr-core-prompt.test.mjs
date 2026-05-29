import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const fixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const BASE_PROMPT = readFileSync(path.join(fixtureDir, "base.md"), "utf8");

function readModeFixture(mode) {
  return readFileSync(path.join(fixtureDir, `${mode}.md`), "utf8");
}

function createState(overrides = {}) {
  return {
    mode: "smart",
    displayName: "Smart",
    source: "settings",
    targetModel: "claude-opus-4-8",
    requestedModels: ["claude-opus-4-8"],
    provider: "claude-subscription",
    model: "claude-opus-4-8",
    modelFound: true,
    modelApplied: true,
    modelFallbackApplied: false,
    modelFallbackReason: undefined,
    modelCandidates: [],
    thinkingLevel: "medium",
    promptRoute: "default",
    requestedTools: ["Read", "Bash"],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

const MODES = ["smart", "smartGPT", "rush", "large", "deep"];

const PI_IDENTITY_LINE = "You are an expert coding assistant operating inside pi, a coding agent harness.";

const MODE_MARKER_OPENINGS = {
  smart: '<mmr_mode name="smart">You are pair programming with the user.',
  smartGPT: '<mmr_mode name="smartGPT">You are pair programming with the user (smartGPT routing).',
  rush: '<mmr_mode name="rush">You and the user share one workspace.',
  large: '<mmr_mode name="large">You are pair programming with the user in Large mode.',
  deep: '<mmr_mode name="deep">You are an autonomous coding agent in Deep mode.',
};

function repeatedLongInstructionLines(prompt) {
  const counts = new Map();
  for (const line of prompt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length < 80) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([line, count]) => `${count}x ${line}`);
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

function buildExtensionStub(handlers) {
  return {
    registerFlag: () => {},
    getFlag: () => undefined,
    getAllTools: () => [],
    getActiveTools: () => ["read", "bash"],
    setActiveTools: () => {},
    setModel: async () => true,
    setThinkingLevel: () => {},
    appendEntry: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (name, handler) => handlers.set(name, handler),
  };
}

describe("mmr-core prompt layer", () => {
  it("renders each mode prompt against the fixture base prompt and matches its snapshot", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode, displayName: mode[0].toUpperCase() + mode.slice(1) });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.equal(result, readModeFixture(mode), `${mode}: rendered prompt must match fixture`);
      assert.equal(result.startsWith(`${PI_IDENTITY_LINE} ${MODE_MARKER_OPENINGS[mode]}`), true);
    }
  });

  it("emits the shared tool-use posture only once per locked-mode prompt", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const { MMR_TOOL_USE_POSTURE_LINE } = await importSource("extensions/mmr-core/prompt-assembly.ts");

    for (const mode of MODES) {
      const state = createState({ mode, displayName: mode[0].toUpperCase() + mode.slice(1) });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.equal(
        result.split(MMR_TOOL_USE_POSTURE_LINE).length - 1,
        1,
        `${mode}: duplicated prompt guidance reinforces repetitive tool-use behavior`,
      );
    }
  });

  it("does not duplicate long instruction lines in locked-mode prompts", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode, displayName: mode[0].toUpperCase() + mode.slice(1) });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.deepEqual(
        repeatedLongInstructionLines(result),
        [],
        `${mode}: long model-visible instruction lines must not be emitted more than once`,
      );
    }
  });

  it("does not duplicate shared guidance when reassembling an already MMR-rewritten prompt", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode, displayName: mode[0].toUpperCase() + mode.slice(1) });
      const first = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      const second = buildMmrPromptLayer({ state, baseSystemPrompt: first });
      assert.deepEqual(
        repeatedLongInstructionLines(second),
        [],
        `${mode}: reassembly must replace prior MMR-owned blocks instead of preserving and duplicating them`,
      );
    }
  });

  it("limits MMR-owned XML-style markers to the initial mode role marker", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const forbiddenMarkers = [
      "<smart>",
      "</smart>",
      "<rush>",
      "</rush>",
      "<large>",
      "</large>",
      "<deep>",
      "</deep>",
      "<tool_use>",
      "</tool_use>",
      "<autonomy_and_persistence>",
      "</autonomy_and_persistence>",
      "<investigate_before_acting>",
      "</investigate_before_acting>",
      "<pragmatism_and_scope>",
      "</pragmatism_and_scope>",
      "<verification>",
      "</verification>",
      "<executing_actions_with_care>",
      "</executing_actions_with_care>",
      "<using_subagents>",
      "</using_subagents>",
      "<diagrams>",
      "</diagrams>",
      "<file_links>",
      "</file_links>",
      "<deep_mode>",
      "</deep_mode>",
      "<diagnostic_gate>",
      "</diagnostic_gate>",
      "<discovery_discipline>",
      "</discovery_discipline>",
      "<working_with_the_user>",
      "</working_with_the_user>",
    ];

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.equal(result.includes(MODE_MARKER_OPENINGS[mode]), true, `${mode}: initial mode marker must describe the mode role`);
      assert.equal(result.includes("</mmr_mode>"), true, `${mode}: mode marker must close with a parseable XML-style close tag`);
      assert.equal(result.split("<mmr_mode ").length - 1, 1, `${mode}: must contain exactly one opening mmr_mode marker`);
      assert.equal(result.split("</mmr_mode>").length - 1, 1, `${mode}: must contain exactly one closing mmr_mode marker`);
      for (const marker of forbiddenMarkers) {
        assert.equal(result.includes(marker), false, `${mode}: must not include legacy marker ${marker}`);
      }
      assert.equal(result.includes("## Tool use"), true, `${mode}: Tool use must be a Markdown heading`);
      assert.equal(result.includes("## Response style"), true, `${mode}: response style must be a Markdown heading`);
    }
  });

  it("instructs raw diagram output without diagram code fences", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.equal(result.includes("When a picture beats prose for architecture, flow, state, or relationships, output the raw box-drawing diagram only."), true);
      assert.equal(result.includes("```diagram"), false, `${mode}: must not force diagram code fences`);
    }
  });

  it("embeds Pi's Available tools list verbatim under the Tool use heading for every mode", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const expectedToolsBlock = [
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute bash commands (ls, grep, find, etc.)",
      "- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
      "- write: Create or overwrite files",
      "- grep: Search file contents for patterns (respects .gitignore)",
      "- find: Find files by glob pattern (respects .gitignore)",
      "- ls: List directory contents",
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      const toolsIdx = result.indexOf(expectedToolsBlock);
      const toolUseIdx = result.indexOf("## Tool use");
      const tailIdx = result.indexOf("\n\n# Project Context");
      assert.notEqual(toolsIdx, -1, `${mode}: Available tools block must appear`);
      assert.equal(toolUseIdx < toolsIdx && toolsIdx < tailIdx, true, `${mode}: tools must be embedded under ## Tool use before the Pi tail`);
      const lastToolsIdx = result.lastIndexOf("Available tools:");
      assert.equal(lastToolsIdx < tailIdx, true, `${mode}: Available tools must not appear in the Pi tail`);
    }
  });

  it("preserves Pi-emitted registered-tool snippets and guidelines in the mode prompt", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const registeredToolLines = [
      "- apply_patch: Apply a Codex-format patch to workspace files",
      "- web_search: Search the public web through Brave Search for a research objective",
      "- read_web_page: Fetch a public http(s) page through mmr-web's custom reader and return Markdown text",
    ];
    const registeredGuidelines = [
      "- Use apply_patch with `*** Begin Patch` / `*** End Patch` envelopes for multi-hunk or multi-file edits.",
      "- Use web_search only for public, non-sensitive research; do not include secrets, API keys, or private data in web_search.objective or web_search.search_queries.",
      "- Use read_web_page only for public http(s) pages; do not use read_web_page for localhost, private IPs, link-local hosts, or non-Internet URLs.",
    ];
    const baseWithRegisteredTools = BASE_PROMPT
      .replace(
        "- bash: Execute bash commands (ls, grep, find, etc.)",
        ["- bash: Execute bash commands (ls, grep, find, etc.)", ...registeredToolLines].join("\n"),
      )
      .replace("Guidelines:\n", `Guidelines:\n${registeredGuidelines.join("\n")}\n`);

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: baseWithRegisteredTools });
      const toolsIdx = result.indexOf("Available tools:");
      const guidelinesIdx = result.indexOf("Guidelines:");
      const piDocsIdx = result.indexOf("Pi documentation (");

      for (const line of registeredToolLines) {
        assert.equal(result.split(line).length - 1, 1, `${mode}: registered tool snippet must appear exactly once: ${line}`);
        const lineIdx = result.indexOf(line);
        assert.equal(toolsIdx < lineIdx && lineIdx < guidelinesIdx, true, `${mode}: registered tool snippet must stay in Available tools`);
      }
      for (const line of registeredGuidelines) {
        assert.equal(result.split(line).length - 1, 1, `${mode}: registered tool guideline must appear exactly once: ${line}`);
        const lineIdx = result.indexOf(line);
        assert.equal(guidelinesIdx < lineIdx && lineIdx < piDocsIdx, true, `${mode}: registered tool guideline must stay in Guidelines`);
      }
    }
  });

  it("embeds the Pi Guidelines block under the Tool use heading and passes every Pi-authored bullet through verbatim", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    // Phase D policy: never edit Pi-authored blocks. The two bullets that
    // earlier versions stripped now pass through alongside the rest.
    const allBullets = [
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
      "- Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
      "- Use read to examine files instead of cat or sed.",
      "- Use edit for precise changes (edits[].oldText must match exactly)",
      "- Use write only for new files or complete rewrites.",
    ];

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      const guidelinesIdx = result.indexOf("Guidelines:");
      const toolUseIdx = result.indexOf("## Tool use");
      const piDocsIdx = result.indexOf("Pi documentation (");
      assert.notEqual(guidelinesIdx, -1, `${mode}: Guidelines: must appear`);
      assert.equal(toolUseIdx < guidelinesIdx && guidelinesIdx < piDocsIdx, true, `${mode}: Guidelines must sit under ## Tool use before Pi docs`);
      for (const bullet of allBullets) {
        assert.equal(result.includes(bullet), true, `${mode}: Pi-authored bullet must pass through verbatim: ${bullet}`);
      }
    }
  });

  it("preserves the Pi tail (Project Context, skills, date, cwd) verbatim from the boundary onward", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const tailStartIdx = BASE_PROMPT.indexOf("# Project Context");
    const expectedTail = BASE_PROMPT.slice(tailStartIdx);

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.equal(result.endsWith(expectedTail), true, `${mode}: tail must be preserved verbatim`);
    }
  });

  it("does not duplicate the Available tools or Guidelines blocks", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      const toolsCount = result.split("Available tools:").length - 1;
      const guidelinesCount = result.split("Guidelines:").length - 1;
      assert.equal(toolsCount, 1, `${mode}: Available tools must appear exactly once, got ${toolsCount}`);
      assert.equal(guidelinesCount, 1, `${mode}: Guidelines must appear exactly once, got ${guidelinesCount}`);
    }
  });

  it("does not emit legacy MMR markers or generated routing/policy sections", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const forbidden = [
      "<!-- mmr-core",
      "## MMR routing context",
      "## MMR mode prompt",
      "### Routing",
      "### Tool policy",
      "### Unavailable/deferred tools",
      "Active resolved tools:",
      "Missing tools:",
      "Deferred tools:",
    ];
    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      for (const phrase of forbidden) {
        assert.equal(result.includes(phrase), false, `${mode}: must not include ${phrase}`);
      }
    }
  });

  it("returns Pi's prompt unchanged in free mode", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const state = createState({ mode: "free", displayName: "Free", promptRoute: "default" });
    const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
    assert.equal(result, BASE_PROMPT);
  });

  it("returns Pi's prompt unchanged when boundary anchors are missing", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const customPrompt = "You are a custom assistant.\n\nNo Pi-style sections here.";
    const state = createState({ mode: "smart" });
    const result = buildMmrPromptLayer({ state, baseSystemPrompt: customPrompt });
    assert.equal(result, customPrompt);
  });

  it("does not emit an MMR prompt block while free mode is active in before_agent_start", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const handlers = new Map();
    runtime.setMmrModeState(createState({ mode: "free", displayName: "Free", promptRoute: "default" }));
    extension(buildExtensionStub(handlers));

    const result = await handlers.get("before_agent_start")({
      systemPrompt: BASE_PROMPT,
      systemPromptOptions: { selectedTools: ["read", "bash"] },
    });

    assert.equal(result, undefined);
  });

  it("returns the new system prompt from before_agent_start when mode rewrites Pi's prompt", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const handlers = new Map();
    runtime.setMmrModeState(createState({ mode: "deep", displayName: "Deep", promptRoute: "deep", thinkingLevel: "xhigh" }));
    extension(buildExtensionStub(handlers));

    const result = await handlers.get("before_agent_start")({
      systemPrompt: BASE_PROMPT,
      systemPromptOptions: { selectedTools: ["read", "bash"] },
    });

    assert.equal(result.systemPrompt, readModeFixture("deep"));
  });

  it("preserves Pi's appendSystemPrompt content inserted between the Pi docs block and the tail", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const piDocsEnd = BASE_PROMPT.indexOf("# Project Context");
    const beforeTail = BASE_PROMPT.slice(0, piDocsEnd);
    const tail = BASE_PROMPT.slice(piDocsEnd);
    const APPEND_BLOCK = "## EXTRA APPENDED INSTRUCTIONS\n\nDo something extra.\n";
    const promptWithAppend = `${beforeTail}${APPEND_BLOCK}\n${tail}`;

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: promptWithAppend });
      assert.equal(result.includes(APPEND_BLOCK), true, `${mode}: appendSystemPrompt block must be preserved`);
      const responseStyleIdx = result.indexOf("## Response style");
      const appendIdx = result.indexOf(APPEND_BLOCK);
      const tailIdx = result.indexOf("# Project Context");
      assert.equal(responseStyleIdx < appendIdx && appendIdx < tailIdx, true, `${mode}: append must sit between mode prompt content and tail`);
    }
  });

  it("preserves content prepended by earlier extension handlers before Pi's identity line", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const PREPENDED = "<!-- earlier-extension:start -->\nEARLIER EXTENSION HEADER\n<!-- earlier-extension:end -->\n\n";
    const promptWithPrepend = `${PREPENDED}${BASE_PROMPT}`;

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: promptWithPrepend });
      assert.equal(result.startsWith(PREPENDED), true, `${mode}: prepended extension content must be preserved at the start`);
      const identityIdx = result.indexOf("You are an expert coding assistant operating inside pi");
      assert.equal(identityIdx > 0, true, `${mode}: Pi identity line must follow prepended content`);
    }
  });

  it("preserves content appended by extensions after Pi's tail", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const APPENDED = "\n\n<!-- footer-extension -->\nFOOTER EXTENSION CONTENT";
    const promptWithAppend = `${BASE_PROMPT}${APPENDED}`;

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: promptWithAppend });
      assert.equal(result.endsWith(APPENDED), true, `${mode}: appended extension content must be preserved at the end`);
    }
  });

  it("preserves Current date and Current working directory when Pi omits the blank line before them (no append, no context, no skills)", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    // Pi attaches `\nCurrent date:` directly to the last Pi docs bullet (single \n) when there
    // is no appendSystemPrompt, no context files, and no skills.
    const minimalBase = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      "",
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute bash commands (ls, grep, find, etc.)",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
      "",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /pi/README.md",
      "- Additional docs: /pi/docs",
    ].join("\n") + "\nCurrent date: 2026-05-08\nCurrent working directory: /test/cwd";

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: minimalBase });

      assert.equal(result.includes("Current date: 2026-05-08"), true, `${mode}: date must be preserved`);
      assert.equal(result.includes("Current working directory: /test/cwd"), true, `${mode}: cwd must be preserved`);

      const responseStyleIdx = result.indexOf("## Response style");
      const dateIdx = result.indexOf("Current date:");
      assert.notEqual(responseStyleIdx, -1, `${mode}: response style heading must appear`);
      assert.equal(responseStyleIdx < dateIdx, true, `${mode}: Current date must come after mode prompt content`);

      const piDocsIdx = result.indexOf("Pi documentation (");
      const modePostureStartIdx = result.indexOf("## ", piDocsIdx + 1);
      const piDocsSlice = result.slice(piDocsIdx, modePostureStartIdx);
      assert.equal(piDocsSlice.includes("Current date:"), false, `${mode}: Current date must not be embedded inside Pi docs`);
      assert.equal(piDocsSlice.includes("Current working directory:"), false, `${mode}: Current working directory must not be embedded inside Pi docs`);
    }
  });

  it("ignores prepended Available tools / Guidelines / Pi documentation sections that come before Pi's identity line", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const PREPENDED = [
      "EARLIER EXTENSION HEADER",
      "",
      "Available tools:",
      "- fake_tool: fake description",
      "",
      "Guidelines:",
      "- fake guideline",
      "",
      "Pi documentation (fake):",
      "- fake docs entry",
      "",
      "",
    ].join("\n");
    const promptWithPrepend = `${PREPENDED}${BASE_PROMPT}`;

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: promptWithPrepend });

      const identityIdx = result.indexOf(PI_IDENTITY_LINE);
      const tailIdx = result.indexOf("# Project Context");
      assert.notEqual(identityIdx, -1, `${mode}: mode prompt content must be present`);
      assert.notEqual(tailIdx, -1, `${mode}: preserved tail must be present`);

      const modePromptContent = result.slice(identityIdx, tailIdx);
      assert.equal(modePromptContent.includes("- fake_tool: fake description"), false, `${mode}: prepended fake tool must not be embedded as Pi tool`);
      assert.equal(modePromptContent.includes("- fake guideline"), false, `${mode}: prepended fake guideline must not be embedded as Pi guideline`);
      assert.equal(modePromptContent.includes("- fake docs entry"), false, `${mode}: prepended fake docs must not be embedded as Pi docs`);
      // Real Pi tool from BASE_PROMPT must be embedded.
      assert.equal(modePromptContent.includes("- read: Read file contents"), true, `${mode}: real Pi tool must be embedded`);

      // Prepended fake content must still be preserved before the mode prompt.
      const beforeMode = result.slice(0, identityIdx);
      assert.equal(beforeMode.includes("EARLIER EXTENSION HEADER"), true, `${mode}: prepended header must be preserved`);
      assert.equal(beforeMode.includes("- fake_tool: fake description"), true, `${mode}: prepended fake tool must be preserved verbatim before mode block`);
      assert.equal(beforeMode.includes("- fake guideline"), true, `${mode}: prepended fake guideline must be preserved verbatim before mode block`);
    }
  });

  it("passes prompt through unchanged when Pi auto-section order is invalid", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const corrupted = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users.",
      "",
      "Pi documentation (out of order):",
      "- doc bullet",
      "",
      "Available tools:",
      "- read: Read file contents",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      "- a guideline",
      "",
      "# Project Context",
      "",
      "Current date: 2026-05-08",
      "Current working directory: /test/cwd",
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: corrupted });
      assert.equal(result, corrupted, `${mode}: invalid section order must pass through unchanged`);
    }
  });

  it("does not treat 'Pi documentation' inside a guideline bullet as the Pi docs header", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    // The Pi guideline body contains the literal substring `Pi documentation`. The parser must
    // anchor to the line-start `\n\nPi documentation (` instead of the substring.
    const baseWithPoisonGuideline = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users.",
      "",
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute bash commands (ls, grep, find, etc.)",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      "- Do not edit Pi documentation unless asked",
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
      "",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /pi/README.md",
      "- Additional docs: /pi/docs",
      "",
      "# Project Context",
      "",
      "Test project content.",
      "",
      "Current date: 2026-05-08",
      "Current working directory: /test/cwd",
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: baseWithPoisonGuideline });

      const tailIdx = result.indexOf("# Project Context");
      const realDocsIdx = result.indexOf("Pi documentation (read only when the user asks about pi itself");
      assert.notEqual(tailIdx, -1, `${mode}: preserved tail must appear`);
      assert.notEqual(realDocsIdx, -1, `${mode}: real Pi docs header must appear`);
      assert.equal(realDocsIdx < tailIdx, true, `${mode}: real Pi docs header must be embedded inside mode prompt content, not left in tail`);
      // Tail must not contain a stray Pi docs header.
      const tailSlice = result.slice(tailIdx);
      assert.equal(tailSlice.includes("Pi documentation (read only"), false, `${mode}: real Pi docs header must not survive in the tail`);
      // The poisoning guideline must remain inside the mode prompt content (it's a Pi guideline).
      const modePromptSlice = result.slice(result.indexOf(PI_IDENTITY_LINE), tailIdx);
      assert.equal(modePromptSlice.includes("- Do not edit Pi documentation unless asked"), true, `${mode}: poisoning guideline must remain in the embedded Guidelines block`);
    }
  });

  it("does not treat 'Available tools:' or 'Guidelines:' substrings inside guideline bodies as auto-section headers", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const baseWithSubstringPoisons = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users.",
      "",
      "Available tools:",
      "- read: Read file contents",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      "- Reference the Available tools: section when in doubt",
      "- See Guidelines: above for Pi-rendered rules",
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
      "",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /pi/README.md",
      "",
      "# Project Context",
      "",
      "Test project content.",
      "",
      "Current date: 2026-05-08",
      "Current working directory: /test/cwd",
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: baseWithSubstringPoisons });

      // Available tools and Guidelines blocks must each appear exactly once (no duplication
      // from substring matches inside the guideline bodies).
      const toolsHeaderCount = result.split(/\nAvailable tools:\n/).length - 1;
      const guidelinesHeaderCount = result.split(/\nGuidelines:\n/).length - 1;
      assert.equal(toolsHeaderCount, 1, `${mode}: Available tools: header line must appear exactly once`);
      assert.equal(guidelinesHeaderCount, 1, `${mode}: Guidelines: header line must appear exactly once`);

      // The poisoning guideline bodies must remain inside the embedded Guidelines block, not be
      // misinterpreted as new section headers.
      const tailIdx = result.indexOf("# Project Context");
      const modePromptSlice = result.slice(result.indexOf(PI_IDENTITY_LINE), tailIdx);
      assert.equal(modePromptSlice.includes("- Reference the Available tools: section when in doubt"), true, `${mode}: substring-poison guideline must remain in Guidelines block`);
      assert.equal(modePromptSlice.includes("- See Guidelines: above for Pi-rendered rules"), true, `${mode}: substring-poison guideline must remain in Guidelines block`);
    }
  });

  it("never includes future tool advertisements from templates (no static tool name lists from mode templates)", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const futureToolNames = [
      "finder",
      "oracle",
      "librarian",
      "handoff",
      "read_session",
      "find_session",
    ];
    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      for (const name of futureToolNames) {
        assert.equal(result.includes(name), false, `${mode}: must not include future tool name ${name}`);
      }
    }
  });
});
