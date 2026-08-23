/**
 * Border primitives — a faithful port of the ide
 * `split-panel/border/border-rendering.ts`. The box-drawing characters live in
 * the shared `../../box-chars` module (same set as the ide `ui/frame.ts`; the
 * ide frame is not available in the bridge) and are re-exported here for
 * `./rows` and `./body`. Width helpers come from {@link ../ansi}.
 *
 * All panel chrome (top border, title row, separators, content rows,
 * footer, bottom border) uses the plain `border` color (see
 * {@link getBorderColor}); selection backgrounds are unaffected.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ensureWidth } from "../ansi";
import { BOX } from "../../box-chars.js";
import type {
  BorderColor,
  PanelRowArgs,
  BorderRowArgs,
  FocusedRowArgs,
} from "./types";

/** A callback that colors a box-drawing fragment with `theme`. */
export function createBorderFn(
  theme: Theme,
): (color: BorderColor, s: string) => string {
  return (color, s) => theme.fg(color, s);
}

/** Border color for a single side: plain border (focus no longer tints). */
export function getBorderColor(focus: boolean | undefined): BorderColor {
  void focus;
  return "border";
}

/** Center-border color: plain border (focus no longer tints). */
export function getCenterBorderColor(
  leftFocus: boolean | undefined,
  rightFocus: boolean | undefined,
): BorderColor {
  void leftFocus;
  void rightFocus;
  return "border";
}

/**
 * One bordered content row: `│ left │ right │` — both cells padded to their
 * pane widths so the center and right bars align.
 */
export function renderPanelRow(args: PanelRowArgs): string {
  const { leftContent, rightContent, leftW, rightW, lb, rb, mb, border } =
    args;
  return (
    border(lb, BOX.vertical) +
    ensureWidth(leftContent, leftW) +
    border(mb, BOX.vertical) +
    ensureWidth(rightContent, rightW) +
    border(rb, BOX.vertical)
  );
}

function renderBorderRow(args: BorderRowArgs): string {
  const {
    leftColor,
    middleColor,
    rightColor,
    leftStart,
    leftContent,
    middle,
    rightContent,
    rightEnd,
    border,
  } = args;
  return (
    border(leftColor, leftStart) +
    border(leftColor, leftContent) +
    border(middleColor, middle) +
    border(rightColor, rightContent) +
    border(rightColor, rightEnd)
  );
}

/**
 * A renderer for a focus-dependent border row: the per-side and center
 * border colors are captured from the focus state, and the returned
 * function colors a {@link FocusedRowArgs} fragment set.
 */
export function createFocusedRowRenderer(
  leftFocus: boolean | undefined,
  rightFocus: boolean | undefined,
  theme: Theme,
): (args: FocusedRowArgs) => string {
  const border = createBorderFn(theme);
  const lb = getBorderColor(leftFocus);
  const mb = getCenterBorderColor(leftFocus, rightFocus);
  const rb = getBorderColor(rightFocus);

  return (args: FocusedRowArgs): string =>
    renderBorderRow({
      ...args,
      leftColor: lb,
      middleColor: mb,
      rightColor: rb,
      border,
    });
}

/** The left/right border colors and color callback for a content body. */
export function getPanelBorderConfig(
  leftFocus: boolean | undefined,
  rightFocus: boolean | undefined,
  theme: Theme,
) {
  const lb: BorderColor = "border";
  const rb: BorderColor = "border";
  const border = (color: BorderColor, s: string) => theme.fg(color, s);
  return { lb, rb, border };
}

/** A row cell, padded with plain spaces when empty/undefined. */
export function getOrPad(row: string | undefined, width: number): string {
  return row || " ".repeat(width);
}
