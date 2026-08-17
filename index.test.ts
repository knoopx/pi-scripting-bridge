/**
 * Smoke test for the scripting-bridge extension, run outside the full Pi
 * runtime (per the smoke-test-extension intent):
 *
 * - The extension loads and discovers type:tool and type:hook skills from a
 *   fixture skills tree (PI_SCRIPTING_BRIDGE_SKILLS_ROOT)
 * - A tool script receiving the stdin JSON payload returns a JSON stdout
 *   result that maps onto AgentToolResult (content, details, defaults applied)
 * - Error paths (non-zero exit, invalid stdout JSON) produce error
 *   results with stderr surfaced in content
 * - Hook scripts receive {"event", "context"} on stdin and their stdout JSON
 *   maps onto the event result per the per-event combination semantics
 *   (field-wise merge for tool_result, first-block-wins for tool_call,
 *   fail-open on failure/timeout, empty output = no-op)
 * - Live reload: added tool files are registered and removed tools are
 *   dropped from the active set without /reload
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface MockTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | null | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
}

interface MockPi {
  api: ExtensionAPI;
  tools: MockTool[];
  toolsByName: Map<string, MockTool>;
  events: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
  active: Set<string>;
  activeSetCalls: string[][];
  notified: { msg: string; type?: string }[];
  /** When true, the api surface throws the SDK staleness assertion error. */
  stale: boolean;
  /** Levels passed to the api surface's setThinkingLevel, in call order. */
  thinkingCalls: string[];
  /** Messages passed to the api surface's sendMessage, in call order. */
  sendMessageCalls: unknown[];
}

function createMockPi(): MockPi {
  const tools: MockTool[] = [];
  const toolsByName = new Map<string, MockTool>();
  const events = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >();
  const active = new Set<string>();
  const activeSetCalls: string[][] = [];
  const notified: { msg: string; type?: string }[] = [];
  const thinkingCalls: string[] = [];
  const sendMessageCalls: unknown[] = [];

  const mock: MockPi = {
    api: null as unknown as ExtensionAPI,
    tools,
    toolsByName,
    events,
    active,
    activeSetCalls,
    notified,
    stale: false,
    thinkingCalls,
    sendMessageCalls,
  };

  const guard = (): void => {
    if (mock.stale) {
      throw new Error(
        "This extension ctx is stale after session replacement or reload",
      );
    }
  };

  mock.api = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      guard();
      const list = events.get(event) ?? [];
      list.push(handler);
      events.set(event, list);
    },
    registerTool(tool: {
      name: string;
      description?: string;
      parameters?: unknown;
      execute: MockTool["execute"];
    }) {
      guard();
      const captured: MockTool = {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters,
        execute: tool.execute.bind(tool),
      };
      tools.push(captured);
      toolsByName.set(tool.name, captured);
      active.add(tool.name);
    },
    getActiveTools: () => {
      guard();
      return [...active];
    },
    setActiveTools(names: string[]) {
      guard();
      activeSetCalls.push([...names]);
      for (const n of [...active]) {
        if (!names.includes(n)) active.delete(n);
      }
      for (const n of names) active.add(n);
    },
    setThinkingLevel(level: string) {
      guard();
      thinkingCalls.push(level);
    },
    sendMessage(msg: unknown) {
      guard();
      sendMessageCalls.push(msg);
    },
  } as unknown as ExtensionAPI;

  return mock;
}

function createMockCtx(cwd: string, notified?: { msg: string; type?: string }[]): ExtensionContext {
  return {
    ui: {
      notify: (msg: string, type?: "info" | "warning" | "error") => {
        notified?.push({ msg, type });
      },
    },
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: {
      getCwd: () => cwd,
      getSessionDir: () => cwd,
      getSessionId: () => "sess-1",
      getSessionFile: () => "/tmp/sess-1.jsonl",
      getLeafId: () => "leaf-1",
      getLeafEntry: () => null,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getBranch: () => [
        { id: "e1", type: "message" },
        { id: "e2", type: "message" },
      ],
      buildContextEntries: () => [],
      getHeader: () => ({}),
      getEntries: () => [],
      getTree: () => ({}),
      getSessionName: () => "test",
    },
    modelRegistry: {},
    model: { id: "test-model" },
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => ({ tokens: 100, contextWindow: 200, percent: 50 }),
    compact: () => {},
    getSystemPrompt: () => "test system prompt",
  } as unknown as ExtensionContext;
}

function fireEvent(
  mock: MockPi,
  event: string,
  eventObj: unknown,
  ctx: ExtensionContext,
): unknown {
  const handlers = mock.events.get(event) ?? [];
  if (handlers.length === 0) {
    throw new Error(`no handlers registered for event '${event}'`);
  }
  let result: unknown;
  for (const handler of handlers) {
    result = handler(eventObj, ctx);
  }
  return result;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixture skills tree
// ---------------------------------------------------------------------------

let fixtureRoot: string;
let demoDir: string;
let extensionModule: {
  default: (pi: ExtensionAPI) => Promise<void>;
} | undefined;

function writeScript(rel: string, body: string): string {
  const path = join(fixtureRoot, rel);
  writeFileSync(path, `#!/usr/bin/env nu\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function writeMd(rel: string, frontmatter: string): void {
  const path = join(fixtureRoot, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\n\n# Fixture\n`);
}

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "scripting-bridge-"));
  demoDir = join(fixtureRoot, "demo");
  mkdirSync(join(demoDir, "tools"), { recursive: true });
  mkdirSync(join(demoDir, "agents"), { recursive: true });
  mkdirSync(join(demoDir, "hooks"), { recursive: true });
  mkdirSync(join(demoDir, "scripts"), { recursive: true });
  mkdirSync(join(demoDir, "loose"), { recursive: true });

  // --- tool fixtures ------------------------------------------------------

  writeScript(
    "demo/scripts/hello.nu",
    [
      "let payload = (^cat | from json)",
      "let out = {",
      '    content: [{type: "text", text: $"Hello, ($payload.params.greeting)($payload.params.punctuation)"}]',
      "    details: {greeting: $payload.params.greeting, toolCallId: $payload.toolCallId}",
      "}",
      "print ($out | to json)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/runner-agent.nu",
    [
      "let payload = (^cat | from json)",
      'print ({content: [{type: "text", text: $"agent ran: ($payload.params.task)"}], details: {task: $payload.params.task}} | to json)',
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/bad-exit.nu",
    ['print -e "boom"', "exit 3"].join("\n"),
  );

  writeScript("demo/scripts/bad-json.nu", ['print "this is not json"'].join("\n"));

  writeMd(
    "demo/tools/hello.md",
    [
      "name: hello",
      "type: tool",
      "description: Say hello over the stdin/stdout JSON payload protocol",
      `command: ${join(demoDir, "scripts/hello.nu")}`,
      "parameters:",
      "  greeting:",
      "    type: string",
      "    required: true",
      "  punctuation:",
      "    type: string",
      "    required: false",
      '    default: "!"',
    ].join("\n"),
  );

  writeMd(
    "demo/tools/bad-exit.md",
    [
      "name: bad-exit",
      "type: tool",
      "description: Fixture tool that exits non-zero",
      `command: ${join(demoDir, "scripts/bad-exit.nu")}`,
    ].join("\n"),
  );

  writeMd(
    "demo/tools/bad-json.md",
    [
      "name: bad-json",
      "type: tool",
      "description: Fixture tool that emits invalid JSON",
      `command: ${join(demoDir, "scripts/bad-json.nu")}`,
    ].join("\n"),
  );

  // A tool living OUTSIDE tools/ and agents/ must still be discovered:
  // registration is driven by the frontmatter `type:`, not the directory.
  writeScript(
    "demo/loose/loose-tool.nu",
    [
      "let payload = (^cat | from json)",
      'print ({content: [{type: "text", text: "loose: ok"}], details: {}} | to json)',
    ].join("\n"),
  );
  writeMd(
    "demo/loose/loose-tool.md",
    [
      "name: loose-tool",
      "type: tool",
      "description: A tool in a non-standard directory (type-authoritative discovery)",
      `command: ${join(demoDir, "loose/loose-tool.nu")}`,
    ].join("\n"),
  );

  writeMd(
    "demo/agents/runner-agent.md",
    [
      "name: runner-agent",
      "type: agent",
      "description: Agent-type fixture; the bridge must not register it",
      `command: ${join(demoDir, "scripts/runner-agent.nu")}`,
      "parameters:",
      "  task:",
      "    type: string",
      "    required: true",
    ].join("\n"),
  );

  // A tool whose command carries a trailing positional token (after the
  // script path). The bridge must forward that token to the script as argv.
  writeScript(
    "demo/scripts/arg-echo.nu",
    [
      "def main [...cli] {",
      "    let payload = (^cat | from json)",
      "    let out = {",
      '        content: [{type: "text", text: $"args=($cli | str join ',') task=($payload.params.task)"}]',
      "        details: {args: $cli, task: $payload.params.task}",
      "    }",
      "    print ($out | to json)",
      "}",
    ].join("\n"),
  );
  writeMd(
    "demo/tools/arg-echo-tool.md",
    [
      "name: arg-echo-tool",
      "type: tool",
      "description: Fixture that echoes its trailing command args as positional argv",
      `command: ${join(demoDir, "scripts/arg-echo.nu")} career-manager`,
      "parameters:",
      "  task:",
      "    type: string",
      "    required: true",
    ].join("\n"),
  );

  // --- hook fixtures ------------------------------------------------------

  writeScript(
    "demo/scripts/alpha.nu",
    [
      "let payload = (^cat | from json)",
      "if $payload.event.toolName in [\"write\" \"edit\"] {",
      '    print ({content: [{type: "text", text: "alpha"}], details: {hook: "alpha"}} | to json)',
      "}",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/beta.nu",
    [
      "let payload = (^cat | from json)",
      "if $payload.event.toolName in [\"write\" \"edit\"] {",
      '    print ({content: [{type: "text", text: "beta"}], details: {hook: "beta"}, isError: false} | to json)',
      "}",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/broken.nu",
    ['print -e "hook failed"', "exit 1"].join("\n"),
  );

  writeScript(
    "demo/scripts/gamma.nu",
    ["sleep 1.5sec", "print '{}'"].join("\n"),
  );

  writeScript(
    "demo/scripts/guard.nu",
    [
      "let payload = (^cat | from json)",
      'let cmd = ($payload.event.input.command | split row " " | first)',
      "if $payload.event.toolName == \"bash\" and $cmd == \"rm\" {",
      '    print ({block: true, reason: "blocked rm commands"} | to json)',
      "}",
    ].join("\n"),
  );

  writeMd(
    "demo/hooks/alpha.md",
    [
      "name: alpha",
      "type: hook",
      "event: tool_result",
      `command: ${join(demoDir, "scripts/alpha.nu")}`,
      "description: Fixture hook A",
    ].join("\n"),
  );

  writeMd(
    "demo/hooks/beta.md",
    [
      "name: beta",
      "type: hook",
      "event: tool_result",
      `command: ${join(demoDir, "scripts/beta.nu")}`,
      "description: Fixture hook B",
    ].join("\n"),
  );

  writeMd(
    "demo/hooks/broken.md",
    [
      "name: broken",
      "type: hook",
      "event: tool_result",
      `command: ${join(demoDir, "scripts/broken.nu")}`,
      "description: Fixture hook that always fails (fail-open)",
    ].join("\n"),
  );

  writeMd(
    "demo/hooks/gamma.md",
    [
      "name: gamma",
      "type: hook",
      "event: tool_result",
      "timeout: 1000",
      `command: ${join(demoDir, "scripts/gamma.nu")}`,
      "description: Fixture hook that always times out (fail-open)",
    ].join("\n"),
  );

  writeMd(
    "demo/hooks/guard.md",
    [
      "name: guard",
      "type: hook",
      "event: tool_call",
      `command: ${join(demoDir, "scripts/guard.nu")}`,
      "description: Fixture guardrail hook",
    ].join("\n"),
  );

  // --- one hook per event, exercising every remaining combiner ---------

  writeScript(
    "demo/scripts/ev-trust.nu",
    ['print ({trusted: true} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-trust.md",
    [
      "name: ev-trust",
      "type: hook",
      "event: project_trust",
      `command: ${join(demoDir, "scripts/ev-trust.nu")}`,
      "description: Fixture hook for project_trust (first decisive wins)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-resources-a.nu",
    ['print ({skillPaths: ["/a"], themePaths: ["/t"]} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-resources-a.md",
    [
      "name: ev-resources-a",
      "type: hook",
      "event: resources_discover",
      `command: ${join(demoDir, "scripts/ev-resources-a.nu")}`,
      "description: First resources_discover hook (arrays accumulate)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-resources-b.nu",
    ['print ({skillPaths: ["/b"], promptPaths: ["/p"]} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-resources-b.md",
    [
      "name: ev-resources-b",
      "type: hook",
      "event: resources_discover",
      `command: ${join(demoDir, "scripts/ev-resources-b.nu")}`,
      "description: Second resources_discover hook (arrays accumulate)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-switch-cancel.nu",
    ['print ({cancel: true} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-switch-cancel.md",
    [
      "name: ev-switch-cancel",
      "type: hook",
      "event: session_before_switch",
      `command: ${join(demoDir, "scripts/ev-switch-cancel.nu")}`,
      "description: Fixture hook for session_before_switch (cancel)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-fork.nu",
    ['print ({skipConversationRestore: true} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-fork.md",
    [
      "name: ev-fork",
      "type: hook",
      "event: session_before_fork",
      `command: ${join(demoDir, "scripts/ev-fork.nu")}`,
      "description: Fixture hook for session_before_fork (first-defined wins)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-tree.nu",
    ['print ({summary: "s", label: "l"} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-tree.md",
    [
      "name: ev-tree",
      "type: hook",
      "event: session_before_tree",
      `command: ${join(demoDir, "scripts/ev-tree.nu")}`,
      "description: Fixture hook for session_before_tree (first-defined wins)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-context.nu",
    ['print ({messages: [{role: "user"}]} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-context.md",
    [
      "name: ev-context",
      "type: hook",
      "event: context",
      `command: ${join(demoDir, "scripts/ev-context.nu")}`,
      "description: Fixture hook for context (full replacement)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-provider.nu",
    ['print ({body: "p"} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-provider.md",
    [
      "name: ev-provider",
      "type: hook",
      "event: before_provider_request",
      `command: ${join(demoDir, "scripts/ev-provider.nu")}`,
      "description: Fixture hook for before_provider_request (replacement)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-agentstart.nu",
    [
      'print ({message: {role: "user"}, systemPrompt: "sp"} | to json)',
    ].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-agentstart.md",
    [
      "name: ev-agentstart",
      "type: hook",
      "event: before_agent_start",
      `command: ${join(demoDir, "scripts/ev-agentstart.nu")}`,
      "description: Fixture hook for before_agent_start (message + systemPrompt)",
    ].join("\n"),
  );

  // Always emits role "user": the test fires matching (preserved) and
  // mismatching (dropped) original roles to cover both branches.
  writeScript(
    "demo/scripts/ev-message-end.nu",
    ['print ({message: {role: "user"}} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-message-end.md",
    [
      "name: ev-message-end",
      "type: hook",
      "event: message_end",
      `command: ${join(demoDir, "scripts/ev-message-end.nu")}`,
      "description: Fixture hook for message_end (role-preserved replacement)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-input-b.nu",
    ['print ({action: "handled"} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-input-b.md",
    [
      "name: ev-input-b",
      "type: hook",
      "event: input",
      `command: ${join(demoDir, "scripts/ev-input-b.nu")}`,
      "description: Second input hook - handled fully suppresses input",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-bash.nu",
    ['print ({result: "custom"} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-bash.md",
    [
      "name: ev-bash",
      "type: hook",
      "event: user_bash",
      `command: ${join(demoDir, "scripts/ev-bash.nu")}`,
      "description: Fixture hook for user_bash (first result wins)",
    ].join("\n"),
  );

  writeScript(
    "demo/scripts/ev-input-a.nu",
    ['print ({action: "transform", text: "t"} | to json)'].join("\n"),
  );
  writeMd(
    "demo/hooks/ev-input-a.md",
    [
      "name: ev-input-a",
      "type: hook",
      "event: input",
      `command: ${join(demoDir, "scripts/ev-input-a.nu")}`,
      "description: First input hook (transform chains)",
    ].join("\n"),
  );

  // Non-bridge types that must be ignored by both bridges.
  writeMd(
    "demo/tools/not-a-tool.md",
    [
      "name: not-a-tool",
      "type: protocols",
      "description: Not a tool; must not be registered",
    ].join("\n"),
  );

  process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = fixtureRoot;

  extensionModule = await import("./index");
});

afterAll(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function shutdownAll(mock: MockPi): void {
  const handlers = mock.events.get("session_shutdown") ?? [];
  for (const handler of handlers) {
    handler({ type: "session_shutdown", reason: "quit" }, createMockCtx(fixtureRoot));
  }
}

/**
 * Boot the extension against the fixture skills tree, fire session_start,
 * and wait for `wait` to hold. Returns the mock plus the handler ctx.
 */
async function startBridge(
  wait: (mock: MockPi) => boolean,
): Promise<{ mock: MockPi; ctx: ExtensionContext }> {
  const mock = createMockPi();
  await extensionModule!.default(mock.api);
  const ctx = createMockCtx(fixtureRoot, mock.notified);
  fireEvent(mock, "session_start", { type: "session_start", reason: "startup" }, ctx);
  await waitFor(() => wait(mock));
  return { mock, ctx };
}

/** Invoke the first registered handler of a hook event with the given ctx. */
function fireFirstHandler(
  mock: MockPi,
  event: string,
  eventObj: unknown,
  ctx: ExtensionContext,
): Promise<unknown> {
  const handler = mock.events.get(event)![0] as (
    e: unknown,
    c: ExtensionContext,
  ) => Promise<unknown>;
  return handler(eventObj, ctx);
}

/** Execute a registered bridge tool with the given call id and params. */
async function runTool(
  mock: MockPi,
  name: string,
  toolCallId: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
): Promise<unknown> {
  return mock.toolsByName.get(name)!.execute(toolCallId, params, null, null, ctx);
}

describe("scripting-bridge", () => {
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
      "hello",
      "loose-tool",
    ]);
    // A tool in a non-standard directory is discovered purely by its `type:`.
    expect(mock.toolsByName.has("loose-tool")).toBe(true);
    // The non-tool skill file must not be registered.
    expect(mock.toolsByName.has("not-a-tool")).toBe(false);
    // type: agent skill files are skipped during tool discovery (agents are
    // regular tools invoked via the spawn-agent tool).
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

  it("produces an error result with stderr for non-zero exits", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("bad-exit"));

    const result = (await runTool(mock, "bad-exit", "call-4", {}, ctx)) as {
      content: { text: string }[];
      details: { exitCode: number; error: string };
    };
    expect(result.content[0].text).toContain("exited with code 3");
    expect(result.content[0].text).toContain("boom");
    expect(result.details.exitCode).toBe(3);
    expect(result.details.error).toContain("exited with code 3");
    shutdownAll(mock);
  });

  it("produces an error result for invalid stdout JSON", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("bad-json"));

    const result = (await runTool(mock, "bad-json", "call-5", {}, ctx)) as {
      content: { text: string }[];
      details: { error: string };
    };
    expect(result.content[0].text).toContain("invalid JSON");
    expect(result.details.error).toContain("invalid JSON");
    shutdownAll(mock);
  });

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

  it("registers a new tool file on change without /reload (live reload)", async () => {
    const { mock, ctx } = await startBridge((m) => m.toolsByName.has("hello"));
    expect(mock.toolsByName.has("live-tool")).toBe(false);

    const scriptPath = join(fixtureRoot, "demo/scripts/live-tool.nu");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env nu",
        "let payload = (^cat | from json)",
        'print ({content: [{type: "text", text: $"live: ($payload.params.thing)"}], details: {}} | to json)',
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);
    writeFileSync(
      join(fixtureRoot, "demo/tools/live-tool.md"),
      [
        "---",
        "name: live-tool",
        "type: tool",
        "description: Added after initial discovery",
        `command: ${scriptPath}`,
        "parameters:",
        "  thing:",
        "    type: string",
        "    required: true",
        "---",
        "",
        "# Live tool",
      ].join("\n"),
    );

    await waitFor(() => mock.toolsByName.has("live-tool"), 5000);
    const result = (await runTool(
      mock,
      "live-tool",
      "call-live",
      { thing: "works" },
      ctx,
    )) as {
      content: { text: string }[];
    };
    expect(result.content[0].text).toBe("live: works");
    shutdownAll(mock);
  }, 8_000);

  it("drops a removed tool from the active set without /reload (live reload)", async () => {
    const { mock } = await startBridge((m) => m.toolsByName.has("bad-json"));
    expect(mock.active.has("bad-json")).toBe(true);

    rmSync(join(fixtureRoot, "demo/tools/bad-json.md"), { force: true });
    await waitFor(() => !mock.active.has("bad-json"), 5000);
    expect(
      mock.activeSetCalls.some((names) => !names.includes("bad-json")),
    ).toBe(true);
    shutdownAll(mock);
  }, 8_000);

  it("closes watchers on session_shutdown quit", async () => {
    const { mock } = await startBridge((m) => m.toolsByName.has("hello"));
    shutdownAll(mock);
    // No assertion on internal state; this must not throw.
    expect(true).toBe(true);
  });

  it("tears down fully (no further rediscovery) on session_shutdown reasons new, fork, resume", async () => {
    const probeScript = join(fixtureRoot, "demo/scripts/teardown-probe.nu");
    writeFileSync(
      probeScript,
      [
        "#!/usr/bin/env nu",
        'print ({content: [{type: "text", text: "teardown probe"}], details: {}} | to json)',
      ].join("\n"),
    );
    chmodSync(probeScript, 0o755);
    try {
      for (const reason of ["new", "fork", "resume"]) {
        const { mock, ctx } = await startBridge((m) => m.toolsByName.has("hello"));

        for (const handler of mock.events.get("session_shutdown") ?? []) {
          handler({ type: "session_shutdown", reason }, ctx);
        }

        // A new tool file landing after shutdown must NOT be registered:
        // the watchers (and debounce) were closed for every shutdown reason.
        writeFileSync(
          join(fixtureRoot, "demo/tools/teardown-probe.md"),
          [
            "---",
            "name: teardown-probe",
            "type: tool",
            "description: Must not be registered after shutdown",
            `command: ${probeScript}`,
            "---",
            "",
          ].join("\n"),
        );
        await sleep(600);
        expect(mock.toolsByName.has("teardown-probe")).toBe(false);
        rmSync(join(fixtureRoot, "demo/tools/teardown-probe.md"), { force: true });
      }
    } finally {
      rmSync(probeScript, { force: true });
    }
  }, 12_000);

  it("performs a one-time silent teardown when a watcher-triggered rediscover hits a stale pi", async () => {
    const { mock } = await startBridge((m) => m.toolsByName.has("hello"));

    const origError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    const probeMd = join(fixtureRoot, "demo/tools/stale-probe.md");
    const probeMdBody = [
      "---",
      "name: stale-probe",
      "type: tool",
      "description: Triggers a watcher rediscovery against a stale instance",
      `command: ${join(demoDir, "scripts/hello.nu")}`,
      "---",
      "",
    ].join("\n");
    try {
      // Simulate a session replacement: the instance's captured pi is now
      // stale and throws the SDK staleness assertion.
      mock.stale = true;

      // First watcher-triggered rediscovery: a new tool file forces a
      // pi.registerTool call, which throws the staleness error.
      writeFileSync(probeMd, probeMdBody);
      await sleep(600);

      // Second attempt: must be a no-op (watchers closed, closed guard).
      writeFileSync(probeMd, `${probeMdBody}\n# second change\n`);
      await sleep(600);
    } finally {
      console.error = origError;
      mock.stale = false;
      rmSync(probeMd, { force: true });
    }

    // No "rediscovery failed" spam at all.
    expect(errors.filter((m) => m.includes("rediscovery failed"))).toHaveLength(0);
    // Exactly one silent teardown note.
    expect(errors.filter((m) => m.includes("instance stale"))).toHaveLength(1);
    // The stale probe tool must never have been registered.
    expect(mock.toolsByName.has("stale-probe")).toBe(false);
  }, 8_000);

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

  // ---------------------------------------------------------------------
  // setThinkingLevel directive
  // ---------------------------------------------------------------------

  /**
   * Boot the bridge against an ISOLATED skills root (env override, like
   * the empty-tree test) containing only the given hook fixtures, and
   * wait for the hook handlers to be registered.
   */
  async function bootWithHooks(hooks: {
    event: string;
    script: string;
  }[]): Promise<{
    mock: MockPi;
    ctx: ExtensionContext;
    root: string;
    savedRoot: string | undefined;
  }> {
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-think-"));
    const savedRoot = process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT;
    process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = root;
    const hooksDir = join(root, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    for (let i = 0; i < hooks.length; i++) {
      const spec = hooks[i];
      const scriptPath = join(hooksDir, `hook-${i}.nu`);
      writeFileSync(scriptPath, `#!/usr/bin/env nu\n${spec.script}\n`);
      chmodSync(scriptPath, 0o755);
      writeFileSync(
        join(hooksDir, `hook-${i}.md`),
        [
          "---",
          `name: hook-${i}`,
          "type: hook",
          `event: ${spec.event}`,
          `command: ${scriptPath}`,
          "description: setThinkingLevel fixture",
          "---",
          "",
        ].join("\n"),
      );
    }
    const mock = createMockPi();
    try {
      await extensionModule!.default(mock.api);
      const ctx = createMockCtx(root, mock.notified);
      fireEvent(
        mock,
        "session_start",
        { type: "session_start", reason: "startup" },
        ctx,
      );
      await waitFor(() =>
        hooks.every((h) => (mock.events.get(h.event) ?? []).length > 0),
      );
      return { mock, ctx, root, savedRoot };
    } catch (err) {
      process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = savedRoot;
      rmSync(root, { recursive: true, force: true });
      throw err;
    }
  }

  function cleanupBooted(
    booted: {
      mock: MockPi;
      root: string;
      savedRoot: string | undefined;
    },
  ): void {
    shutdownAll(booted.mock);
    process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = booted.savedRoot;
    rmSync(booted.root, { recursive: true, force: true });
  }

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

  it("logs and ignores an invalid setThinkingLevel directive (API not called)", async () => {
    const booted = await bootWithHooks([
      { event: "turn_end", script: 'print ({setThinkingLevel: "ultra"} | to json)' },
    ]);
    const { mock, ctx } = booted;
    const origError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    try {
      await fireFirstHandler(mock, "turn_end", { type: "turn_end" }, ctx);
      expect(mock.thinkingCalls).toHaveLength(0);
      expect(
        errors.some(
          (m) =>
            m.includes("invalid thinkingLevel directive") &&
            m.includes("\"ultra\""),
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
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

  it("logs and strips an invalid sendMessage directive (API not called)", async () => {
    const booted = await bootWithHooks([
      { event: "agent_end", script: 'print ({sendMessage: "not-an-object"} | to json)' },
    ]);
    const { mock, ctx } = booted;
    const origError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    try {
      await fireFirstHandler(mock, "agent_end", { type: "agent_end" }, ctx);
      expect(mock.sendMessageCalls).toHaveLength(0);
      expect(
        errors.some(
          (m) =>
            m.includes("invalid sendMessage directive") &&
            m.includes("not-an-object"),
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
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
  // Hook execution visibility
  // ---------------------------------------------------------------------

  it("emits an info notification listing applied directives on success", async () => {
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
      expect(mock.sendMessageCalls).toHaveLength(1);
      // The success line lists both applied directive keys and the result.
      const line = mock.notified.find(
        (n) => n.msg.includes("hook 'hook-0' (before_provider_request)"),
      );
      expect(line).toBeDefined();
      expect(line!.type).toBe("info");
      expect(line!.msg).toContain("setThinkingLevel=xhigh");
      expect(line!.msg).toContain("sendMessage");
      expect(line!.msg).toContain("result applied");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("emits an info no-op notification for empty hook output", async () => {
    const booted = await bootWithHooks([
      {
        event: "turn_end",
        // Prints nothing: the empty-stdout branch resolves as a no-op.
        script: 'if false { print "x" }',
      },
    ]);
    const { mock, ctx } = booted;
    try {
      const result = await fireFirstHandler(mock, "turn_end", { type: "turn_end" }, ctx);
      expect(result).toBeUndefined();
      const line = mock.notified.find((n) => n.msg.includes("no-op"));
      expect(line).toBeDefined();
      expect(line!.type).toBe("info");
      expect(line!.msg).toContain("hook 'hook-0' (turn_end)");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("emits a warning notification when a hook fails", async () => {
    const booted = await bootWithHooks([
      {
        event: "turn_end",
        script: 'print -e "boom"\nexit 1',
      },
    ]);
    const { mock, ctx } = booted;
    try {
      const result = await fireFirstHandler(mock, "turn_end", { type: "turn_end" }, ctx);
      expect(result).toBeUndefined();
      const line = mock.notified.find((n) => n.msg.includes("failed (exit 1)"));
      expect(line).toBeDefined();
      expect(line!.type).toBe("warning");
      expect(line!.msg).toContain("hook 'hook-0' (turn_end)");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("emits an info result-applied notification for a combined result", async () => {
    const booted = await bootWithHooks([
      {
        event: "before_provider_request",
        script: 'print ({body: "p"} | to json)',
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
      const line = mock.notified.find((n) => n.msg.includes("result applied"));
      expect(line).toBeDefined();
      expect(line!.type).toBe("info");
      expect(line!.msg).toContain("hook 'hook-0' (before_provider_request)");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("emits an info chain-stop notification when a hook stops the chain", async () => {
    const booted = await bootWithHooks([
      { event: "project_trust", script: 'print ({trusted: true} | to json)' },
    ]);
    const { mock, ctx } = booted;
    try {
      const result = await fireFirstHandler(
        mock,
        "project_trust",
        { type: "project_trust" },
        ctx,
      );
      expect(result).toEqual({ trusted: true });
      const line = mock.notified.find((n) => n.msg.includes("chain stopped after"));
      expect(line).toBeDefined();
      expect(line!.type).toBe("info");
      expect(line!.msg).toContain("event 'project_trust': chain stopped after 'hook-0'");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("tolerates a ctx without ui (notification guard never throws)", async () => {
    const booted = await bootWithHooks([
      { event: "turn_end", script: 'print ({setThinkingLevel: "low"} | to json)' },
    ]);
    const { mock } = booted;
    try {
      // A ctx with no ui: every notify must be silently skipped, never throw.
      const ctxNoUi = { ...createMockCtx(booted.root, mock.notified), ui: undefined } as unknown as ExtensionContext;
      const result = await fireFirstHandler(mock, "turn_end", { type: "turn_end" }, ctxNoUi);
      expect(result).toBeUndefined();
      // The directive was still applied even though no notification was possible.
      expect(mock.thinkingCalls).toEqual(["low"]);
      expect(mock.notified).toHaveLength(0);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);
});
