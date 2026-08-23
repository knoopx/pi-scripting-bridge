/**
 * Bridge-native single-column item picker (a pi-tui {@link Component}).
 *
 * A `type: command` skill that wants a picker launches one by emitting a
 * top-level `pick` field in its stdout JSON; the bridge builds a
 * {@link createPicker} component from that config and mounts it via
 * `ctx.ui.custom`. The component renders a filterable single-column list in
 * a bordered frame (ide split-panel style: top border, bordered title row,
 * separator, item blocks — each up to `config.maxLines` rows when the
 * label carries embedded newlines, with a selection background spanning all
 * rows of the focused item — separator, footer help/status line, bottom
 * border) and maps keypresses onto declarative actions
 * (see {@link PickerAction}).
 *
 * Fail-open contract: a picker must never crash pi. Every action effect runs
 * inside try/catch, and the promise-returning command callbacks have their
 * rejections absorbed — on any failure the picker notifies a short error line
 * and stays open rather than throwing into the pi core.
 */
import {
  matchesKey,
  type Component,
  type KeyId,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  BORDER_LINES,
  barRow,
  bottomBorder,
  rawBarRow,
  selectionBackground,
  separator,
  titleRow,
  topBorder,
} from "./picker-border";
import { padAligned } from "./split/ansi";

/** A picker row. `id`/`label` are required; extra item fields are carried as
 * `unknown` and addressable through the config `columns`. */
export type PickerItem = { id: string; label: string } & Record<string, unknown>;

/** What a picker action does when its key is pressed. */
export type PickerEffect = "paste" | "run";

/** A declarative keybinding. The bridge always ensures the default insert
 * keybinds (`enter` and `tab`) exist (see {@link ensureEnterAction}). */
export interface PickerAction {
  /** pi-tui KeyId string (a keybinding), e.g. "enter", "escape", "ctrl+a". */
  shortcut: string;
  effect: PickerEffect;
  /** effect "run": name of a bridge-registered command; an empty or
   * absent name means the current command (the def that produced the
   * picker). */
  command?: string;
  /** effect "run": args template, {fieldName} interpolated from the
   * focused item (default "" when absent). */
  args?: string;
  /** effect "paste": text template, {fieldName} interpolated from the
   * focused item; absent pastes the item's label field. The picker closes
   * with the focused item after the insert. */
  text?: string;
  /** help-line label; default: "select" for the enter action, otherwise the
   * effect name. */
  label?: string;
}

/** One aligned column of the picker table (the `picker.columns` frontmatter
 * block): the item `field` to render, an optional visible `width` in columns
 * (auto-sized from the items' content when absent), and the `align` (left by
 * default; right for numeric/date columns). Columns render as an aligned,
 * padded table: the first (primary) column is pasted on Enter and drives the
 * per-item row height, plus one padded cell per item. */
export interface PickerColumn {
  /** item field rendered in this column */
  field: string;
  /** visible width of the column in columns (auto-sized when absent) */
  width?: number;
  /** alignment within the column (default "left") */
  align?: "left" | "right";
  /** style name for unfocused state (default "normal") — one of: "normal", "dim", "bold", "accent" */
  style?: string;
  /** style name for focused state (default: same as `style` or "accent" if `style` is "dim") */
  focusedStyle?: string;
}

export interface PickerConfig {
  /** overlay title */
  title: string;
  /** declarative keybinds; the bridge always ensures an enter action exists */
  actions: PickerAction[];
  /** Max display rows per item block: an item label may carry embedded
   * newlines; they are split into up to this many rows (further lines are
   * collapsed into the last row with a trailing ellipsis). Default 3.
   * Labels without newlines render as a single row (unchanged). */
  maxLines?: number;
  /**
   * The aligned column layout (the `columns` frontmatter key). The item rows
   * render as an aligned, padded table; the FIRST column is the primary
   * column — it is what gets pasted on Enter and its content drives the
   * per-item row height (it may carry embedded newlines). Each column adds
   * one padded cell per row (auto-width or a declared `width`, honoring
   * `align`).
   */
  columns: PickerColumn[];
}

/**
 * A split (list + preview) picker config: a {@link PickerConfig} with the
 * split-pane fields. When `split` is true the bridge mounts a
 * {@link createSplitPicker} (two panes: the filterable list on the left, a
 * per-item preview on the right) instead of the single-pane picker.
 *
 * The preview is driven by a single `previewCommand` template string (from
 * the skill's frontmatter `picker` block), not by per-item payload data: each
 * `{fieldName}` placeholder is interpolated from the focused item's fields
 * (the value is single-quoted, embedded single quotes escaped) and the result
 * is run via `/bin/sh -c`, capturing its stdout as the per-item preview lines
 * shown line-by-line in the right pane.
 *
 * - `split`: enable the split (list + preview) view.
 * - `splitWidth`: the left (list) pane ratio of the terminal width
 *   (default 0.28); must lie in [0, 1] when present.
 * - `previewCommand`: the preview command template; `{fieldName}` tokens are
 *   interpolated from the focused item. Absent (or empty) → the preview pane
 *   shows the empty-state placeholder (no preview command is run).
 */
export interface SplitPickerConfig extends PickerConfig {
  /** Enable the split (list + preview) view. */
  split?: boolean;
  /** Left (list) pane ratio of the terminal width (default 0.28). */
  splitWidth?: number;
  /**
   * The preview command template: `{fieldName}` placeholders are
   * interpolated from the focused item's fields (single-quoted, embedded
   * single quotes escaped) and the resulting command is run via `/bin/sh -c`
   * to produce the preview pane content.
   */
  previewCommand?: string;
}

export interface PickerOptions<T extends PickerItem> {
  tui: TUI;
  theme: Theme;
  items: T[];
  config: PickerConfig;
  /** resolves with the chosen item or null on cancel */
  done: (item: T | null) => void;
  /** invoke a bridge-registered command (the run effect); an empty name
   * means the current command (the def that produced the picker). The
   * optional `item` is the selected PickerItem (for command-template
   * interpolation; absent for the legacy script path). */
  runCommand: (
    name: string,
    args: string,
    item?: PickerItem,
  ) => void | Promise<void>;
  /** ui.notify (info) */
  notify: (text: string) => void;
  /** insert text into the pi editor (ctx.ui.pasteToEditor); the picker
   * closes with the focused item after the insert (paste effect) */
  pasteToEditor: (text: string) => void;
}

/** Display text for a picker item field: null/undefined → "", strings
 * pass through, other scalars via String(), objects via JSON.stringify. */
export function fieldText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

/**
 * Replace every `{name}` (name = \w+) in `template` with
 * `fieldText(item[name])`. Unmatched braces stay literal.
 */
export function interpolateTemplate(
  template: string,
  item: Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => fieldText(item[name]));
}

/**
 * Return `config` unchanged when every default insert keybind (`enter`,
 * `tab`) already has an action, otherwise append the missing insert actions
 * (the frontmatter-defined actions keep their declared precedence: the
 * defaults are appended last and matched after them).
 */
export function ensureEnterAction(config: PickerConfig): PickerConfig {
  const has = (shortcut: string): boolean =>
    config.actions.some((a) => a.shortcut === shortcut);
  const missing: PickerAction[] = [];
  if (!has("enter")) missing.push({ shortcut: "enter", effect: "paste" });
  if (!has("tab")) missing.push({ shortcut: "tab", effect: "paste" });
  if (missing.length === 0) return config;
  return {
    ...config,
    actions: [...config.actions, ...missing],
  };
}

/** The zero-config picker: type-to-filter, enter or tab to insert the
 * focused item's label into the editor and close, escape to cancel. */
export function zeroConfigPickerConfig(commandName: string): PickerConfig {
  return {
    title: commandName,
    columns: [{ field: "label" }],
    actions: [
      { shortcut: "enter", effect: "paste" },
      { shortcut: "tab", effect: "paste" },
    ],
  };
}

/** The default row cap for multi-line item labels. */
const DEFAULT_MAX_LINES = 3;

/** The effective per-item row cap from a config: `maxLines` when it is a
 * positive integer, the {@link DEFAULT_MAX_LINES} fallback otherwise
 * (fail-open: a bad value must never throw into the render). */
function maxLabelLines(config: PickerConfig): number {
  const n = config.maxLines;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    return DEFAULT_MAX_LINES;
  }
  return n;
}

/**
 * Split an item label into display rows: embedded `\n` characters become
 * row breaks, capped at `maxLines` rows. When the label has more lines than
 * the cap, lines 1..maxLines-1 are kept verbatim and the remaining lines
 * are collapsed into the last row with a trailing ellipsis.
 * A label without newlines returns a single row (the legacy render).
 */
function splitLabelLines(label: string, maxLines: number): string[] {
  const lines = label.split("\n");
  if (lines.length <= maxLines) return lines;
  const head = lines.slice(0, maxLines - 1);
  const collapsed = lines.slice(maxLines - 1).join(" ");
  return [...head, `${collapsed}…`];
}

/** Row count of every item block (1..maxLines, from the label split). */
function itemRowHeights<T extends PickerItem>(
  items: T[],
  labelField: string,
  maxLines: number,
): number[] {
  return items.map((item) =>
    splitLabelLines(fieldText(item[labelField]), maxLines).length,
  );
}

/**
 * The `[start, end)` range of whole item rows shown in a `contentRows`
 * row content area: the maximal set of whole items that fits, with the
 * focused item's first row kept in view (the focused block's rows are
 * reserved for the tail; preceding blocks fill the remaining budget).
 * For single-line items this degenerates to the legacy row window
 * (start = max(0, focus - contentRows + 1), end = min(start + contentRows, n)).
 */
function visibleItemRange(
  heights: number[],
  focusedIndex: number,
  contentRows: number,
): [number, number] {
  const n = heights.length;
  if (n === 0) return [0, 0];
  const focus = Math.max(0, Math.min(n - 1, focusedIndex));
  // Reserve the focused block's rows so its first row stays in view; fill
  // the budget above it with whole preceding blocks.
  const budgetAbove = Math.max(0, contentRows - heights[focus]);
  let start = focus;
  let used = 0;
  for (let i = focus - 1; i >= 0; i--) {
    if (used + heights[i] > budgetAbove) break;
    used += heights[i];
    start = i;
  }
  // Forward: maximal set of whole blocks that fits the content area.
  let end = start;
  let usedRows = 0;
  for (let i = start; i < n; i++) {
    if (i > start && usedRows + heights[i] > contentRows) break;
    usedRows += heights[i];
    end = i + 1;
  }
  return [start, end];
}

/** Mutable picker state: filter query, visible items, focus, finish guard. */
export interface PickerState<T extends PickerItem> {
  query: string;
  filteredItems: T[];
  focusedIndex: number;
  doneCalled: boolean;
}

/** The picker content height in rows (6 non-content frame lines excluded:
 * top border, title row, both separators, footer, bottom border — see
 * picker-border.ts). */
function pickerContentHeight(tui: TUI): number {
  return Math.max(1, tui.terminal.rows - BORDER_LINES);
}

/** Filter `items` by `q` (case-insensitive) across every configured column
 * (the first column is the label); an empty needle returns all items. */
function filterItems<T extends PickerItem>(
  items: T[],
  columns: PickerColumn[],
  q: string,
): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    columns
      .map((col) => fieldText(item[col.field]).toLowerCase())
      .some((h) => h.includes(needle)),
  );
}

/** Re-apply the filter and clamp the focus into the visible range. */
function refilterState<T extends PickerItem>(
  state: PickerState<T>,
  options: PickerOptions<T>,
): void {
  state.filteredItems = filterItems(
    options.items,
    options.config.columns,
    state.query,
  );
  const max = state.filteredItems.length - 1;
  state.focusedIndex = Math.max(0, Math.min(max, state.focusedIndex));
}

/** Re-apply the filter and request a re-render — the shared tail of the
 * backspace and printable-char filter branches. */
function refilterAndRender<T extends PickerItem>(
  state: PickerState<T>,
  options: PickerOptions<T>,
): void {
  refilterState(state, options);
  options.tui.requestRender();
}

/** The focused item, or null when the visible list is empty. */
export function focusedItem<T extends PickerItem>(state: PickerState<T>): T | null {
  if (state.filteredItems.length === 0) return null;
  return state.filteredItems[state.focusedIndex] ?? null;
}

/** Resolve the picker: the first call wins (later calls are ignored). */
function finishPick<T extends PickerItem>(
  state: PickerState<T>,
  options: PickerOptions<T>,
  item: T | null,
): void {
  if (state.doneCalled) return;
  state.doneCalled = true;
  options.done(item);
}

/** One line of short error text (truncated to 80 chars). */
function shortErr(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 80 ? `${m.slice(0, 80)}…` : m;
}

/** Absorb a promise-returning command callback so a later rejection never
 * reaches pi unhandled. */
function settleCommand<T extends PickerItem>(
  options: PickerOptions<T>,
  v: void | Promise<void>,
): void {
  if (v && typeof (v).catch === "function") {
    (v).catch((e) => {
      options.notify(`picker: ${shortErr(e)}`);
      options.tui.requestRender();
    });
  }
}

/** Run a command-effect callback (absorbing its rejection via
 * settleCommand), then resolve the pick with `item`. Shared by the "paste"
 * and "run" effects. */
function settleAndFinish<T extends PickerItem>(
  options: PickerOptions<T>,
  state: PickerState<T>,
  item: T,
  run: () => void | Promise<void>,
): void {
  settleCommand(options, run());
  finishPick(state, options, item);
}

/** Move the focus by `delta` (clamped to the visible range). */
function moveFocus<T extends PickerItem>(
  state: PickerState<T>,
  tui: TUI,
  delta: number,
): void {
  const max = state.filteredItems.length - 1;
  state.focusedIndex = Math.max(0, Math.min(max, state.focusedIndex + delta));
  tui.requestRender();
}

/** The first configured action whose shortcut matches `data` (in order). */
function matchConfiguredAction(
  config: PickerConfig,
  data: string,
): PickerAction | null {
  for (const action of config.actions) {
    if (matchesKey(data, action.shortcut as KeyId)) {
      return action;
    }
  }
  return null;
}

/** Execute one picker action against the focused item; effect errors are
 * reported via notify (fail-open), never thrown. */
function executePickerAction<T extends PickerItem>(
  options: PickerOptions<T>,
  state: PickerState<T>,
  action: PickerAction,
  item: T | null,
): void {
  switch (action.effect) {
    case "paste":
      if (item) {
        settleAndFinish(options, state, item, () => {
          const labelField = options.config.columns[0].field;
          const text =
            action.text !== undefined
              ? interpolateTemplate(action.text, item)
              : fieldText(item[labelField]);
          options.pasteToEditor(text);
        });
      }
      break;
    case "run":
      if (item) {
        settleAndFinish(
          options,
          state,
          item,
          () =>
            options.runCommand(
              action.command ?? "",
              interpolateTemplate(action.args ?? "", item),
              item,
            ),
        );
      }
      break;
  }
}

/**
 * Handle one keypress (the full input pipeline): escape cancels, backspace
 * drops the last filter char, configured actions consume the input in
 * order (first match), arrow/page keys navigate, and printable chars
 * extend the filter.
 */
export function handlePickerInput<T extends PickerItem>(
  options: PickerOptions<T>,
  state: PickerState<T>,
  config: PickerConfig,
  data: string,
): void {
  // 1. escape -> cancel (done(null))
  if (matchesKey(data, "escape")) {
    finishPick(state, options, null);
    return;
  }
  // 2. backspace (backspace key, \x7f, or \b) -> drop last filter char
  if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
    state.query = state.query.slice(0, -1);
    refilterAndRender(state, options);
    return;
  }
  // 3. configured actions, in order (first match consumes the input)
  const action = matchConfiguredAction(config, data);
  if (action !== null) {
    try {
      executePickerAction(options, state, action, focusedItem(state));
    } catch (err) {
      options.notify(`picker: ${shortErr(err)}`);
      options.tui.requestRender();
    }
    return;
  }
  // 4. navigation (page offset = contentHeight - 1, min 1)
  if (matchesKey(data, "up")) {
    moveFocus(state, options.tui, -1);
    return;
  }
  if (matchesKey(data, "down")) {
    moveFocus(state, options.tui, 1);
    return;
  }
  const page = Math.max(1, pickerContentHeight(options.tui) - 1);
  if (matchesKey(data, "pageUp")) {
    moveFocus(state, options.tui, -page);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    moveFocus(state, options.tui, page);
    return;
  }
  // 5. printable char -> append to filter
  if (data.length === 1 && data >= " " && data <= "~") {
    state.query += data;
    refilterAndRender(state, options);
  }
}

/** Apply a named style to text via the theme object. Supported styles:
 * "dim" → theme.fg("dim", t); "bold" → theme.bold(t);
 * "accent" → theme.fg("accent", t); default → text unchanged. */
function applyStyle(theme: Theme, style: string, text: string): string {
  switch (style) {
    case "dim":
      return theme.fg("dim", text);
    case "bold":
      return theme.bold(text);
    case "accent":
      return theme.fg("accent", text);
    default:
      return text;
  }
}

/** The bordered item rows (or the single dim "No items" line when empty).
 * Each item renders as an aligned table block: the first column is the
 * primary (label) column — dim when unfocused, accent when focused by
 * default — plus one padded cell per remaining column (honoring `align`).
 * The label may carry embedded newlines and split into up to `config.maxLines`
 * rows; the other cells appear only on the item's FIRST row (continuation
 * rows carry empty padded cells so the columns stay aligned). The focused
 * item carries a full-width selection background spanning ALL of its rows. */
function renderItemLines<T extends PickerItem>(
  options: PickerOptions<T>,
  state: PickerState<T>,
  innerWidth: number,
): string[] {
  const { theme, tui } = options;
  const lines: string[] = [];
  if (state.filteredItems.length === 0) {
    lines.push(barRow(theme, theme.fg("dim", " No items"), innerWidth, "border"));
    return lines;
  }
  const columns = options.config.columns;
  const labelField = columns[0].field;
  const maxLines = maxLabelLines(options.config);
  const widths = layoutColumnWidths(
    columns,
    state.filteredItems,
    innerWidth,
    maxLines,
  );
  const heights = itemRowHeights(state.filteredItems, labelField, maxLines);
  const [start, end] = visibleItemRange(
    heights,
    state.focusedIndex,
    pickerContentHeight(tui),
  );
  // One column cell: the primary column (index 0) defaults to dim/accent;
  // the remaining columns default to normal (accent when their style is dim).
  const renderCell = (colIdx: number, text: string, focused: boolean): string => {
    const col = columns[colIdx];
    const unfocusedStyle =
      colIdx === 0 ? (col.style ?? "dim") : (col.style ?? "normal");
    const focusedStyle =
      colIdx === 0
        ? (col.focusedStyle ?? "accent")
        : (col.focusedStyle ??
          (unfocusedStyle === "dim" ? "accent" : unfocusedStyle));
    const activeStyle = focused ? focusedStyle : unfocusedStyle;
    const styled =
      activeStyle === "normal" ? text : applyStyle(theme, activeStyle, text);
    return padAligned(styled, widths[colIdx], col.align ?? "left", "");
  };
  for (let i = start; i < end; i++) {
    const item = state.filteredItems[i];
    const focused = i === state.focusedIndex;
    const labelLines = splitLabelLines(fieldText(item[labelField]), maxLines);
    // other cells appear only on row 0
    const dataCells = columns.slice(1).map((col, idx) =>
      renderCell(
        idx + 1,
        fieldText(item[col.field]).replace(/\n/g, " "),
        focused,
      ),
    );
    const emptyCells = columns.slice(1).map((_, idx) => " ".repeat(widths[idx + 1]));
    labelLines.forEach((line, li) => {
      const labelCell = renderCell(0, line, focused);
      const cells =
        li === 0 ? [labelCell, ...dataCells] : [labelCell, ...emptyCells];
      const cell = " " + cells.join(" ");
      const content = focused ? selectionBackground(theme, cell, innerWidth) : cell;
      lines.push(
        focused
          ? rawBarRow(theme, content, "border")
          : barRow(theme, cell, innerWidth, "border"),
      );
    });
  }
  return lines;
}

/**
 * Visible widths for the whole table row (the primary/label column first,
 * then each remaining column). A row renders as `" " + cells.join(" ")` over
 * all `n` columns — a leading space plus `n - 1` separators — so the column
 * widths must sum to exactly `innerWidth - n`.
 *
 * The layout serves a "main content column + compact side columns" table:
 *  - A column with a declared `width` (finite, >= 2) is capped at that width;
 *    any column without a declared width (including the primary) is
 *    unbounded (content-fit).
 *  - The unbounded column with the largest content width is the MAIN column;
 *    it absorbs ALL leftover space, so the row always sums to the budget —
 *    its content shows fully (left-aligned, no truncation) when space is
 *    free, and it is the first column to truncate when the terminal is too
 *    narrow.
 *  - Side/aux columns keep their content (content-fit, capped by a declared
 *    width when one is set) and are never stretched to fill space.
 *  - Over-budget (the non-main columns alone already exceed the budget), the
 *    main column shrinks to 1 and, if that still overflows, every column is
 *    scaled down proportionally (never below 1) — the prior behavior.
 * Truncation to an allocation renders a trailing ellipsis via `padAligned`.
 */
function layoutColumnWidths(
  columns: PickerColumn[],
  items: PickerItem[],
  innerWidth: number,
  maxLines: number,
): number[] {
  const n = columns.length;
  // `n` cells render as `" " + cells.join(" ")` (leading space plus n-1
  // separators), so the column widths must sum to exactly `innerWidth - n`.
  const budget = Math.max(0, innerWidth - n);
  // Content width per column: the primary column (index 0, the label) is the
  // widest rendered line of its newline-split content (up to `maxLines`
  // rows); the other columns are their widest single-line cell (newlines →
  // spaces).
  const content = columns.map((col, idx) => {
    let max = 0;
    for (const item of items) {
      if (idx === 0) {
        for (const line of splitLabelLines(fieldText(item[col.field]), maxLines)) {
          max = Math.max(max, visibleWidth(line));
        }
      } else {
        const text = fieldText(item[col.field]).replace(/\n/g, " ");
        max = Math.max(max, visibleWidth(text));
      }
    }
    return max;
  });
  // A declared `width` (finite, >= 2) caps the column (including the
  // primary); any column without a declared width is unbounded (content-fit).
  const caps = columns.map((col) => {
    const w = col.width;
    return typeof w === "number" && Number.isFinite(w) && w >= 2
      ? Math.floor(w)
      : Infinity;
  });
  // MAIN column: the unbounded column with the largest content width. When
  // none exists (every column declared a width), mainIdx stays -1 and no
  // column absorbs leftover space.
  let mainIdx = -1;
  let mainContent = 0;
  for (let i = 0; i < content.length; i++) {
    if (caps[i] === Infinity && content[i] > mainContent) {
      mainContent = content[i];
      mainIdx = i;
    }
  }
  // Non-main columns keep their content: capped by a declared width, or
  // content-fit when unbounded. The main column is 0 here (filled below).
  const widths = content.map((c, i) =>
    i === mainIdx ? 0 : Math.max(1, Math.min(c, caps[i])),
  );
  const othersSum = widths.reduce((a, b) => a + b, 0);
  if (mainIdx !== -1) {
    // The main column absorbs all leftover space so the row sums to budget.
    widths[mainIdx] = Math.max(1, budget - othersSum);
  }
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= budget) return widths;
  // The non-main columns alone exceed the budget: scale every column down
  // proportionally (never below 1) — the prior over-budget behavior.
  const factor = budget / total;
  return widths.map((w) => Math.max(1, Math.floor(w * factor)));
}

/** The footer help/status line: key help labels plus the active filter
 * query as a dim status suffix. */
function renderFooterLine<T extends PickerItem>(
  options: PickerOptions<T>,
  state: PickerState<T>,
  innerWidth: number,
): string {
  const parts: string[] = ["esc cancel", "type filter"];
  for (const a of options.config.actions) {
    if (a.shortcut === "escape") continue;
    const label = a.label ?? (a.effect === "paste" ? "insert" : a.effect);
    parts.push(`${a.shortcut} ${label}`);
  }
  const status =
    state.query.length > 0 ? ` ${options.theme.fg("dim", `<${state.query}>`)}` : "";
  return barRow(
    options.theme,
    ` ${options.theme.fg("dim", parts.join(" · "))}${status}`,
    innerWidth,
    "border",
  );
}

/** Render the full picker frame (top border, title row, separators, item
 * lines, footer, bottom border) as the line list for this width. */
function renderPickerLines<T extends PickerItem>(
  options: PickerOptions<T>,
  state: PickerState<T>,
  config: PickerConfig,
  width: number,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  return [
    // 1. top border (plain border)
    topBorder(options.theme, innerWidth),
    // 2. title row: plain border bars with the accent title
    titleRow(options.theme, config.title, innerWidth),
    // 3. top separator (plain border)
    separator(options.theme, innerWidth),
    // 4. bordered item lines (plain border bars)
    ...renderItemLines(options, state, innerWidth),
    // 5. bottom separator (plain border)
    separator(options.theme, innerWidth),
    // 6. footer (help/status line) — plain border bars, dim text
    renderFooterLine(options, state, innerWidth),
    // 7. bottom border (plain border)
    bottomBorder(options.theme, innerWidth),
  ];
}

/** Build the picker component. */
export function createPicker<T extends PickerItem>(options: PickerOptions<T>): Component {
  const config = ensureEnterAction(options.config);

  // closure state
  const state: PickerState<T> = {
    query: "",
    filteredItems: options.items,
    focusedIndex: 0,
    doneCalled: false,
  };

  const component: Component & { dispose(): void } = {
    render: (width: number) =>
      renderPickerLines(options, state, config, width),
    handleInput: (data: string) =>
      handlePickerInput(options, state, config, data),
    invalidate(): void {
      /* stateless render; nothing to reset */
    },
    dispose(): void {
      /* nothing to dispose */
    },
  };
  return component;
}