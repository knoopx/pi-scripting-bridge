/**
 * Mock ExtensionContext for the picker-capable ui surface. Its ui.custom
 * captures the item-picker overlay (returning the promise the bridge awaits)
 * and its ui.pasteToEditor records paste calls into a caller-provided state
 * object, so tests can drive the picker and assert on the surfaced result.
 * The shared TUI-mode surface lives in ctx-base.ts (sharedCtx); this builder
 * only supplies the picker's ui surface, mode/hasUI gate, and empty branch.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sharedCtx, type Notified } from "./ctx-base.js";

/** A captured ui.custom (item-picker overlay) call. */
export interface PickerCustomCapture {
  factory: (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    done: (item: unknown) => void,
  ) => { handleInput?: (d: string) => void; render?: (w: number) => string[] };
  options: Record<string, unknown>;
  component: { handleInput?: (d: string) => void; render?: (w: number) => string[] };
  /** Resolve the picker promise with the chosen item (or null). */
  done: (item: unknown) => void;
}

/** Per-test capture state for the picker-capable ui surface. */
export interface PickerUiState {
  customCalls: PickerCustomCapture[];
  pasteCalls: string[];
}

/**
 * Build a mock ExtensionContext whose ui surface captures the item-picker
 * overlay (ui.custom) and the editor paste (ui.pasteToEditor). `mode` and
 * `hasUI` drive the bridge's picker-launch gate (TUI only): the picker is
 * launched only when hasUI is true and mode is "tui". The ui.custom factory
 * is invoked synchronously with a mock tui/theme; its returned component's
 * done callback resolves the promise the bridge awaits.
 */
export function createPickerCtx(
  cwd: string,
  notified: Notified,
  uiState: PickerUiState,
  opts: { mode?: string; hasUI?: boolean } = {},
): ExtensionContext {
  const mode = opts.mode ?? "tui";
  const hasUI = opts.hasUI ?? true;
  const custom = (factory: unknown, options?: Record<string, unknown>) => {
    const factoryFn = factory as (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (item: unknown) => void,
    ) => { handleInput?: (d: string) => void; render?: (w: number) => string[] };
    const tui = { terminal: { rows: 10 }, requestRender: () => {} };
    const theme = {
      bold: (t: string) => t,
      fg: (_c: string, t: string) => t,
    };
    let resolveDone: (item: unknown) => void = () => {};
    const promise = new Promise<unknown>((resolve) => {
      resolveDone = resolve;
    });
    const component = factoryFn(tui, theme, {}, (item: unknown) => {
      resolveDone(item);
    });
    uiState.customCalls.push({
      factory: factoryFn,
      options: options ?? {},
      component,
      done: (item: unknown) => resolveDone(item),
    });
    return promise;
  };
  return sharedCtx(
    cwd,
    notified,
    {
      ui: {
        notify: (msg: string, type?: "info" | "warning" | "error") => {
          notified.push({ msg, type });
        },
        custom,
        pasteToEditor: (text: string) => {
          uiState.pasteCalls.push(text);
        },
      },
      mode,
      hasUI,
    },
    () => [],
  );
}
