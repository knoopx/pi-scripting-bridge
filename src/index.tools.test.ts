/**
 * Tool-bridge tests: tool discovery (type:tool, skip type:agent), stdin/stdout
 * JSON payload execution, parameter defaults, trailing-token forwarding,
 * fail-open on non-zero exit / invalid JSON, content-array mapping +
 * validation, and executionMode frontmatter (defaulting to parallel).
 *
 * Shared helpers come from src/test-util/ (mock-pi, mock-ctx, bridge,
 * boot, fixtures). The fixture skills tree is built by setupFixture() in
 * beforeAll and removed by teardownFixture() in afterAll (re-entrant, per
 * test file).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi } from "./test-util/mock-pi.js";
import { createMockCtx } from "./test-util/mock-ctx.js";
import {
  fireEvent,
  runTool,
  shutdownAll,
  sleep,
  startBridge,
} from "./test-util/bridge.js";
import {
  setupFixture,
  teardownFixture,
  type Fixture,
} from "./test-util/fixtures.js";
import { bootWithTools, cleanupBooted } from "./test-util/boot.js";

let extensionModule: Fixture["extensionModule"];

beforeAll(async () => {
  extensionModule = (await setupFixture()).extensionModule;
});

afterAll(() => {
  teardownFixture();
});

describe("scripting-bridge tools", () => {
  it("registers zero tools on an empty skills tree", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "scripting-bridge-empty-"));
    const saved = process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT;
    process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = emptyRoot;
    try {
      const mock = createMockPi();
      await extensionModule!.default(mock.api);
      const ctx = createMockCtx(emptyRoot, mock.notified);
      fireEvent(mock, "session_start", { type: "session_start", reason: "startup" }, ctx);
      await sleep(300);
      expect(mock.tools).toHaveLength(0);
      shutdownAll(mock);
    } finally {
      process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = saved;
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("discovers type:tool skills anywhere in the tree on session_start", async () => {
    const { mock } = await startBridge((m) => m.toolsByName.has("hello"));

    expect([...mock.toolsByName.keys()].sort()).toEqual([
      "arg-echo-tool",
      "bad-exit",
      "bad-json",
      "content-bad",
      "content-img",
      "hello",
      "loose-tool",
    ]);
    // A tool in a non-standard directory is discovered purely by its `type:`.
    expect(mock.toolsByName.has("loose-tool")).toBe(true);
    // The non-tool skill file must not be registered.
    expect(mock.toolsByName.has("not-a-tool")).toBe(false);
    // type: agent skill files are not registered (agent definitions are
    // invoked via the agent-spawn tool, not bridge-registered).
    expect(mock.toolsByName.has("runner-agent")).toBe(false);

    // Parameter schema generation: greeting required, punctuation optional.
    const helloParams = mock.toolsByName.get("hello")!.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(helloParams.properties).toBeDefined();
    expect(helloParams.required).toContain("greeting");

    shutdownAll(mock);
  });

  it("executes a tool over the stdin/stdout JSON payload protocol", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("hello"));

    const result = (await runTool(
      mock,
      "hello",
      "call-1",
      { greeting: "world" },
      ctx,
    )) as {
      content: { type: string; text: string }[];
      details: Record<string, unknown>;
    };

    expect(result.content[0]).toBeDefined();
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("Hello, world!");
    expect(result.details.greeting).toBe("world");
    expect(result.details.toolCallId).toBe("call-1");
    shutdownAll(mock);
  });

  it("applies parameter defaults before the payload reaches the script", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("hello"));

    const result = (await runTool(
      mock,
      "hello",
      "call-2",
      { greeting: "hi" },
      ctx,
    )) as {
      content: { text: string }[];
    };
    // punctuation defaults to "!"
    expect(result.content[0].text).toBe("Hello, hi!");
    shutdownAll(mock);
  });

  it("skips type:agent skill files during tool discovery", async () => {
    const { mock } = await startBridge((m) => m.toolsByName.has("hello"));

    // The demo/agents/runner-agent.md fixture (type: agent) must be skipped:
    // the bridge's discovery gate targets type: tool and type: hook only.
    expect(mock.toolsByName.has("runner-agent")).toBe(false);
    shutdownAll(mock);
  });

  it("forwards trailing command tokens as positional args to the script", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("arg-echo-tool"));

    const result = (await runTool(
      mock,
      "arg-echo-tool",
      "call-args",
      { task: "carry the arg" },
      ctx,
    )) as {
      content: { text: string }[];
      details: { args: string[]; task: string };
    };
    expect(result.details.args).toEqual(["career-manager"]);
    expect(result.details.task).toBe("carry the arg");
    expect(result.content[0].text).toBe("args=career-manager task=carry the arg");
    shutdownAll(mock);
  });

  it("throws for non-zero exits with the stderr surfaced in the message", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("bad-exit"));

    // The bridge now throws (pi core wraps the throw into an error result
    // with isError=true); the script stderr is carried in the message.
    await expect(runTool(mock, "bad-exit", "call-4", {}, ctx)).rejects.toThrow(
      /exited with code 3/,
    );
    await expect(runTool(mock, "bad-exit", "call-4", {}, ctx)).rejects.toThrow(
      /boom/,
    );
    shutdownAll(mock);
  });

  it("throws for invalid stdout JSON", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("bad-json"));

    await expect(runTool(mock, "bad-json", "call-5", {}, ctx)).rejects.toThrow(
      /invalid JSON/,
    );
    shutdownAll(mock);
  });

  it("maps an image-only tool content array onto the result (image entries are valid content)", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("content-img"));

    const res = (await runTool(mock, "content-img", "call-img", {}, ctx)) as {
      content: { type: string }[];
      details: Record<string, unknown>;
    };
    expect(res.content).toEqual([{ type: "image" }]);
    expect(res.details).toEqual({ status: "image" });
    shutdownAll(mock);
  }, 8_000);

  it("rejects a tool content array with non-object entries (content validation)", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("content-bad"));

    await expect(
      runTool(mock, "content-bad", "call-bad", {}, ctx),
    ).rejects.toThrow(
      /missing required 'content'/,
    );
    shutdownAll(mock);
  }, 8_000);

  // ---------------------------------------------------------------------
  // executionMode frontmatter (registration defaulting to parallel)
  // ---------------------------------------------------------------------

  it("registers tools with executionMode from frontmatter, defaulting to parallel", async () => {
    const script = 'print ({content: [{type: "text", text: "ok"}], details: {}} | to json)';
    const booted = await bootWithTools([
      { name: "exec-default", script },
      { name: "exec-seq", script, executionMode: "sequential" },
    ]);
    const { mock } = booted;
    try {
      // Absent frontmatter field: the registerTool call defaults to parallel.
      expect(mock.toolsByName.get("exec-default")!.executionMode).toBe(
        "parallel",
      );
      // Explicit frontmatter field is honored.
      expect(mock.toolsByName.get("exec-seq")!.executionMode).toBe(
        "sequential",
      );
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("falls back to parallel for an invalid executionMode (no console output of any kind)", async () => {
    const booted = await bootWithTools([
      {
        name: "exec-bad",
        script: 'print ({content: [{type: "text", text: "ok"}], details: {}} | to json)',
        executionMode: "bogus",
      },
    ]);
    try {
      expect(booted.mock.toolsByName.get("exec-bad")!.executionMode).toBe(
        "parallel",
      );
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);
});
