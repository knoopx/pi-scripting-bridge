/**
 * Empty-state row factory — a faithful port of the ide
 * `split-panel/empty-rows.ts`. Returns a pi-tui {@link Component} that
 * renders a single dim placeholder line (padded / truncated to the pane
 * width) with a no-op {@link Component.invalidate}.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderEmptyRowWithReset } from "./visible";

/** A dim placeholder row prefixed with a color reset (diff-pane style). */
export function createEmptyDiffRow(message: string, theme: Theme): Component {
  return {
    render(width: number): string[] {
      return [renderEmptyRowWithReset(message, width, theme)];
    },
    invalidate(): void {},
  };
}
