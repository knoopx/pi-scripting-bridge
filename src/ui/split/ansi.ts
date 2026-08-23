/**
 * ANSI width helpers for the split picker — the bridge-native equivalent of
 * the ide `shared/format/ansi-text` module. Built on pi-tui's
 * `visibleWidth` + `truncateToWidth` (no slice-ansi / string-width / OSC
 * stripping: the bridge controls all preview content, so no OSC sequences
 * appear).
 *
 * - {@link truncateAnsi}: clip to `width` visible columns (no ellipsis); the
 *   clipped result carries a trailing reset so a color never bleeds into the
 *   next line.
 * - {@link pad} / {@link ensureWidth}: clip to `width` when over-long, else
 *   pad with spaces (a reset is inserted before the padding so the fill never
 *   inherits an active color — mirrors the ide `ensureWidth`). `pad` and
 *   `ensureWidth` are behaviorally identical (the ide's only difference, a
 *   no-op in the exact-width case, collapses under pi-tui's semantics).
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Clip `text` to `width` visible columns (no ellipsis); trailing reset. */
/**
 * Pad `text` to exactly `width` visible columns, honoring `align`:
 *   - "left" (default): left-align — truncate then right-pad (uses pi-tui
 *     `truncateToWidth` with pad=true).
 *   - "right": right-align — truncate then left-pad (spaces are prepended
 *     so they never inherit the text's active color; no SGR reset needed).
 * Both first truncate to `width` (no ellipsis) so the result is exactly
 * `width` visible columns.
 *
 * `ellipsis` (default "" = no ellipsis, a plain clip) is appended when the
 * text is truncated to `width` — data columns pass "…" so an over-long cell
 * shows a trailing ellipsis; an empty ellipsis keeps the legacy clip.
 */
export function padAligned(
  text: string,
  width: number,
  align: "left" | "right" = "left",
  ellipsis: string = "",
): string {
  if (align === "right") {
    const truncated = truncateToWidth(text, width, ellipsis, false);
    return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
  }
  return truncateToWidth(text, width, ellipsis, true);
}

export function truncateAnsi(text: string, width: number): string {
  return truncateToWidth(text, width, "", false);
}

/**
 * Normalize `text` to exactly `width` visible columns: truncate when
 * over-long, else pad with spaces (a reset precedes the padding so it never
 * inherits an active color).
 */
function normalizeWidth(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, "", false);
  return text + "\x1b[0m" + " ".repeat(width - w);
}

/** Pad (or truncate, no ellipsis) `text` to exactly `width` visible columns. */
export function pad(text: string, width: number): string {
  return normalizeWidth(text, width);
}

/** Ensure `text` is exactly `width` visible columns (truncate or pad). */
export function ensureWidth(text: string, width: number): string {
  return normalizeWidth(text, width);
}
