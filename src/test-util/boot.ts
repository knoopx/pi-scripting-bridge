/**
 * Isolated-root boot helpers for scripting-bridge tests. Where startBridge()
 * (bridge.ts) boots the extension against the current fixture skills tree,
 * these boot it against a FRESH, fully isolated temp root (env override)
 * containing only the given hook/tool/command fixtures, and wait for the
 * matching registrations. The shared skeleton lives in bootIsolated(); the
 * bootWithHooks/bootWithTools/bootWithCommands wrappers only differ in the
 * sub-directory, per-spec file writer, and the registration wait-predicate.
 * The matching cleanup restores the env override and removes the temp root.
 *
 * They read the extension module via currentFixture() (set up by each test
 * file's beforeAll -> setupFixture()), so per-topic files can reuse them
 * unchanged.
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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockPi, type MockPi } from "./mock-pi.js";
import { createMockCtx } from "./mock-ctx.js";
import { fireEvent, shutdownAll, waitFor } from "./bridge.js";
import { currentFixture } from "./fixtures.js";

/** The booted-isolated-root handle returned by the boot* helpers. */
export interface Booted {
  mock: MockPi;
  ctx: ExtensionContext;
  root: string;
  savedRoot: string | undefined;
}

/**
 * Write a nushell script (shebang + body) at ${dir}/${base}.nu, mode 0755,
 * and return its absolute path. `body` may be a single string or an array of
 * lines (joined with newlines, no trailing newline for the array form).
 */
function writeNuscript(dir: string, base: string, body: string | string[]): string {
  const scriptPath = join(dir, `${base}.nu`);
  const content =
    typeof body === "string"
      ? `#!/usr/bin/env nu\n${body}\n`
      : ["#!/usr/bin/env nu", ...body].join("\n");
  writeFileSync(scriptPath, content);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Write a skill frontmatter file at ${dir}/${base}.md (fence-wrapped). */
function writeSkillMd(dir: string, base: string, lines: string[]): void {
  writeFileSync(
    join(dir, `${base}.md`),
    ["---", ...lines, "---", ""].join("\n"),
  );
}

/** The per-kind parameters that distinguish each isolated boot. */
export interface BootIsolatedOpts<TSpec> {
  /** Sub-directory under the fresh root (e.g. "hooks", "tools", "cmds"). */
  dirName: string;
  /** Write one spec's script + skill-md into the sub-directory. */
  writeSpec: (dir: string, spec: TSpec, index: number) => void;
  /** Poll (via waitFor) until the given specs are registered on the mock. */
  waitFor: (mock: MockPi, specs: readonly TSpec[]) => boolean;
}

/**
 * Boot the bridge against a FRESH, isolated temp root (env override) that
 * contains only the specs written by opts.writeSpec, wait for opts.waitFor
 * to hold, and return the booted handle. On error, restores the env override
 * and removes the temp root. This is the single shared skeleton behind the
 * three boot* wrappers.
 */
export async function bootIsolated<TSpec>(
  opts: BootIsolatedOpts<TSpec>,
  specs: TSpec[],
): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), `scripting-bridge-${opts.dirName}-`));
  const savedRoot = process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT;
  process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = root;
  const dir = join(root, opts.dirName);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < specs.length; i++) {
    opts.writeSpec(dir, specs[i], i);
  }
  const mock = createMockPi();
  try {
    await currentFixture().extensionModule.default(mock.api);
    const ctx = createMockCtx(root, mock.notified);
    fireEvent(
      mock,
      "session_start",
      { type: "session_start", reason: "startup" },
      ctx,
    );
    await waitFor(() => opts.waitFor(mock, specs));
    return { mock, ctx, root, savedRoot };
  } catch (err) {
    process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = savedRoot;
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** A hook fixture spec (event + nushell script body). */
export type HookSpec = { event: string; script: string };

/**
 * Boot the bridge against an ISOLATED skills root (env override, like
 * the empty-tree test) containing only the given hook fixtures, and
 * wait for the hook handlers to be registered.
 */
export function bootWithHooks(hooks: HookSpec[]): Promise<Booted> {
  return bootIsolated(
    {
      dirName: "hooks",
      writeSpec: (dir, spec, i) => {
        const base = `hook-${i}`;
        const scriptPath = writeNuscript(dir, base, spec.script);
        writeSkillMd(dir, base, [
          `name: ${base}`,
          "type: hook",
          `event: ${spec.event}`,
          `command: ${scriptPath}`,
          "description: setThinkingLevel fixture",
        ]);
      },
      waitFor: (mock, specs) =>
        specs.every((h) => (mock.events.get(h.event) ?? []).length > 0),
    },
    hooks,
  );
}

/** A tool fixture spec (name + nushell script body, optional executionMode). */
export type ToolSpec = {
  name: string;
  script: string;
  /** Optional `executionMode` frontmatter line (validated by discovery). */
  executionMode?: string;
};

/**
 * Boot the bridge against an ISOLATED skills root (env override) containing
 * only the given tool fixtures, and wait for the tools to be registered.
 */
export function bootWithTools(tools: ToolSpec[]): Promise<Booted> {
  return bootIsolated(
    {
      dirName: "tools",
      writeSpec: (dir, spec, i) => {
        const base = `tool-${i}`;
        const scriptPath = writeNuscript(dir, base, spec.script);
        writeSkillMd(dir, base, [
          `name: ${spec.name}`,
          "type: tool",
          `command: ${scriptPath}`,
          "description: terminateSession fixture",
          ...(spec.executionMode !== undefined
            ? [`executionMode: ${spec.executionMode}`]
            : []),
        ]);
      },
      waitFor: (mock, specs) => specs.every((t) => mock.toolsByName.has(t.name)),
    },
    tools,
  );
}

/** A command fixture spec (name + script lines + frontmatter lines). */
export type CommandSpec = {
  name: string;
  script: string[];
  frontmatter: string[];
};

/**
 * Boot the bridge against an ISOLATED skills root (env override) that
 * contains only the given type:command fixtures, and wait for them to be
 * registered. `frontmatter` is the frontmatter body (without the ---
 * fences); the `command:` line is appended automatically.
 */
export function bootWithCommands(commands: CommandSpec[]): Promise<Booted> {
  return bootIsolated(
    {
      dirName: "cmds",
      writeSpec: (dir, spec) => {
        const scriptPath = writeNuscript(dir, spec.name, spec.script);
        writeSkillMd(dir, spec.name, [
          ...spec.frontmatter,
          `command: ${scriptPath}`,
        ]);
      },
      waitFor: (mock, specs) => specs.every((c) => mock.commandsByName.has(c.name)),
    },
    commands,
  );
}

/**
 * Tear down any isolated boot (bootWithHooks/bootWithTools/bootWithCommands):
 * shutdown + env restore + remove the temp root.
 */
export function cleanupBooted(booted: {
  mock: MockPi;
  root: string;
  savedRoot: string | undefined;
}): void {
  shutdownAll(booted.mock);
  process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT = booted.savedRoot;
  rmSync(booted.root, { recursive: true, force: true });
}
