# pi-mmr public API surface tiers

**Audience.** Maintainers and embedders deciding how stable a given
package-root export from `pi-mmr` is.

**Scope.** The export tiers used by the root barrel (`src/index.ts`).
This document classifies *stability*; the symbol-by-symbol API reference
lives in [`public-api.md`](./public-api.md) (non-core extensions) and
[`mmr-core-api.md`](./mmr-core-api.md) (`mmr-core`). Keep this table in
sync with the tier doc block and the section banner comments at the top
of `src/index.ts`.

**Related.** Documentation conventions:
[`documentation-style-guide.md`](./documentation-style-guide.md).

## Tiers

| Tier | Stability promise | Removal/rename process |
| --- | --- | --- |
| **Stable** | Supported public API. Safe to depend on. | Breaking change: semver-major bump plus a `CHANGELOG.md` migration note. |
| **Internal / prompt-assembly** | Exported for cross-extension wiring and advanced embedders. Not part of the stability promise; may change without a major bump. | May change between minor versions; prefer the documented stable APIs. |
| **Test seam** | Exported (or, in a few cases, deliberately *not* re-exported from the barrel) only for the repo's own tests. | Not a public contract; do not depend on externally. |

## Compatibility rule

No export is pruned abruptly. Any future removal or relocation of a
package-root export must ship a staged compatibility plan:

1. A `CHANGELOG.md` deprecation note describing the migration.
2. A transition window where both the old and new surface resolve.
3. For type-only members, a `@deprecated` JSDoc tag before removal.

Annotation comes first; pruning is a deliberate, staged follow-up.

## What lives in each tier

### Stable

- Mode keys and definitions: `DEFAULT_MMR_MODE`, `MMR_MODE_KEYS`,
  `MMR_MODES`, `getMmrMode`, `isMmrModeKey`, and the mode-related public
  types.
- Model resolver and routing: `selectMmrModelRoute`,
  `resolveAndApplyMmrModel`, `resolveMmrModeSelection`, and the runtime
  resolver/state accessors re-exported from `mmr-core/runtime`.
- Feature gates and settings loaders: `createMmrFeatureGateRegistry`,
  `loadMmrCoreSettings`, `loadMmrWebSettings`, `loadMmrGithubSettings`,
  `loadMmrHistorySettings`.
- Extension factories: every `createMmr*Extension` factory.
- Public tool register/create functions: the `register*`/`create*`
  functions for the `oracle`, `finder`, `librarian`, `history-reader`,
  and `Task`/async-task tools, plus the toolbox and history tool
  registrars.
- The exported public type surface for the above.

### Internal / prompt-assembly

- Prompt-layer markers and builders: `MMR_PROMPT_LAYER_START`,
  `MMR_PROMPT_LAYER_END`, `buildMmrPromptLayer`, and the prompt-assembly
  helpers (`assembleActiveSurface`, `assembleMmrSubagentSurface`, the
  builtin-tool-guidance helpers).
- Planned-tool catalog: `MMR_PLANNED_TOOL_CATALOG`.
- Debug-fixture renderers: `renderMmrPromptDebugFixture`,
  `stringifyMmrToolSchema`.
- Legacy convenience constants such as `ORACLE_DEFAULT_MODEL_PREFERENCES`
  — a frozen, profile-derived list retained for compatibility that has
  no internal runtime consumer.

### Test seam

- Symbols exported only for the repo's own tests, and the deliberate
  non-re-exports the barrel documents inline (for example
  `clearMmrSubagentPromptBuilders`, which is reached through its owning
  module rather than the barrel, and the worker outcome discriminator
  type that is intentionally not re-exported to keep the
  `tests/mmr-pi-root-todo-exports.test.mjs` negative guard valid).
