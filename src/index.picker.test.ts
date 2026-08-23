/**
 * Picker tests: command picker config parsing (discovery-level unit tests —
 * invalid picker action entries are skipped with a keyed warning while valid
 * siblings are kept, and a present non-array actions block ignores the whole
 * picker block) and multi-line picker item rendering (createPicker unit
 * level — labels may carry embedded newlines; each item renders as up to
 * config.maxLines rows, the extra dim fields stay on the item's first row,
 * scrolling is variable-height, and the selection background spans ALL rows
 * of the focused item).
 *
 * Shared helpers come from src/test-util/ (fixtures). The fixture skills tree
 * is built by setupFixture() in beforeAll and removed by teardownFixture() in
 * afterAll (re-entrant, per test file).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCommands } from "./discovery.js";
import {
  createPicker,
  type PickerConfig,
  type PickerItem,
  type PickerOptions,
} from "./ui/picker.js";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  setupFixture,
  teardownFixture,
} from "./test-util/fixtures.js";

beforeAll(async () => {
  await setupFixture();
});

afterAll(() => {
  teardownFixture();
});

describe("scripting-bridge picker", () => {
  // -----------------------------------------------------------------------
  // Command picker config parsing (discovery-level unit tests): invalid
  // picker action entries are skipped with a keyed warning while valid
  // siblings are kept; a present non-array actions block ignores the whole
  // picker block.
  // -----------------------------------------------------------------------

  function writePickerFixture(root: string, name: string, actionsYaml: string[]): void {
    const scriptPath = join(root, `${name}.nu`);
    writeFileSync(scriptPath, "#!/usr/bin/env nu\nprint '{}'\n");
    chmodSync(scriptPath, 0o755);
    writeFileSync(
      join(root, `${name}.md`),
      [
        "---",
        `name: ${name}`,
        "type: command",
        "description: Fixture command with a picker block",
        `command: ${scriptPath}`,
        "picker:",
        `  title: ${name}`,
        "  actions:",
        ...actionsYaml,
        "---",
        "",
      ].join("\n"),
    );
  }

  it("skips invalid picker action entries (shortcut-named warnings) and keeps valid siblings", async () => {
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-picker-"));
    try {
      writePickerFixture(root, "bad-picker", [
        "    - shortcut: ctrl+a",
        "      effect: run",
        '      args: "{id}"',
        "    - effect: bogus", // invalid: missing shortcut (warning names shortcut "?")
        '    - "garbage"', // invalid: not an object (warning names shortcut "?")
        "    -", // invalid: null entry (warning names shortcut "?")
        "    - shortcut: ctrl+y",
        "      effect: bogus", // invalid: bad effect (warning names shortcut "ctrl+y")
        "    - shortcut: edit",
        "      effect: run", // invalid: not a real keybinding (warning names shortcut "edit")
      ]);
      const { commands, skipped } = await discoverCommands(root);
      expect(skipped).toEqual([]);
      const def = commands.get("bad-picker");
      expect(def?.picker?.actions).toEqual([
        { shortcut: "ctrl+a", effect: "run", args: "{id}" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a picker block with only valid action entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-picker-"));
    try {
      writePickerFixture(root, "good-picker", [
        "    - shortcut: enter",
        "      effect: run",
        '      args: "{id}"',
        "    - shortcut: tab",
        "      effect: paste",
      ]);
      const { commands, skipped } = await discoverCommands(root);
      expect(skipped).toEqual([]);
      expect(commands.get("good-picker")?.picker?.actions).toEqual([
        { shortcut: "enter", effect: "run", args: "{id}" },
        { shortcut: "tab", effect: "paste" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Multi-line picker item rendering (createPicker unit level). Labels may
  // carry embedded newlines; each item renders as up to config.maxLines rows
  // (default 3, further lines collapsed with an ellipsis), the extra dim
  // fields stay on the item's first row, scrolling is variable-height
  // (maximal set of whole item blocks that fits the content area, the
  // focused block's first row kept in view), and the selection background
  // spans ALL rows of the focused item. Single-line items render and scroll
  // exactly like the legacy implementation.
  // -----------------------------------------------------------------------

  /** pi-tui legacy arrow-key sequences (keys.js LEGACY_KEY_SEQUENCES). */
  const KEY_UP = "\x1b[A";
  const KEY_DOWN = "\x1b[B";
  /** Marker the mock theme's bg wraps the selection content in. */
  const BG_OPEN = "\u27E6"; // ⟦
  const BG_CLOSE = "\u27E7"; // ⟧

  const INNER_WIDTH = 38; // render width 40 - 2 border columns

  /** Render a picker with the given items/rows, optionally driving key
   * presses against the component first; returns the rendered frame lines.
   * The mock theme's bg wraps content in the BG_OPEN/BG_CLOSE markers so
   * selection-background rows are assertable. */
  function renderPicker(
    items: PickerItem[],
    rows: number,
    presses: string[] = [],
    config: Partial<PickerConfig> = {},
  ): string[] {
    const tui = {
      terminal: { rows },
      requestRender: () => {},
    } as unknown as TUI;
    const theme = {
      bold: (t: string) => t,
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => `${BG_OPEN}${t}${BG_CLOSE}`,
    } as unknown as Theme;
    const options: PickerOptions<PickerItem> = {
      tui,
      theme,
      items,
      config: {
        title: "T",
        columns: [{ field: "label" }, { field: "age", width: 4 }],
        actions: [],
        ...config,
      },
      done: () => {},
      runCommand: () => {},
      notify: () => {},
      pasteToEditor: () => {},
    };
    const component = createPicker(options) as unknown as {
      handleInput: (d: string) => void;
      render: (w: number) => string[];
    };
    for (const press of presses) component.handleInput(press);
    return component.render(40);
  }

  /** The item-block rows of a rendered frame (the 6 frame rows excluded:
   * top border, title row, both separators, footer, bottom border). */
  function blockRows(lines: string[]): string[] {
    return lines.slice(3, lines.length - 3);
  }

  const singleLineItems: PickerItem[] = [
    { id: "s1", label: "/proj/one", age: "38m" },
    { id: "s2", label: "/proj/two", age: "2h" },
    { id: "s3", label: "/proj/three", age: "5h" },
    { id: "s4", label: "/proj/four", age: "8h" },
    { id: "s5", label: "/proj/five", age: "1d" },
    { id: "s6", label: "/proj/six", age: "2d" },
  ];

  const multiLineItems: PickerItem[] = [
    { id: "a", label: "a1\na2\na3", age: "1h" },
    { id: "b", label: "b", age: "2h" },
    { id: "c", label: "c1\nc2\nc3", age: "3h" },
  ];

  // (a) Regression: single-line items render and scroll correctly with the column grid.
  it("renders single-line items with the column grid", () => {
    const lines = renderPicker(singleLineItems, 10);
    // 10 terminal rows -> 4 content rows -> the first 4 items, plus the
    // 6 frame rows.
    expect(lines).toHaveLength(10);
    const rows = blockRows(lines);
    expect(rows).toHaveLength(4);
    // Focused item: full-width selection background, label + age column.
    expect(rows[0].startsWith(`│${BG_OPEN} /proj/one`)).toBe(true);
    expect(rows[0]).toContain("38m");
    expect(rows[0]).toContain(BG_CLOSE);
    // Unfocused items: plain bordered rows with the age column.
    expect(rows[1]).toContain("/proj/two");
    expect(rows[1]).toContain("2h");
    expect(rows[1]).not.toContain(BG_OPEN);
    // Frame rows intact.
    expect(lines[0]).toBe("╭" + "─".repeat(INNER_WIDTH) + "╮");
    expect(lines[1]).toContain(" T");
    expect(lines[lines.length - 1]).toBe("╰" + "─".repeat(INNER_WIDTH) + "╯");
    // Footer help line.
    expect(lines[lines.length - 2]).toContain("esc cancel");
  });

  // (d) Up/down moves focus by ITEM (not by line) and clamps to the range.
  it("moves focus by item and clamps at the range ends", () => {
    // 3 downs: focus item 3 -> legacy row window start = 3 - 4 + 1 = 0.
    let lines = renderPicker(singleLineItems, 10, [KEY_DOWN, KEY_DOWN, KEY_DOWN]);
    let rows = blockRows(lines);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toContain("/proj/four");
    expect(rows[3]).toContain(BG_OPEN);
    // 10 more downs: focus clamps to the last item (5) -> window 2..5.
    lines = renderPicker(
      singleLineItems,
      10,
      [KEY_DOWN].concat(Array(10).fill(KEY_DOWN)),
    );
    rows = blockRows(lines);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("/proj/three");
    expect(rows[3]).toContain("/proj/six");
    expect(rows[3]).toContain(BG_OPEN);
    // And up moves one ITEM back: window 1..4 (start = 4 - 4 + 1 = 1),
    // so the last row is item 5 ("/proj/five") and the item before it is
    // no longer selected.
    const presses = Array<string>(11).fill(KEY_DOWN).concat([KEY_UP]);
    lines = renderPicker(singleLineItems, 10, presses);
    rows = blockRows(lines);
    expect(rows[2]).toContain("/proj/four");
    expect(rows[2]).not.toContain(BG_OPEN);
    expect(rows[3]).toContain("/proj/five");
    expect(rows[3]).toContain(BG_OPEN);
  });

  // (b) A 3-line label renders 3 rows; the selection background covers ALL
  // 3 rows when the item is focused; fields stay on the first row only.
  it("renders a 3-line label as 3 rows with the selection background on all of them", () => {
    // rows=9 -> content 3 rows: exactly the single 3-row block fits.
    const lines = renderPicker(multiLineItems, 9);
    const rows = blockRows(lines);
    expect(rows).toHaveLength(3);
    // All 3 rows of the focused item carry the full-width selection bg.
    for (const row of rows) {
      expect(row.startsWith(`│${BG_OPEN}`)).toBe(true);
      expect(row).toContain(BG_CLOSE);
    }
    expect(rows[0]).toContain("a1");
    expect(rows[1]).toContain("a2");
    expect(rows[2]).toContain("a3");
    // The age field stays on the FIRST row only.
    expect(rows[0]).toContain("1h");
    expect(rows[1]).not.toContain("1h");
    expect(rows[2]).not.toContain("1h");

    // Down: the NEXT item (single-line) is focused; the previous block is
    // scrolled away entirely (budget above focus 3 - 1 = 2 < block a's 3).
    const down = renderPicker(multiLineItems, 9, [KEY_DOWN]);
    const downRows = blockRows(down);
    expect(downRows).toHaveLength(1);
    expect(downRows[0]).toContain("b");
    expect(downRows[0]).toContain("2h");
    expect(downRows[0]).toContain(BG_OPEN);
  });

  it("collapses a label with more than maxLines lines into the last row with an ellipsis", () => {
    const items: PickerItem[] = [
      { id: "x", label: "x1\nx2\nx3\nx4", age: "4h" },
    ];
    const lines = renderPicker(items, 10);
    const rows = blockRows(lines);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("x1");
    expect(rows[1]).toContain("x2");
    expect(rows[2]).toContain("x3 x4…");
  });

  // (c) Variable-height scroll: the content area holds the maximal set of
  // whole item blocks that fits, keeping the focused block's first row in
  // view, at a fixed terminal height.
  it("variable-height scroll shows the right item blocks at a fixed terminal height", () => {
    // rows=12 -> content 6 rows; block heights [3, 1, 3].
    // Focus 0: block a (3) + block b (1) fit (4 <= 6); block c (3 more
    // rows -> 7 > 6) is scrolled out. lines = 6 frame + 4 item rows.
    let lines = renderPicker(multiLineItems, 12);
    expect(lines).toHaveLength(10);
    let rows = blockRows(lines);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("a1");
    expect(rows[3]).toContain(" b");
    expect(rows.some((r) => r.includes("c1"))).toBe(false);

    // Focus 2 (block c): the budget above the focused block (6 - 3 = 3
    // rows) fits block b (1 row) but not block a (3 rows) -> blocks b+c.
    lines = renderPicker(multiLineItems, 12, [KEY_DOWN, KEY_DOWN]);
    rows = blockRows(lines);
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.includes("a1"))).toBe(false);
    expect(rows[0]).toContain(" b");
    // All 3 rows of the focused block c carry the selection background.
    expect(rows[1].includes(BG_OPEN)).toBe(true);
    expect(rows[2].includes(BG_OPEN)).toBe(true);
    expect(rows[3].includes(BG_OPEN)).toBe(true);

    // rows=13 -> content 7 rows: with focus 2 the whole list fits (3 + 1
    // + 3 = 7) and all three blocks are shown.
    lines = renderPicker(multiLineItems, 13, [KEY_DOWN, KEY_DOWN]);
    rows = blockRows(lines);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toContain("a1");
    expect(rows[3]).toContain(" b");
    expect(rows[4]).toContain("c1");
  });

  // Type-to-filter still matches across the full multi-line label text.
  it("type-to-filter matches across multi-line label text", () => {
    const lines = renderPicker(multiLineItems, 10, ["c", "2"]);
    const rows = blockRows(lines);
    // Only block c matches the needle "c2" (its embedded label line).
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("c1");
    expect(rows[1]).toContain("c2");
    expect(rows[2]).toContain("c3");
    expect(rows[0]).toContain(BG_OPEN);
  });

  // The row cap is a parameter (config.maxLines), not a hardcode: maxLines
  // 2 renders a 3-line label as 2 rows; an invalid value falls back to the
  // default of 3.
  it("honors config.maxLines as the row cap (parameterized)", () => {
    const items: PickerItem[] = [{ id: "a", label: "a1\na2\na3", age: "9h" }];
    let lines = renderPicker(items, 10, [], { maxLines: 2 });
    let rows = blockRows(lines);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("a1");
    expect(rows[1]).toContain("a2 a3…");

    // maxLines 1: everything collapses into a single row.
    lines = renderPicker(items, 10, [], { maxLines: 1 });
    rows = blockRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("a1 a2 a3…");

    // An invalid cap (0) falls back to the default (3 rows).
    lines = renderPicker(items, 10, [], { maxLines: 0 });
    rows = blockRows(lines);
    expect(rows).toHaveLength(3);
  });
});
