/**
 * Shared list/source rendering helpers — the bridge home for the ide
 * `formatting/text.ts` helpers the split panel needs. Width math uses
 * pi-tui's `visibleWidth` (no string-width).
 *
 * - {@link getVisibleItems}: the window of `height` items keeping the
 *   selected item in view (scroll starts at `selectedIndex - height + 1`
 *   once it exceeds the viewport).
 * - {@link applySelectionBackground}: wrap a styled row in the selection
 *   background, padded so the highlight spans the full cell.
 * - {@link renderEmptyRow} / {@link renderEmptyRowWithReset}: a single dim
 *   placeholder line (the reset variant prefixes a color reset so the dim
 *   text never inherits the previous row's styling).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ensureWidth } from "./ansi";

/** Wrap `styledText` in the selection background, padded to `width`. */
export function applySelectionBackground(
  styledText: string,
  width: number,
  theme: Theme,
): string {
  const visibleLen = visibleWidth(styledText);
  const padding = Math.max(0, width - visibleLen);
  return theme.bg("selectedBg", styledText + " ".repeat(padding));
}

/** A single dim placeholder line, padded to `width`. */
function renderEmptyRow(
  message: string,
  width: number,
  theme: Theme,
): string {
  const text = theme.fg("dim", ` ${message}`);
  return ensureWidth(text, width);
}

/** {@link renderEmptyRow} prefixed with a color reset. */
export function renderEmptyRowWithReset(
  message: string,
  width: number,
  theme: Theme,
): string {
  return "\x1b[0m" + renderEmptyRow(message, width, theme);
}

/** The window of up to `height` items keeping `selectedIndex` in view. */
export function getVisibleItems<T>(
  items: T[],
  selectedIndex: number,
  height: number,
): Array<{ item: T; index: number }> {
  let startIdx = 0;
  if (selectedIndex >= height) {
    startIdx = selectedIndex - height + 1;
  }
  const visible: Array<{ item: T; index: number }> = [];
  for (let i = 0; i < height && startIdx + i < items.length; i++) {
    const idx = startIdx + i;
    visible.push({ item: items[idx], index: idx });
  }
  return visible;
}
