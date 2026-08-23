/**
 * A single list-item row — a faithful port of the ide
 * `split-panel/list-row.ts`. The item text is clipped to the row width; a
 * selected item is rendered accent + bold on the selection background, a
 * "current" item (e.g. the focused diff) in the warning color, and an
 * ordinary item plain.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateAnsi } from "./ansi";
import { Row } from "./row";
import { applySelectionBackground } from "./visible";

interface ListRowProps {
  text: string;
  width: number;
  isSelected?: boolean;
  isCurrent?: boolean;
  theme?: Theme;
}

export class ListRow extends Row<Omit<ListRowProps, "width">> {
  protected renderLine(width: number): string {
    const truncated = truncateAnsi(this.props.text, width);
    return this.applyRowStyle(truncated, width);
  }

  private applyRowStyle(truncated: string, width: number): string {
    const theme = this.props.theme;
    if (!theme) {
      return truncated;
    }
    if (this.props.isSelected) {
      return this.renderSelected(truncated, width, theme);
    }
    if (this.props.isCurrent) {
      return this.renderCurrent(truncated, theme);
    }
    return truncated;
  }

  private renderSelected(
    truncated: string,
    width: number,
    theme: Theme,
  ): string {
    const styled = theme.fg("accent", theme.bold(truncated));
    return applySelectionBackground(styled, width, theme);
  }

  private renderCurrent(truncated: string, theme: Theme): string {
    return theme.fg("warning", truncated);
  }
}
