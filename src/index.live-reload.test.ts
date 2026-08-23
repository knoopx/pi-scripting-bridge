/**
 * Live-reload tests: the watcher registers a new tool file on change (no
 * /reload), drops a removed tool from the active set, closes watchers on
 * session_shutdown quit, tears down fully (no further rediscovery) on the
 * new/fork/resume shutdown reasons, and performs a one-time silent teardown
 * when a watcher-triggered rediscovery hits a stale pi.
 *
 * Shared helpers come from src/test-util/ (bridge, fixtures). The fixture
 * skills tree is built by setupFixture() in beforeAll (exposed as
 * fixtureRoot + demoDir) and removed by teardownFixture() in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  runTool,
  shutdownAll,
  sleep,
  startBridge,
  waitFor,
} from "./test-util/bridge.js";
import {
  setupFixture,
  teardownFixture,
} from "./test-util/fixtures.js";

let fixtureRoot: string;
let demoDir: string;

beforeAll(async () => {
  const fixture = await setupFixture();
  fixtureRoot = fixture.fixtureRoot;
  demoDir = fixture.demoDir;
});

afterAll(() => {
  teardownFixture();
});

describe("scripting-bridge live reload", () => {
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

    await waitFor(() => mock.toolsByName.has("live-tool"), 10_000);
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
  }, 15_000);

  it("drops a removed tool from the active set without /reload (live reload)", async () => {
    const { mock } = await startBridge((m) => m.toolsByName.has("bad-json"));
    expect(mock.active.has("bad-json")).toBe(true);

    rmSync(join(fixtureRoot, "demo/tools/bad-json.md"), { force: true });
    await waitFor(() => !mock.active.has("bad-json"), 10_000);
    expect(
      mock.activeSetCalls.some((names) => !names.includes("bad-json")),
    ).toBe(true);
    shutdownAll(mock);
  }, 15_000);

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
      mock.stale = false;
      rmSync(probeMd, { force: true });
    }

    // No "rediscovery failed" TUI spam at all.
    expect(
      mock.notified.filter((n) => n.msg.includes("rediscovery failed")),
    ).toHaveLength(0);
    // Exactly one TUI warning for the one-time teardown (no console output
    // of any kind).
    expect(
      mock.notified.filter(
        (n) => n.type === "warning" && n.msg.includes("instance stale"),
      ),
    ).toHaveLength(1);
    // The stale probe tool must never have been registered.
    expect(mock.toolsByName.has("stale-probe")).toBe(false);
  }, 8_000);
});
