/**
 * Bordered frame rows — a faithful port of the ide
 * `split-panel/border/rows.ts`. Renders the four chrome rows of a split
 * panel: top border, title row, separator, and the three-row bottom block
 * (separator, help row, bottom border). Each side's border color follows the
 * focus state (see {@link createFocusedRowRenderer}).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { pad } from "../ansi";
import { BOX } from "../../box-chars.js";
import {
  createBorderFn,
  createFocusedRowRenderer,
  getBorderColor,
  getCenterBorderColor,
} from "./border-rendering";
import type {
  FocusedRowArgs,
  TopBorderArgs,
  TitleRowArgs,
  SeparatorRowArgs,
  BottomBorderArgs,
} from "./types";

/** Shared focus/theme base for the focused chrome rows (top, title, separator). */
interface FocusedChromeBase {
  leftFocus: boolean | undefined;
  rightFocus: boolean | undefined;
  theme: Theme;
}

/**
 * One focused chrome row: resolve the focus-based renderer and emit a
 * {@link FocusedRowArgs} fragment set. Single shared body for the top edge,
 * the title row, and the separator — each supplies only its own fragments.
 */
function renderFocusedChromeRow(
  base: FocusedChromeBase,
  row: FocusedRowArgs,
): string {
  const renderRow = createFocusedRowRenderer(
    base.leftFocus,
    base.rightFocus,
    base.theme,
  );
  return renderRow(row);
}

/** `╭────┬────╮` — the panel's top edge (accent when a side is focused). */
export function renderTopBorder(args: TopBorderArgs): string {
  const { leftW, rightW } = args;
  return renderFocusedChromeRow(args, {
    leftStart: BOX.topLeft,
    leftContent: BOX.horizontal.repeat(leftW),
    middle: BOX.teeDown,
    rightContent: BOX.horizontal.repeat(rightW),
    rightEnd: BOX.topRight,
  });
}

/** `│ title │ subtitle │` — accent-titled row (accent when focused). */
export function renderTitleRow(args: TitleRowArgs): string {
  const { leftTitle, rightTitle, leftW, rightW } = args;
  return renderFocusedChromeRow(args, {
    leftStart: BOX.vertical,
    leftContent: args.theme.fg("accent", pad(leftTitle, leftW)),
    middle: BOX.vertical,
    rightContent: args.theme.fg("accent", pad(rightTitle, rightW)),
    rightEnd: BOX.vertical,
  });
}

/** `├────┼────┤` — the separator under the title row. */
export function renderSeparatorRow(args: SeparatorRowArgs): string {
  const { leftW, rightW } = args;
  return renderFocusedChromeRow(args, {
    leftStart: BOX.teeLeft,
    leftContent: BOX.horizontal.repeat(leftW),
    middle: BOX.cross,
    rightContent: BOX.horizontal.repeat(rightW),
    rightEnd: BOX.teeRight,
  });
}

/** The bottom three rows: separator, dim help row, plain bottom border. */
export function renderBottomBorder(args: BottomBorderArgs): string[] {
  const { leftW, rightW, helpText, leftFocus, rightFocus, theme } = args;
  const border = createBorderFn(theme);
  const lb = getBorderColor(leftFocus);
  const rb = getBorderColor(rightFocus);
  const separatorMb = getCenterBorderColor(leftFocus, rightFocus);
  const separator =
    border(lb, BOX.teeLeft) +
    border(lb, BOX.horizontal.repeat(leftW)) +
    border(separatorMb, BOX.teeUp) +
    border(rb, BOX.horizontal.repeat(rightW)) +
    border(rb, BOX.teeRight);
  const helpRow =
    border("border", BOX.vertical) +
    theme.fg("dim", pad(` ${helpText}`, leftW + rightW + 1)) +
    border("border", BOX.vertical);
  const bottomRow =
    border("border", BOX.bottomLeft) +
    border("border", BOX.horizontal.repeat(leftW + rightW + 1)) +
    border("border", BOX.bottomRight);

  return [separator, helpRow, bottomRow];
}
