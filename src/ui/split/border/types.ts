/**
 * Border argument / context types — a faithful port of the ide
 * `split-panel/border/types.ts`. The `border` callback colors a box-drawing
 * fragment with a {@link BorderColor}; the `*Args` interfaces are the
 * parameter objects the row renderers in `./rows` and `./body` consume.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";

export type BorderColor = "border";

export interface PanelRowArgs {
  leftContent: string;
  rightContent: string;
  leftW: number;
  rightW: number;
  lb: BorderColor;
  rb: BorderColor;
  mb: BorderColor;
  border: (color: BorderColor, s: string) => string;
}

export interface BorderRowArgs {
  leftColor: BorderColor;
  middleColor: BorderColor;
  rightColor: BorderColor;
  leftStart: string;
  leftContent: string;
  middle: string;
  rightContent: string;
  rightEnd: string;
  border: (color: BorderColor, s: string) => string;
}

export interface FocusedRowArgs {
  leftStart: string;
  leftContent: string;
  middle: string;
  rightContent: string;
  rightEnd: string;
}

export interface PanelRenderCtx {
  leftRows: string[];
  leftW: number;
  rightW: number;
  lb: BorderColor;
  rb: BorderColor;
  mb: BorderColor;
  border: (color: BorderColor, s: string) => string;
}

export interface TopBorderArgs {
  leftW: number;
  rightW: number;
  leftFocus: boolean | undefined;
  rightFocus: boolean | undefined;
  theme: Theme;
}

/** The title-row separator takes the same shape as the top border args. */
export type SeparatorRowArgs = TopBorderArgs;

export interface TitleRowArgs {
  leftTitle: string;
  rightTitle: string;
  leftW: number;
  rightW: number;
  leftFocus: boolean | undefined;
  rightFocus: boolean | undefined;
  theme: Theme;
}

export interface BottomBorderArgs {
  leftW: number;
  rightW: number;
  helpText: string;
  leftFocus: boolean;
  rightFocus: boolean | undefined;
  theme: Theme;
}

export interface SplitRightPanelArgs {
  leftRows: string[];
  rightTopRows: string[];
  rightBottomRows: string[];
  leftW: number;
  rightW: number;
  rightTopH: number;
  rightBottomH: number;
  leftFocus: boolean | undefined;
  rightFocus: boolean | undefined;
  rightBottomTitle: string;
  theme: Theme;
}

export interface SimplePanelArgs {
  leftRows: string[];
  rightRows: string[];
  leftW: number;
  rightW: number;
  contentH: number;
  leftFocus: boolean | undefined;
  rightFocus: boolean | undefined;
  theme: Theme;
}
