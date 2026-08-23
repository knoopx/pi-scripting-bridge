/**
 * A single diff/source line — a faithful port of the ide
 * `split-panel/diff-row.ts`. A divider line renders in the muted color; an
 * ordinary line expands tabs (local tab stop of 2, matching the ide), is
 * clipped to `width - 1` (leaving room for the row's leading space), and is
 * padded back to the full width. A leading reset keeps the line from
 * inheriting the previous row's color.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ensureWidth, truncateAnsi } from "./ansi";
import { Row } from "./row";

interface DiffRowProps {
  line: string;
  isDivider?: boolean;
  theme: Theme;
}

export class DiffRow extends Row<Omit<DiffRowProps, "width">> {
  protected renderLine(width: number): string {
    const reset = "\x1b[0m";

    if (this.props.isDivider) {
      return ensureWidth(
        reset + this.props.theme.fg("muted", this.props.line),
        width,
      );
    }
    const expanded = expandTabs(this.props.line);
    const content = ` ${expanded}`;
    const truncated = truncateAnsi(content, width - 1);
    return ensureWidth(reset + truncated, width);
  }
}

/** Local tab expansion with a 2-column stop (the ide DiffRow default). */
function expandTabs(text: string, tabWidth = 2): string {
  return text.replace(/\t/g, " ".repeat(tabWidth));
}
