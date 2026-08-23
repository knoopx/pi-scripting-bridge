/**
 * Shared fixture tree for scripting-bridge tests.
 *
 * setupFixture() builds a fresh, isolated skills tree (tools/hooks/commands +
 * nushell scripts) under a unique temp dir, points the bridge's
 * PI_SCRIPTING_BRIDGE_SKILLS_ROOT env var at it, imports the extension module,
 * and returns the fixture. teardownFixture() removes it. Because the tree is
 * created under a unique temp dir each call, per-topic test files can each
 * build their own fresh tree in their own beforeAll (re-entrant).
 *
 * The tree itself is table-driven: baseFixtureSpecs() is a data array of
 * {path, kind, script?/frontmatter?} specs and a single write loop materializes
 * every file. Per-scenario trees are data (base tree + additions) rather than
 * repeated write blocks. The bridge helpers in bridge.ts read the most-recently
 * created fixture via currentFixture().
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The imported extension module (its default export). */
export interface ExtensionModule {
  default: (pi: ExtensionAPI) => Promise<void>;
}

/** A freshly built fixture skills tree plus the extension module. */
export interface Fixture {
  fixtureRoot: string;
  demoDir: string;
  extensionModule: ExtensionModule;
}

/**
 * Write a nushell script (with shebang, mode 0755) at ${root}/${rel} and
 * return its absolute path. Exported so per-topic test files can add their
 * own fixtures into an isolated tree.
 */
export function writeScript(root: string, rel: string, body: string): string {
  const path = join(root, rel);
  writeFileSync(path, `#!/usr/bin/env nu\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Write a skill markdown file (frontmatter + body) at ${root}/${rel},
 * creating parent directories. Exported so per-topic test files can add
 * their own fixtures into an isolated tree.
 */
export function writeMd(root: string, rel: string, frontmatter: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\n\n# Fixture\n`);
}

/** One file in the fixture tree: a nushell script or a skill frontmatter md. */
export interface FixtureSpec {
  /** Path relative to the fixture root, e.g. "demo/scripts/hello.nu". */
  rel: string;
  kind: "script" | "md";
  /** Nushell source lines for kind "script" (shebang + 0755 applied by the writer). */
  script?: string[];
  /** Frontmatter lines for kind "md" (fence-wrapped by the writer). */
  frontmatter?: string[];
}

let current: Fixture | undefined;

/**
 * Return the fixture created by the most recent setupFixture() call (the
 * bridge helpers use this so per-topic files can reuse them unchanged).
 */
export function currentFixture(): Fixture {
  if (!current) {
    throw new Error("setupFixture() has not been called");
  }
  return current;
}

/**
 * The base fixture tree as data: one spec per file. `demoDir` supplies the
 * absolute `command:` paths each skill frontmatter references. Per-scenario
 * trees are built by appending to this (base tree + additions).
 */
export function baseFixtureSpecs(demoDir: string): FixtureSpec[] {
  const script = (rel: string, body: string[]): FixtureSpec => ({
    rel,
    kind: "script",
    script: body,
  });
  const md = (rel: string, frontmatter: string[]): FixtureSpec => ({
    rel,
    kind: "md",
    frontmatter,
  });
  const cmd = (base: string): string => join(demoDir, `scripts/${base}.nu`);
  const hookMd = (
    name: string,
    event: string,
    desc: string,
    extra: string[] = [],
  ): FixtureSpec =>
    md(`demo/hooks/${name}.md`, [
      `name: ${name}`,
      "type: hook",
      `event: ${event}`,
      ...extra,
      `command: ${cmd(name)}`,
      `description: ${desc}`,
    ]);
  const evScript = (base: string, expr: string): FixtureSpec =>
    script(`demo/scripts/${base}.nu`, [expr]);

  return [
    // --- tool fixtures ------------------------------------------------------

    script("demo/scripts/hello.nu", [
      "let payload = (^cat | from json)",
      "let out = {",
      '    content: [{type: "text", text: $"Hello, ($payload.params.greeting)($payload.params.punctuation)"}]',
      "    details: {greeting: $payload.params.greeting, toolCallId: $payload.toolCallId}",
      "}",
      "print ($out | to json)",
    ]),
    script("demo/scripts/runner-agent.nu", [
      "let payload = (^cat | from json)",
      'print ({content: [{type: "text", text: $"agent ran: ($payload.params.task)"}], details: {task: $payload.params.task}} | to json)',
    ]),
    script("demo/scripts/bad-exit.nu", ['print -e "boom"', "exit 3"]),
    script("demo/scripts/bad-json.nu", ['print "this is not json"']),

    md("demo/tools/hello.md", [
      "name: hello",
      "type: tool",
      "description: Say hello over the stdin/stdout JSON payload protocol",
      `command: ${cmd("hello")}`,
      "parameters:",
      "  greeting:",
      "    type: string",
      "    required: true",
      "  punctuation:",
      "    type: string",
      "    required: false",
      '    default: "!"',
    ]),
    md("demo/tools/bad-exit.md", [
      "name: bad-exit",
      "type: tool",
      "description: Fixture tool that exits non-zero",
      `command: ${cmd("bad-exit")}`,
    ]),
    md("demo/tools/bad-json.md", [
      "name: bad-json",
      "type: tool",
      "description: Fixture tool that emits invalid JSON",
      `command: ${cmd("bad-json")}`,
    ]),

    // A tool living OUTSIDE tools/ and agents/ must still be discovered:
    // registration is driven by the frontmatter `type:`, not the directory.
    script("demo/loose/loose-tool.nu", [
      "let payload = (^cat | from json)",
      'print ({content: [{type: "text", text: "loose: ok"}], details: {}} | to json)',
    ]),
    md("demo/loose/loose-tool.md", [
      "name: loose-tool",
      "type: tool",
      "description: A tool in a non-standard directory (type-authoritative discovery)",
      `command: ${join(demoDir, "loose/loose-tool.nu")}`,
    ]),

    md("demo/agents/runner-agent.md", [
      "name: runner-agent",
      "type: agent",
      "description: Agent-type fixture; the bridge must not register it",
      `command: ${cmd("runner-agent")}`,
      "parameters:",
      "  task:",
      "    type: string",
      "    required: true",
    ]),

    // A tool whose command carries a trailing positional token (after the
    // script path). The bridge must forward that token to the script as argv.
    script("demo/scripts/arg-echo.nu", [
      "def main [...cli] {",
      "    let payload = (^cat | from json)",
      "    let out = {",
      '        content: [{type: "text", text: $"args=($cli | str join \',\') task=($payload.params.task)"}]',
      "        details: {args: $cli, task: $payload.params.task}",
      "    }",
      "    print ($out | to json)",
      "}",
    ]),
    md("demo/tools/arg-echo-tool.md", [
      "name: arg-echo-tool",
      "type: tool",
      "description: Fixture that echoes its trailing command args as positional argv",
      `command: ${cmd("arg-echo")} career-manager`,
      "parameters:",
      "  task:",
      "    type: string",
      "    required: true",
    ]),

    // Content-validation fixtures: an image-only content array (valid) and a
    // content array with non-object entries (invalid: every() must reject).
    script("demo/scripts/content-img.nu", [
      'print ({content: [{type: "image"}], details: {status: "image"}} | to json)',
    ]),
    md("demo/tools/content-img.md", [
      "name: content-img",
      "type: tool",
      "description: Fixture tool emitting an image-only content array",
      `command: ${cmd("content-img")}`,
    ]),
    script("demo/scripts/content-bad.nu", [
      'print ({content: [null, 42], details: {status: "bad"}} | to json)',
    ]),
    md("demo/tools/content-bad.md", [
      "name: content-bad",
      "type: tool",
      "description: Fixture tool emitting a content array with non-object entries",
      `command: ${cmd("content-bad")}`,
    ]),

    // --- hook fixtures ------------------------------------------------------

    script("demo/scripts/alpha.nu", [
      "let payload = (^cat | from json)",
      "if $payload.event.toolName in [\"write\" \"edit\"] {",
      '    print ({content: [{type: "text", text: "alpha"}], details: {hook: "alpha"}} | to json)',
      "}",
    ]),
    script("demo/scripts/beta.nu", [
      "let payload = (^cat | from json)",
      "if $payload.event.toolName in [\"write\" \"edit\"] {",
      '    print ({content: [{type: "text", text: "beta"}], details: {hook: "beta"}, isError: false} | to json)',
      "}",
    ]),
    script("demo/scripts/broken.nu", ['print -e "hook failed"', "exit 1"]),
    script("demo/scripts/gamma.nu", ["sleep 1.5sec", "print '{}'"]),
    script("demo/scripts/guard.nu", [
      "let payload = (^cat | from json)",
      'let cmd = ($payload.event.input.command | split row " " | first)',
      "if $payload.event.toolName == \"bash\" and $cmd == \"rm\" {",
      '    print ({block: true, reason: "blocked rm commands"} | to json)',
      "}",
    ]),
    script("demo/scripts/slow.nu", ["sleep 0.4sec"]),

    hookMd("alpha", "tool_result", "Fixture hook A"),
    hookMd("beta", "tool_result", "Fixture hook B"),
    hookMd("broken", "tool_result", "Fixture hook that always fails (fail-open)"),
    hookMd("gamma", "tool_result", "Fixture hook that always times out (fail-open)", [
      "timeout: 1000",
    ]),
    hookMd("guard", "tool_call", "Fixture guardrail hook"),
    hookMd("slow", "tool_result", "Fixture hook that sleeps 0.4s"),

    // --- multi-event hook: one script bound to two events from one file ----
    // The `event` frontmatter field as a flow list; the same .nu script is
    // registered into a bucket for every bound event (session_before_compact
    // is a result event, session_compact a no-result event — neither is bound
    // by any other base fixture hook). Emits a sendMessage directive so the
    // test can observe the script running on each bound event.
    script("demo/scripts/multi-event.nu", [
      'print ({sendMessage: {customType: "multi-event", content: "fired", display: true}} | to json)',
    ]),
    hookMd(
      "multi-event",
      "[session_before_compact, session_compact]",
      "Multi-event fixture hook (one script bound to two events from one file)",
    ),

    // --- one hook per event, exercising every remaining combiner ---------

    evScript("ev-trust", 'print ({trusted: true} | to json)'),
    hookMd("ev-trust", "project_trust", "Fixture hook for project_trust (first decisive wins)"),
    evScript("ev-resources-a", 'print ({skillPaths: ["/a"], themePaths: ["/t"]} | to json)'),
    hookMd("ev-resources-a", "resources_discover", "First resources_discover hook (arrays accumulate)"),
    evScript("ev-resources-b", 'print ({skillPaths: ["/b"], promptPaths: ["/p"]} | to json)'),
    hookMd("ev-resources-b", "resources_discover", "Second resources_discover hook (arrays accumulate)"),
    evScript("ev-switch-cancel", 'print ({cancel: true} | to json)'),
    hookMd("ev-switch-cancel", "session_before_switch", "Fixture hook for session_before_switch (cancel)"),
    evScript("ev-fork", 'print ({skipConversationRestore: true} | to json)'),
    hookMd("ev-fork", "session_before_fork", "Fixture hook for session_before_fork (first-defined wins)"),
    evScript("ev-tree", 'print ({summary: "s", label: "l"} | to json)'),
    hookMd("ev-tree", "session_before_tree", "Fixture hook for session_before_tree (first-defined wins)"),
    evScript("ev-context", 'print ({messages: [{role: "user"}]} | to json)'),
    hookMd("ev-context", "context", "Fixture hook for context (full replacement)"),
    evScript("ev-provider", 'print ({body: "p"} | to json)'),
    hookMd("ev-provider", "before_provider_request", "Fixture hook for before_provider_request (replacement)"),
    evScript("ev-agentstart", 'print ({message: {role: "user"}, systemPrompt: "sp"} | to json)'),
    hookMd("ev-agentstart", "before_agent_start", "Fixture hook for before_agent_start (message + systemPrompt)"),

    // Always emits role "user": the test fires matching (preserved) and
    // mismatching (dropped) original roles to cover both branches.
    evScript("ev-message-end", 'print ({message: {role: "user"}} | to json)'),
    hookMd("ev-message-end", "message_end", "Fixture hook for message_end (role-preserved replacement)"),
    evScript("ev-input-b", 'print ({action: "handled"} | to json)'),
    hookMd("ev-input-b", "input", "Second input hook - handled fully suppresses input"),
    evScript("ev-bash", 'print ({result: "custom"} | to json)'),
    hookMd("ev-bash", "user_bash", "Fixture hook for user_bash (first result wins)"),
    evScript("ev-input-a", 'print ({action: "transform", text: "t"} | to json)'),
    hookMd("ev-input-a", "input", "First input hook (transform chains)"),

    // --- command fixtures --------------------------------------------------

    script("demo/scripts/pong.nu", [
      "let _payload = (^cat | from json | default {})",
      'print ({content: [{type: "text", text: "pong"}], details: {status: "ok"}} | to json)',
    ]),
    script("demo/scripts/broken-cmd.nu", ['print -e "cmd failed"', "exit 1"]),
    md("demo/commands/ping.md", [
      "name: ping",
      "type: command",
      "description: Fixture slash command that returns pong",
      `command: ${cmd("pong")}`,
    ]),
    md("demo/commands/broken-cmd.md", [
      "name: broken-cmd",
      "type: command",
      "description: Fixture command that always fails (fail-open)",
      `command: ${cmd("broken-cmd")}`,
    ]),

    // Non-bridge types that must be ignored by both bridges.
    md("demo/tools/not-a-tool.md", [
      "name: not-a-tool",
      "type: protocols",
      "description: Not a tool; must not be registered",
    ]),
  ];
}

/**
 * Build an isolated fixture skills tree under a fresh temp dir, point
 * PI_SCRIPTING_BRIDGE_SKILLS_ROOT at it, import the extension module, and
 * remember it as the current fixture. Re-entrant: each call yields a fresh
 * tree, so it can be invoked once per test file's beforeAll.
 */
export async function setupFixture(): Promise<Fixture> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "scripting-bridge-"));
  const demoDir = join(fixtureRoot, "demo");
  mkdirSync(join(demoDir, "tools"), { recursive: true });
  mkdirSync(join(demoDir, "agents"), { recursive: true });
  mkdirSync(join(demoDir, "hooks"), { recursive: true });
  mkdirSync(join(demoDir, "scripts"), { recursive: true });
  mkdirSync(join(demoDir, "loose"), { recursive: true });

  // Materialize the whole base tree from the spec table (single write loop).
  for (const spec of baseFixtureSpecs(demoDir)) {
    if (spec.kind === "script" && spec.script) {
      writeScript(fixtureRoot, spec.rel, spec.script.join("\n"));
    } else if (spec.kind === "md" && spec.frontmatter) {
      writeMd(fixtureRoot, spec.rel, spec.frontmatter.join("\n"));
    }
  }

  process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = fixtureRoot;

  const extensionModule = await import("../index.js");

  const fixture: Fixture = { fixtureRoot, demoDir, extensionModule };
  current = fixture;
  return fixture;
}

/**
 * Remove the current fixture's temp tree and clear it. Called from a test
 * file's afterAll.
 */
export function teardownFixture(): void {
  if (current) {
    rmSync(current.fixtureRoot, { recursive: true, force: true });
    current = undefined;
  }
}
