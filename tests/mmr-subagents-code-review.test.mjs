// Unit tests for the `mmr-workers` code_review tool — written test-first to
// pin observable behavior before implementing
// src/extensions/mmr-workers/code-review.ts.
//
// Behavior pinned here (the subprocess runner and the provider/extension
// wiring have their own suites):
//
//   1. The tool definition advertises name `code_review`, a snippet, a
//      schema-only full description, and a
//      `{ diff_description, files?, instructions? }` params shape plus the
//      shared background run fields.
//   2. The description states the diff-description contract (the worker
//      generates the diff itself), blocking-by-default + background: true,
//      and never references the deprecated start_task alias.
//   3. Guidelines stay a single routing line naming code_review.
//   4. The `code-review` subagent profile is standalone, read-only by
//      contract (read/grep/find/bash, no MCP/toolbox), backgroundable, and
//      uses GPT-5.5 at medium effort.
//   5. The worker system prompt pins the review method: merge-base
//      origin/HEAD reference commands, read-only guardrails, low
//      persistence, the oversized-diff abort, severity/type taxonomy, and
//      new-side line-number rules.
//   6. buildCodeReviewUserPrompt folds files focus and extra instructions
//      into the worker task text.
//   7. execute() rejects invalid params before spawning, resolves the
//      profile route from ctx.modelRegistry, runs through the injected
//      runner once with the assembled system prompt, and returns the
//      worker's final output verbatim with worker metadata in details.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

initTheme(undefined, false);

after(cleanupLoadedSource);

const CODE_REVIEW_MODULE = "extensions/mmr-workers/code-review.ts";
const PROMPTS_MODULE = "extensions/mmr-workers/prompts.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";
const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";
const GUIDANCE_MODULE = "extensions/mmr-core/worker-tool-guidance.ts";
const BACKGROUND_AGENTS_MODULE = "extensions/mmr-workers/background-agents.ts";

beforeEach(async () => {
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  const { registerMmrSubagentsPromptBuilders } = await importSource(PROMPTS_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrSubagentsPromptBuilders();
});

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "Summary: looks good.\n\nFindings:\n- src/foo.ts:10-12 — severity: low; type: compliment",
    truncatedFinalOutput: "Summary: looks good.\n\nFindings:\n- src/foo.ts:10-12 — severity: low; type: compliment",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    model: "gpt-5.5",
    stopReason: "end_turn",
    errorMessage: undefined,
    prompt: "Review the following diff: all uncommitted changes",
    cwd: "/tmp/project",
    command: "pi",
    args: ["--mode", "json", "-p", "--no-session"],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    ...overrides,
  };
}

function makeRunnerSpy(result = makeWorkerResult()) {
  const calls = [];
  const runWorker = async (options) => {
    calls.push(options);
    return result;
  };
  return { runWorker, calls };
}

function makeRegistry(models) {
  return {
    getAll: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    isUsingOAuth: (model) => model.provider.endsWith("subscription") || model.provider.endsWith("codex"),
    getAvailable: () => models,
  };
}

describe("code_review tool definition", () => {
  it("declares name, snippet, description, and the diff_description-led parameter schema", async () => {
    const {
      createCodeReviewTool,
      CODE_REVIEW_TOOL_NAME,
      CODE_REVIEW_PROMPT_SNIPPET,
      CODE_REVIEW_DESCRIPTION,
    } = await importSource(CODE_REVIEW_MODULE);
    assert.equal(CODE_REVIEW_TOOL_NAME, "code_review");
    const tool = createCodeReviewTool();
    assert.equal(tool.name, "code_review");
    assert.equal(tool.promptSnippet, CODE_REVIEW_PROMPT_SNIPPET);
    assert.equal(tool.description, CODE_REVIEW_DESCRIPTION);
    const params = tool.parameters;
    assert.equal(params.type, "object");
    assert.deepEqual(params.required, ["diff_description"]);
    assert.equal(params.properties.diff_description.type, "string");
    assert.equal(params.properties.files.type, "array");
    assert.equal(params.properties.instructions.type, "string");
    // Shared v2 background-run fields are part of the public schema.
    assert.equal(params.properties.background.type, "boolean");
    assert.equal(params.properties.group.type, "string");
    assert.equal(params.properties.notify.type, "boolean");
  });

  it("description states the diff-description contract and the blocking/background split without start_task", async () => {
    const { createCodeReviewTool } = await importSource(CODE_REVIEW_MODULE);
    const tool = createCodeReviewTool();
    assert.match(tool.description, /Review code changes/i);
    assert.match(tool.description, /description of the diff/i);
    assert.match(tool.description, /do not.*generate the diff/i);
    assert.match(tool.description, /blocking by default/i);
    assert.match(tool.description, /background: true/);
    assert.match(tool.description, /WHEN TO USE THIS TOOL/);
    assert.match(tool.description, /WHEN NOT TO USE THIS TOOL/);
    assert.match(tool.description, /read-only/i);
    assert.doesNotMatch(tool.description, /start_task/);
  });

  it("keeps guidelines to a single routing line that names code_review", async () => {
    const { CODE_REVIEW_PROMPT_GUIDELINES, createCodeReviewTool } = await importSource(CODE_REVIEW_MODULE);
    assert.equal(CODE_REVIEW_PROMPT_GUIDELINES.length, 1);
    assert.match(CODE_REVIEW_PROMPT_GUIDELINES[0], /code_review/);
    assert.doesNotMatch(CODE_REVIEW_PROMPT_GUIDELINES[0], /start_task/);
    assert.doesNotMatch(CODE_REVIEW_PROMPT_GUIDELINES[0], /blocking/i);
    const tool = createCodeReviewTool();
    assert.deepEqual([...tool.promptGuidelines], [...CODE_REVIEW_PROMPT_GUIDELINES]);
  });
});

describe("code-review subagent profile", () => {
  it("is standalone, read-only by contract, backgroundable, and uses GPT-5.5 medium", async () => {
    const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
    const profile = getMmrSubagentProfile("code-review");
    assert.ok(profile, "mmr-core must expose a code-review subagent profile");
    assert.equal(profile.promptRoute, "standalone");
    assert.equal(profile.promptBuilder, "code-review");
    assert.deepEqual([...profile.tools], ["read", "grep", "find", "bash"]);
    assert.equal(profile.allowMcp, false);
    assert.equal(profile.allowToolbox, false);
    assert.notEqual(profile.backgroundable, false, "code-review must be backgroundable");
    assert.equal(profile.thinkingLevel, "medium");
    assert.deepEqual([...profile.modelPreferences], [
      { model: "gpt-5.5", thinkingLevel: "medium" },
    ]);
  });

  it("derives CODE_REVIEW_WORKER_TOOLS from the profile", async () => {
    const { CODE_REVIEW_WORKER_TOOLS } = await importSource(CODE_REVIEW_MODULE);
    assert.deepEqual([...CODE_REVIEW_WORKER_TOOLS], ["read", "grep", "find", "bash"]);
  });
});

describe("code-review worker system prompt", () => {
  it("pins the review method, git command policy, guardrails, and report format", async () => {
    const { buildCodeReviewWorkerSystemPrompt } = await importSource(CODE_REVIEW_MODULE);
    const prompt = buildCodeReviewWorkerSystemPrompt("/abs/project");
    assert.match(prompt, /expert senior engineer/i);
    assert.match(prompt, /Working directory: \/abs\/project/);
    // Review method.
    assert.match(prompt, /high-level summary/i);
    assert.match(prompt, /file-by-file/i);
    assert.match(prompt, /bugs, hackiness, unnecessary code/i);
    assert.match(prompt, /shared mutable state/i);
    assert.match(prompt, /abstraction fit in both directions/i);
    assert.match(prompt, /avoid speculative refactors/i);
    // Git command policy: merge-base only, origin/HEAD as the upstream ref.
    assert.match(prompt, /git diff --merge-base origin\/HEAD HEAD/);
    assert.match(prompt, /git diff --cached --merge-base origin\/HEAD/);
    assert.match(prompt, /git ls-files --others --exclude-standard/);
    assert.match(prompt, /git diff --name-only --merge-base origin\/HEAD HEAD/);
    assert.match(prompt, /Avoid commands/i);
    assert.match(prompt, /git diff <base-ref> <head-ref>/);
    assert.match(prompt, /git diff <base-ref>\.\.<head-ref>/);
    assert.match(prompt, /Do not assume main, origin\/main, or origin\/master/);
    // Guardrails.
    assert.match(prompt, /more than 2 times/i);
    assert.match(prompt, /untracked/i);
    assert.match(prompt, /Do not edit or modify files/i);
    assert.match(prompt, /Do not re-read files/i);
    assert.match(prompt, /more than 100 changed files or is more than 10,000 lines/);
    assert.match(prompt, /single critical finding/i);
    // Report format: taxonomy + line-number rules + final-message contract.
    assert.match(prompt, /critical/);
    assert.match(prompt, /high/);
    assert.match(prompt, /medium/);
    assert.match(prompt, /low/);
    assert.match(prompt, /bug, suggested_edit, compliment, non_actionable/);
    assert.match(prompt, /NEW version/);
    assert.match(prompt, /ADDED files/);
    assert.match(prompt, /DELETED files/);
    assert.match(prompt, /only message returned to the parent agent/i);
  });

  it("falls back to a safe placeholder when cwd is missing", async () => {
    const { buildCodeReviewWorkerSystemPrompt } = await importSource(CODE_REVIEW_MODULE);
    const prompt = buildCodeReviewWorkerSystemPrompt("");
    assert.doesNotMatch(prompt, /Working directory: \n/);
    assert.match(prompt, /Working directory:\s+\S/);
  });
});

describe("code-review worker user prompt", () => {
  it("folds the diff description, files focus, and extra instructions into the task text", async () => {
    const { buildCodeReviewUserPrompt } = await importSource(CODE_REVIEW_MODULE);
    assert.equal(
      buildCodeReviewUserPrompt({ diff_description: "all uncommitted changes" }),
      "Review the following diff: all uncommitted changes",
    );
    const withFocus = buildCodeReviewUserPrompt({
      diff_description: "branch changes since origin/HEAD",
      files: ["src/a.ts", "src/b.ts"],
      instructions: "Focus on concurrency.",
    });
    assert.match(withFocus, /^Review the following diff: branch changes since origin\/HEAD/);
    assert.match(withFocus, /Focus the review on these files:/);
    assert.match(withFocus, /- src\/a\.ts/);
    assert.match(withFocus, /- src\/b\.ts/);
    assert.match(withFocus, /Focus on concurrency\./);
  });

  it("ignores empty files arrays and blank instructions", async () => {
    const { buildCodeReviewUserPrompt } = await importSource(CODE_REVIEW_MODULE);
    const prompt = buildCodeReviewUserPrompt({
      diff_description: "staged changes",
      files: [],
      instructions: "   ",
    });
    assert.equal(prompt, "Review the following diff: staged changes");
  });
});

describe("code_review execute() seam", () => {
  it("rejects missing, blank, or extra parameters before spawning a worker", async () => {
    const { createCodeReviewTool } = await importSource(CODE_REVIEW_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createCodeReviewTool({ runWorker });
    await assert.rejects(tool.execute("c1", undefined, undefined, undefined, { cwd: "/tmp" }), /diff_description/i);
    await assert.rejects(tool.execute("c2", { diff_description: "" }, undefined, undefined, { cwd: "/tmp" }), /diff_description/i);
    await assert.rejects(tool.execute("c3", { diff_description: "   " }, undefined, undefined, { cwd: "/tmp" }), /diff_description/i);
    await assert.rejects(
      tool.execute("c4", { diff_description: "all changes", extra: true }, undefined, undefined, { cwd: "/tmp" }),
      /additional properties/i,
    );
    assert.equal(calls.length, 0, "runner must not be invoked when params are invalid");
  });

  it("calls the injected runner with the assembled prompt, profile, and the GPT-5.5 route", async () => {
    const { createCodeReviewTool, CODE_REVIEW_WORKER_TOOLS } = await importSource(CODE_REVIEW_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createCodeReviewTool({
      runWorker,
      buildSystemPrompt: (cwd) => `SP for ${cwd}`,
    });
    const result = await tool.execute(
      "call-1",
      { diff_description: "all uncommitted changes" },
      undefined,
      undefined,
      {
        cwd: "/abs/project",
        modelRegistry: makeRegistry([{ provider: "openai-codex", id: "gpt-5.5" }]),
      },
    );
    assert.equal(calls.length, 1);
    const options = calls[0];
    assert.equal(options.prompt, "Review the following diff: all uncommitted changes");
    assert.equal(options.cwd, "/abs/project");
    // Degrade-mode worker: the child resolves its own tool set; the parent
    // does not mirror --tools (same contract as finder).
    assert.equal(options.tools, undefined);
    assert.equal(options.systemPrompt, "SP for /abs/project");
    assert.equal(options.model, "openai-codex/gpt-5.5");
    assert.equal(options.profileName, "code-review");
    assert.equal(result.details.cwd, "/abs/project");
    assert.deepEqual([...result.details.workerTools], [...CODE_REVIEW_WORKER_TOOLS]);
  });

  it("returns the worker's final output verbatim as visible content", async () => {
    const { createCodeReviewTool } = await importSource(CODE_REVIEW_MODULE);
    const { runWorker } = makeRunnerSpy();
    const tool = createCodeReviewTool({ runWorker });
    const result = await tool.execute(
      "call-1",
      { diff_description: "all uncommitted changes" },
      undefined,
      undefined,
      { cwd: "/abs/project" },
    );
    assert.match(result.content[0].text, /Summary: looks good\./);
    assert.match(result.content[0].text, /severity: low/);
  });

  it("surfaces a clear error when the worker exits nonzero without output", async () => {
    const { createCodeReviewTool } = await importSource(CODE_REVIEW_MODULE);
    const { runWorker } = makeRunnerSpy(
      makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", exitCode: 1, stderr: "boom" }),
    );
    const tool = createCodeReviewTool({ runWorker });
    const result = await tool.execute(
      "call-1",
      { diff_description: "all uncommitted changes" },
      undefined,
      undefined,
      { cwd: "/abs/project" },
    );
    assert.match(result.content[0].text, /code_review.*exited with code 1/i);
  });
});

describe("code_review cross-worker wiring", () => {
  it("participates in the Using workers block as a background-capable delegation tool", async () => {
    const { buildUsingWorkersGuidance, CODE_REVIEW_BACKGROUND_GUIDANCE } = await importSource(GUIDANCE_MODULE);
    assert.match(CODE_REVIEW_BACKGROUND_GUIDANCE, /code_review is blocking by default/);
    assert.match(CODE_REVIEW_BACKGROUND_GUIDANCE, /background: true/);
    const block = buildUsingWorkersGuidance(["code_review"]);
    assert.ok(block, "code_review alone must render the Using workers block");
    assert.match(block, /## Using workers/);
    assert.match(block, /Do not start a worker/);
    assert.match(block, /background: true/);
  });

  it("is registered as a background agent keyed to diff_description", async () => {
    const { listMmrBackgroundAgents } = await importSource(BACKGROUND_AGENTS_MODULE);
    const descriptor = listMmrBackgroundAgents().find((d) => d.agent === "code_review");
    assert.ok(descriptor, "code_review must be a registered background agent");
    assert.equal(descriptor.profileName, "code-review");
    assert.equal(descriptor.promptParamKey, "diff_description");
  });
});
