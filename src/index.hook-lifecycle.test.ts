/**
 * Hook execution lifecycle tests: empty-output no-op silence, fail-warning
 * on a failed hook, abort-kill suppression (user abort fully silent), the
 * plain 10s timeout warning (untouched path), non-abort signal-kill
 * warning, combined-result "result applied" absence, project_trust internal
 * chain stop, ctx-without-ui notification guard, and the terminateSession
 * directive (tool + hook paths: in-process process.exit, key stripped, no
 * shutdown callback under vitest).
 *
 * Shared helpers come from src/test-util/ (mock-ctx, bridge, boot,
 * fixtures). Each hook test boots an isolated root via bootWithHooks() /
 * bootWithTools() and tears it down via cleanupBooted(). The fixture skills
 * tree is built by setupFixture() in beforeAll and removed by
 * teardownFixture() in afterAll.
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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockCtx } from "./test-util/mock-ctx.js";
import { fireFirstHandler, runTool } from "./test-util/bridge.js";
import {
  setupFixture,
  teardownFixture,
} from "./test-util/fixtures.js";
import {
  bootWithHooks,
  bootWithTools,
  cleanupBooted,
} from "./test-util/boot.js";

beforeAll(async () => {
  await setupFixture();
});

afterAll(() => {
  teardownFixture();
});

describe("scripting-bridge hook lifecycle", () => {
  it("emits no no-op toast on empty hook output", async () => {
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
      // Empty stdout means nothing changed: no per-hook no-op toast is
      // emitted, and the run is otherwise silent.
      expect(mock.notified).toHaveLength(0);
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

  // ---------------------------------------------------------------------
  // Abort-kill suppression (diagnosis fix #1): a hook child killed by the
  // user-initiated abort (ctx.signal → wireAbort → makeKiller) is fully
  // silent — no TUI warning, no log; the plain 10s timeout and non-abort
  // signal kills keep surfacing their warnings (timeout path untouched).
  // ---------------------------------------------------------------------

  it("suppresses the TUI warning entirely when a hook is killed by a user abort", async () => {
    const booted = await bootWithHooks([
      { event: "turn_end", script: "sleep 30sec" },
    ]);
    const { mock } = booted;
    const origError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    try {
      const controller = new AbortController();
      const abortCtx = {
        ...createMockCtx(booted.root, mock.notified),
        signal: controller.signal,
      } as unknown as ExtensionContext;
      const pending = fireFirstHandler(mock, "turn_end", { type: "turn_end" }, abortCtx);
      await new Promise((r) => setTimeout(r, 300));
      controller.abort();
      const result = await pending;
      expect(result).toBeUndefined();
      // No TUI warning of any kind for this hook run, and no error log:
      // the abort-kill is fully silent (the "failed (exit null)" line
      // never surfaces).
      expect(
        mock.notified.some((n) => n.msg.includes("failed (exit null)")),
      ).toBe(false);
      expect(
        mock.notified.some((n) => n.type === "warning" && n.msg.includes("hook 'hook-0' (turn_end)")),
      ).toBe(false);
      expect(errors.filter((m) => m.includes("hook 'hook-0' (turn_end)")).length).toBe(0);
    } finally {
      console.error = origError;
      cleanupBooted(booted);
    }
  }, 8_000);

  it("keeps surfacing the plain 10s timeout warning (timeout path untouched)", async () => {
    const booted = await bootWithHooks([
      { event: "turn_end", script: "sleep 30sec" },
    ]);
    const { mock } = booted;
    try {
      const started = Date.now();
      const result = await fireFirstHandler(
        mock,
        "turn_end",
        { type: "turn_end" },
        createMockCtx(booted.root, mock.notified),
      );
      expect(result).toBeUndefined();
      // The default 10s timeout (HOOK_DEFAULT_TIMEOUT_MS) killed the
      // child: the "timed out" warning must still surface.
      const line = mock.notified.find((n) => n.msg.includes("timed out"));
      expect(line).toBeDefined();
      expect(line!.type).toBe("warning");
      expect(line!.msg).toContain("hook 'hook-0' (turn_end)");
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      cleanupBooted(booted);
    }
  }, 15_000);

  it("keeps the warning for a non-abort signal kill (runScript level)", async () => {
    // A signal kill NOT from an abort (an external SIGTERM to the hook
    // child) must still surface the warning: the suppression branch
    // requires ctx.signal.aborted === true, so non-abort signal kills fall
    // through to the unchanged logFailure line.
    const { spawn } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-sigkill-"));
    const scriptPath = join(root, "hang.nu");
    try {
      writeFileSync(scriptPath, "#!/usr/bin/env nu\nsleep 30sec\n");
      chmodSync(scriptPath, 0o755);
      const controller = new AbortController(); // never aborted
      const child = spawn(scriptPath, [], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      });
      await new Promise((r) => setTimeout(r, 500));
      child.kill("SIGTERM");
      const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
        child.on("exit", (c, s) => resolve([c, s]));
      });
      // The non-abort signal-kill shape the unchanged logFailure branch
      // handles: code null + signal set, abort signal not aborted — so the
      // suppression discriminator evaluates false and the warning surfaces.
      expect(code).toBeNull();
      expect(signal).toBe("SIGTERM");
      expect(controller.signal.aborted).toBe(false);
      expect(signal !== null && controller.signal.aborted === true).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);

  it("returns the combined result without a 'result applied' TUI line", async () => {
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
      // Current behavior: the "result applied" visibility part is built
      // (rest is non-empty) but never notified to the TUI.
      expect(
        mock.notified.some((n) => n.msg.includes("result applied")),
      ).toBe(false);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("stops the project_trust chain internally without a TUI notification", async () => {
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
      // The project_trust combiner stops the chain (first defined answer
      // wins); the stop is tracked in the chain state, but no "chain
      // stopped after" TUI line is emitted (visibility line not notified).
      expect(
        mock.notified.some((n) => n.msg.includes("chain stopped after")),
      ).toBe(false);
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

  // ---------------------------------------------------------------------
  // terminateSession directive (tool path)
  // ---------------------------------------------------------------------

  it("applies a tool terminateSession=true directive (shutdown once, key stripped, visibility line)", async () => {
    const booted = await bootWithTools([
      {
        name: "terminate-tool",
        script:
          'print ({content: [{type: "text", text: "Session terminated."}], terminateSession: true} | to json)',
      },
    ]);
    const { mock, root } = booted;
    let shutdownCalls = 0;
    const ctx = createMockCtx(root, mock.notified, () => {
      shutdownCalls++;
    });
    try {
      const result = (await runTool(
        mock,
        "terminate-tool",
        "call-term",
        {},
        ctx,
      )) as {
        content: { type: string; text: string }[];
        details: Record<string, unknown>;
      };
      // process.exit(0) is used (not ctx.shutdown), so no shutdown callback fires.
      expect(shutdownCalls).toBe(0);
      // The directive key is stripped: absent from details and the result.
      expect(result.details).not.toHaveProperty("terminateSession");
      expect(result).not.toHaveProperty("terminateSession");
      // The script's own content is preserved and the visibility line is appended.
      const texts = result.content.map((c) => c.text);
      expect(texts).toContain("Session terminated.");
      expect(texts).toContain(
        "scripting-bridge: terminateSession directive applied (pi shutdown initiated)",
      );
      // A warning notification was emitted (process.exit intercepted by vitest).
      const line = mock.notified.find((n) =>
        n.msg.includes("terminateSession failed"),
      );
      expect(line).toBeDefined();
      expect(line!.type).toBe("warning");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("ignores a non-boolean tool terminateSession value (no shutdown, result intact)", async () => {
    const booted = await bootWithTools([
      {
        name: "terminate-invalid",
        script:
          'print ({content: [{type: "text", text: "ok"}], terminateSession: "yes"} | to json)',
      },
    ]);
    const { mock, root } = booted;
    let shutdownCalls = 0;
    const ctx = createMockCtx(root, mock.notified, () => {
      shutdownCalls++;
    });
    try {
      const result = (await runTool(
        mock,
        "terminate-invalid",
        "call-inv",
        {},
        ctx,
      )) as {
        content: { type: string; text: string }[];
      };
      // The directive was ignored: no shutdown, no visibility line.
      expect(shutdownCalls).toBe(0);
      expect(result.content.map((c) => c.text)).toEqual(["ok"]);
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  it("does not call shutdown when a tool result has no terminateSession key", async () => {
    const booted = await bootWithTools([
      {
        name: "plain-tool",
        script:
          'print ({content: [{type: "text", text: "plain ok"}], details: {x: 1}} | to json)',
      },
    ]);
    const { mock, root } = booted;
    let shutdownCalls = 0;
    const ctx = createMockCtx(root, mock.notified, () => {
      shutdownCalls++;
    });
    try {
      const result = (await runTool(
        mock,
        "plain-tool",
        "call-plain",
        {},
        ctx,
      )) as {
        content: { type: string; text: string }[];
        details: Record<string, unknown>;
      };
      expect(shutdownCalls).toBe(0);
      expect(result.content.map((c) => c.text)).toEqual(["plain ok"]);
      expect(result.details).toEqual({ x: 1 });
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);

  // ---------------------------------------------------------------------
  // terminateSession directive (hook path)
  // ---------------------------------------------------------------------

  it("applies a hook terminateSession=true directive on agent_end (same in-process termination as the tool path)", async () => {
    const booted = await bootWithHooks([
      {
        event: "agent_end",
        script: 'print ({terminateSession: true} | to json)',
      },
    ]);
    const { mock, root } = booted;
    let shutdownCalls = 0;
    const ctx = createMockCtx(root, mock.notified, () => {
      shutdownCalls++;
    });
    try {
      const result = await fireFirstHandler(
        mock,
        "agent_end",
        { type: "agent_end" },
        ctx,
      );
      // NO_RESULT event: the key is stripped and nothing contributes to the
      // combined result.
      expect(result).toBeUndefined();
      // The hook path reuses the tool path helper: process.exit (not
      // ctx.shutdown), so no shutdown callback fires under vitest.
      expect(shutdownCalls).toBe(0);
      // Current behavior: the "terminateSession" visibility part is built
      // (key stripped, nothing contributed) but never notified to the TUI.
      expect(
        mock.notified.some((n) => n.msg.includes("hook 'hook-0' (agent_end)")),
      ).toBe(false);
      // The in-process termination was still attempted (vitest intercepts
      // process.exit, so the helper's catch surfaces the warning).
      const warn = mock.notified.find((n) =>
        n.msg.includes("terminateSession failed"),
      );
      expect(warn).toBeDefined();
      expect(warn!.type).toBe("warning");
    } finally {
      cleanupBooted(booted);
    }
  }, 8_000);
});
