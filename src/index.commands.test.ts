/**
 * Command-bridge tests (type:command): slash-command discovery/registration,
 * handler execution + pong notification, fail-open on a broken handler, the
 * sendMessage directive, missing-name skip, shortcut key bindings, and the
 * item-picker overlay (TUI launch + re-run, non-TUI fallback, empty-items
 * fallback, image-only content valid, invalid content fail-open).
 *
 * Shared helpers come from src/test-util/ (mock-pi, mock-ctx, picker-ctx,
 * bridge, boot, fixtures). The fixture skills tree is built by setupFixture()
 * in beforeAll (exposed as extensionModule) and removed by teardownFixture()
 * in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi } from "./test-util/mock-pi.js";
import { createMockCtx } from "./test-util/mock-ctx.js";
import { createPickerCtx, type PickerUiState } from "./test-util/picker-ctx.js";
import {
  fireEvent,
  runCommand,
  shutdownAll,
  sleep,
  startBridge,
  waitFor,
} from "./test-util/bridge.js";
import {
  setupFixture,
  teardownFixture,
  type Fixture,
} from "./test-util/fixtures.js";
import { bootWithCommands, cleanupBooted } from "./test-util/boot.js";

let extensionModule: Fixture["extensionModule"];

beforeAll(async () => {
  extensionModule = (await setupFixture()).extensionModule;
});

afterAll(() => {
  teardownFixture();
});

describe("scripting-bridge commands", () => {
  // ---------------------------------------------------------------------
  // Command bridge (type: command) — slash commands over the same payload
  // protocol, surfaced via sendMessage, fail-open on handler failure.
  // ---------------------------------------------------------------------

  it("discovers type:command skills and registers slash commands on session_start", async () => {
    const { mock } = await startBridge((m) => m.commandsByName.has("ping"));

    expect(mock.commandsByName.has("ping")).toBe(true);
    expect(mock.commandsByName.has("broken-cmd")).toBe(true);
    expect(mock.commandsByName.get("ping")!.description).toBe(
      "Fixture slash command that returns pong",
    );
    // A type:command skill must NOT register as a tool or hook.
    expect(mock.toolsByName.has("ping")).toBe(false);
    shutdownAll(mock);
  });

  it("executes a command handler and notifies the pong result to the user (not the agent)", async () => {
    const { mock, ctx } = await startBridge((m) => m.commandsByName.has("ping"));

    const sent = await runCommand(mock, "ping", "hi there", ctx);
    // The base result is a user notification, not a sendMessage call.
    expect(sent).toHaveLength(0);
    const notified = mock.notified.find((n) => n.type === "info" && n.msg.includes("pong"));
    expect(notified).toBeDefined();
    shutdownAll(mock);
  }, 8_000);

  it("fails open on a broken command handler (resolves, no surface, warning)", async () => {
    const { mock, ctx } = await startBridge((m) => m.commandsByName.has("broken-cmd"));

    const sent = await runCommand(mock, "broken-cmd", "", ctx);
    // No base result is surfaced on failure.
    expect(sent).toHaveLength(0);
    // A warning notification is surfaced to the TUI.
    const warn = mock.notified.find(
      (n) => n.type === "warning" && n.msg.includes("broken-cmd"),
    );
    expect(warn).toBeDefined();
    shutdownAll(mock);
  }, 8_000);

  it("applies a command sendMessage directive (same combiner as hooks)", async () => {
    // A command handler may emit a top-level sendMessage directive in its
    // stdout; the bridge applies it via pi.sendMessage and strips the key.
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-cmd-dir-"));
    const savedRoot = process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT;
    process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = root;
    const dir = join(root, "cmds");
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, "dir-cmd.nu");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env nu",
        'print ({content: [{type: "text", text: "base"}], details: {}, sendMessage: {customType: "x", content: "hi", display: true}} | to json)',
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);
    writeFileSync(
      join(dir, "dir-cmd.md"),
      [
        "---",
        "name: dir-cmd",
        "type: command",
        "description: Fixture command emitting a sendMessage directive",
        `command: ${scriptPath}`,
        "---",
        "",
      ].join("\n"),
    );
    const mock = createMockPi();
    try {
      await extensionModule!.default(mock.api);
      const ctx = createMockCtx(root, mock.notified);
      fireEvent(mock, "session_start", { type: "session_start", reason: "startup" }, ctx);
      await waitFor(() => mock.commandsByName.has("dir-cmd"));

      const sent = (await runCommand(mock, "dir-cmd", "", ctx)) as Record<string, unknown>[];
      // Only the explicit sendMessage directive is sent; the base result is
      // a user notification (not in sendMessageCalls).
      expect(sent).toHaveLength(1);
      // The directive message is applied as-is (the sendMessage value).
      expect(sent).toContainEqual({
        customType: "x",
        content: "hi",
        display: true,
      });
      // The base result is surfaced to the user as a notification.
      const baseNotified = mock.notified.find((n) => n.type === "info" && n.msg.includes("base"));
      expect(baseNotified).toBeDefined();
    } finally {
      process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = savedRoot;
      rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);

  it("skips a type:command skill with a missing name (never registered, no warning, no log)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-cmd-nomd-"));
    const savedRoot = process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT;
    process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = root;
    const dir = join(root, "cmds");
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, "noname.nu");
    writeFileSync(scriptPath, "#!/usr/bin/env nu\nprint '{}'\n");
    chmodSync(scriptPath, 0o755);
    // A type:command file WITHOUT a name must be skipped (never registered).
    writeFileSync(
      join(dir, "noname.md"),
      [
        "---",
        "type: command",
        "description: Missing name; must be skipped",
        `command: ${scriptPath}`,
        "---",
        "",
      ].join("\n"),
    );
    const mock = createMockPi();
    try {
      await extensionModule!.default(mock.api);
      const ctx = createMockCtx(root, mock.notified);
      fireEvent(mock, "session_start", { type: "session_start", reason: "startup" }, ctx);
      await sleep(300);
      expect(mock.commandsByName.size).toBe(0);
      // The visibility feature was removed: the skip is not surfaced as a
      // TUI warning and there is no log of any kind (the run stays silent).
      expect(mock.notified).toHaveLength(0);
    } finally {
      process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = savedRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers no shortcuts for commands without a shortcut field (demo tree)", async () => {
    const { mock } = await startBridge((m) => m.commandsByName.has("ping"));
    // The demo tree has only ping/broken-cmd; none of them carries a
    // frontmatter `shortcut` field, so no shortcut is registered.
    expect(mock.shortcuts.size).toBe(0);
    shutdownAll(mock);
  });

  it("registers the frontmatter shortcut key bindings and triggers the live command", async () => {
    // A tree with four commands, each carrying a frontmatter `shortcut`
    // field (files, search, directories, skills), each emitting a distinct
    // pong text.
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-shortcuts-"));
    const savedRoot = process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT;
    process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = root;
    const dir = join(root, "cmds");
    mkdirSync(dir, { recursive: true });
    const bindings: [string, string][] = [
      ["files", "ctrl+p"],
      ["search", "ctrl+shift+f"],
      ["directories", "ctrl+shift+p"],
      ["skills", "ctrl+s"],
    ];
    for (const [name, key] of bindings) {
      const scriptPath = join(dir, `${name}.nu`);
      writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env nu",
          'let _payload = (^cat | from json | default {})',
          `print ({content: [{type: "text", text: "${name}-pong"}], details: {}} | to json)`,
        ].join("\n"),
      );
      chmodSync(scriptPath, 0o755);
      writeFileSync(
        join(dir, `${name}.md`),
        [
          "---",
          `name: ${name}`,
          "type: command",
          "description: Fixture shortcut command",
          `shortcut: ${key}`,
          `command: ${scriptPath}`,
          "---",
          "",
        ].join("\n"),
      );
    }
    const mock = createMockPi();
    try {
      await extensionModule!.default(mock.api);
      const ctx = createMockCtx(root, mock.notified);
      fireEvent(mock, "session_start", { type: "session_start", reason: "startup" }, ctx);
      await waitFor(() => mock.shortcuts.size === 4);

      // Exactly the four key -> command bindings, nothing else.
      expect([...mock.shortcuts.keys()].sort()).toEqual([
        "ctrl+p",
        "ctrl+s",
        "ctrl+shift+f",
        "ctrl+shift+p",
      ]);
      expect(mock.shortcuts.get("ctrl+p")!.description).toContain("/files");
      expect(mock.shortcuts.get("ctrl+shift+f")!.description).toContain("/search");
      expect(mock.shortcuts.get("ctrl+shift+p")!.description).toContain("/directories");
      expect(mock.shortcuts.get("ctrl+s")!.description).toContain("/skills");

      // Trigger: the ctrl+p shortcut handler runs the live /files command.
      const handler = mock.shortcuts.get("ctrl+p")!.handler;
      await handler(ctx);
      const notified = mock.notified.find(
        (n) => n.type === "info" && n.msg.includes("files-pong"),
      );
      expect(notified).toBeDefined();
      // The other commands are not triggered by the wrong key.
      expect(
        mock.notified.some((n) => n.msg?.includes("skills-pong")),
      ).toBe(false);
    } finally {
      process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = savedRoot;
      rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);

  // ---------------------------------------------------------------------
  // Item picker overlay (type: command `pick` payload -> ctx.ui.custom).
  // The bridge launches a pi-tui picker only in TUI mode (hasUI + mode
  // "tui") when the stdout carries a non-empty `pick.items`; otherwise (and
  // on empty/invalid items) the existing text notify is the only surface.
  // ---------------------------------------------------------------------

  // A command that emits a `pick` payload (items) on a bare invocation and a
  // plain text result when re-run with an id arg (no second picker).
  const pickCmdFixture = {
    name: "pick-cmd",
    script: [
      "let payload = (^cat | from json | default {})",
      'let args = ($payload | get params? | default {} | get args? | default "")',
      "if ($args | str trim | is-not-empty) {",
      '    print ({content: [{type: "text", text: $"restored ($args)"}], details: {restored: $args}} | to json)',
      "} else {",
      '    print ({content: [{type: "text", text: "stashed sessions"}], details: {status: "pick"}, pick: {title: "Stashed sessions", items: [{id: "s1", label: "/proj/one", age: "38m"}, {id: "s2", label: "/proj/two", age: "2h"}]}} | to json)',
      "}",
    ],
    frontmatter: [
      "name: pick-cmd",
      "type: command",
      "description: Fixture command emitting a pick payload (item picker)",
      "picker:",
      '  title: "Stashed sessions"',
      "  columns: [{field: label}, {field: age}]",
      "  actions:",
      "    - shortcut: enter",
      "      effect: run",
      '      args: "{id}"',
      '      label: "restore"',
      "    - shortcut: ctrl+a",
      '      label: "restore all"',
      "      effect: run",
      '      args: "--all"',
    ],
  };

  it("launches the item picker overlay in TUI mode and re-runs the command with the focused id on enter", async () => {
    const booted = await bootWithCommands([pickCmdFixture]);
    const { mock, root } = booted;
    const uiState: PickerUiState = { customCalls: [], pasteCalls: [] };
    try {
      const notified: { msg: string; type?: string }[] = [];
      const ctx = createPickerCtx(root, notified, uiState, { mode: "tui", hasUI: true });
      // Launch without awaiting: the bridge awaits ui.custom, which resolves
      // only when the picker calls done().
      const pending = runCommand(mock, "pick-cmd", "", ctx);
      await waitFor(() => uiState.customCalls.length > 0);

      const cap = uiState.customCalls[0];
      // The overlay options are the pinned bridge contract.
      expect(cap.options).toEqual({
        overlay: true,
        overlayOptions: { width: "95%", anchor: "center" },
      });
      expect(typeof cap.component.handleInput).toBe("function");

      // Drive enter: the enter action (run, args "{id}") re-runs the command
      // with the focused item's id (s1) and resolves the picker (done).
      cap.component.handleInput!("\r");
      await pending;

      // The fire-and-forget re-run surfaces its "restored s1" text notify.
      await waitFor(() => notified.some((n) => n.msg.includes("restored s1")));
      // The base result text is still surfaced (additive pick, byte-identical).
      expect(notified.some((n) => n.msg.includes("stashed sessions"))).toBe(true);
      // The re-run emitted no pick (args non-empty), so no second overlay.
      expect(uiState.customCalls).toHaveLength(1);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("falls back to the text notification (no picker) in non-TUI mode", async () => {
    const booted = await bootWithCommands([pickCmdFixture]);
    const { mock, root } = booted;
    const uiState: PickerUiState = { customCalls: [], pasteCalls: [] };
    try {
      const notified: { msg: string; type?: string }[] = [];
      // Non-TUI mode: the picker gate (ctx.mode === "tui") fails, so no overlay.
      const ctx = createPickerCtx(root, notified, uiState, { mode: "print", hasUI: true });
      await runCommand(mock, "pick-cmd", "", ctx);
      expect(uiState.customCalls).toHaveLength(0);
      // The base text is still surfaced (the pick is ignored in non-TUI).
      expect(notified.some((n) => n.msg.includes("stashed sessions"))).toBe(true);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("falls back to the text notification (no picker) when the pick items are empty", async () => {
    const booted = await bootWithCommands([
      {
        name: "pick-empty",
        script: [
          "let _p = (^cat | from json | default {})",
          'print ({content: [{type: "text", text: "empty list"}], details: {status: "empty"}, pick: {title: "Empty", items: []}} | to json)',
        ],
        frontmatter: [
          "name: pick-empty",
          "type: command",
          "description: Fixture command emitting an empty pick payload",
        ],
      },
    ]);
    const { mock, root } = booted;
    const uiState: PickerUiState = { customCalls: [], pasteCalls: [] };
    try {
      const notified: { msg: string; type?: string }[] = [];
      // TUI mode, but empty items -> parsePickPayload yields null -> no overlay.
      const ctx = createPickerCtx(root, notified, uiState, { mode: "tui", hasUI: true });
      await runCommand(mock, "pick-empty", "", ctx);
      expect(uiState.customCalls).toHaveLength(0);
      expect(notified.some((n) => n.msg.includes("empty list"))).toBe(true);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  // ---------------------------------------------------------------------
  // Command content validation: image-only content is valid (no text to
  // surface, no failure warning); non-object content entries fail open
  // (no surface, no warning — the command simply resolves).
  // ---------------------------------------------------------------------

  it("treats image-only command content as valid (no text surfaced, no failure)", async () => {
    const booted = await bootWithCommands([
      {
        name: "cmd-img",
        script: [
          "let _p = (^cat | from json | default {})",
          'print ({content: [{type: "image"}], details: {status: "image"}} | to json)',
        ],
        frontmatter: [
          "name: cmd-img",
          "type: command",
          "description: Fixture command emitting image-only content",
        ],
      },
    ]);
    const { mock, root } = booted;
    const uiState: PickerUiState = { customCalls: [], pasteCalls: [] };
    try {
      const notified: { msg: string; type?: string }[] = [];
      // Non-TUI mode: no picker; image content has no text to notify.
      const ctx = createPickerCtx(root, notified, uiState, { mode: "print", hasUI: true });
      const sent = await runCommand(mock, "cmd-img", "", ctx);
      expect(sent).toHaveLength(0);
      // Valid content: no failure warning, and no text notification.
      expect(notified.some((n) => n.type === "warning")).toBe(false);
      expect(notified).toHaveLength(0);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("fails open on a command content array with non-object entries (no surface, no warning)", async () => {
    const booted = await bootWithCommands([
      {
        name: "cmd-badcontent",
        script: [
          "let _p = (^cat | from json | default {})",
          'print ({content: [null, 42], details: {status: "bad"}} | to json)',
        ],
        frontmatter: [
          "name: cmd-badcontent",
          "type: command",
          "description: Fixture command emitting invalid content entries",
        ],
      },
    ]);
    const { mock, root } = booted;
    const uiState: PickerUiState = { customCalls: [], pasteCalls: [] };
    try {
      const notified: { msg: string; type?: string }[] = [];
      const ctx = createPickerCtx(root, notified, uiState, { mode: "print", hasUI: true });
      const sent = await runCommand(mock, "cmd-badcontent", "", ctx);
      expect(sent).toHaveLength(0);
      // Invalid content is dropped silently (fail-open): nothing surfaced.
      expect(notified).toHaveLength(0);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);
});
