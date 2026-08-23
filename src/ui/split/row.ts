/**
 * Abstract base for single-line panel rows — a faithful port of the ide
 * `row.ts`. A `Row` is a pi-tui {@link Component} that renders exactly one
 * line: subclasses implement {@link renderLine} and the base `render` wraps
 * it in a one-element array. `invalidate` is a no-op (rows are stateless; the
 * parent pane re-renders them on demand).
 */
import type { Component } from "@earendil-works/pi-tui";

export abstract class Row<P = Record<string, never>> implements Component {
  protected readonly props: P;

  constructor(props: P) {
    this.props = props;
  }

  render(width: number): string[] {
    return [this.renderLine(width)];
  }

  // fallow-ignore-next-line unused-class-member -- pi-tui Component interface requires invalidate(): void (pi-tui/dist/tui.d.ts:30); no-op override is interface conformance
  invalidate(): void {}

  protected abstract renderLine(width: number): string;
}
