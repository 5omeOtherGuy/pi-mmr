// Shared helpers for the mmr-patch apply_patch test suites.
//
// The Pi-host mock used to live here as `makeMockPi`. It has been removed in
// favor of the canonical `createMockPi` exported by `./pi-stub.mjs`, which
// models the full Pi extension surface (tools, flags, shortcuts, commands,
// events). The two helpers below are not Pi mocks; they support the
// apply-patch suites' minimal `ExtensionContext` shape and the patch-text
// builder used by every apply-patch fixture.

export function makeCtx(cwd) {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getEntries: () => [], getBranch: () => [] },
    ui: { notify() {} },
  };
}

/**
 * Helper for assembling Codex-format patch text. Joins with `\n` and adds a
 * trailing newline so the parser does not need to special-case the EOF.
 */
export function patch(...lines) {
  return lines.join("\n") + "\n";
}
