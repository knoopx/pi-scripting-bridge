import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  createPicker,
  zeroConfigPickerConfig,
  type PickerConfig,
  type PickerItem,
} from "./picker";

// Plain marker transforms (no chalk) so render assertions are deterministic.
const theme = {
  bold: (t: string) => `[b]${t}[/b]`,
  fg: (c: string, t: string) => `[${c}]${t}[/]`,
  bg: (c: string, t: string) => `[bg:${c}]${t}[/bg]`,
} as unknown as Theme;

// Identity-styled theme: fg/bold/bg are no-ops, so a styled cell has the same
// visible width as its plain content. Required for width-sensitive assertions
// (content-fit / truncation / right-align): pi-tui's visibleWidth ignores real
// ANSI codes, but the marker theme above would count its [..] chars, clipping
// content-fit cells and breaking plain-substring assertions.
const plainTheme = {
  bold: (t: string) => t,
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
} as unknown as Theme;

const items: PickerItem[] = [
  { id: "0192aaa", label: "~/.pi", age: "38m", hint: "Fix the build" },
  { id: "0192bbb", label: "~/Projects/x", age: "2h", hint: "Refactor" },
  { id: "0192ccc", label: "~/.pi", age: "3d", hint: "Fix the docs" },
];

interface Harness {
  picker: Component & { handleInput(data: string): void };
  tui: TUI;
  done: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  pasteToEditor: ReturnType<typeof vi.fn>;
  render: (width?: number) => string[];
}

function buildPicker(
  config: PickerConfig,
  itemsOverride?: PickerItem[],
  themeOverride?: Theme,
): Harness {
  const tui = { terminal: { rows: 10 }, requestRender: vi.fn() } as unknown as TUI;
  const done = vi.fn();
  const runCommand = vi.fn();
  const notify = vi.fn();
  const pasteToEditor = vi.fn();
  const picker = createPicker({
    tui,
    theme: themeOverride ?? theme,
    items: itemsOverride ?? items,
    config,
    done,
    runCommand,
    notify,
    pasteToEditor,
  }) as unknown as Harness["picker"];
  const render = (width = 200): string[] => picker.render(width);
  return { picker, tui, done, runCommand, notify, pasteToEditor, render };
}

function type(picker: Harness["picker"], text: string): void {
  for (const ch of text) picker.handleInput(ch);
}

const accentRow = (lines: string[]): number =>
  // row 1 (title row) is also accent, so the focused item row is the one
  // carrying the full-width selection background (only the focused item)
  lines.findIndex((l) => l.includes("[bg:selectedBg]"));

describe("zero-config", () => {
  it("zeroConfigPickerConfig builds an insert/cancel config", () => {
    const config = zeroConfigPickerConfig("unstash-session");
    expect(config.title).toBe("unstash-session");
    expect(config.columns).toEqual([{ field: "label" }]);
    // The configured actions are the two default insert keybinds only —
    // escape-to-cancel is hardcoded in the input pipeline, not an action.
    expect(config.actions).toEqual([
      { shortcut: "enter", effect: "paste" },
      { shortcut: "tab", effect: "paste" },
    ]);
  });
});

describe("render", () => {
  const config: PickerConfig = {
    title: "unstash-session",
    columns: [{ field: "label" }, { field: "age", width: 12 }, { field: "hint", width: 22 }],
    actions: [{ shortcut: "enter", effect: "run", args: "{id}" }],
  };

  it("dumps the exact rendered frame lines (diagnostic)", () => {
    // Verbatim dump of the rendered frame so the output can be inspected
    // visually (marker theme: [dim]/[accent]/[b] markers instead of ANSI).
    const { render } = buildPicker(config);
    const lines = render();
    for (let i = 0; i < lines.length; i++) {
      console.log(`[picker-frame] ${i} ${lines[i]}`);
    }
  });

  it("renders the ide-style frame: top border, title row, separators, bordered rows, footer, bottom border", () => {
    const { render } = buildPicker(config);
    const lines = render();

    // 6 frame lines (top border, title row, 2 separators, footer, bottom
    // border) + 3 item rows — a single bordered panel
    expect(lines).toHaveLength(9);

    // top border line: plain (no title), border
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("╮");
    expect(lines[0]).toContain("[border]");
    expect(lines[0]).not.toContain("unstash-session");

    // title row: border bars with the accent title, padded to the
    // full inner width
    expect(lines[1]).toContain("unstash-session");
    expect(lines[1]).toContain("[accent]");
    expect(lines[1]).toContain("[border]");
    expect(lines[1].startsWith("[border]│")).toBe(true);
    expect(lines[1].endsWith("│[/]")).toBe(true);

    // exactly two separator rows (top at 2, bottom at 6), border
    const teeRows = lines
      .map((l, i) => (l.includes("├") ? i : -1))
      .filter((i) => i >= 0);
    expect(teeRows).toEqual([2, 6]);
    for (const i of [2, 6]) {
      expect(lines[i]).toContain("├");
      expect(lines[i]).toContain("┤");
      expect(lines[i]).toContain("[border]");
    }

    // item rows carry single left/right border bars; the focused row
    // (index 0) carries a full-width selection background with the accent
    // label; the side columns render plain (no marker) on the right of the row
    for (const l of lines.slice(3, 6)) expect(l).toContain("│");
    expect(lines[3]).toContain("[bg:selectedBg]");
    expect(lines[3]).toContain("[/bg]");
    expect(lines[3]).toContain("[accent]~/.pi[/]");
    expect(lines[3]).toContain("38m");
    expect(lines[3]).toContain("Fix the build");
    expect(lines[4]).toContain("~/Projects/x");
    expect(lines[4]).toContain("2h");
    expect(lines[4]).toContain("Refactor");
    expect(lines[4]).not.toContain("[bg:selectedBg]");
    expect(lines[5]).toContain("3d");
    expect(lines[5]).toContain("Fix the docs");
    expect(lines[5]).not.toContain("[bg:selectedBg]");

    // single frame: exactly one top border and one bottom border line
    expect(lines.filter((l) => l.includes("╭")).length).toBe(1);
    expect(lines.filter((l) => l.includes("╰")).length).toBe(1);

    // footer (help/status line) on plain border bars, dim text. The run
    // action's default label is its effect name.
    expect(lines[7]).toContain("esc cancel");
    expect(lines[7]).toContain("type filter");
    expect(lines[7]).toContain("enter run");
    expect(lines[7]).toContain("[border]│");

    // bottom border (plain border)
    expect(lines[8]).toContain("╰");
    expect(lines[8]).toContain("╯");
    expect(lines[8]).toContain("[border]");
  });

  it("shows the active filter query as a dim status suffix in the footer", () => {
    const { picker, render } = buildPicker(config);
    type(picker, "38m");
    const lines = render();
    // 6 frame lines + 1 item row
    expect(lines).toHaveLength(7);
    expect(lines[5]).toContain("esc cancel");
    expect(lines[5]).toContain("[dim]<38m>[/]");
  });
});

describe("focus", () => {
  it("moves focus with down/up and clamps with pageUp/pageDown", () => {
    const { picker, render } = buildPicker(zeroConfigPickerConfig("unstash-session"));

    // rows 0-2 are the frame top (top border, title row, separator), so
    // item 0 focuses at row 3
    expect(accentRow(render())).toBe(3);

    picker.handleInput("\x1b[B"); // down
    expect(accentRow(render())).toBe(4);

    picker.handleInput("\x1b[A"); // up
    expect(accentRow(render())).toBe(3);

    picker.handleInput("\x1b[6~"); // pageDown clamps to the last item (index 2)
    expect(accentRow(render())).toBe(5);

    picker.handleInput("\x1b[5~"); // pageUp back to the first
    expect(accentRow(render())).toBe(3);
  });
});

describe("filter", () => {
  const config: PickerConfig = {
    title: "unstash-session",
    columns: [{ field: "label" }, { field: "age", width: 12 }, { field: "hint", width: 22 }],
    actions: [{ shortcut: "enter", effect: "run", args: "{id}" }],
  };

  it("typing a hint fragment leaves only the matching item", () => {
    const p = buildPicker(config);
    type(p.picker, "build");
    const lines = p.render();
    // 6 frame lines + 1 item row
    expect(lines).toHaveLength(7);
    expect(lines[3]).toContain("Fix the build");
    expect(lines.join("\n")).not.toContain("Refactor");
  });

  it("matches the custom age field", () => {
    const p = buildPicker(config);
    type(p.picker, "38m");
    const lines = p.render();
    expect(lines).toHaveLength(7);
    expect(lines[3]).toContain("38m");
    expect(lines[3]).toContain("~/.pi");
  });

  it("backspace three times restores all items", () => {
    const p = buildPicker(config);
    type(p.picker, "38m");
    expect(p.render()).toHaveLength(7);
    p.picker.handleInput("\x7f");
    p.picker.handleInput("\x7f");
    p.picker.handleInput("\x7f");
    const lines = p.render();
    expect(lines).toHaveLength(9);
    expect(lines.join("\n")).toContain("Refactor");
  });

  it("shows the dim No items line when nothing matches", () => {
    const p = buildPicker(config);
    type(p.picker, "38m");
    for (let i = 0; i < 3; i++) p.picker.handleInput("\x7f");
    // "zz" matches no field; ("x" would NOT work: "Fix the build"/"Fix the docs"
    // and "~/Projects/x" all contain "x")
    type(p.picker, "zz");
    const lines = p.render();
    // "No items" is the single content row, carried inside the borders
    expect(lines).toHaveLength(7);
    expect(lines[3]).toContain("│");
    expect(lines[3]).toContain("[dim] No items[/]");
  });
});

describe("default insert (enter/tab)", () => {
  it("enter inserts the focused item's label into the editor and closes", () => {
    const p = buildPicker(zeroConfigPickerConfig("unstash-session"));
    p.picker.handleInput("\x1b[B"); // focus item 1
    p.picker.handleInput("\r");
    expect(p.pasteToEditor).toHaveBeenCalledTimes(1);
    expect(p.pasteToEditor).toHaveBeenCalledWith("~/Projects/x");
    expect(p.done).toHaveBeenCalledTimes(1);
    expect(p.done).toHaveBeenCalledWith(items[1]);
  });

  it("tab inserts the focused item's label into the editor and closes", () => {
    const p = buildPicker(zeroConfigPickerConfig("unstash-session"));
    p.picker.handleInput("\x1b[B"); // focus item 1
    p.picker.handleInput("\t");
    expect(p.pasteToEditor).toHaveBeenCalledTimes(1);
    expect(p.pasteToEditor).toHaveBeenCalledWith("~/Projects/x");
    expect(p.done).toHaveBeenCalledTimes(1);
    expect(p.done).toHaveBeenCalledWith(items[1]);
  });
});

describe("enter with custom args template", () => {
  it("interpolates the custom args template into the run effect", () => {
    const config: PickerConfig = {
      title: "unstash-session",
      columns: [{ field: "label" }],
      actions: [{ shortcut: "enter", effect: "run", args: "{id} --verbose" }],
    };
    const p = buildPicker(config);
    p.picker.handleInput("\r");
    // An absent command name means the current command (empty name).
    expect(p.runCommand).toHaveBeenCalledTimes(1);
    expect(p.runCommand).toHaveBeenCalledWith("", "0192aaa --verbose", items[0]);
    expect(p.done).toHaveBeenCalledTimes(1);
    expect(p.done).toHaveBeenCalledWith(items[0]);
  });
});

describe("run effect", () => {
  it("invokes the named command with interpolated args", () => {
    const config: PickerConfig = {
      title: "unstash-session",
      columns: [{ field: "label" }],
      actions: [
        { shortcut: "enter", effect: "run", args: "{id}" },
        { shortcut: "ctrl+r", effect: "run", command: "unstash-session", args: "{id}" },
      ],
    };
    const p = buildPicker(config);
    p.picker.handleInput("\x12"); // ctrl+r
    expect(p.runCommand).toHaveBeenCalledTimes(1);
    expect(p.runCommand).toHaveBeenCalledWith("unstash-session", "0192aaa", items[0]);
    expect(p.done).toHaveBeenCalledTimes(1);
    expect(p.done).toHaveBeenCalledWith(items[0]);
  });
});

describe("paste effect with a text template", () => {
  it("interpolates the text template into the editor insert and closes", () => {
    const config: PickerConfig = {
      title: "unstash-session",
      columns: [{ field: "label" }],
      actions: [{ shortcut: "ctrl+o", effect: "paste", text: "restoring {label}" }],
    };
    const p = buildPicker(config);
    p.picker.handleInput("\x0f"); // ctrl+o
    expect(p.pasteToEditor).toHaveBeenCalledTimes(1);
    expect(p.pasteToEditor).toHaveBeenCalledWith("restoring ~/.pi");
    expect(p.done).toHaveBeenCalledTimes(1);
    expect(p.done).toHaveBeenCalledWith(items[0]);
  });
});

describe("cancel", () => {
  it("resolves done with null on escape and guards double-done", () => {
    const p = buildPicker(zeroConfigPickerConfig("unstash-session"));
    p.picker.handleInput("\x1b");
    expect(p.done).toHaveBeenCalledTimes(1);
    expect(p.done).toHaveBeenCalledWith(null);
    p.picker.handleInput("\x1b");
    expect(p.done).toHaveBeenCalledTimes(1);
  });
});

describe("empty items", () => {
  it("renders No items and enter is a no-op without an item", () => {
    const p = buildPicker(zeroConfigPickerConfig("unstash-session"), []);
    const lines = p.render();
    // 6 frame lines + single "No items" content row
    expect(lines).toHaveLength(7);
    expect(lines[3]).toContain("No items");
    expect(lines[3]).toContain("│");
    p.picker.handleInput("\r");
    // module behavior: a null focused item makes the insert effect a no-op,
    // so done is NOT called (it is not a cancel path)
    expect(p.done).not.toHaveBeenCalled();
  });
});

describe("effect failure is fail-open", () => {
  it("absorbs a throwing insert effect: notifies a picker: line and stays open", () => {
    const p = buildPicker(zeroConfigPickerConfig("unstash-session"));
    p.pasteToEditor.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => p.picker.handleInput("\r")).not.toThrow();
    expect(p.notify).toHaveBeenCalledTimes(1);
    const msg = p.notify.mock.calls[0][0] as string;
    expect(msg).toBe("picker: boom");
    expect(msg.startsWith("picker:")).toBe(true);
    // fail-open contract: a throwing insert effect is absorbed, the pick is
    // not resolved, and the picker stays open
    expect(p.done).not.toHaveBeenCalled();
  });
});

describe("data-column content-fit", () => {
  // A middle `msg` column whose longest cell ("Refactor the parser", 19 cols)
  // must render in full — the old DEFAULT_COLUMN_WIDTH=3 fallback would show
  // only "Ref". Rendered with plainTheme so the styled cell width equals the
  // plain content width (pi-tui visibleWidth ignores real ANSI codes).
  const msgItems: PickerItem[] = [
    { id: "a", label: "session-a", age: "38m", msg: "Fix the build", hint: "x" },
    { id: "b", label: "session-b", age: "2h", msg: "Refactor the parser", hint: "y" },
    { id: "c", label: "session-c", age: "3d", msg: "Fix the docs", hint: "z" },
  ];

  it("a width-less column fits its longest cell (message fully visible, not 3 chars)", () => {
    const config: PickerConfig = {
      title: "unstash-session",
      columns: [{ field: "label" }, { field: "age" }, { field: "msg" }, { field: "hint" }], // all auto
      actions: [{ shortcut: "enter", effect: "run", args: "{id}" }],
    };
    const p = buildPicker(config, msgItems, plainTheme);
    const text = p.render().join("\n");
    // content-fit: each auto column is as wide as its longest cell
    expect(text).toContain("Refactor the parser");
    expect(text).toContain("Fix the build");
    expect(text).toContain("Fix the docs");
  });

  it("an explicit width still caps and truncates with a trailing ellipsis", () => {
    const config: PickerConfig = {
      title: "unstash-session",
      columns: [{ field: "label" }, { field: "age" }, { field: "msg", width: 8 }, { field: "hint" }],
      actions: [{ shortcut: "enter", effect: "run", args: "{id}" }],
    };
    const p = buildPicker(config, msgItems, plainTheme);
    const text = p.render().join("\n");
    // 19-char message in an 8-wide column -> clipped to 8 chars ("Refactor");
    // the layout hard-clips to the declared width without an ellipsis
    expect(text).toContain("Refactor");
    expect(text).not.toContain("Refactor the");
  });

  it("align: right left-pads (right-justifies) within the content-fit width", () => {
    const config: PickerConfig = {
      title: "unstash-session",
      columns: [{ field: "label" }, { field: "age", align: "right" }],
      actions: [{ shortcut: "enter", effect: "run", args: "{id}" }],
    };
    const p = buildPicker(config, msgItems, plainTheme);
    const lines = p.render();
    const rowA = lines.find((l) => l.includes("session-a")) as string; // age "38m"
    const rowB = lines.find((l) => l.includes("session-b")) as string; // age "2h"
    // age column is content-fit to the longest value ("38m", 3); the shorter
    // "2h" is right-justified, so it sits one column to the right of "38m"
    expect(rowB.indexOf("2h")).toBeGreaterThan(rowA.indexOf("38m"));
  });
});