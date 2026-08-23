/**
 * makeLoadPreview contract: the `previewCommand` template is interpolated from the
 * focused item (single-quoted; embedded quotes escaped) and run via `/bin/sh -c`;
 * an absent/empty template, non-zero exit, or hung command (5s kill) fails open to [].
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeLoadPreview,
  splitArgv,
} from "./command-exec.js";
import { discoverCommands } from "./discovery.js";
import { interpolateTemplate } from "./ui/picker.js";
import type { PickerItem } from "./ui/picker.js";

/** A picker item carrying a `path` field (the template's interpolation target). */
function item(path: string, extra?: Record<string, unknown>): PickerItem {
  return { id: path, label: path, path, ...extra };
}

describe("makeLoadPreview (previewCommand template runner)", () => {
  it("captures the command stdout on focus (split on newlines)", async () => {
    const load = makeLoadPreview("printf 'line1\\nline2'");
    expect(await load(item("a"))).toEqual(["line1", "line2"]);
  });

  it("captures ANSI-colored stdout verbatim (renderer is ANSI-aware)", async () => {
    const load = makeLoadPreview("printf '\\033[32mok\\033[0m'");
    expect(await load(item("a"))).toEqual(["\u001b[32mok\u001b[0m"]);
  });

  it("interpolates a {field} placeholder from the item (single-quoted value)", async () => {
    const load = makeLoadPreview("printf {path}");
    expect(await load(item("a b c"))).toEqual(["a b c"]);
  });

  it("escapes embedded single quotes in an interpolated value", async () => {
    const load = makeLoadPreview("printf {path}");
    expect(await load(item("o'clock"))).toEqual(["o'clock"]);
  });

  it("leaves an unknown placeholder as literal text", async () => {
    const load = makeLoadPreview("printf {missing}");
    expect(await load(item("a"))).toEqual(["{missing}"]);
  });

  it("yields an empty preview when no template is supplied", async () => {
    expect(await makeLoadPreview()(item("a"))).toEqual([]);
    expect(await makeLoadPreview(undefined)(item("a"))).toEqual([]);
  });

  it("yields an empty preview for an empty template", async () => {
    expect(await makeLoadPreview("")(item("a"))).toEqual([]);
  });

  it("yields an empty preview on non-zero exit (stdout on failure not shown)", async () => {
    const load = makeLoadPreview("printf 'nope'; exit 3");
    expect(await load(item("a"))).toEqual([]);
  });

  it("kills a hung command after 5s and yields an empty preview", async () => {
    const load = makeLoadPreview("sleep 30");
    const started = Date.now();
    expect(await load(item("a"))).toEqual([]);
    const elapsed = Date.now() - started;
    // The kill fires at the 5s timeout — well before the 30s sleep.
    expect(elapsed).toBeLessThan(20_000);
  }, 10_000);
});

describe("splitArgv (command template tokenizer)", () => {
  it("splits a simple unquoted command into tokens", () => {
    expect(splitArgv("kitty @ launch --type=os-window hx /tmp/foo")).toEqual([
      "kitty", "@", "launch", "--type=os-window", "hx", "/tmp/foo",
    ]);
  });

  it("handles single-quoted strings (literal content)", () => {
    expect(splitArgv("printf 'hello world'")).toEqual(["printf", "hello world"]);
  });

  it("handles double-quoted strings with escapes", () => {
    expect(splitArgv('echo "a \\"b\\" c"')).toEqual(["echo", "a \"b\" c"]);
  });

  it("handles backslash escapes outside quotes", () => {
    expect(splitArgv("echo a\\ b")).toEqual(["echo", "a b"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(splitArgv("")).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(splitArgv("   ")).toEqual([]);
  });

  it("handles empty single-quoted strings", () => {
    expect(splitArgv("echo ''")).toEqual(["echo", ""]);
  });

  it("handles empty double-quoted strings", () => {
    expect(splitArgv('echo ""')).toEqual(["echo", ""]);
  });

  it("handles mixed quoting", () => {
    expect(splitArgv("cmd 'a b' c d f")).toEqual(["cmd", "a b", "c", "d", "f"]);
  });

  it("tokenizes the full kitty launch template", () => {
    expect(
      splitArgv("kitty @ launch --type=os-window hx /home/user/file.ts"),
    ).toEqual(["kitty", "@", "launch", "--type=os-window", "hx", "/home/user/file.ts"]);
  });
});

describe("interpolateTemplate (round-trip with splitArgv)", () => {
  it("interpolates {path} from a picker item", () => {
    const result = interpolateTemplate("kitty @ launch --type=os-window hx {path}", {
      id: "/tmp/foo",
      label: "/tmp/foo",
      path: "/tmp/foo",
    });
    expect(result).toBe("kitty @ launch --type=os-window hx /tmp/foo");
  });

  it("leaves unbalanced { as literal (matches picker semantics)", () => {
    const result = interpolateTemplate("cmd {unbalanced", { id: "x", label: "x" });
    expect(result).toBe("cmd {unbalanced");
  });

  it("interpolates multiple placeholders", () => {
    const result = interpolateTemplate("cmd {a} {b}", {
      id: "x",
      label: "x",
      a: "val1",
      b: "val2",
    });
    expect(result).toBe("cmd val1 val2");
  });

  it("replaces unknown placeholders with empty string (fieldText undefined → '')", () => {
    const result = interpolateTemplate("cmd {missing}", { id: "x", label: "x" });
    expect(result).toBe("cmd ");
  });

  it("round-trips through splitArgv for a full launch command", () => {
    const template = "kitty @ launch --type=os-window hx {path}";
    const item: PickerItem = { id: "/tmp/foo", label: "/tmp/foo", path: "/tmp/foo" };
    const interpolated = interpolateTemplate(template, item);
    const argv = splitArgv(interpolated);
    expect(argv[0]).toBe("kitty");
    expect(argv.slice(1)).toEqual(["@", "launch", "--type=os-window", "hx", "/tmp/foo"]);
  });
});

describe("command dispatch (legacy vs template)", () => {
  it("resolvable .nu file → legacy scriptPath set, commandTemplate absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-dispatch-"));
    try {
      const scriptPath = join(root, "legacy-cmd.nu");
      writeFileSync(scriptPath, "#!/usr/bin/env nu\nprint '{}'\n");
      chmodSync(scriptPath, 0o755);
      writeFileSync(
        join(root, "legacy-cmd.md"),
        [
          "---",
          "name: legacy-cmd",
          "type: command",
          "description: Legacy script command",
          `command: ${scriptPath}`,
          "---",
          "",
        ].join("\n"),
      );
      const { commands, skipped } = await discoverCommands(root);
      expect(skipped).toEqual([]);
      const def = commands.get("legacy-cmd");
      expect(def?.scriptPath).toBe(scriptPath);
      expect(def?.commandTemplate).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("non-file command string → template set, scriptPath is the raw string", async () => {
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-dispatch-"));
    try {
      const template = "kitty @ launch --type=os-window hx {path}";
      writeFileSync(
        join(root, "tmpl-cmd.md"),
        [
          "---",
          "name: tmpl-cmd",
          "type: command",
          "description: Template command",
          `command: "${template}"`,
          "---",
          "",
        ].join("\n"),
      );
      const { commands, skipped } = await discoverCommands(root);
      expect(skipped).toEqual([]);
      const def = commands.get("tmpl-cmd");
      expect(def?.commandTemplate).toBe(template);
      expect(def?.scriptPath).toBe(template); // fingerprint base
      expect(def?.fingerprint).toContain(template);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("missing command field → hard error (skipped)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scripting-bridge-dispatch-"));
    try {
      writeFileSync(
        join(root, "no-cmd.md"),
        [
          "---",
          "name: no-cmd",
          "type: command",
          "description: Missing command",
          "---",
          "",
        ].join("\n"),
      );
      const { commands, skipped } = await discoverCommands(root);
      expect(commands.size).toBe(0);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.name).toBe("no-cmd");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
