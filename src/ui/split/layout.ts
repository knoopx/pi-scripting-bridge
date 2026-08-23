/**
 * Split-panel geometry — a faithful port of the ide `split-panel/layout.ts`.
 *
 * A two-pane (or right-sub-split) panel occupies the whole overlay: the left
 * pane gets a ratio of the terminal width, the right pane gets the remainder
 * minus the three vertical border characters, and the content area is the
 * terminal height minus the six non-content frame lines.
 */
export interface SplitPanelConfig {
  leftTitle: string;
  rightTitle: string;
  rightTopTitle?: string;
  rightBottomTitle?: string;
  helpText: string;
  leftFocus: boolean;
  rightFocus?: boolean;

  leftRatio?: number;

  rightSplit?: boolean;

  rightTopRatio?: number;
}

export interface SplitPanelDimensions {
  width: number;
  height: number;
  leftW: number;
  rightW: number;
  contentH: number;

  rightTopH?: number;

  rightBottomH?: number;
}

interface SplitPanelRows {
  left: string[];
  right?: string[];
  rightTop?: string[];
  rightBottom?: string[];
}
export type { SplitPanelRows };

/** Resolve the pane widths and content height for a given terminal size. */
export function calculateDimensions(
  terminalRows: number,
  width: number,
  config: SplitPanelConfig,
): SplitPanelDimensions {
  const leftRatio = config.leftRatio ?? 0.35;
  const leftW = Math.floor(width * leftRatio);
  const rightW = width - leftW - 3; // 3 for border chars
  const overlayHeight = terminalRows;
  const borderLines = 6;
  const contentH = overlayHeight - borderLines;
  const result: SplitPanelDimensions = {
    width,
    height: overlayHeight,
    leftW,
    rightW,
    contentH,
  };

  if (config.rightSplit) {
    const rightTopRatio = config.rightTopRatio ?? 0.3;
    result.rightTopH = Math.min(
      Math.max(3, Math.floor(contentH * rightTopRatio)),
      Math.floor(contentH * 0.4),
    );
    result.rightBottomH = contentH - result.rightTopH - 3;
  }

  return result;
}

function handlePageScroll(options: {
  direction: "up" | "down";
  currentScroll: number;
  contentLength: number;
  viewportHeight: number;
  scrollAmount?: number;
}): number {
  const {
    direction,
    currentScroll,
    contentLength,
    viewportHeight,
    scrollAmount = 10,
  } = options;
  if (direction === "down") {
    const maxScroll = Math.max(0, contentLength - viewportHeight);
    return Math.min(maxScroll, currentScroll + scrollAmount);
  }
  return Math.max(0, currentScroll - scrollAmount);
}

/**
 * Page-scroll a diff/preview pane by one viewport. The viewport height is
 * derived from the (right-sub-split) content dimensions for `cachedWidth`;
 * the caller passes the last rendered width so the scroll step tracks the
 * live pane size.
 */
export function calculateDiffScroll(options: {
  direction: "up" | "down";
  currentScroll: number;
  contentLength: number;
  terminalRows: number;
  cachedWidth: number;
}): number {
  const { direction, currentScroll, contentLength, terminalRows, cachedWidth } =
    options;
  const dims = calculateDimensions(terminalRows, cachedWidth || 200, {
    leftTitle: "",
    rightTitle: "",
    helpText: "",
    leftFocus: true,
    rightSplit: true,
  });
  return handlePageScroll({
    direction,
    currentScroll,
    contentLength,
    viewportHeight: dims.rightBottomH ?? 10,
  });
}
