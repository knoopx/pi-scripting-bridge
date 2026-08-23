/**
 * Bordered frame drawing for the bridge picker — a single-column adaptation
 * of the ide split-panel frame (ide/lib/split-panel/border/*). Row layout
 * mirrors the ide `renderSplitPanel` header/content/footer stack:
 *
 *   ╭────────╮  top border (plain border)
 *   │ title  │  title row (plain border bars; accent title, padded)
 *   ├────────┤  separator (plain border)
 *   │ item   │  bordered item blocks (plain border bars; an item may
 *   │        │  span up to maxLines rows when its label carries embedded
 *   │        │  newlines — the focused block's full-width selection
 *   │        │  background spans ALL of its rows)
 *   ├────────┤  separator (plain border)
 *   │ help   │  footer help/status line (plain border bars; dim text)
 *   ╰────────╯  bottom border (plain border)
 *
 * All chrome uses the plain "border" color; the title text keeps the
 * accent color and the focused block keeps its selectedBg background.
 *
 * Self-contained by design: the box characters are inlined here (same set as
 * the ide frame) and only pi-tui width helpers are used — no ide or shared
 * tree imports at runtime.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BOX } from "./box-chars.js";

/** Non-content frame lines: top border, title row, top separator, bottom
 * separator, footer, bottom border. */
export const BORDER_LINES = 6;

/** Pad (or truncate, no ellipsis) to exactly `width` visible columns — the
 * single-column equivalent of the ide panel `ensureWidth`. */
function padToWidth(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - w);
}

/** Horizontal rule row: `<left> ── <right>` (repeated to innerWidth),
 * colored with `color`. */
function hRule(
  theme: Theme,
  color: ThemeColor,
  left: string,
  right: string,
  innerWidth: number,
): string {
  return theme.fg(
    color,
    left + BOX.horizontal.repeat(innerWidth) + right,
  );
}

/** Bordered row: vertical bars in `color` framing `inner` (already exactly
 * innerWidth wide). */
function vBars(theme: Theme, color: ThemeColor, inner: string): string {
  return theme.fg(color, BOX.vertical) + inner + theme.fg(color, BOX.vertical);
}

/** Top border: `╭────╮` (plain border). */
export function topBorder(theme: Theme, innerWidth: number): string {
  return hRule(theme, "border", BOX.topLeft, BOX.topRight, innerWidth);
}

/** Title row: `│ title │` — plain border bars with the accent title padded
 * to the full inner width (mirrors the ide renderTitleRow). */
export function titleRow(
  theme: Theme,
  title: string,
  innerWidth: number,
): string {
  const inner = theme.fg("accent", padToWidth(" " + title, innerWidth));
  return vBars(theme, "border", inner);
}

/** Separator row: `├──┤` (plain border). */
export function separator(theme: Theme, innerWidth: number): string {
  return hRule(theme, "border", BOX.teeLeft, BOX.teeRight, innerWidth);
}

/** Bordered content row: `│ content │` — vertical bars in `color`, the
 * content padded (or truncated) to exactly innerWidth so the right bar
 * aligns with the frame corners. */
export function barRow(
  theme: Theme,
  content: string,
  innerWidth: number,
  color: ThemeColor,
): string {
  const inner = padToWidth(content, innerWidth);
  return vBars(theme, color, inner);
}

/** Bordered row for content that is already exactly innerWidth (the
 * selection-background rows, which pad inside the background so the
 * highlight covers the whole cell — see {@link selectionBackground}). */
export function rawBarRow(
  theme: Theme,
  inner: string,
  color: ThemeColor,
): string {
  return vBars(theme, color, inner);
}

/** Wrap a styled item cell in the selection background, padded to the full
 * inner width (mirrors the ide applySelectionBackground). An over-long cell
 * is truncated first so the background never exceeds the frame. */
export function selectionBackground(
  theme: Theme,
  styled: string,
  innerWidth: number,
): string {
  const clipped =
    visibleWidth(styled) > innerWidth
      ? truncateToWidth(styled, innerWidth, "")
      : styled;
  const padding = Math.max(0, innerWidth - visibleWidth(clipped));
  return theme.bg("selectedBg", clipped + " ".repeat(padding));
}

/** Bottom border: `╰────╯` (plain border). */
export function bottomBorder(theme: Theme, innerWidth: number): string {
  return hRule(theme, "border", BOX.bottomLeft, BOX.bottomRight, innerWidth);
}