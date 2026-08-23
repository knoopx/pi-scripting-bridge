/**
 * Source/diff pane row rendering — a faithful port of the ide
 * `split-panel/content.ts` (the parts the split picker uses). Each source
 * line is wrapped in a {@link DiffRow} (leading space, tab expansion, clip +
 * pad). The ide renders source lines through its `highlightCodeLines`
 * (file-preview) module; the bridge has no such dependency, so
 * {@link renderSourceRows} accepts an optional `highlighter` and falls back
 * to an accent foreground for highlighted lines when none is supplied.
 *
 * Note: the slice `lines.slice(scroll, scroll + scroll + height)` preserves
 * the ide's exact (deliberately quirky) windowing — see the comment at the
 * call site.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DiffRow } from "./diff-row";
import { createEmptyDiffRow } from "./empty-rows";

type HighlightRange = { start: number; end: number };

/** A caller-supplied line highlighter (stands in for the ide file-preview
 * `highlightCodeLines`); `emphasized` marks lines inside the highlight
 * range. */
type LineHighlighter = (text: string, theme: Theme, emphasized: boolean) => string;

function isInHighlightRange(
  lineNum: number,
  highlightRange: HighlightRange | undefined,
): boolean {
  return !!(
    highlightRange &&
    lineNum >= highlightRange.start &&
    lineNum <= highlightRange.end
  );
}

function renderSourceLine(
  text: string,
  lineNum: number,
  theme: Theme,
  highlightRange: HighlightRange | undefined,
  width: number,
  highlighter: LineHighlighter | undefined,
): string {
  const isHighlighted = isInHighlightRange(lineNum, highlightRange);
  const styledLine = highlighter
    ? highlighter(text, theme, isHighlighted)
    : isHighlighted
      ? theme.fg("accent", text)
      : text;
  const row = new DiffRow({
    line: ` ${styledLine}`,
    isDivider: false,
    theme,
  });
  return row.render(width)[0];
}

/** Render the visible window of a source/preview pane as diff rows. */
export function renderSourceRows(options: {
  lines: string[];
  width: number;
  height: number;
  scroll: number;
  theme: Theme;
  highlightRange?: HighlightRange;
  highlighter?: LineHighlighter;
}): string[] {
  const { lines, width, height, scroll, theme, highlightRange, highlighter } =
    options;
  if (lines.length === 0) {
    const empty = createEmptyDiffRow(" No preview available", theme);
    return empty.render(width);
  }
  // Preserved verbatim from the ide: the window start is `scroll` but the
  // length is `scroll + height` (an intentional quirk of the ide slice).
  const visible = lines.slice(scroll, scroll + scroll + height);
  const rows: string[] = [];

  for (let i = 0; i < visible.length; i++) {
    const lineNum = scroll + i + 1;
    rows.push(
      renderSourceLine(visible[i], lineNum, theme, highlightRange, width, highlighter),
    );
  }

  return rows;
}
