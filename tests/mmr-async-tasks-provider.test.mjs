import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-async-tasks provider", () => {
  it("identifies itself as mmr-async-tasks", async () => {
    const { createMmrAsyncTasksToolProvider, MMR_ASYNC_TASKS_PROVIDER_NAME } = await importSource(
      "extensions/mmr-async-tasks/provider.ts",
    );
    const provider = createMmrAsyncTasksToolProvider();
    assert.equal(provider.name, "mmr-async-tasks");
    assert.equal(provider.name, MMR_ASYNC_TASKS_PROVIDER_NAME);
  });

  it("gates and activates the async background task tools behind mmr-async-tasks", async () => {
    const {
      createMmrAsyncTasksFeatureGateProvider,
      createMmrAsyncTasksToolProvider,
      MMR_ASYNC_TASKS_FEATURE_GATE,
      MMR_ASYNC_TASK_TOOLS,
    } = await importSource("extensions/mmr-async-tasks/provider.ts");

    const inactive = createMmrAsyncTasksToolProvider();
    for (const logical of MMR_ASYNC_TASK_TOOLS) {
      const rule = inactive.resolve(logical);
      assert.equal(rule.kind, "gated");
      assert.equal(rule.gate, MMR_ASYNC_TASKS_FEATURE_GATE);
    }
    assert.equal(inactive.resolve("finder"), undefined);

    const active = createMmrAsyncTasksToolProvider({ asyncTasks: true });
    for (const logical of MMR_ASYNC_TASK_TOOLS) {
      assert.deepEqual(active.resolve(logical), { kind: "active" }, `${logical} must resolve active when enabled`);
    }

    const gate = createMmrAsyncTasksFeatureGateProvider({ asyncTasks: true });
    const enabled = gate.evaluate(MMR_ASYNC_TASKS_FEATURE_GATE);
    assert.equal(enabled.status, "enabled");
    const disabled = createMmrAsyncTasksFeatureGateProvider().evaluate(MMR_ASYNC_TASKS_FEATURE_GATE);
    assert.equal(disabled.status, "disabled");
  });

  it("retains the deprecated mmr-subagents.async-tasks gate as compatibility", async () => {
    const {
      createMmrAsyncTasksFeatureGateProvider,
      MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
      MMR_SUBAGENTS_ASYNC_TASK_TOOLS,
      MMR_ASYNC_TASK_TOOLS,
    } = await importSource("extensions/mmr-async-tasks/provider.ts");
    assert.deepEqual([...MMR_SUBAGENTS_ASYNC_TASK_TOOLS], [...MMR_ASYNC_TASK_TOOLS]);
    const decision = createMmrAsyncTasksFeatureGateProvider({ asyncTasks: true }).evaluate(MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE);
    assert.equal(decision.status, "enabled");
  });
});
