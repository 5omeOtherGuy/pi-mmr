import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-subagents/child-extension-scope.ts";

const EXT_DIR = "/pkg/src/extensions";
const LOCATION = { extensionsDir: EXT_DIR, moduleExt: ".ts" };
const piMmr = (name) => path.join(EXT_DIR, name, "index.ts");
const EXTERNAL_A = "/home/u/.pi/agent/git/host/owner/minimalcc-pi/extensions/minimalcc-pi/index.ts";
const EXTERNAL_B = "/home/u/.pi/agent/git/host/owner/gemini-pi/extensions/gemini-pi/index.ts";

/** fileExists stub: every pi-mmr index + the two external entries exist. */
function defaultExists(candidate) {
  if (candidate === EXTERNAL_A || candidate === EXTERNAL_B) return true;
  return candidate.startsWith(EXT_DIR) && candidate.endsWith("index.ts");
}

describe("mmr-subagents child-extension-scope: keep map", () => {
  it("declares the four built-in spawned profiles with mmr-core always present", async () => {
    const mod = await importSource(MODULE);
    const map = mod.MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS;
    assert.deepEqual([...map.finder], ["mmr-core"]);
    assert.deepEqual([...map.oracle], ["mmr-core", "mmr-web", "mmr-history", "mmr-subagents"]);
    assert.deepEqual([...map.librarian], ["mmr-core", "mmr-github"]);
    assert.deepEqual([...map["task-subagent"]], ["mmr-core", "mmr-web", "mmr-subagents", "mmr-tasks"]);
    for (const names of Object.values(map)) {
      assert.ok([...names].includes("mmr-core"), "every profile keeps mmr-core");
    }
  });
});

describe("mmr-subagents child-extension-scope: enumeration", () => {
  it("collects tool + command source paths, drops builtins and .md, dedupes", async () => {
    const mod = await importSource(MODULE);
    const host = {
      getAllTools: () => [
        { name: "read", sourceInfo: { path: "<builtin:read>" } },
        { name: "web_search", sourceInfo: { path: piMmr("mmr-web") } },
        { name: "finder", sourceInfo: { path: piMmr("mmr-subagents") } },
        { name: "dup", sourceInfo: { path: piMmr("mmr-web") } },
      ],
      getCommands: () => [
        { name: "claude-subscription-usage", sourceInfo: { path: EXTERNAL_A } },
        { name: "mmr-config", sourceInfo: { path: piMmr("mmr-core") } },
        { name: "skill", sourceInfo: { path: "/home/u/.pi/agent/skills/x/SKILL.md" } },
      ],
    };
    const paths = mod.enumerateLoadedExtensionPaths(host);
    assert.deepEqual(paths, [piMmr("mmr-web"), piMmr("mmr-subagents"), EXTERNAL_A, piMmr("mmr-core")]);
  });

  it("returns [] for an absent host or throwing probes", async () => {
    const mod = await importSource(MODULE);
    assert.deepEqual(mod.enumerateLoadedExtensionPaths(undefined), []);
    assert.deepEqual(
      mod.enumerateLoadedExtensionPaths({
        getAllTools: () => {
          throw new Error("boom");
        },
        getCommands: () => {
          throw new Error("boom");
        },
      }),
      [],
    );
  });
});

describe("mmr-subagents child-extension-scope: resolver", () => {
  it("finder keeps only mmr-core plus all external packages, drops other pi-mmr ext", async () => {
    const mod = await importSource(MODULE);
    const loadedPaths = [
      piMmr("mmr-core"),
      piMmr("mmr-web"),
      piMmr("mmr-history"),
      piMmr("mmr-github"),
      piMmr("mmr-subagents"),
      piMmr("mmr-tasks"),
      EXTERNAL_A,
      EXTERNAL_B,
    ];
    const scope = mod.resolveMmrChildExtensionScope({
      profileName: "finder",
      loadedPaths,
      location: LOCATION,
      fileExists: defaultExists,
    });
    assert.deepEqual(scope, [piMmr("mmr-core"), EXTERNAL_A, EXTERNAL_B]);
  });

  it("oracle keeps mmr-core/web/history/subagents + externals, drops github/tasks", async () => {
    const mod = await importSource(MODULE);
    const loadedPaths = [
      piMmr("mmr-web"),
      piMmr("mmr-core"),
      piMmr("mmr-history"),
      piMmr("mmr-github"),
      piMmr("mmr-subagents"),
      piMmr("mmr-tasks"),
      EXTERNAL_A,
    ];
    const scope = mod.resolveMmrChildExtensionScope({
      profileName: "oracle",
      loadedPaths,
      location: LOCATION,
      fileExists: defaultExists,
    });
    // pi-mmr keep paths first in declared order, then externals first-seen.
    assert.deepEqual(scope, [
      piMmr("mmr-core"),
      piMmr("mmr-web"),
      piMmr("mmr-history"),
      piMmr("mmr-subagents"),
      EXTERNAL_A,
    ]);
  });

  it("keeps unknown third-party extensions verbatim (only drops recognized pi-mmr)", async () => {
    const mod = await importSource(MODULE);
    const thirdParty = "/opt/other-pkg/ext/index.ts";
    const scope = mod.resolveMmrChildExtensionScope({
      profileName: "finder",
      loadedPaths: [piMmr("mmr-core"), piMmr("mmr-web"), thirdParty],
      location: LOCATION,
      fileExists: (c) => c === thirdParty || defaultExists(c),
    });
    assert.deepEqual(scope, [piMmr("mmr-core"), thirdParty]);
  });

  it("returns undefined for unknown/custom profiles", async () => {
    const mod = await importSource(MODULE);
    assert.equal(
      mod.resolveMmrChildExtensionScope({
        profileName: "sa__custom",
        loadedPaths: [piMmr("mmr-core")],
        location: LOCATION,
        fileExists: defaultExists,
      }),
      undefined,
    );
  });

  it("returns undefined when debug capture is active", async () => {
    const mod = await importSource(MODULE);
    assert.equal(
      mod.resolveMmrChildExtensionScope({
        profileName: "finder",
        loadedPaths: [piMmr("mmr-core"), EXTERNAL_A],
        location: LOCATION,
        fileExists: defaultExists,
        debugCaptureActive: true,
      }),
      undefined,
    );
  });

  it("returns undefined when a required keep extension entry cannot be resolved on disk", async () => {
    const mod = await importSource(MODULE);
    // oracle needs mmr-history, but pretend its index file is missing.
    const scope = mod.resolveMmrChildExtensionScope({
      profileName: "oracle",
      loadedPaths: [piMmr("mmr-core"), piMmr("mmr-web"), piMmr("mmr-subagents"), EXTERNAL_A],
      location: LOCATION,
      fileExists: (c) => c !== piMmr("mmr-history") && defaultExists(c),
    });
    assert.equal(scope, undefined);
  });
});

describe("mmr-subagents child-extension-scope: compute (host-driven)", () => {
  it("enumerates the host then resolves the keep set", async () => {
    const mod = await importSource(MODULE);
    const host = {
      getAllTools: () => [
        { name: "web_search", sourceInfo: { path: piMmr("mmr-web") } },
        { name: "find", sourceInfo: { path: "<builtin:find>" } },
      ],
      getCommands: () => [
        { name: "mmr-config", sourceInfo: { path: piMmr("mmr-core") } },
        { name: "antigravity-status", sourceInfo: { path: EXTERNAL_B } },
      ],
    };
    const scope = mod.computeMmrChildExtensionScope({
      profileName: "finder",
      host,
      location: LOCATION,
      fileExists: defaultExists,
      debugCaptureActive: false,
    });
    assert.deepEqual(scope, [piMmr("mmr-core"), EXTERNAL_B]);
  });

  it("returns undefined (full discovery) when the host enumerates nothing", async () => {
    const mod = await importSource(MODULE);
    assert.equal(
      mod.computeMmrChildExtensionScope({ profileName: "finder", host: undefined, location: LOCATION }),
      undefined,
    );
  });

  it("returns undefined for an unknown profile without touching the host", async () => {
    const mod = await importSource(MODULE);
    let probed = false;
    const host = {
      getAllTools: () => {
        probed = true;
        return [];
      },
    };
    assert.equal(
      mod.computeMmrChildExtensionScope({ profileName: "history-reader", host, location: LOCATION }),
      undefined,
    );
    assert.equal(probed, false);
  });
});

describe("mmr-subagents child-extension-scope: debug-capture detection", () => {
  it("treats a non-empty MMR_DEBUG_CAPTURE_FILE as active", async () => {
    const mod = await importSource(MODULE);
    assert.equal(mod.isMmrDebugCaptureActive({ MMR_DEBUG_CAPTURE_FILE: "/tmp/cap.jsonl" }), true);
    assert.equal(mod.isMmrDebugCaptureActive({ MMR_DEBUG_CAPTURE_FILE: "   " }), false);
    assert.equal(mod.isMmrDebugCaptureActive({}), false);
  });
});
