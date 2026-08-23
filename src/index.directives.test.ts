/**
 * Result-directive tests: setThinkingLevel, sendMessage, and notify
 * directives applied in-process by the hook combiner (no-result events
 * still apply directives), key stripping from combined result payloads,
 * TUI-warning surfacing for invalid directive values (API not called), and
 * the persistent-notify bridge-status entry path.
 *
 * Shared helpers come from src/test-util/ (bridge, boot, fixtures). Each test
 * boots an isolated hook-only root via bootWithHooks() and tears it down via
 * cleanupBooted(). The fixture skills tree is built by setupFixture() in
 * beforeAll and removed by teardownFixture() in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fireFirstHandler } from "./test-util/bridge.js";
import {
  setupFixture,
  teardownFixture,
} from "./test-util/fixtures.js";
import { bootWithHooks, cleanupBooted } from "./test-util/boot.js";

beforeAll(async () => {
  await setupFixture();
});

afterAll(() => {
  teardownFixture();
});

describe("scripting-bridge directives", () => {
  // ---------------------------------------------------------------------
  // setThinkingLevel directive
  // ---------------------------------------------------------------------

  it("applies a hook setThinkingLevel directive on a no-result event exactly once", async () => {
    const booted = await bootWithHooks([
      { event: "turn_end", script: 'print ({setThinkingLevel: "low"} | to json)' },
    ]);
    const { mock, ctx } = booted;
    try {
      // turn_end is a no-result event: the combined result is discarded,
      // but the directive is still applied in-process.
      await fireFirstHandler(mock, "turn_end", { type: "turn_end" }, ctx);
      expect(mock.thinkingCalls).toEqual(["low"]);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("surfaces a TUI warning and ignores an invalid setThinkingLevel directive (API not called)", async () => {
    const booted = await bootWithHooks([
      { event: "turn_end", script: 'print ({setThinkingLevel: "ultra"} | to json)' },
    ]);
    const { mock, ctx } = booted;
    try {
      await fireFirstHandler(mock, "turn_end", { type: "turn_end" }, ctx);
      expect(mock.thinkingCalls).toHaveLength(0);
      // No console output of any kind: the failure is surfaced as a TUI
      // warning only.
      const warn = mock.notified.find(
        (n) =>
          n.type === "warning" &&
          n.msg.includes("invalid thinkingLevel directive") &&
          n.msg.includes("\"ultra\""),
      );
      expect(warn).toBeDefined();
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("strips the setThinkingLevel key from combined result payloads", async () => {
    const booted = await bootWithHooks([
      {
        event: "before_provider_request",
        script: 'print ({setThinkingLevel: "xhigh", body: "p"} | to json)',
      },
    ]);
    const { mock, ctx } = booted;
    try {
      const result = await fireFirstHandler(
        mock,
        "before_provider_request",
        { type: "before_provider_request" },
        ctx,
      );
      // The replacement payload carries the other keys but never the
      // directive key.
      expect(result).toEqual({ body: "p" });
      expect(result).not.toHaveProperty("setThinkingLevel");
      expect(mock.thinkingCalls).toEqual(["xhigh"]);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("applies multiple setThinkingLevel directives in hook run order (last valid wins)", async () => {
    const booted = await bootWithHooks([
      { event: "turn_end", script: 'print ({setThinkingLevel: "low"} | to json)' },
      { event: "turn_end", script: 'print ({setThinkingLevel: "high"} | to json)' },
    ]);
    const { mock, ctx } = booted;
    try {
      await fireFirstHandler(mock, "turn_end", { type: "turn_end" }, ctx);
      // Both calls happen, in hook run order; the last valid level wins.
      expect(mock.thinkingCalls).toEqual(["low", "high"]);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  // ---------------------------------------------------------------------
  // sendMessage directive
  // ---------------------------------------------------------------------

  it("applies a hook sendMessage directive on a no-result event exactly once", async () => {
    const booted = await bootWithHooks([
      {
        event: "agent_end",
        script: 'print ({sendMessage: {customType: "x", content: "hi", display: true}} | to json)',
      },
    ]);
    const { mock, ctx } = booted;
    try {
      // agent_end is a no-result event: the combined result is discarded,
      // but the directive is still applied in-process.
      await fireFirstHandler(mock, "agent_end", { type: "agent_end" }, ctx);
      expect(mock.sendMessageCalls).toHaveLength(1);
      expect(mock.sendMessageCalls[0]).toEqual({
        customType: "x",
        content: "hi",
        display: true,
      });
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("surfaces a TUI warning and strips an invalid sendMessage directive (API not called)", async () => {
    const booted = await bootWithHooks([
      { event: "agent_end", script: 'print ({sendMessage: "not-an-object"} | to json)' },
    ]);
    const { mock, ctx } = booted;
    try {
      await fireFirstHandler(mock, "agent_end", { type: "agent_end" }, ctx);
      expect(mock.sendMessageCalls).toHaveLength(0);
      // No console output of any kind: the failure is surfaced as a TUI
      // warning only.
      const warn = mock.notified.find(
        (n) =>
          n.type === "warning" &&
          n.msg.includes("invalid sendMessage directive") &&
          n.msg.includes("not-an-object"),
      );
      expect(warn).toBeDefined();
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("strips the sendMessage key from combined result payloads", async () => {
    const booted = await bootWithHooks([
      {
        event: "before_provider_request",
        script: 'print ({sendMessage: {customType: "x", content: "hi", display: true}, body: "p"} | to json)',
      },
    ]);
    const { mock, ctx } = booted;
    try {
      const result = await fireFirstHandler(
        mock,
        "before_provider_request",
        { type: "before_provider_request" },
        ctx,
      );
      // The replacement payload carries the other keys but never the
      // directive key.
      expect(result).toEqual({ body: "p" });
      expect(result).not.toHaveProperty("sendMessage");
      expect(mock.sendMessageCalls).toHaveLength(1);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  // ---------------------------------------------------------------------
  // notify directive
  // ---------------------------------------------------------------------

  it("applies a bare-string notify directive via the transient status path (no appendEntry)", async () => {
    const booted = await bootWithHooks([
      { event: "agent_end", script: 'print ({notify: "stats line"} | to json)' },
    ]);
    const { mock, ctx } = booted;
    try {
      await fireFirstHandler(mock, "agent_end", { type: "agent_end" }, ctx);
      // The bare string is the unchanged path: the line goes to the
      // dedup/replace status slot (ctx.ui.notify), never to an entry.
      expect(mock.appendEntryCalls).toHaveLength(0);
      const line = mock.notified.find((n) => n.msg.includes("stats line"));
      expect(line).toBeDefined();
      expect(line!.type).toBe("info");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("appends a persistent notify line as a bridge-status entry (not the status slot)", async () => {
    const booted = await bootWithHooks([
      {
        event: "agent_end",
        script: 'print ({notify: {message: "stats line", persistent: true}} | to json)',
      },
    ]);
    const { mock, ctx } = booted;
    try {
      await fireFirstHandler(mock, "agent_end", { type: "agent_end" }, ctx);
      expect(mock.appendEntryCalls).toEqual([
        { customType: "bridge-status", data: { message: "stats line" } },
      ]);
      // The persistent line must not hit the dedup/replace status slot.
      expect(
        mock.notified.some((n) => n.msg.includes("stats line")),
      ).toBe(false);
      // The entry renderer registered at setup renders the dim line.
      const renderer = mock.entryRenderers.get("bridge-status") as
        | ((entry: unknown, options: unknown, theme: unknown) => {
            render: (width: number) => string[];
          })
        | undefined;
      expect(renderer).toBeDefined();
      const theme = { fg: (color: string, text: string) => `[${color}]${text}` };
      const component = renderer!({
        type: "custom",
        customType: "bridge-status",
        data: { message: "stats line" },
      }, { expanded: true }, theme);
      expect(component.render(80).join("\n")).toContain("[dim]stats line");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("surfaces a TUI warning and ignores an invalid persistent notify directive (no append, no throw)", async () => {
    const booted = await bootWithHooks([
      {
        event: "agent_end",
        script: 'print ({notify: {message: 42, persistent: true}} | to json)',
      },
    ]);
    const { mock, ctx } = booted;
    try {
      // The handler resolves: the invalid shape fails open, never throws.
      await fireFirstHandler(mock, "agent_end", { type: "agent_end" }, ctx);
      expect(mock.appendEntryCalls).toHaveLength(0);
      // No console output of any kind: the failure is surfaced as a TUI
      // warning only.
      const warn = mock.notified.find(
        (n) =>
          n.type === "warning" &&
          n.msg.includes("invalid notify directive") && n.msg.includes("42"),
      );
      expect(warn).toBeDefined();
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  // ---------------------------------------------------------------------
  // Hook execution visibility
  // ---------------------------------------------------------------------

  it("applies the setThinkingLevel and sendMessage directives on success (no TUI visibility line)", async () => {
    const booted = await bootWithHooks([
      {
        event: "before_provider_request",
        script: 'print ({setThinkingLevel: "xhigh", sendMessage: {customType: "x", content: "hi", display: true}, body: "p"} | to json)',
      },
    ]);
    const { mock, ctx } = booted;
    try {
      const result = await fireFirstHandler(
        mock,
        "before_provider_request",
        { type: "before_provider_request" },
        ctx,
      );
      expect(result).toEqual({ body: "p" });
      expect(mock.thinkingCalls).toEqual(["xhigh"]);
      expect(mock.sendMessageCalls).toEqual([
        { customType: "x", content: "hi", display: true },
      ]);
      // Current behavior: the hook-report visibility parts
      // (setThinkingLevel=xhigh, sendMessage, result applied) are built
      // but never surfaced as a TUI notification — assert the absence of
      // the hook-report info line.
      expect(
        mock.notified.some((n) => n.msg.includes("hook 'hook-0' (before_provider_request)")),
      ).toBe(false);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);
});
