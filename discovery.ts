/**
 * Skill discovery: a single recursive walk of the skills tree in which the
 * frontmatter `type:` field — never the file's directory — decides
 * registration. `type: tool` registers as a bridge tool; `type: hook`
 * registers as an event hook. `type: agent` files are regular tools
 * (invoked via the `spawn-agent` tool); they are outside this extension's
 * auto-registration set because they resolve to the shared `spawn-agent.nu`
 * command rather than a per-skill script.
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  BRIDGEABLE_EVENTS,
  HOOK_DEFAULT_TIMEOUT_MS,
  HOOK_MAX_TIMEOUT_MS,
  SKIP_DIRS,
  type BridgeableEvent,
} from "./constants.js";
import type { ShellToolProperty } from "./schema.js";
import {
  deriveName,
  readSkillFile,
  resolveScriptCommand,
} from "./frontmatter.js";

export interface DiscoveredTool {
  name: string;
  description: string;
  parameters: Record<string, ShellToolProperty>;
  scriptPath: string;
  /** Positional args forwarded to the script (trailing tokens of `command`). */
  args: string[];
  defaults: Record<string, unknown>;
  /** Content hash of the .md file; changes force tool re-registration. */
  fingerprint: string;
}

export interface ToolDiscovery {
  tools: Map<string, DiscoveredTool>;
  skipped: { name: string; error: string }[];
}

export interface DiscoveredHook {
  /** File stem (hook name). */
  name: string;
  domain: string;
  event: BridgeableEvent;
  timeoutMs: number;
  scriptPath: string;
  /** Positional args forwarded to the hook script (trailing `command` tokens). */
  args: string[];
  fingerprint: string;
}

export interface HookDiscovery {
  /** Hooks sorted by event then filename (run order). */
  hooks: DiscoveredHook[];
  skipped: { name: string; error: string }[];
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Recursively collect every .md file under `root`. Skips node_modules/.git
 * and other dot-dirs.
 */
async function walkMdFiles(
  root: string,
  dir: string = root,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      files.push(...(await walkMdFiles(root, full)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

async function parseToolSkill(mdPath: string): Promise<{
  def: DiscoveredTool | null;
  error: string | null;
}> {
  const file = await readSkillFile(mdPath);
  if (!file.ok) {
    return { def: null, error: file.error };
  }

  const raw = file.data;
  // The frontmatter `type:` is authoritative: only `tool` skills register as
  // bridge tools.
  if (raw.type !== "tool") {
    return { def: null, error: null };
  }

  if (
    typeof raw.description !== "string" ||
    raw.description.trim().length === 0
  ) {
    return { def: null, error: "missing description" };
  }

  const script = await resolveScriptCommand(mdPath, raw.command);
  if (!script.ok) {
    return { def: null, error: script.error };
  }

  const parameters =
    typeof raw.parameters === "object" && raw.parameters !== null
      ? (raw.parameters as Record<string, ShellToolProperty>)
      : {};

  return {
    def: {
      name:
        typeof raw.name === "string" && raw.name.trim().length > 0
          ? raw.name
          : deriveName(mdPath),
      description: raw.description,
      parameters,
      scriptPath: script.scriptPath,
      args: script.args,
      defaults: collectDefaults(parameters),
      fingerprint: `${hashString(file.content)}:${script.scriptPath}`,
    },
    error: null,
  };
}

function collectDefaults(
  parameters: Record<string, ShellToolProperty>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(parameters)) {
    if (prop && prop.default !== undefined) {
      defaults[key] = prop.default;
    }
  }
  return defaults;
}

export async function discoverTools(root: string): Promise<ToolDiscovery> {
  const tools = new Map<string, DiscoveredTool>();
  const skipped: { name: string; error: string }[] = [];

  // Single recursive walk; the frontmatter `type: tool` decides
  // registration, independent of where the file lives.
  for (const mdPath of (await walkMdFiles(root)).sort()) {
    const { def, error } = await parseToolSkill(mdPath);
    if (error !== null) {
      skipped.push({ name: deriveName(mdPath), error });
      continue;
    }
    if (def === null) {
      continue; // not a type: tool skill
    }
    if (tools.has(def.name)) {
      skipped.push({
        name: def.name,
        error: `duplicate tool name (kept first)`,
      });
      continue;
    }
    tools.set(def.name, def);
  }

  return { tools, skipped };
}

async function parseHookSkill(
  mdPath: string,
  root: string,
): Promise<{ def: DiscoveredHook | null; error: string | null }> {
  const file = await readSkillFile(mdPath);
  if (!file.ok) {
    return { def: null, error: file.error };
  }

  const raw = file.data;
  if (raw.type !== "hook") {
    return { def: null, error: null };
  }

  const event = raw.event;
  if (
    typeof event !== "string" ||
    !(BRIDGEABLE_EVENTS as readonly string[]).includes(event)
  ) {
    return {
      def: null,
      error: `event missing or not bridgeable: ${String(event)}`,
    };
  }

  const timeout = parseHookTimeout(raw.timeout);
  if (typeof timeout === "string") {
    return { def: null, error: timeout };
  }

  const script = await resolveScriptCommand(mdPath, raw.command);
  if (!script.ok) {
    return { def: null, error: script.error };
  }

  // Top-level directory segment under the skills root (metadata only).
  const rel = mdPath.startsWith(root) ? mdPath.slice(root.length + 1) : mdPath;
  const domain = rel.split(/[\\/]/)[0] ?? "";

  return {
    def: {
      name: basename(mdPath, ".md"),
      domain,
      event: event as BridgeableEvent,
      timeoutMs: timeout,
      scriptPath: script.scriptPath,
      args: script.args,
      fingerprint: `${hashString(file.content)}:${script.scriptPath}`,
    },
    error: null,
  };
}

/**
 * Hook timeout (ms): default 10s, clamped to [1, 300000]. Returns the
 * timeout, or an error message string for invalid values.
 */
function parseHookTimeout(raw: unknown): number | string {
  if (raw === undefined) {
    return HOOK_DEFAULT_TIMEOUT_MS;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return `timeout must be a number of milliseconds`;
  }
  return Math.min(Math.max(Math.floor(raw), 1), HOOK_MAX_TIMEOUT_MS);
}

export async function discoverHooks(root: string): Promise<HookDiscovery> {
  const hooks: DiscoveredHook[] = [];
  const skipped: { name: string; error: string }[] = [];

  // Same single recursive, type-authoritative walk as tool discovery: the
  // frontmatter `type: hook` decides registration, not the file's directory.
  for (const mdPath of (await walkMdFiles(root)).sort()) {
    const { def, error } = await parseHookSkill(mdPath, root);
    if (error !== null) {
      skipped.push({ name: basename(mdPath, ".md"), error });
      continue;
    }
    if (def !== null) {
      hooks.push(def);
    }
  }

  // Sorted-filename run order, grouped by event.
  hooks.sort(
    (a, b) =>
      a.event.localeCompare(b.event) ||
      a.scriptPath.localeCompare(b.scriptPath),
  );

  return { hooks, skipped };
}
