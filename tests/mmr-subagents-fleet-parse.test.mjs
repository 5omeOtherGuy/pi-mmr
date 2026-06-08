import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const FORMAT_MODULE = "extensions/mmr-subagents/async-task-tool-format.ts";
const SCHEMA_MODULE = "extensions/mmr-subagents/async-task-tool-schemas.ts";

after(cleanupLoadedSource);

const validFleet = () => ({
  fleet: {
    groups: [
      {
        group_label: "API surface review",
        members: [
          { agent: "finder", params: { query: "find routes" }, description: "Find routes" },
          { agent: "Task", params: { prompt: "inspect handlers", description: "Inspect" } },
        ],
      },
      {
        members: [{ agent: "librarian", params: { query: "compare repos" } }],
      },
    ],
  },
});

describe("parseFleet", () => {
  it("normalizes a valid multi-group fleet", async () => {
    const { parseFleet } = await importSource(FORMAT_MODULE);
    const parsed = parseFleet(validFleet());
    assert.ok(!("error" in parsed), `unexpected error: ${parsed.error}`);
    assert.equal(parsed.groups.length, 2);
    assert.equal(parsed.totalMembers, 3);
    assert.equal(parsed.groups[0].label, "API surface review");
    assert.equal(parsed.groups[0].members[0].agent, "finder");
    assert.equal(parsed.groups[1].members[0].agent, "librarian");
    assert.equal(parsed.wantsNotify, true);
  });

  it("normalizes a finder member's prompt shortcut into a query", async () => {
    const { parseFleet } = await importSource(FORMAT_MODULE);
    const parsed = parseFleet({
      fleet: { groups: [{ members: [{ agent: "finder", prompt: "where is auth" }] }] },
    });
    assert.ok(!("error" in parsed));
    assert.deepEqual(parsed.groups[0].members[0].params, { query: "where is auth" });
  });

  it("rejects an empty groups array", async () => {
    const { parseFleet } = await importSource(FORMAT_MODULE);
    const parsed = parseFleet({ fleet: { groups: [] } });
    assert.ok("error" in parsed);
  });

  it("rejects a group with no members", async () => {
    const { parseFleet } = await importSource(FORMAT_MODULE);
    const parsed = parseFleet({ fleet: { groups: [{ members: [] }] } });
    assert.ok("error" in parsed);
  });

  it("rejects mixing fleet with single-task fields", async () => {
    const { parseFleet } = await importSource(FORMAT_MODULE);
    for (const extra of [{ agent: "finder" }, { params: { query: "x" } }, { prompt: "x" }, { group_id: "new" }]) {
      const parsed = parseFleet({ ...validFleet(), ...extra });
      assert.ok("error" in parsed, `should reject fleet + ${JSON.stringify(extra)}`);
    }
  });

  it("rejects a member with an unknown agent", async () => {
    const { parseFleet } = await importSource(FORMAT_MODULE);
    const parsed = parseFleet({ fleet: { groups: [{ members: [{ agent: "oracle", params: { prompt: "x" } }] }] } });
    assert.ok("error" in parsed);
  });
});

describe("START_TASK_PARAMETERS fleet schema", () => {
  it("accepts a structurally valid fleet", async () => {
    const { START_TASK_PARAMETERS, validateAsyncToolParams } = await importSource(SCHEMA_MODULE);
    const r = validateAsyncToolParams("start_task", START_TASK_PARAMETERS, validFleet());
    assert.equal(r.ok, true, r.ok ? "" : r.message);
  });

  it("rejects a group_id placed inside a fleet member (additionalProperties)", async () => {
    const { START_TASK_PARAMETERS, validateAsyncToolParams } = await importSource(SCHEMA_MODULE);
    const r = validateAsyncToolParams("start_task", START_TASK_PARAMETERS, {
      fleet: { groups: [{ members: [{ agent: "finder", params: { query: "x" }, group_id: "new" }] }] },
    });
    assert.equal(r.ok, false);
  });

  it("still accepts the legacy single-task shape", async () => {
    const { START_TASK_PARAMETERS, validateAsyncToolParams } = await importSource(SCHEMA_MODULE);
    const r = validateAsyncToolParams("start_task", START_TASK_PARAMETERS, {
      agent: "finder",
      params: { query: "x" },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.message);
  });
});

describe("fleet-aware model-visible guidance", () => {
  it("routes fan-out to fleet and forbids narration + restating the settled card", async () => {
    const { START_TASK_GROUP_FANOUT_GUIDANCE } = await importSource("extensions/mmr-subagents/tool-guidance.ts");
    assert.match(START_TASK_GROUP_FANOUT_GUIDANCE, /fleet\.groups\[\]/);
    assert.match(START_TASK_GROUP_FANOUT_GUIDANCE, /do not narrate/i);
    assert.match(START_TASK_GROUP_FANOUT_GUIDANCE, /do not re-emit the card/i);
    // The impossible "single step" mint-then-reuse promise is gone.
    assert.doesNotMatch(START_TASK_GROUP_FANOUT_GUIDANCE, /single step/i);
  });

  it("frames group_id as the legacy incremental path that defers to fleet", async () => {
    const { START_TASK_PARAMETERS } = await importSource(SCHEMA_MODULE);
    const desc = START_TASK_PARAMETERS.properties.group_id.description;
    assert.match(desc, /legacy/i);
    assert.match(desc, /start_task\.fleet/);
  });
});
