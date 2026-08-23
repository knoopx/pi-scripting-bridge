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
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import {
  BRIDGEABLE_EVENTS,
  HOOK_DEFAULT_TIMEOUT_MS,
  HOOK_MAX_TIMEOUT_MS,
  SKIP_DIRS,
  type BridgeableEvent,
} from "./constants.js";
import type { ShellToolProperty } from "./schema.js";
import { Key } from "@earendil-works/pi-tui";

/**
 * The set of valid key identifiers a picker-action `shortcut` may name: every
 * string-valued entry of the pi-tui `Key` map, plus the modifier keys that
 * may prefix them (ctrl/shift/alt/super).
 */
const KNOWN_KEYS = new Set<string>(
  (Object.values(Key) as unknown[]).filter((v): v is string =>
    typeof v === "string",
  ),
);
const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/**
 * Whether a `shortcut` value is a real pi-tui keybinding. A keybinding is a
 * single printable char, or a known Key name ("enter", "escape", "tab", "f1",
 * ...), optionally prefixed with ctrl/shift/alt/super joined by "+". Values
 * like "edit" (not a keybinding) are invalid.
 */
function isValidKeyId(keyId: string): boolean {
  const parts = keyId.trim().toLowerCase().split("+");
  const base = parts[parts.length - 1];
  if (!base) {
    return false;
  }
  for (let i = 0; i < parts.length - 1; i++) {
    if (!KEY_MODIFIERS.has(parts[i])) {
      return false;
    }
  }
  return base.length === 1 || KNOWN_KEYS.has(base);
}
import type {
  PickerAction,
  PickerColumn,
  PickerEffect,
  SplitPickerConfig,
} from "./ui/picker.js";
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
  /**
   * Per-tool execution mode from the frontmatter `executionMode` field
   * ("sequential" | "parallel"). Undefined when the field is absent so the
   * caller's `?? "parallel"` default applies at registration time.
   */
  executionMode?: "sequential" | "parallel";
}

export interface ToolDiscovery {
  tools: Map<string, DiscoveredTool>;
  skipped: { name: string; error: string }[];
}

export interface DiscoveredHook {
  /** Hook name: frontmatter `name` (domain identity), or the file stem when absent. */
  name: string;
  domain: string;
  /**
   * The bridgeable events this hook is bound to. One script/handler may serve
   * multiple events: the frontmatter `event` field accepts either a single
   * bridgeable string (backward-compatible) or a non-empty list of them, and
   * the hook is registered into a bucket for every event in this list. The
   * list preserves frontmatter order and is deduplicated; the first entry is
   * the sort/primary event.
   */
  events: BridgeableEvent[];
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

export interface DiscoveredCommand {
  /** Slash-command name, invoked as `/name`. */
  name: string;
  description: string;
  parameters: Record<string, ShellToolProperty>;
  /** Defaults collected from the `parameters` field (applied into `params`). */
  defaults: Record<string, unknown>;
  scriptPath: string;
  /** Positional args forwarded to the command script (trailing `command` tokens). */
  args: string[];
  /**
   * Picker config from the optional `picker` frontmatter block. Undefined
   * when the block is absent (or failed validation): the bridge then
   * launches the zero-config picker defaults.
   */
  picker?: SplitPickerConfig;
  /**
   * The optional `shortcut` frontmatter field: a pi-tui KeyId string
   * (e.g. "ctrl+p") the bridge binds to this command. Undefined when the
   * field is absent (or failed validation): the command gets no key
   * binding.
   */
  shortcut?: string;
  /**
   * Executable command template (no shell, no script): when set, the
   * command's on-select action is spawned via Node child_process using the
   * selected picker item's fields for {param} interpolation. Mutually
   * exclusive with the legacy `scriptPath` execution path.
   */
  commandTemplate?: string;
  /** Content hash of the .md file; changes force command re-registration. */
  fingerprint: string;
}

export interface CommandDiscovery {
  commands: Map<string, DiscoveredCommand>;
  skipped: { name: string; error: string }[];
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** A directory that the skills-tree walk must never descend into. */
function isSkippedDirectory(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

/**
 * Read one directory's entries; an unreadable directory contributes nothing.
 */
async function listDirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A subdirectory worth recursing into (not a skip-dir, not a dot-dir). */
function isWalkableDir(entry: Dirent): boolean {
  return entry.isDirectory() && !isSkippedDirectory(entry.name);
}

/** A regular .md file to collect. */
function isMdFile(entry: Dirent): boolean {
  return entry.isFile() && entry.name.endsWith(".md");
}

/**
 * The .md files contributed by one directory entry: walkable
 * subdirectories contribute their recursive walk, .md files contribute
 * themselves, everything else contributes nothing.
 */
async function collectEntryFiles(
  dir: string,
  entry: Dirent,
): Promise<string[]> {
  if (isWalkableDir(entry)) {
    return collectMdFiles(join(dir, entry.name));
  }
  if (isMdFile(entry)) {
    return [join(dir, entry.name)];
  }
  return [];
}

/**
 * Recursively collect every .md file under `dir`. Skips node_modules/.git
 * and other dot-dirs; unreadable directories contribute nothing.
 */
async function collectMdFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await listDirEntries(dir)) {
    files.push(...(await collectEntryFiles(dir, entry)));
  }
  return files;
}

/**
 * Recursively collect every .md file under `root`. Skips node_modules/.git
 * and other dot-dirs.
 */
async function walkMdFiles(root: string): Promise<string[]> {
  return collectMdFiles(root);
}

/** Outcome of the shared skill-parse preamble (read file + type check). */
type SkillPreamble =
  | { kind: "gate"; def: null; error: string | null }
  | { kind: "ok"; raw: Record<string, unknown>; content: string };

/**
 * Shared parse preamble for the per-type skill parsers: read the .md file
 * and gate on the frontmatter `type:`. A read failure is a real error; a
 * type mismatch is "not this skill" (no error). Both are returned in the
 * caller's early-return shape `{ def: null, error }` so the caller can
 * `return` it directly; on a match the raw frontmatter plus the file
 * content (for fingerprinting) are returned.
 */
async function readSkillPreamble(
  mdPath: string,
  type: "tool" | "hook" | "command",
): Promise<SkillPreamble> {
  const file = await readSkillFile(mdPath);
  if (!file.ok) {
    return { kind: "gate", def: null, error: file.error };
  }
  if (file.data.type !== type) {
    return { kind: "gate", def: null, error: null };
  }
  return { kind: "ok", raw: file.data, content: file.content };
}

/**
 * The `parameters` field of a skill frontmatter as a ShellToolProperty map
 * (absent / non-object → empty map). Shared by the tool and command
 * parsers.
 */
function collectParameters(
  raw: Record<string, unknown>,
): Record<string, ShellToolProperty> {
  return typeof raw.parameters === "object" && raw.parameters !== null
    ? (raw.parameters as Record<string, ShellToolProperty>)
    : {};
}

/** Shared per-file outcome of a skill parser: the definition or the error. */
type SkillParserResult<T> = { def: T | null; error: string | null };

/** Per-file skill parser consumed by the shared registration walk. */
type SkillParser<T> = (mdPath: string) => Promise<SkillParserResult<T>>;

/** A present non-empty string (after trimming) — shared guard clause. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A present finite number — shared guard clause. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * One entry of a discovery `skipped` list.
 */
type SkippedEntry = { name: string; error: string };

/**
 * Decide the registry fate of one parsed skill: a parse error or a
 * duplicate name (keeping the first) becomes a skip record; a fresh
 * definition registers; "not this skill" (null def) is a silent no-op.
 */
function registerSkill<T extends { name: string }>(
  result: SkillParserResult<T>,
  fallbackName: string,
  registry: Map<string, T>,
  dupLabel: string,
): SkippedEntry | null {
  const { def, error } = result;
  if (error !== null) {
    return { name: fallbackName, error };
  }
  if (def === null) {
    return null;
  }
  if (registry.has(def.name)) {
    return {
      name: def.name,
      error: `duplicate ${dupLabel} name (kept first)`,
    };
  }
  registry.set(def.name, def);
  return null;
}

/**
 * Shared registration walk for map-keyed skill types (tools, commands):
 * walk the tree, parse each file with `parser`, collect read/validation
 * errors into `skipped`, register fresh names into `registry`, and record a
 * duplicate-name skip ("kept first") for collisions. Returns the skipped
 * list; the caller pairs it with its registry.
 */
async function registerSkills<T extends { name: string }>(
  root: string,
  parser: SkillParser<T>,
  registry: Map<string, T>,
  dupLabel: string,
): Promise<SkippedEntry[]> {
  const skipped: SkippedEntry[] = [];
  for (const mdPath of (await walkMdFiles(root)).sort()) {
    const entry = registerSkill(
      await parser(mdPath),
      deriveName(mdPath),
      registry,
      dupLabel,
    );
    if (entry !== null) {
      skipped.push(entry);
    }
  }
  return skipped;
}

/**
 * Validate the required `description` of a `type: tool` skill: a
 * non-empty (after trimming) string; the `{ error }` shape when it is
 * absent, not a string, or empty after trimming.
 */
function parseToolSkillDescription(
  raw: Record<string, unknown>,
): { description: string } | { error: string } {
  if (!isNonEmptyString(raw.description)) {
    return { error: "missing description" };
  }
  return { description: raw.description };
}

/**
 * Resolve the skill's `command` script path + trailing args, preserving
 * the resolver's exact error message when the command is missing or
 * unresolvable.
 */
async function resolveScriptStep(
  mdPath: string,
  command: unknown,
): Promise<
  | { scriptPath: string; args: string[] }
  | { error: string }
> {
  const script = await resolveScriptCommand(mdPath, command);
  if (!script.ok) {
    return { error: script.error };
  }
  return { scriptPath: script.scriptPath, args: script.args };
}

/**
 * A tool's name: the frontmatter `name` when present and non-empty,
 * otherwise the file-stem-derived default.
 */
function toolNameOf(mdPath: string, raw: Record<string, unknown>): string {
  return isNonEmptyString(raw.name) ? raw.name : deriveName(mdPath);
}

/** Assemble the DiscoveredTool from its validated pieces. */
function buildToolDef(
  mdPath: string,
  raw: Record<string, unknown>,
  content: string,
  description: string,
  scriptPath: string,
  args: string[],
): DiscoveredTool {
  const parameters = collectParameters(raw);
  const name = toolNameOf(mdPath, raw);
  return {
    name,
    description,
    parameters,
    scriptPath,
    args,
    defaults: collectDefaults(parameters),
    fingerprint: `${hashString(content)}:${scriptPath}`,
    executionMode: parseExecutionMode(raw.executionMode),
  };
}

/**
 * Normalized validation result: either the validated value or an error.
 * Used by the shared skill-parse pipeline to unify the type-specific
 * validation step across tool/hook/command parsers.
 */
type ValidationResult<T> = { valid: T } | { error: string };

/**
 * Shared discovery tail: resolve the skill's `command` script step and, on
 * success, build the type-specific def via `buildDef`. A script resolution
 * failure calls `onScriptError` (when provided); a non-null result from it
 * overrides the default error. When `onScriptError` is absent or returns
 * `null`, the failure short-circuits to a `{ def: null, error }` result.
 */
async function resolveScriptAndBuildDef<TDef>(
  mdPath: string,
  pre: { raw: Record<string, unknown>; content: string },
  buildDef: (script: { scriptPath: string; args: string[] }) => TDef,
  onScriptError?: (script: { error: string }) =>
    | SkillParserResult<TDef>
    | null,
): Promise<SkillParserResult<TDef>> {
  const script = await resolveScriptStep(mdPath, pre.raw.command);
  if ("error" in script) {
    if (onScriptError) {
      const override = onScriptError(script);
      if (override !== null) {
        return override;
      }
    }
    return { def: null, error: script.error };
  }
  return { def: buildDef(script), error: null };
}

/**
 * Shared skill-parse pipeline: read the preamble, run the type-specific
 * validation, then delegate to `resolveScriptAndBuildDef` for script
 * resolution and def construction. An optional `onScriptError` in the
 * config handles script-resolution errors (e.g. the command template
 * branch); returning `null` falls through to the default error.
 */
async function parseSkill<TDef, TValid>(
  mdPath: string,
  type: "tool" | "hook" | "command",
  validate: (raw: Record<string, unknown>) => ValidationResult<TValid>,
  config: {
    buildDef: (
      script: { scriptPath: string; args: string[] },
      valid: TValid,
      pre: { raw: Record<string, unknown>; content: string },
    ) => TDef;
    onScriptError?: (
      script: { error: string },
      valid: TValid,
      pre: { raw: Record<string, unknown>; content: string },
    ) => SkillParserResult<TDef> | null;
  },
): Promise<SkillParserResult<TDef>> {
  const pre = await readSkillPreamble(mdPath, type);
  if (pre.kind === "gate") {
    return pre;
  }
  const result = validate(pre.raw);
  if ("error" in result) {
    return { def: null, error: result.error };
  }
  const valid = result.valid;
  const { buildDef, onScriptError } = config;
  return resolveScriptAndBuildDef(
    mdPath,
    pre,
    (script) => buildDef(script, valid, pre),
    onScriptError ? (script) => onScriptError(script, valid, pre) : undefined,
  );
}

async function parseToolSkill(mdPath: string): Promise<
  SkillParserResult<DiscoveredTool>
> {
  return parseSkill(
    mdPath,
    "tool",
    (raw) => {
      const result = parseToolSkillDescription(raw);
      return "error" in result ? result : { valid: result.description };
    },
    {
      buildDef: (script, description, pre) =>
        buildToolDef(
          mdPath,
          pre.raw,
          pre.content,
          description,
          script.scriptPath,
          script.args,
        ),
    },
  );
}

/**
 * Parse and validate the optional `executionMode` frontmatter field. Valid
 * values are "sequential" and "parallel". Absent → undefined (the caller's
 * `?? "parallel"` default in registerTool applies). Present but invalid →
 * "parallel" (silently — no console output of any kind). Present and valid
 * → that value.
 */
function parseExecutionMode(
  raw: unknown,
): "sequential" | "parallel" | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "sequential" || raw === "parallel") {
    return raw;
  }
  return "parallel";
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
  // Single recursive walk; the frontmatter `type: tool` decides
  // registration, independent of where the file lives.
  const skipped = await registerSkills(root, parseToolSkill, tools, "tool");
  return { tools, skipped };
}

/**
 * Parse a hook's `event` field into the ordered list of bridgeable events it
 * is bound to. The field accepts either a single bridgeable string
 * (backward-compatible) or a non-empty list of bridgeable strings (one
 * script hooking multiple events). Each value is validated against
 * BRIDGEABLE_EVENTS and duplicates are dropped, preserving first-seen order.
 * Returns the list, or null when the field is missing, empty, or carries a
 * value that is neither a bridgeable string nor a list of them.
 */
/** Normalize a raw `event` value into an array of candidate values. */
function normalizeEventValues(raw: Record<string, unknown>): unknown[] {
  const value = raw.event;
  if (Array.isArray(value)) return value;
  if (value !== undefined && value !== null) return [value];
  return [];
}

/** Validate that every entry is a bridgeable event; deduplicate preserving order. */
function validateBridgeableEvents(values: unknown[]): BridgeableEvent[] | null {
  const bridgeable = BRIDGEABLE_EVENTS as readonly string[];
  const events: BridgeableEvent[] = [];
  for (const entry of values) {
    if (typeof entry !== "string" || !bridgeable.includes(entry)) {
      return null;
    }
    const ev = entry as BridgeableEvent;
    if (!events.includes(ev)) {
      events.push(ev);
    }
  }
  return events.length > 0 ? events : null;
}

function parseHookEvents(
  raw: Record<string, unknown>,
): BridgeableEvent[] | null {
  const values = normalizeEventValues(raw);
  if (values.length === 0) {
    return null;
  }
  return validateBridgeableEvents(values);
}

/**
 * A hook's `timeout` (ms) from the frontmatter, or the error message for an
 * invalid value. Absent uses the default; valid values are floored and
 * clamped to [1, 300000].
 */
function hookTimeoutOf(
  raw: Record<string, unknown>,
): number | string {
  return parseHookTimeout(raw.timeout);
}

/**
 * Validate a hook's `event` + `timeout` frontmatter fields together; the
 * `{ error }` shape when either is invalid (event first, then timeout).
 */
function validateHookMeta(
  raw: Record<string, unknown>,
): { events: BridgeableEvent[]; timeoutMs: number } | { error: string } {
  const events = parseHookEvents(raw);
  if (events === null) {
    return { error: `event missing or not bridgeable: ${JSON.stringify(raw.event)}` };
  }
  const timeout = hookTimeoutOf(raw);
  if (typeof timeout === "string") {
    return { error: timeout };
  }
  return { events, timeoutMs: timeout };
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

/**
 * The top-level directory segment under the skills root (metadata only):
 * the file's relative path when it lives under the root, else the full
 * path.
 */
function hookDomainOf(mdPath: string, root: string): string {
  const rel = mdPath.startsWith(root)
    ? mdPath.slice(root.length + 1)
    : mdPath;
  return rel.split(/[\\/]/)[0] ?? "";
}

/**
 * Hook name: the frontmatter `name` (domain identity after the per-domain
 * hook.md rename) when present and non-empty, else the file stem.
 */
function hookNameOf(mdPath: string, raw: Record<string, unknown>): string {
  return isNonEmptyString(raw.name) ? raw.name : basename(mdPath, ".md");
}

/** Assemble the DiscoveredHook from its validated pieces. */
function buildHookDef(
  mdPath: string,
  root: string,
  raw: Record<string, unknown>,
  content: string,
  events: BridgeableEvent[],
  timeoutMs: number,
  scriptPath: string,
  args: string[],
): DiscoveredHook {
  return {
    name: hookNameOf(mdPath, raw),
    domain: hookDomainOf(mdPath, root),
    events,
    timeoutMs,
    scriptPath,
    args,
    fingerprint: `${hashString(content)}:${scriptPath}`,
  };
}

async function parseHookSkill(
  mdPath: string,
  root: string,
): Promise<SkillParserResult<DiscoveredHook>> {
  return parseSkill(
    mdPath,
    "hook",
    (raw) => {
      const result = validateHookMeta(raw);
      return "error" in result ? result : { valid: result };
    },
    {
      buildDef: (script, meta, pre) =>
        buildHookDef(
          mdPath,
          root,
          pre.raw,
          pre.content,
          meta.events,
          meta.timeoutMs,
          script.scriptPath,
          script.args,
        ),
    },
  );
}

export async function discoverHooks(root: string): Promise<HookDiscovery> {
  const hooks: DiscoveredHook[] = [];
  const skipped: SkippedEntry[] = [];

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

  // Run order: primary event (the hook's first bound event) then filename.
  // A multi-event hook is sorted by its primary event and is registered into
  // a bucket for every bound event (see applyHookDiscovery in extension.ts).
  hooks.sort(
    (a, b) =>
      a.events[0].localeCompare(b.events[0]) ||
      a.scriptPath.localeCompare(b.scriptPath),
  );

  return { hooks, skipped };
}

/** Valid `picker.actions` effect values (mirrors the PickerEffect union). */
const PICKER_EFFECTS: readonly string[] = ["paste", "run"];

/** Field names that can appear on a picker action entry (effect-specific). */
type PickerEffectField = "command" | "args" | "text" | "label";

const ALL_EFFECT_FIELDS: readonly PickerEffectField[] = [
  "command",
  "args",
  "text",
  "label",
];
const PASTE_FIELDS: readonly PickerEffectField[] = ["text", "label"];
const RUN_FIELDS: readonly PickerEffectField[] = [
  "command",
  "args",
  "label",
];

/** Returns true when the entry is a valid picker action object (not null,
 * not an array, and carries no leftover `key` field). */
function isPickerActionObject(entry: unknown): entry is Record<string, unknown> {
  if (!isPickerBlock(entry)) {
    return false;
  }
  // A leftover `key` field (pre-rename) is a hard error, not silently accepted.
  return (entry as Record<string, unknown>).key === undefined;
}

/** Extract and validate the `shortcut` field: must be a non-empty valid keybinding. */
function extractShortcut(a: Record<string, unknown>): string | null {
  const shortcut = typeof a.shortcut === "string" ? a.shortcut.trim() : "";
  // A picker action with no valid keybinding cannot be invoked: missing OR
  // a value that is not a real keybinding (e.g. "edit") is a parse error.
  if (shortcut.length === 0 || !isValidKeyId(shortcut)) {
    return null;
  }
  return shortcut;
}

/** Validate the `effect` field: must be a string in the exact PickerEffect set. */
function extractEffect(a: Record<string, unknown>): PickerEffect | null {
  const effect = a.effect;
  if (typeof effect !== "string" || !PICKER_EFFECTS.includes(effect)) {
    return null;
  }
  return effect as PickerEffect;
}

/** Returns true when the entry carries a field that is not allowed for its effect. */
function hasCrossEffectFields(
  a: Record<string, unknown>,
  allowed: readonly PickerEffectField[],
): boolean {
  for (const field of ALL_EFFECT_FIELDS) {
    if (!allowed.includes(field) && a[field] !== undefined) {
      return true;
    }
  }
  return false;
}

/** Copy the allowed per-effect fields onto the action; returns false if any
 * value is present but not a string. */
function copyEffectFields(
  action: PickerAction,
  a: Record<string, unknown>,
  fields: readonly PickerEffectField[],
): boolean {
  for (const field of fields) {
    const value = a[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      return false;
    }
    action[field] = value.trim();
  }
  return true;
}

/**
 * Validate one `picker.actions` entry: a non-null object with a valid-keybinding
 * `shortcut` (a pi-tui KeyId string) and an `effect` in the exact PickerEffect
 * set (paste/run). The per-effect fields are strict: a "paste" entry may carry
 * string `text`/`label`; a "run" entry may carry string `command`/`args`/
 * `label`; any cross-effect field (text on a run entry, command/args on a
 * paste entry) invalidates the entry. A leftover `key` field (the pre-rename
 * name) also invalidates the entry. Returns the trimmed PickerAction, or null
 * when the entry is invalid (the caller warns and drops it, naming the
 * offending shortcut).
 */
/** Select the allowed effect fields for the given effect type. */
function effectFields(effect: PickerEffect): readonly PickerEffectField[] {
  return effect === "paste" ? PASTE_FIELDS : RUN_FIELDS;
}

function parsePickerActionEntry(entry: unknown): PickerAction | null {
  if (!isPickerActionObject(entry)) {
    return null;
  }
  const shortcut = extractShortcut(entry);
  if (shortcut === null) {
    return null;
  }
  const effect = extractEffect(entry);
  if (effect === null) {
    return null;
  }
  // Strict per-effect fields: a "paste" entry may carry text/label; a
  // "run" entry may carry command/args/label.
  const fields = effectFields(effect);
  if (hasCrossEffectFields(entry, fields)) {
    return null;
  }
  const action: PickerAction = { shortcut, effect };
  if (!copyEffectFields(action, entry, fields)) {
    return null;
  }
  return action;
}


/**
 * Parse and validate the optional `picker.actions` block: an array of
 * declarative keybinds. Invalid entries are skipped silently (no console
 * output of any kind) while their valid siblings are kept. Absent actions
 * yield an empty array; a present non-array yields null (the caller then
 * ignores the whole picker block).
 */
export function parsePickerActions(
  rawActions: unknown,
): PickerAction[] | null {
  if (!Array.isArray(rawActions)) {
    return rawActions === undefined ? [] : null;
  }
  const actions: PickerAction[] = [];
  for (const entry of rawActions as unknown[]) {
    const action = parsePickerActionEntry(entry);
    if (action !== null) {
      actions.push(action);
    }
  }
  return actions;
}

/**
 * Parse an optional trimmed-string picker field (title): absent
 * (undefined) yields the fallback; a present value must be a non-empty
 * string after trimming, else null is returned silently (no console output
 * of any kind; the caller then ignores the whole picker block).
 */
function parseOptionalTrimmedString(
  value: unknown,
  fallback: string,
): string | null {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

/**
 * Parse a single `picker.columns` entry: an object with a required `field`
 * (trimmed non-empty string), an optional `width` (positive number; absent
 * yields undefined so the column is auto-sized), an optional `align`
 * ("left" | "right", default "left"), an optional `style` (string; default
 * "normal" when absent), and an optional `focusedStyle` (string; absent
 * means the focused state uses the same style as unfocused). Returns null
 * when the entry is invalid.
 */
/** Parse the optional `width` field: positive finite number → floored int, else undefined. */
function parseColumnWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

/** Parse an optional trimmed-string column field (style/focusedStyle). */
function parseColumnStyle(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parsePickerColumnEntry(entry: unknown): PickerColumn | null {
  if (!isPickerBlock(entry)) {
    return null;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.field !== "string" || e.field.trim().length === 0) {
    return null;
  }
  return {
    field: e.field.trim(),
    width: parseColumnWidth(e.width),
    align: e.align === "right" ? "right" : "left",
    style: parseColumnStyle(e.style),
    focusedStyle: parseColumnStyle(e.focusedStyle),
  };
}

/**
 * Parse the `picker.columns` block into a non-empty column list:
 * absent yields the default label column; a present non-array yields the
 * default silently (no console output of any kind); invalid entries are
 * skipped silently while valid siblings are kept. An empty result (all entries invalid, or an
 * empty array) yields the default label column so the picker always has
 * at least one column.
 */
function parsePickerColumns(
  rawColumns: unknown,
): PickerColumn[] {
  const defaultColumns: PickerColumn[] = [{ field: "label" }];
  if (!Array.isArray(rawColumns)) {
    return defaultColumns;
  }
  const columns: PickerColumn[] = [];
  for (const entry of rawColumns) {
    const col = parsePickerColumnEntry(entry);
    if (col !== null) {
      columns.push(col);
    }
  }
  return columns.length > 0 ? columns : defaultColumns;
}

/** A present picker block: a non-null, non-array object. */
function isPickerBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize the optional `picker` frontmatter value to a block record:
 * absent (undefined/null) yields null silently (the zero-config picker
 * applies); a present non-object yields null silently (no console output
 * of any kind; the caller ignores the whole block).
 */
function normalizePickerBlock(
  raw: unknown,
): Record<string, unknown> | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isPickerBlock(raw)) {
    return null;
  }
  return raw;
}

/**
 * The required-to-keep picker fields (title, actions): any invalid one
 * fails open and returns null (no console output of any kind; the caller
 * ignores the whole block).
 * The aligned column layout always yields a non-empty column list
 * (absent or fully invalid input defaults to the label column).
 */
function parsePickerCore(
  block: Record<string, unknown>,
  commandName: string,
): { title: string; actions: PickerAction[]; columns: PickerColumn[] } | null {
  // title: optional; default the command name.
  const title = parseOptionalTrimmedString(block.title, commandName);
  if (title === null) {
    return null;
  }

  // actions: optional; array of declarative keybinds (invalid entries are
  // skipped silently while their valid siblings are kept).
  const actions = parsePickerActions(block.actions);
  if (actions === null) {
    return null;
  }

  // columns: aligned column layout (invalid entries skipped; absent or
  // fully invalid input yields the default label column).
  const columns = parsePickerColumns(block.columns);

  return { title, actions, columns };
}

/**
 * The optional `picker.split` key: only the literal `true` enables split
 * view; any other value is silently ignored (fail-open).
 */
function pickerSplitOf(block: Record<string, unknown>): true | undefined {
  return block.split === true ? true : undefined;
}

/** A present finite number in (0, 1]. */
function isSplitWidth(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0 && value <= 1;
}

/**
 * The optional `picker.splitWidth` key (fail-open per-key): a present value
 * must be a finite number in (0, 1]; an invalid value is ignored silently
 * (no console output of any kind).
 */
function pickerSplitWidthOf(
  block: Record<string, unknown>,
): number | undefined {
  const value = block.splitWidth;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isSplitWidth(value)) {
    return undefined;
  }
  return value;
}

/**
 * The optional `picker.previewCommand` key (fail-open per-key): a present
 * value must be a trimmed non-empty string, else it is ignored (the preview
 * pane shows the empty-state placeholder). Absent yields undefined.
 */
function pickerPreviewCommandOf(
  block: Record<string, unknown>,
): string | undefined {
  const value = block.previewCommand;
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}

/**
 * Parse the optional `picker` block into a SplitPickerConfig (fail-open: invalid
 * or absent → null, zero-config defaults apply). No default keybinds are
 * injected here — ensureEnterAction at the component layer guarantees them.
 */
function parsePickerConfig(
  raw: unknown,
  commandName: string,
): SplitPickerConfig | null {
  const block = normalizePickerBlock(raw);
  if (block === null) {
    return null;
  }
  const core = parsePickerCore(block, commandName);
  if (core === null) {
    return null;
  }
  return {
    ...core,
    split: pickerSplitOf(block),
    splitWidth: pickerSplitWidthOf(block),
    previewCommand: pickerPreviewCommandOf(block),
  };
}

/**
 * A slash command's required `name`: a non-empty (after trimming) string,
 * else null (the validation error is raised by the caller), mirroring the
 * hook validation gate.
 */
function parseCommandName(
  raw: Record<string, unknown>,
): string | null {
  if (!isNonEmptyString(raw.name)) {
    return null;
  }
  return raw.name.trim();
}

/** The optional `description` of a `type: command` skill (absent → ""). */
function parseCommandDescription(raw: Record<string, unknown>): string {
  return typeof raw.description === "string" ? raw.description : "";
}

/**
 * The optional `shortcut` frontmatter field: a key string (a pi-tui KeyId
 * combo, e.g. "ctrl+p") binding the command to a pi shortcut. Loose,
 * fail-open validation (mirroring the picker block): absent
 * (undefined/null) yields undefined silently (no binding); a present value
 * must be a non-empty (after trimming) string, else undefined is returned
 * silently (no console output of any kind; no binding, the command still
 * registers).
 */
function parseCommandShortcut(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return undefined;
  }
  return raw.trim();
}

/**
 * Assemble the DiscoveredCommand from its validated pieces: the picker
 * block (absent/invalid → undefined, the zero-config picker applies) plus
 * the shared parameter defaults and content-hash fingerprint.
 */
/** Build the content-hash fingerprint for a command definition. */
function commandFingerprint(content: string, scriptPath: string, commandTemplate?: string): string {
  return `${hashString(content)}:${commandTemplate ?? scriptPath}`;
}

function buildCommandDef(
  mdPath: string,
  raw: Record<string, unknown>,
  content: string,
  name: string,
  scriptPath: string,
  args: string[],
  commandTemplate?: string,
): DiscoveredCommand {
  const parameters = collectParameters(raw);
  const picker = parsePickerConfig(raw.picker, name);
  const shortcut = parseCommandShortcut(raw.shortcut);
  return {
    name,
    description: parseCommandDescription(raw),
    parameters,
    defaults: collectDefaults(parameters),
    scriptPath,
    args,
    commandTemplate: commandTemplate ?? undefined,
    picker: picker ?? undefined,
    shortcut: shortcut ?? undefined,
    fingerprint: commandFingerprint(content, scriptPath, commandTemplate),
  };
}

/**
 * Parse a `type: command` skill file into a DiscoveredCommand. A command
 * skill registers as a user-invocable slash command: the frontmatter `name`
 * is the slash-command name (invoked as `/name`), `command` is the handler
 * script, and `parameters` (ShellToolProperty format, same as tools) carries
 * optional parameter defaults. `name` is REQUIRED for slash commands; a
 * missing/empty name is a validation error (skipped + warning), mirroring
 * the hook validation gate.
 */
async function parseCommandSkill(
  mdPath: string,
): Promise<SkillParserResult<DiscoveredCommand>> {
  return parseSkill(
    mdPath,
    "command",
    (raw): ValidationResult<string> => {
      const name = parseCommandName(raw);
      if (name === null) {
        return { error: "missing name (required for slash commands)" };
      }
      return { valid: name };
    },
    {
      buildDef: (script, name, pre) =>
        buildCommandDef(
          mdPath,
          pre.raw,
          pre.content,
          name,
          script.scriptPath,
          script.args,
        ),
      onScriptError: (script, name, pre) => {
        // Template branch: `command` is a non-empty string that does not
        // resolve to an existing file — treat it as an executable command
        // template spawned via Node child_process (no shell) on picker
        // selection.
        const rawCommand = pre.raw.command;
        if (typeof rawCommand === "string" && rawCommand.trim().length > 0) {
          const template = rawCommand.trim();
          return {
            def: buildCommandDef(
              mdPath,
              pre.raw,
              pre.content,
              name,
              template, // scriptPath (fingerprint base; not a real path)
              [], // no positional args in the template model
              template, // commandTemplate
            ),
            error: null,
          };
        }
        return null;
      },
    },
  );
}

/**
 * Discover every `type: command` skill file under `root` (single recursive,
 * type-authoritative walk — same as tool/hook discovery). Returns the
 * discovered commands (keyed by slash-command name) plus the skipped
 * (invalid/unparseable) files with their errors.
 */
export async function discoverCommands(
  root: string,
): Promise<CommandDiscovery> {
  const commands = new Map<string, DiscoveredCommand>();
  const skipped = await registerSkills(root, parseCommandSkill, commands, "command");
  return { commands, skipped };
}
