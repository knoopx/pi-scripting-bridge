/**
 * Bridge-native split (list + preview) picker — a faithful port of the ide
 * `list-picker` split-pane component. A two-pane overlay: a filterable list
 * of items on the left (one row per item, selection background on the
 * focused row) and a per-item preview on the right (the item's
 * {@link SplitPickerOptions.loadPreview} lines, page-scrollable).
 *
 * The layout is the full-frame {@link renderSplitPanel} (6 non-content frame
 * lines: top border, title row, separator, content, separator, footer,
 * bottom border). The footer text is identical to the single-pane picker
 * (help labels + active filter status).
 *
 * Input: the full {@link handlePickerInput} pipeline (filter, actions,
 * navigation, enter) plus shift+pageUp/shift+pageDown, which page-scroll
 * the PREVIEW pane (checked before generic navigation — the ide binding
 * precedence). A focus change loads the new item's preview via
 * {@link loadPreviewItem} (cached, with a monotonic load-token so a stale
 * async load never clobbers a newer focus) and resets the preview scroll.
 *
 * Fail-open: `loadPreview` is wrapped in try/catch; a failure leaves the
 * preview empty and keeps the picker open.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
  PickerItem,
  PickerOptions,
  PickerState,
  SplitPickerConfig,
} from "./picker";
import {
  ensureEnterAction,
  fieldText,
  focusedItem,
  handlePickerInput,
} from "./picker";
import {
  calculateDimensions,
  calculateDiffScroll,
  type SplitPanelRows,
} from "./split/layout";
import { renderSplitPanel } from "./split/border/renderer";
import { renderListPane } from "./split/list-pane-renderer";
import { ListRow } from "./split/list-row";
import { renderSourceRows } from "./split/content";

/** A {@link PickerOptions} for the split picker: a split config plus the
 * preview loader. */
export interface SplitPickerOptions<T extends PickerItem>
  extends Omit<PickerOptions<T>, "config"> {
  config: SplitPickerConfig;
  /** Load the preview lines for an item (the command's `previewCommand`
   * template, `{fieldName}`-interpolated from the item, run via `/bin/sh -c`
   * and its stdout split on newlines). Failures are absorbed (empty preview,
   * picker stays open). */
  loadPreview: (item: T) => Promise<string[]>;
}

/** Split picker state: the base {@link PickerState} plus the preview cache,
 * current preview lines, preview scroll offset, last rendered width (used
 * as the cached width for {@link calculateDiffScroll}), and a monotonic
 * load token so a stale async preview load never clobbers a newer focus. */
interface SplitPickerState<T extends PickerItem>
  extends PickerState<T> {
  /** Preview cache: item identity key → loaded lines. */
  previewCache: Map<string, string[]>;
  /** The preview lines currently shown in the right pane. */
  previewLines: string[];
  /** The preview pane's current scroll offset. */
  previewScroll: number;
  /** The last rendered terminal width (cached width for scroll math). */
  lastWidth: number;
  /** Monotonic token guarding against stale async preview loads. */
  loadToken: number;
}

/** The cache key for an item's preview: the item's unique id (the preview
 * content is derived from the item's fields via the command's `previewCommand`
 * template, so one cache entry per distinct item). */
function previewCacheKey<T extends PickerItem>(item: T): string {
  return item.id;
}

/** Load an item's preview lines (from the cache or `options.loadPreview`),
 * caching the result. Failures return an empty array (fail-open). */
async function resolvePreviewLines<T extends PickerItem>(
  state: SplitPickerState<T>,
  options: SplitPickerOptions<T>,
  item: T,
): Promise<string[]> {
  const key = previewCacheKey(item);
  const cached = state.previewCache.get(key);
  if (cached) return cached;
  let lines: string[];
  try {
    lines = await options.loadPreview(item);
  } catch {
    lines = [];
  }
  state.previewCache.set(key, lines);
  return lines;
}

/** Apply resolved preview lines to `state` (only when the load is not
 * stale), reset the preview scroll, and request a render. */
function applyPreviewLines<T extends PickerItem>(
  state: Pick<SplitPickerState<T>, "loadToken" | "previewLines" | "previewScroll">,
  options: SplitPickerOptions<T>,
  token: number,
  lines: string[],
): void {
  // A newer focus (a higher token) has superseded this load: drop it.
  if (token !== state.loadToken) return;
  state.previewLines = lines;
  state.previewScroll = 0;
  options.tui.requestRender();
}

/** Load the preview for an item (from cache or `options.loadPreview`),
 * apply it to `state` only when the load is not stale, and reset the
 * preview scroll. Failures leave the preview empty (fail-open). */
async function loadPreviewItem<T extends PickerItem>(
  state: SplitPickerState<T>,
  options: SplitPickerOptions<T>,
  item: T,
): Promise<void> {
  const token = ++state.loadToken;
  const lines = await resolvePreviewLines(state, options, item);
  applyPreviewLines(state, options, token, lines);
}

/** Page-scroll the preview pane by one viewport (up/down), via
 * {@link calculateDiffScroll} (the task-mandated scroll helper; the cached
 * width tracks the last rendered width). */
function scrollPreview(
  state: {
    previewScroll: number;
    previewLines: string[];
    lastWidth: number;
  },
  tui: TUI,
  direction: "up" | "down",
): void {
  state.previewScroll = calculateDiffScroll({
    direction,
    currentScroll: state.previewScroll,
    contentLength: state.previewLines.length,
    terminalRows: tui.terminal.rows,
    cachedWidth: state.lastWidth || 200,
  });
  tui.requestRender();
}

/** The focused pane titles: the list title (item count) and the preview
 * title. */
function buildSplitTitles(
  state: SplitPickerState<PickerItem>,
  config: SplitPickerConfig,
): { leftTitle: string; rightTitle: string } {
  const leftTitle = ` ${config.title} (${state.filteredItems.length})`;
  const rightTitle = ` Preview`;
  return { leftTitle, rightTitle };
}

/** The help-line label for one configured action: its explicit `label`,
 * else "insert" for the paste effect, else the effect name. */
function actionHelpLabel(
  action: { shortcut: string; effect: string; label?: string },
): string {
  return action.label ?? (action.effect === "paste" ? "insert" : action.effect);
}

/** The active-filter suffix appended to the help line (dim, `" <query>"`). */
function buildFilterSuffix(query: string, theme: Theme): string {
  if (query.length === 0) return "";
  return ` ${theme.fg("dim", `<${query}>`)}`;
}

/** The footer help/status line: identical to the single-pane picker
 * (esc/type labels + action labels + active filter query). */
function buildSplitHelp(
  state: SplitPickerState<PickerItem>,
  config: SplitPickerConfig,
  theme: Theme,
): string {
  const parts: string[] = ["esc cancel", "type filter"];
  for (const a of config.actions) {
    if (a.shortcut === "escape") continue;
    parts.push(`${a.shortcut} ${actionHelpLabel(a)}`);
  }
  return `${parts.join(" · ")}${buildFilterSuffix(state.query, theme)}`;
}

/** Render the split picker frame (list pane + preview pane) as lines. */
function renderSplitPickerLines<T extends PickerItem>(
  options: SplitPickerOptions<T>,
  state: SplitPickerState<T>,
  config: SplitPickerConfig,
  width: number,
): string[] {
  const { theme, tui } = options;
  const terminalRows = tui.terminal.rows;
  state.lastWidth = width;

  const dims = calculateDimensions(terminalRows, width, {
    leftTitle: "",
    rightTitle: "",
    helpText: "",
    leftFocus: true,
    rightSplit: false,
    leftRatio: config.splitWidth ?? 0.28,
  });

  const { leftW, rightW, contentH } = dims;

  // Left pane: the filterable list (one row per item; multi-line labels
  // collapse to a single row — ide list-pane behavior).
  const leftRows = renderListPane<PickerItem>({
    items: state.filteredItems,
    selectedIndex: state.focusedIndex,
    height: contentH,
    width: leftW,
    theme,
    emptyMessage: "No items",
    createRow: (item, index) =>
      new ListRow({
        text: fieldText(item[config.columns[0]?.field ?? "label"]).replace(/\n/g, " "),
        isSelected: index === state.focusedIndex,
        theme,
      }),
  });

  // Right pane: the per-item preview (diff rows, page-scrolled).
  const rightRows = renderSourceRows({
    lines: state.previewLines,
    width: rightW,
    height: contentH,
    scroll: state.previewScroll,
    theme,
  });

  const { leftTitle, rightTitle } = buildSplitTitles(state, config);
  const helpText = buildSplitHelp(state, config, theme);

  const rows: SplitPanelRows = { left: leftRows, right: rightRows };

  return renderSplitPanel(
    theme,
    {
      leftTitle,
      rightTitle,
      rightTopTitle: rightTitle,
      helpText,
      leftFocus: true,
      rightSplit: false,
    },
    dims,
    rows,
  );
}

/** Page-scroll the preview pane on shift+pageUp/shift+pageDown (checked
 * before generic navigation — the ide binding precedence). */
function handlePreviewScroll(
  state: {
    previewScroll: number;
    previewLines: string[];
    lastWidth: number;
  },
  tui: TUI,
  data: string,
): boolean {
  if (matchesKey(data, Key.shift("pageUp"))) {
    scrollPreview(state, tui, "up");
    return true;
  }
  if (matchesKey(data, Key.shift("pageDown"))) {
    scrollPreview(state, tui, "down");
    return true;
  }
  return false;
}

/** Post-input preview bookkeeping: a focus change loads the new item's
 * preview; a resolved pick (cancel/enter) is done — the base pipeline
 * handled it; otherwise request a render. */
function postInputPreviewUpdate<T extends PickerItem>(
  state: SplitPickerState<T>,
  options: SplitPickerOptions<T>,
  prevFocus: number,
): void {
  if (state.doneCalled) return;
  if (state.focusedIndex === prevFocus) {
    options.tui.requestRender();
    return;
  }
  const item = focusedItem(state);
  if (item) void loadPreviewItem(state, options, item);
}

/** The split picker component: the full render + input + preview pipeline. */
export function createSplitPicker<T extends PickerItem>(
  options: SplitPickerOptions<T>,
): Component {
  const config = ensureEnterAction(options.config);

  const state: SplitPickerState<T> = {
    query: "",
    filteredItems: options.items,
    focusedIndex: 0,
    doneCalled: false,
    previewCache: new Map(),
    previewLines: [],
    previewScroll: 0,
    lastWidth: 200,
    loadToken: 0,
  };

  // Load the initial preview for the first item (fail-open).
  if (state.filteredItems.length > 0) {
    void loadPreviewItem(state, options, state.filteredItems[0]);
  }

  const component: Component & { dispose(): void } = {
    render: (width: number) =>
      renderSplitPickerLines(options, state, config, width),
    handleInput: (data: string) => {
      // Preview scroll (checked before generic navigation — the ide
      // binding precedence).
      if (handlePreviewScroll(state, options.tui, data)) return;
      const prevFocus = state.focusedIndex;
      handlePickerInput(options, state, config, data);
      postInputPreviewUpdate(state, options, prevFocus);
    },
    invalidate(): void {
      /* stateless render; nothing to reset */
    },
    dispose(): void {
      state.previewCache.clear();
    },
  };
  return component;
}
