/**
 * Hook-bridge tests (registration + combination semantics): handlers register
 * on the 31 bridgeable events only, tool_result output merges field-wise with
 * fail-open, empty output is a no-op, event/context round-trip through the
 * stdin payload, first-wins / replacement / accumulate combination rules,
 * the project_trust undecided fallback, and role-preserving message_end
 * replacements.
 *
 * Shared helpers come from src/test-util/ (bridge, boot, fixtures). The
 * fixture skills tree is built by setupFixture() in beforeAll and removed by
 * teardownFixture() in afterAll (re-entrant, per test file).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fireFirstHandler, shutdownAll, startBridge } from "./test-util/bridge.js";
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

describe("scripting-bridge hooks", () => {
  it("registers hook handlers on the 31 bridgeable events only", async () => {
    const { mock } = await startBridge(
      (m) => (m.events.get("tool_result") ?? []).length > 0,
    );

    expect(mock.events.has("tool_result")).toBe(true);
    expect(mock.events.has("tool_call")).toBe(true);
    expect(mock.events.has("input")).toBe(true);
    expect(mock.events.has("context")).toBe(true);
    // message_update and tool_execution_update stay TS-only.
    expect(mock.events.has("message_update")).toBe(false);
    expect(mock.events.has("tool_execution_update")).toBe(false);
    shutdownAll(mock);
  });

  it("runs a multi-event hook's script on every event it is bound to", async () => {
    const { mock, ctx } = await startBridge(
      (m) => (m.events.get("session_compact") ?? []).length > 0,
    );

    // No base-fixture hook binds session_before_compact or session_compact, so
    // the multi-event hook (event: [session_before_compact, session_compact])
    // is the only one registered into each bucket. Firing both bound events
    // must run the same script once per event.
    const before = mock.sendMessageCalls.length;
    await fireFirstHandler(
      mock,
      "session_before_compact",
      { type: "session_before_compact" },
      ctx,
    );
    await fireFirstHandler(
      mock,
      "session_compact",
      { type: "session_compact" },
      ctx,
    );

    const fired = mock.sendMessageCalls
      .slice(before)
      .map((m) => (m as { customType?: string }).customType);
    expect(fired).toEqual(["multi-event", "multi-event"]);
    shutdownAll(mock);
  });

  it("merges tool_result hook output field-wise and fails open on broken hooks", async () => {
    const { mock, ctx } = await startBridge(
      (m) => (m.events.get("tool_result") ?? []).length > 0,
    );

    const event = {
      type: "tool_result",
      toolCallId: "t1",
      toolName: "write",
      input: { path: "/tmp/a.ts", content: "x" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details: undefined,
    };

    const result = (await fireFirstHandler(
      mock,
      "tool_result",
      event,
      ctx,
    )) as {
      content: { type: string; text: string }[];
      details: Record<string, unknown>;
      isError?: boolean;
    };

    // alpha + beta contribute (sorted-filename order); broken (exit 1) and
    // gamma (timeout) fail open and contribute nothing.
    expect(result.content.map((c) => c.text)).toEqual(["alpha", "beta"]);
    expect(result.details.hook).toBe("beta");
    expect(result.isError).toBeUndefined();
    shutdownAll(mock);
  }, 8_000);

  it("treats empty hook output as a no-op for non-matching events", async () => {
    const { mock, ctx } = await startBridge(
      (m) => (m.events.get("tool_result") ?? []).length > 0,
    );

    const event = {
      type: "tool_result",
      toolCallId: "t2",
      toolName: "bash",
      input: { command: "ls" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details: undefined,
    };

    const result = await fireFirstHandler(mock, "tool_result", event, ctx);

    // alpha and beta are silent for toolName "bash"; broken/gamma fail open.
    expect(result).toBeUndefined();
    shutdownAll(mock);
  }, 8_000);

  it("serializes event and context into the hook stdin payload", async () => {
    // The guard script reads event.toolName and event.input.command from the
    // payload, which proves the event object round-trips through JSON.
    const { mock, ctx } = await startBridge(
      (m) => (m.events.get("tool_call") ?? []).length > 0,
    );

    const blocked = await fireFirstHandler(
      mock,
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "rm -rf /tmp/x" },
      },
      ctx,
    );
    expect(blocked).toEqual({ block: true, reason: "blocked rm commands" });

    const passed = await fireFirstHandler(
      mock,
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "c2",
        toolName: "bash",
        input: { command: "ls -la" },
      },
      ctx,
    );
    expect(passed).toBeUndefined();
    shutdownAll(mock);
  });

  it("applies first-wins, replacement, and accumulate combination semantics", async () => {
    const { mock, ctx } = await startBridge(
      (m) => (m.events.get("project_trust") ?? []).length > 0,
    );

    // project_trust: first decisive answer wins.
    expect(
      await fireFirstHandler(
        mock,
        "project_trust",
        { type: "project_trust" },
        ctx,
      ),
    ).toEqual({ trusted: true });

    // resources_discover: arrays accumulate across hooks.
    expect(
      await fireFirstHandler(
        mock,
        "resources_discover",
        { type: "resources_discover" },
        ctx,
      ),
    ).toEqual({ skillPaths: ["/a", "/b"], promptPaths: ["/p"], themePaths: ["/t"] });

    // session_before_switch: cancel short-circuits the chain.
    expect(
      await fireFirstHandler(
        mock,
        "session_before_switch",
        { type: "session_before_switch" },
        ctx,
      ),
    ).toEqual({ cancel: true });

    // session_before_fork: first-defined wins per key.
    expect(
      await fireFirstHandler(
        mock,
        "session_before_fork",
        { type: "session_before_fork" },
        ctx,
      ),
    ).toEqual({ skipConversationRestore: true });

    // session_before_tree: first-defined wins per key.
    expect(
      await fireFirstHandler(
        mock,
        "session_before_tree",
        { type: "session_before_tree" },
        ctx,
      ),
    ).toEqual({ summary: "s", label: "l" });

    // context: full replacement (chaining means last wins).
    expect(
      await fireFirstHandler(
        mock,
        "context",
        { type: "context" },
        ctx,
      ),
    ).toEqual({ messages: [{ role: "user" }] });

    // before_provider_request: any defined return replaces the payload.
    expect(
      await fireFirstHandler(
        mock,
        "before_provider_request",
        { type: "before_provider_request" },
        ctx,
      ),
    ).toEqual({ body: "p" });

    // before_agent_start: message first-defined, systemPrompt last wins.
    expect(
      await fireFirstHandler(
        mock,
        "before_agent_start",
        { type: "before_agent_start" },
        ctx,
      ),
    ).toEqual({ message: { role: "user" }, systemPrompt: "sp" });

    // user_bash: first non-undefined result wins.
    expect(
      await fireFirstHandler(mock, "user_bash", { type: "user_bash" }, ctx),
    ).toEqual({ result: "custom" });

    // input: the transform chains, then "handled" suppresses input and
    // stops the chain.
    expect(
      await fireFirstHandler(mock, "input", { type: "input" }, ctx),
    ).toEqual({ action: "handled" });
    shutdownAll(mock);
  }, 8_000);

  it("returns the project_trust undecided fallback when no hook contributes (never undefined)", async () => {
    // Boot against an isolated root with NO hooks at all: the handler must
    // fall back to { trusted: "undecided" } — the Pi runner dereferences
    // handlerResult.trusted, so an undefined result crashes the runner.
    const booted = await bootWithHooks([]);
    const { mock, ctx } = booted;
    try {
      expect(
        await fireFirstHandler(
          mock,
          "project_trust",
          { type: "project_trust" },
          ctx,
        ),
      ).toEqual({ trusted: "undecided" });

      // Other events keep the current behavior: undefined when no hook
      // contributes (turn_end is a no-result event).
      expect(
        await fireFirstHandler(mock, "turn_end", { type: "turn_end" }, ctx),
      ).toBeUndefined();
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("accepts role-preserving message_end replacements and drops role changes", async () => {
    const { mock, ctx } = await startBridge(
      (m) => (m.events.get("message_end") ?? []).length > 0,
    );

    // Same role as the original message: replacement applies (chaining).
    expect(
      await fireFirstHandler(
        mock,
        "message_end",
        {
          type: "message_end",
          message: { role: "user", content: "original" },
        },
        ctx,
      ),
    ).toEqual({ message: { role: "user" } });

    // Role change: the replacement is dropped, accumulator unchanged.
    expect(
      await fireFirstHandler(
        mock,
        "message_end",
        {
          type: "message_end",
          message: { role: "assistant", content: "original" },
        },
        ctx,
      ),
    ).toBeUndefined();
    shutdownAll(mock);
  }, 8_000);
});
