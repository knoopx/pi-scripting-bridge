/**
 * Render a scrollable list pane — a faithful port of the ide
 * `split-panel/list-pane-renderer.ts`. Given the full item list, the
 * selected index, and the pane height, it renders the visible window of
 * items (one row each) via a caller-supplied row factory, or a single dim
 * empty-state line when the list is empty.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ensureWidth } from "./ansi";
import { getVisibleItems } from "./visible";

interface ListPaneRendererOptions<T> {
  items: T[];
  selectedIndex: number;
  height: number;
  width: number;
  theme: Theme;
  emptyMessage: string;
  createRow: (
    item: T,
    index: number,
  ) => { render: (width: number) => string[] };
}

/** Render the visible window of a list pane as one row per item. */
export function renderListPane<T>(
  options: ListPaneRendererOptions<T>,
): string[] {
  if (options.items.length === 0) {
    return [
      ensureWidth(options.theme.fg("dim", options.emptyMessage), options.width),
    ];
  }

  const visibleItems = getVisibleItems(
    options.items,
    options.selectedIndex,
    options.height,
  );
  const rows: string[] = [];

  for (const { item, index: idx } of visibleItems) {
    const row = options.createRow(item, idx);
    rows.push(row.render(options.width)[0]);
  }

  return rows;
}
