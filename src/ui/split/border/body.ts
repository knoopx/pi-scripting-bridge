/**
 * Split-panel content body — a faithful port of the ide
 * `split-panel/border/body.ts`. Renders the content area between the title
 * and the footer: a simple two-pane body (left + right rows, one row each)
 * or, when the config enables a right sub-split, a right pane that is itself
 * split into top/bottom sections with their own separators.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { pad, ensureWidth } from "../ansi";
import { BOX } from "../../box-chars.js";
import type {
  SplitPanelConfig,
  SplitPanelDimensions,
  SplitPanelRows,
} from "../layout";
import type {
  BorderColor,
  PanelRenderCtx,
  SplitRightPanelArgs,
  SimplePanelArgs,
} from "./types";
import {
  getPanelBorderConfig,
  getCenterBorderColor,
  renderPanelRow,
  getOrPad,
} from "./border-rendering";

function renderSimplePanel(args: SimplePanelArgs): string[] {
  const {
    leftRows,
    rightRows,
    leftW,
    rightW,
    contentH,
    leftFocus,
    rightFocus,
    theme,
  } = args;
  const lines: string[] = [];
  const { lb, rb, border } = getPanelBorderConfig(leftFocus, rightFocus, theme);
  const mb = getCenterBorderColor(leftFocus, rightFocus);

  for (let i = 0; i < contentH; i++) {
    lines.push(
      renderPanelRow({
        leftContent: leftRows[i] || pad("", leftW),
        rightContent: rightRows[i] || pad("", rightW),
        leftW,
        rightW,
        lb,
        rb,
        mb,
        border,
      }),
    );
  }

  return lines;
}

function renderSplitRightPanel(args: SplitRightPanelArgs): string[] {
  const {
    leftRows,
    rightTopRows,
    rightBottomRows,
    leftW,
    rightW,
    rightTopH,
    rightBottomH,
    leftFocus,
    rightFocus,
    rightBottomTitle,
    theme,
  } = args;
  const { lb, rb, border } = getPanelBorderConfig(leftFocus, rightFocus, theme);
  const mb = getCenterBorderColor(leftFocus, rightFocus);
  const ctx: PanelRenderCtx = {
    leftRows,
    leftW,
    rightW,
    lb,
    rb,
    mb,
    border,
  };

  return [
    ...renderRightTopSection(rightTopRows, rightTopH, ctx),
    renderSeparatorLine(ctx.leftRows, rightTopH, ctx),
    renderBottomTitleLine({
      leftRows,
      idx: rightTopH + 1,
      rightBottomTitle,
      leftW,
      rightW,
      theme,
      lb,
      mb,
      rb,
    }),
    renderSeparatorLine(leftRows, rightTopH + 2, ctx),
    ...renderRightBottomSection(rightBottomRows, rightBottomH, rightTopH, ctx),
  ];
}

function renderSectionLines(
  rightRows: string[],
  height: number,
  leftOffset: number,
  ctx: PanelRenderCtx,
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    lines.push(
      renderPanelRow({
        ...ctx,
        leftContent: getOrPad(ctx.leftRows[leftOffset + i], ctx.leftW),
        rightContent: getOrPad(rightRows[i], ctx.rightW),
      }),
    );
  }
  return lines;
}

function renderRightTopSection(
  rightTopRows: string[],
  rightTopH: number,
  ctx: PanelRenderCtx,
): string[] {
  return renderSectionLines(rightTopRows, rightTopH, 0, ctx);
}

function renderRightBottomSection(
  rightBottomRows: string[],
  rightBottomH: number,
  rightTopH: number,
  ctx: PanelRenderCtx,
): string[] {
  return renderSectionLines(rightBottomRows, rightBottomH, rightTopH + 3, ctx);
}

function renderSeparatorLine(
  leftRows: string[],
  idx: number,
  ctx: PanelRenderCtx,
): string {
  const { leftW, rightW, lb, rb, mb, border } = ctx;
  return (
    border(lb, BOX.vertical) +
    ensureWidth(leftRows[idx] || "", leftW) +
    border(mb, BOX.teeLeft) +
    border(rb, BOX.horizontal.repeat(rightW)) +
    border(rb, BOX.teeRight)
  );
}

function renderBottomTitleLine(opts: {
  leftRows: string[];
  idx: number;
  rightBottomTitle: string;
  leftW: number;
  rightW: number;
  theme: Theme;
  lb: BorderColor;
  mb: BorderColor;
  rb: BorderColor;
}): string {
  const { leftRows, idx, rightBottomTitle, leftW, rightW, theme, lb, mb, rb } =
    opts;
  const border = (color: BorderColor, s: string) => theme.fg(color, s);
  return (
    border(lb, BOX.vertical) +
    ensureWidth(leftRows[idx] || "", leftW) +
    border(mb, BOX.vertical) +
    theme.fg("accent", pad(rightBottomTitle, rightW)) +
    border(rb, BOX.vertical)
  );
}

function hasSplitRightDims(
  dims: SplitPanelDimensions,
): dims is SplitPanelDimensions & {
  rightTopH: number;
  rightBottomH: number;
} {
  return !!(dims.rightTopH && dims.rightBottomH);
}

function shouldRenderSplitRight(
  config: SplitPanelConfig,
  dims: SplitPanelDimensions,
): boolean {
  return !!(config.rightSplit && hasSplitRightDims(dims));
}

/** Render the panel content body (simple two-pane or right sub-split). */
export function renderPanelContent(
  theme: Theme,
  config: SplitPanelConfig,
  dims: SplitPanelDimensions,
  rows: SplitPanelRows,
): string[] {
  const { leftW, rightW, contentH } = dims;

  if (shouldRenderSplitRight(config, dims)) {
    return renderSplitRightPanel(buildSplitParams(theme, config, dims, rows));
  }

  return renderSimplePanel(
    buildSimpleParams(config, rows, leftW, rightW, contentH, theme),
  );
}

function assertSplitRightDims(
  dims: SplitPanelDimensions,
): asserts dims is SplitPanelDimensions & {
  rightTopH: number;
  rightBottomH: number;
} {
  if (!dims.rightTopH || !dims.rightBottomH) {
    throw new Error("split panel dimensions missing");
  }
}

function buildSplitParams(
  theme: Theme,
  config: SplitPanelConfig,
  dims: SplitPanelDimensions,
  rows: SplitPanelRows,
): Parameters<typeof renderSplitRightPanel>[0] {
  assertSplitRightDims(dims);
  return {
    leftRows: rows.left,
    rightTopRows: rows.rightTop ?? [],
    rightBottomRows: rows.rightBottom ?? [],
    leftW: dims.leftW,
    rightW: dims.rightW,
    rightTopH: dims.rightTopH,
    rightBottomH: dims.rightBottomH,
    leftFocus: config.leftFocus,
    rightFocus: config.rightFocus,
    rightBottomTitle: config.rightBottomTitle ?? " Preview",
    theme,
  };
}

function buildSimpleParams(
  config: SplitPanelConfig,
  rows: SplitPanelRows,
  leftW: number,
  rightW: number,
  contentH: number,
  theme: Theme,
): Parameters<typeof renderSimplePanel>[0] {
  return {
    leftRows: rows.left,
    rightRows: rows.right ?? [],
    leftW,
    rightW,
    contentH,
    leftFocus: config.leftFocus,
    rightFocus: config.rightFocus,
    theme,
  };
}
