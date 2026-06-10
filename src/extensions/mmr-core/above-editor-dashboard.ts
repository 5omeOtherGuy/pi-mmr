import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const ABOVE_EDITOR_DASHBOARD_WIDGET_ID = "pi-mmr-above-editor-dashboard";

export type AboveEditorDashboardSlot = "left" | "right";

export interface AboveEditorDashboardTheme {
  fg(name: string, value: string): string;
  bold(value: string): string;
}

export interface AboveEditorDashboardTui {
  requestRender?(force?: boolean): void;
}

export type AboveEditorDashboardComponent = {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
};

export type AboveEditorDashboardFactory = (
  tui: AboveEditorDashboardTui,
  theme: AboveEditorDashboardTheme,
) => AboveEditorDashboardComponent;

export type AboveEditorDashboardValue = readonly string[] | AboveEditorDashboardFactory;

interface WidgetUILike {
  setWidget(
    id: string,
    value: AboveEditorDashboardValue | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

interface WidgetCtxLike {
  ui?: WidgetUILike;
}

interface SlotState {
  id: string;
  value: AboveEditorDashboardValue;
}

interface DashboardStore {
  slots: Partial<Record<AboveEditorDashboardSlot, SlotState>>;
  showingCombined: boolean;
  rowBudgets: Partial<Record<AboveEditorDashboardSlot, number>>;
}

const DASHBOARD_STORE_KEY = Symbol.for("pi-mmr.above-editor-dashboard");
const MIN_COLUMN_DASHBOARD_WIDTH = 80;

function dashboardStore(): DashboardStore {
  const globalStore = globalThis as unknown as { [key: symbol]: DashboardStore | undefined };
  const existing = globalStore[DASHBOARD_STORE_KEY];
  if (existing) return existing;
  const store: DashboardStore = { slots: {}, showingCombined: false, rowBudgets: {} };
  globalStore[DASHBOARD_STORE_KEY] = store;
  return store;
}

function instantiate(
  value: AboveEditorDashboardValue,
  tui: AboveEditorDashboardTui,
  theme: AboveEditorDashboardTheme,
): AboveEditorDashboardComponent {
  if (typeof value === "function") return value(tui, theme);
  return {
    render: () => [...value],
    invalidate: () => {},
  };
}

function padVisibleEnd(value: string, width: number): string {
  const current = visibleWidth(value);
  if (current >= width) return value;
  return `${value}${" ".repeat(width - current)}`;
}

function combineLines(left: readonly string[], right: readonly string[], width: number): string[] {
  if (!Number.isFinite(width)) return [...left, ...right];
  if (width <= 0) return [];

  const separator = " │ ";
  const separatorWidth = visibleWidth(separator);
  if (width < MIN_COLUMN_DASHBOARD_WIDTH) {
    return [...left, ...right].map((line) => truncateToWidth(line, width));
  }

  const leftWidth = Math.min(48, Math.max(28, Math.floor(width * 0.42)));
  const rightWidth = Math.max(0, width - leftWidth - separatorWidth);
  const rowCount = Math.max(left.length, right.length);
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const leftCell = padVisibleEnd(truncateToWidth(left[i] ?? "", leftWidth), leftWidth);
    const rightCell = truncateToWidth(right[i] ?? "", rightWidth);
    rows.push(`${leftCell}${separator}${rightCell}`);
  }
  return rows;
}

function columnWidths(width: number): { left: number; right: number } {
  if (!Number.isFinite(width)) return { left: Number.POSITIVE_INFINITY, right: Number.POSITIVE_INFINITY };
  const left = Math.min(48, Math.max(28, Math.floor(width * 0.42)));
  return { left, right: Math.max(0, width - left - 3) };
}

function makeCombinedWidget(left: SlotState, right: SlotState): AboveEditorDashboardFactory {
  return (tui, theme) => {
    const leftComponent = instantiate(left.value, tui, theme);
    const rightComponent = instantiate(right.value, tui, theme);
    return {
      render: (width) => {
        const columns = columnWidths(width);
        const leftLines = leftComponent.render(columns.left);
        const store = dashboardStore();
        store.rowBudgets.right = leftLines.length;
        try {
          const rightLines = rightComponent.render(columns.right);
          return combineLines(leftLines, rightLines, width);
        } finally {
          delete store.rowBudgets.right;
        }
      },
      invalidate: () => {
        leftComponent.invalidate();
        rightComponent.invalidate();
      },
      dispose: () => {
        leftComponent.dispose?.();
        rightComponent.dispose?.();
      },
    };
  };
}

export function getAboveEditorDashboardSlotRowBudget(slot: AboveEditorDashboardSlot): number | undefined {
  return dashboardStore().rowBudgets[slot];
}

export function updateAboveEditorDashboardSlot(
  ctx: WidgetCtxLike | undefined,
  slot: AboveEditorDashboardSlot,
  id: string,
  value: AboveEditorDashboardValue | undefined,
): void {
  const ui = ctx?.ui;
  if (!ui) return;

  const store = dashboardStore();
  if (value === undefined) delete store.slots[slot];
  else store.slots[slot] = { id, value };

  const left = store.slots.left;
  const right = store.slots.right;
  if (left && right) {
    if (!store.showingCombined) {
      ui.setWidget(left.id, undefined, { placement: "aboveEditor" });
      ui.setWidget(right.id, undefined, { placement: "aboveEditor" });
    }
    store.showingCombined = true;
    ui.setWidget(ABOVE_EDITOR_DASHBOARD_WIDGET_ID, makeCombinedWidget(left, right), { placement: "aboveEditor" });
    return;
  }

  const active = left ?? right;
  if (store.showingCombined) {
    ui.setWidget(ABOVE_EDITOR_DASHBOARD_WIDGET_ID, undefined, { placement: "aboveEditor" });
    store.showingCombined = false;
    if (active) {
      ui.setWidget(active.id, active.value, { placement: "aboveEditor" });
      return;
    }
  }
  ui.setWidget(id, active && active.id === id ? active.value : undefined, { placement: "aboveEditor" });
}

export function resetAboveEditorDashboardForTest(): void {
  const store = dashboardStore();
  delete store.slots.left;
  delete store.slots.right;
  delete store.rowBudgets.left;
  delete store.rowBudgets.right;
  store.showingCombined = false;
}
