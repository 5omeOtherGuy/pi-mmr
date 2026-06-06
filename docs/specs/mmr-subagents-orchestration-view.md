# mmr-subagents: grouped orchestration view

Restyle of the below-editor background-task widget into a **grouped orchestration
view**, derived from the reference screenshot but expressed in our existing
design language. This is a **rendering-layer change**: the registry already
exposes every field we need.

## Decisions (locked)

| Area | Decision |
| --- | --- |
| Scope | Restyle **+ grouped sections**. No synthesis/summary block (deferred). |
| Finished rows | **Persist briefly in-group, then drop** (retention window). |
| Status markers | **Keep** `⠋`(braille spinner) / `✓` / `✕` / `–`. No `.:`/`\|`/`[done]`. |
| Profile labels | **Keep raw keys** (`read-only` / `read-write`) as a row chip. |

Out of scope (explicitly deferred): the orchestrator "synthesis" lead+bullets
block, the `.:`/`|` marker language, and the full-panel prompt-echo/input-bar
chrome from the screenshot. Those would be a separate feature on top of this.

## What already exists (no change needed)

`MmrAsyncTaskBoardEntry` (async-task-registry.ts:266) already carries every
field the new view reads:

- `capabilityProfile?: string` — the chip (`read-only` / `read-write`)
- `groupId?: string` — the section key
- `completedAtMs?`, `terminalOutcome?`, `status`, `freshness`, `runtimeMs`,
  `usage`, `resolvedModel`, `latestToolName`, `latestToolStatus`
- `MmrAsyncTaskBoard.finished[]` (async-task-registry.ts:297) — the settled lane
  the widget **currently ignores** (`boardRows()` only reads `active`+`stalled`).
- `MmrAsyncTaskGroupSnapshot` (async-task-registry.ts:302) — `status` + `counts`
  for the section header.

So the registry/runner/tools layers are untouched. All work lands in
`background-task-widget.ts` (+ one small read of group snapshots).

## Component layout

All additions are in `src/extensions/mmr-subagents/background-task-widget.ts`.
The widget stays a pure UI mirror of the registry board (owns no state).

### 1. Section model (new internal type)

```ts
/** One group's worth of rows, plus the header snapshot that labels it. */
interface WidgetSection {
  /** undefined => the synthetic "ungrouped" bucket (rendered headerless). */
  groupId: string | undefined;
  /** Group status + counts for the header. undefined for the ungrouped bucket. */
  group?: Pick<MmrAsyncTaskGroupSnapshot, "status" | "counts">;
  rows: WidgetRow[]; // active, then stalled, then briefly-retained finished
}
```

### 2. Board → sections (replaces `boardRows`)

```ts
const WIDGET_FINISHED_RETENTION_MS = 8_000; // settled rows linger this long

function boardSections(
  board: MmrAsyncTaskBoard,
  groupSnapshots: Map<string, MmrAsyncTaskGroupSnapshot>,
  nowMs: number,
): WidgetSection[]
```

Algorithm:
1. Take `board.active`, `board.stalled`, and the slice of `board.finished` where
   `nowMs - (completedAtMs ?? 0) <= WIDGET_FINISHED_RETENTION_MS` (the
   "persist briefly then drop" rule — the registry's own 2–15min retention is a
   superset, so we just filter the lane we already get).
2. Bucket by `groupId` (a stable insertion-ordered `Map`; `undefined` →
   the trailing "ungrouped" bucket).
3. Within each section sort rows: running → stalled → finished, then by
   `createdAtMs` (group members keep launch order).
4. Attach `group` from `groupSnapshots.get(groupId)` for the header.

`nowMs` is threaded in (not read from a clock) to stay aligned with the
codebase's injectable-time convention and keep the render pure/testable.

### 3. Header renderer (new)

```ts
function renderSectionHeader(section: WidgetSection, theme): string
// ▸ group_94f0d2  ● completed · 4/4
```

- `▸` + `groupId` in `dim`.
- `●` + status word in the **group status colour**: `running`→`warning`,
  `completed`→`success`, `failed`→`error`, `partial`→`warning`,
  `cancelled`→`muted` (new `groupStatusColor`, mirrors `backgroundStatusColor`).
- `settled/total` count in `dim`, where
  `settled = succeeded + failed + cancelled + partial`.
- Ungrouped bucket: header line is just `dim("▸ ungrouped")` (or omitted when it
  is the only section — see §6).

### 4. Row renderer (small edits to `renderRowLine` + `widgetMetadataParts`)

Reuse `renderRowLine` verbatim except:
- **Indent group members by two spaces** (`  `) so they sit under the header.
  Ungrouped rows keep zero indent.
- In `widgetMetadataParts`: **add** `capabilityProfile` as a chip (right after
  `model`); **remove** the `groupId` chip (it now lives in the header). All other
  chips (`elapsed`, `latestTool…`, `turns`, `tools`, `partial`, `ctx`) unchanged.

Glyphs/colours are untouched — `backgroundStatusGlyph` / `backgroundStatusColor`
already give `⠋`/`✓`/`✕`/`–` and warning/success/error/muted.

### 5. Line assembly (replaces `renderWidgetLines`)

```ts
function renderWidgetLines(sections, theme, activeFrame): string[]
```
- For each section: header line (if any), then its rows.
- `WIDGET_MAX_ROWS` (8) now counts **header + body** lines together; overflow
  collapses to `dim("… N more")` as today. A group is never split across the
  truncation boundary — drop whole trailing sections, not half a group.
- Animation timer (`PI_LOADER_INTERVAL_MS`, `unref`) is unchanged; it runs while
  any section has a running/stalled row.

### 6. Edge cases

- **No groups at all** → exactly today's flat list (single ungrouped section,
  header suppressed). Zero visual regression for non-grouped Task usage.
- **Group fully settled** → its header flips to `completed`/`failed`/`partial`
  colour; rows show `✓`/`✕` and linger `WIDGET_FINISHED_RETENTION_MS`, then the
  whole section drops (mirrors the existing "result card shows the detail"
  contract — the brief overlap is intentional, bounded, and matches the
  "persist briefly then drop" decision).
- **Empty board** → `setWidget(..., undefined)` clears it, as today.

## Data flow

```
registry.listTasks(sessionKey)         -> MmrAsyncTaskBoard (active/stalled/finished)
registry.getGroup(sessionKey, id)      -> MmrAsyncTaskGroupSnapshot  (per distinct groupId)
        │
        ▼
boardSections(board, groupSnapshots, now)  ── filter finished by retention, bucket by groupId
        │
        ▼
renderWidgetLines(sections, theme, frame)  ── header + indented rows, braille/✓/✕/–
        │
        ▼
ctx.ui.setWidget(BACKGROUND_TASK_WIDGET_ID, factory, { placement: "belowEditor" })
```

`refreshBackgroundTaskWidget` gains a second arg (the group-snapshot lookup) or
resolves snapshots from a passed-in registry handle; the caller already holds the
registry when it builds the board, so this is a local wiring change.

## Test plan (mirrors existing widget tests)

1. `boardSections`: buckets by `groupId`, ungrouped trails last, retention filter
   drops `finished` older than the window, keeps newer ones.
2. Row sort within a section: running → stalled → finished, stable by `createdAtMs`.
3. `widgetMetadataParts`: includes `capabilityProfile`, excludes `groupId`.
4. Header: status colour + `settled/total` count for each `MmrAsyncTaskGroupStatus`.
5. Truncation: `WIDGET_MAX_ROWS` counts headers; no half-group at the boundary.
6. Regression: a board with no `groupId`s renders byte-identical to current output.

## Preview

`node scripts/preview-orchestration-widget.mjs` renders the CURRENT flat widget
and the PROPOSED grouped view side by side with real ANSI colours, using the
screenshot's "p99 latency regression" scenario in our design language.
