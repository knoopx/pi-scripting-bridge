/**
 * Shared box-drawing characters — the single source of truth for the frame
 * chrome used by both the single-column bridge picker
 * (`./picker-border.ts`) and the ide split-panel border
 * (`./split/border/border-rendering.ts`). The set matches the ide `ui/frame.ts`
 * box characters; the ide frame is not available in the bridge, so both
 * consumers import this one shared constant instead of redeclaring it.
 */

/** Box-drawing characters (same set as the ide frame). */
export const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  teeLeft: "├",
  teeRight: "┤",
  teeDown: "┬",
  teeUp: "┴",
  cross: "┼",
} as const;
