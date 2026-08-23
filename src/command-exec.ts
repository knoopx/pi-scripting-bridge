/**
 * Command execution path. Unlike tools (which throw for pi's isError), command
 * execution FAILS OPEN: handler errors, timeouts, and bad stdout surface as
 * user warnings (ui.notify only — no console output of any kind) and never
 * crash pi; output is surfaced to the user, never injected into the
 * conversation.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { DiscoveredCommand } from "./discovery.js";
import { parsePickerActions } from "./discovery.js";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  createPicker,
  fieldText,
  interpolateTemplate,
  zeroConfigPickerConfig,
  type PickerAction,
  type PickerItem,
  type SplitPickerConfig,
} from "./ui/picker.js";
import { createSplitPicker } from "./ui/split-picker.js";
import type { ScriptExecResult } from "./script-exec.js";
import { runScript } from "./script-exec.js";
import { applyTerminateSession } from "./tool-exec.js";
import {
  isContentEntry,
  logFailure,
  runSendMessage,
} from "./failure.js";
import { safe } from "./safe.js";

type CommandContent = AgentToolResult<unknown>["content"];

/**
 * Build the command context payload: sessionId, sessionFile and cwd pulled
 * from the live sessionManager, plus `tui` — true when the extension runs
 * in TUI mode (ctx.hasUI && ctx.mode === "tui"), the flag that tells a
 * handler whether the bridge can launch the item picker overlay. Every
 * session getter is guarded; a failure yields null so the payload is
 * always JSON-serializable.
 */
function buildCommandContextPayload(
  ctx: ExtensionContext,
): Record<string, unknown> {
  const sm = ctx.sessionManager as unknown as Record<string, unknown>;
  return {
    sessionId: safe(() => (sm.getSessionId as () => string)()),
    sessionFile: safe(
      () => (sm.getSessionFile as () => string | undefined)(),
    ),
    // Prefer the session cwd; fall back to the context cwd.
    cwd:
      safe(() => (sm.getCwd as () => string)()) ?? ctx.cwd,
    // TUI mode flag (plain access: both fields always exist on the context).
    tui: ctx.hasUI && ctx.mode === "tui",
  };
}

/**
 * Build the command stdin payload. `params` carries the frontmatter
 * parameter defaults plus the raw argument string under `args`; `context`
 * carries the live session identity.
 */
function buildCommandPayload(
  def: DiscoveredCommand,
  args: string,
  ctx: ExtensionContext,
): string {
  const params: Record<string, unknown> = {
    ...def.defaults,
    args,
  };
  return JSON.stringify({
    command: def.name,
    params,
    context: buildCommandContextPayload(ctx),
  });
}

/**
 * Validate a command handler's content array: a non-empty array of text (or
 * image) content objects. Mirrors the tool content validation.
 */
function isValidContent(content: unknown): content is CommandContent {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(isContentEntry)
  );
}

/**
 * Parse the optional top-level `pick` field of a command's stdout JSON.
 * Fail-open: an absent (undefined/null) or non-object payload returns null
 * silently (the normal text path applies); non-object items are dropped
 * silently, and zero kept items yields null — except when the block carries
 * an explicit `open: true`, which opts a command into opening the picker
 * even with an empty item list (e.g. a search with a blank query that still
 * wants the filterable picker to open). A present title must be a non-empty
 * (trimmed) string, otherwise it is treated as absent.
 */
function parsePickPayload(
  raw: unknown,
): { title?: string; items: PickerItem[]; actions?: PickerAction[] } | null {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return null;
  }
  const src = raw as {
    title?: unknown;
    items?: unknown;
    open?: unknown;
    actions?: unknown;
  };
  const items = Array.isArray(src.items)
    ? (src.items as unknown[])
        .filter(
          (it) =>
            typeof it === "object" &&
            it !== null &&
            typeof (it as { id?: unknown }).id === "string" &&
            typeof (it as { label?: unknown }).label === "string",
        )
        .map((it) => it as PickerItem)
    : [];
  if (items.length === 0 && src.open !== true) {
    return null;
  }
  const title =
    typeof src.title === "string" && src.title.trim().length > 0
      ? src.title
      : undefined;
  // Optional payload actions: when present and valid, they replace the
  // command's base picker actions (per-mode keybinds the script chose).
  // Absent yields undefined (fall back to base); a present non-array is
  // ignored (base config kept). Invalid entries are dropped with a warning
  // by parsePickerActions; an empty result keeps the base actions.
  let actions: PickerAction[] | undefined;
  if (src.actions !== undefined && src.actions !== null) {
    const parsed = parsePickerActions(src.actions);
    if (parsed !== null && parsed.length > 0) {
      actions = parsed;
    }
  }
  const result: { title?: string; items: PickerItem[]; actions?: PickerAction[] } =
    { items };
  if (title !== undefined) result.title = title;
  if (actions !== undefined) result.actions = actions;
  return result;
}

/** The sendMessage directive outcome: "stale" ends the surface early. */
type CommandSendOutcome = "ok" | "stale";

/**
 * Apply the command's optional `sendMessage` directive (the same combiner as
 * the hook path) and strip it so it never leaks into the surfaced base
 * payload. An invalid directive is logged; a stale API error terminates the
 * instance (the caller must then return without surfacing); any other send
 * failure is logged and the surface proceeds.
 */
function applyCommandSendMessage(
  pi: ExtensionAPI,
  value: Record<string, unknown>,
  label: string,
  ctx: ExtensionContext,
): CommandSendOutcome {
  if (!("sendMessage" in value)) {
    return "ok";
  }
  const msg = value.sendMessage;
  if (typeof msg !== "object" || msg === null) {
    logFailure(
      `${label}: invalid sendMessage directive: ${JSON.stringify(value)}`,
      ctx,
    );
    return "ok";
  }
  return runSendMessage(pi, msg, label, ctx, () => {}) ? "stale" : "ok";
}

/**
 * Apply the command's `terminateSession` directive: same contract as the
 * tool path — honored only when the top-level key is the exact boolean
 * `true`. The key is never copied into the result (content and details are
 * the only mapped fields), so it is structurally stripped and cannot leak
 * to the LLM.
 */
function applyCommandTerminate(
  value: Record<string, unknown>,
  def: DiscoveredCommand,
  ctx: ExtensionContext,
): void {
  if (value.terminateSession !== true) {
    return;
  }
  const result: AgentToolResult<unknown> = {
    content: (Array.isArray(value.content)
      ? value.content
      : []) as AgentToolResult<unknown>["content"],
    details: {},
  };
  applyTerminateSession(def.name, ctx, result);
}

/**
 * The human-readable text of a validated content array (text entries only,
 * joined with newlines) — the payload of the user-visible notify.
 */
function extractSurfaceText(content: CommandContent): string {
  return (content as { type: string; text: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** The picker action effect callbacks (see {@link buildPickerEffects}):
 * run/invoke a command def (an empty name is the current command, the def
 * that produced the picker), best-effort notify (the fail-open error
 * surfacing for effects), and a fail-open editor insert. */
interface PickerEffectCallbacks {
  runCommand: (name: string, args: string, item?: PickerItem) => void;
  notify: (text: string) => void;
  pasteToEditor: (text: string) => void;
}

/**
 * Build the picker action effect callbacks: run/invoke the current or a
 * named bridge command (fire-and-forget, failures logged as warnings),
 * plus best-effort notify (the fail-open error surfacing) and a fail-open
 * editor insert. A picker effect must never crash pi.
 */
function buildPickerEffects(
  pi: ExtensionAPI,
  def: DiscoveredCommand,
  label: string,
  ctx: ExtensionContext,
  commands: Map<string, DiscoveredCommand>,
): PickerEffectCallbacks {
  const failed = (what: string, err: unknown): void => {
    logFailure(
      `${label}: ${what} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      ctx,
    );
  };
  return {
    runCommand: (name: string, args: string, item?: PickerItem) => {
      // An empty name means the current command (the def that produced the
      // picker); otherwise the named command def from the live registry.
      const target = name.length > 0 ? commands.get(name) : def;
      if (target === undefined) {
        logFailure(
          `scripting-bridge: picker: unknown command '${name}'`,
          ctx,
        );
        return;
      }
      // Template branch: when the target has a commandTemplate and the
      // picker passed the selected item, spawn the template directly
      // (no shell, no runScript).
      if (target.commandTemplate && item !== undefined) {
        spawnCommandTemplate(target.commandTemplate, item, ctx, label);
        return;
      }
      void executeCommand(pi, target, args, ctx, commands).catch((err) =>
        failed(`run '${name}'`, err),
      );
    },
    notify: (text: string) => {
      try {
        ctx.ui.notify(text, "info");
      } catch {
        // Notification is best-effort.
      }
    },
    pasteToEditor: (text: string) => {
      try {
        ctx.ui.pasteToEditor(text);
      } catch (e) {
        // Fail-open: a missing/broken UI must not break the command path —
        // surface the error via notify and leave the picker open.
        try {
          ctx.ui.notify(
            `picker: ${e instanceof Error ? e.message : String(e)}`,
            "info",
          );
        } catch {
          // Best-effort.
        }
      }
    },
  };
}

/** Hung preview commands are killed after this many milliseconds (the
 * preview falls back to the empty-state placeholder). */
const PREVIEW_TIMEOUT_MS = 5000;

/**
 * Interpolate a preview command template with the focused item's fields:
 * every `{name}` (name = \w+) placeholder is replaced with the item's
 * `name` field value, single-quoted with embedded single quotes escaped
 * (`'` → `'\''`) for safe `/bin/sh -c` execution. A placeholder with no
 * matching item field is left as literal text. `fieldText` (in picker.ts)
 * maps null/undefined → "" and scalars/objects → their string form before
 * quoting.
 */
function interpolatePreviewTemplate(
  template: string,
  item: Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = item[name];
    if (value === undefined || value === null) return match; // literal
    return `'${fieldText(value).replace(/'/g, "'\\''")}'`;
  });
}

/**
 * Build a preview-line loader for a split picker from the command's
 * `previewCommand` template (the frontmatter `picker.previewCommand`): on
 * focus the template's `{fieldName}` placeholders are interpolated from the
 * item (single-quoted, escaped) and the result is run via `/bin/sh -c`,
 * capturing its stdout split on newlines. Fail-open: an absent/empty
 * template, a hung command (killed after {@link PREVIEW_TIMEOUT_MS}), a
 * non-zero exit, or a spawn error all yield an empty array (the preview
 * pane shows the empty-state placeholder), never a thrown error into pi.
 */
// fallow-ignore-next-line unused-export -- intentional test-facing export; only cross-module consumers are the ignored **/*.test.ts files (see .fallowrc.json ignorePatterns)
export function makeLoadPreview(previewCommand?: string) {
  return async (item: PickerItem): Promise<string[]> => {
    if (typeof previewCommand !== "string" || previewCommand.length === 0) {
      return [];
    }
    const command = interpolatePreviewTemplate(previewCommand, item);
    if (command.length === 0) return [];
    return runPreviewCommand(command);
  };
}

/**
 * Run a preview shell command via `/bin/sh -c`, capture its stdout split
 * on newlines, and kill the child after {@link PREVIEW_TIMEOUT_MS} (SIGTERM,
 * escalating to SIGKILL if still alive — the hang guard). A non-zero exit
 * yields an empty preview (stdout on failure is not shown); a spawn error
 * yields an empty preview (fail-open, never throws).
 */
function runPreviewCommand(command: string): Promise<string[]> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve([]);
      return;
    }
    let settled = false;
    const stdoutChunks: string[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000).unref();
      finish([]);
    }, PREVIEW_TIMEOUT_MS);
    const finish = (lines: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(lines);
    };
    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d.toString()));
    child.on("error", () => finish([]));
    child.on("exit", (code) => {
      finish(code === 0 ? stdoutChunks.join("").split("\n") : []);
    });
  });
}

/**
 * Launch the item picker overlay for a command's `pick` payload: config is
 * the command's frontmatter `picker` block (or the zero-config defaults),
 * with a present `pick.title` overriding the zero-config title only. A
 * launch failure is fail-open: the warning is logged and the text notify
 * that follows still fires.
 */
async function launchCommandPicker(
  pi: ExtensionAPI,
  def: DiscoveredCommand,
  pick: { title?: string; items: PickerItem[]; actions?: PickerAction[] },
  label: string,
  ctx: ExtensionContext,
  commands: Map<string, DiscoveredCommand>,
): Promise<void> {
  const baseConfig = def.picker ?? zeroConfigPickerConfig(def.name);
  // A non-empty payload actions list replaces the base config's actions (the
  // script's per-mode keybinds win); an absent/empty payload falls back to
  // the frontmatter base. ensureEnterAction (inside createPicker) still
  // guarantees enter/tab defaults when the payload omits them.
  const config: SplitPickerConfig =
    def.picker === undefined && pick.title !== undefined
      ? { ...baseConfig, title: pick.title }
      : baseConfig;
  const effectiveConfig: SplitPickerConfig =
    pick.actions !== undefined && pick.actions.length > 0
      ? { ...config, actions: pick.actions }
      : config;
  const isSplit = effectiveConfig.split === true;
  try {
    await ctx.ui.custom<PickerItem | null>(
      (tui, theme, _keybindings, done) => {
        const common = {
          tui,
          theme,
          items: pick.items,
          config: effectiveConfig,
          done,
          ...buildPickerEffects(pi, def, label, ctx, commands),
        };
        return isSplit
          ? createSplitPicker({
              ...common,
              loadPreview: makeLoadPreview(effectiveConfig.previewCommand),
            })
          : createPicker(common);
      },
      { overlay: true, overlayOptions: { width: "95%", anchor: "center" } },
    );
  } catch (err) {
    logFailure(
      `${label}: picker launch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      ctx,
    );
  }
}

/**
 * The per-command log/notify label — the single source of the
 * `scripting-bridge: command '<name>'` string shared by every command-path
 * message (spawn, timeout, surface, send, terminate). Both the direct-invoke
 * path (executeCommand) and the surface path (surfaceResult) derive it the
 * same way, so it lives here once.
 */
function commandExecutionLabel(def: DiscoveredCommand): string {
  return `scripting-bridge: command '${def.name}'`;
}

/**
 * The command-execution surface prelude: derive the label, apply the optional
 * `sendMessage` directive (a stale API error tears the instance down — the
 * caller must then bail without surfacing), and apply the
 * `terminateSession` directive (honored only when the send did not go
 * stale). Returns the label (for the downstream notify/picker) plus whether
 * the send was stale.
 */
function prepareCommandExecution(
  pi: ExtensionAPI,
  def: DiscoveredCommand,
  value: Record<string, unknown>,
  ctx: ExtensionContext,
): { label: string; stale: boolean } {
  const label = commandExecutionLabel(def);
  // Apply the optional sendMessage directive (same combiner as the hook path)
  // and strip it so it never leaks into the surfaced base payload.
  const send = applyCommandSendMessage(pi, value, label, ctx);
  if (send !== "stale") {
    // terminateSession directive: same contract as the tool path.
    applyCommandTerminate(value, def, ctx);
  }
  return { label, stale: send === "stale" };
}

/** Validate + extract the human-readable surface text from a content value.
 * Returns an empty string when the content is not a valid content array. */
function surfaceTextOf(content: unknown): string {
  if (!isValidContent(content)) return "";
  return extractSurfaceText(content);
}

/**
 * Launch the item picker overlay from the optional `pick` payload, TUI only:
 * in non-TUI modes (or when items are empty/invalid) the pick is ignored and
 * the text notify is the only surface. Fail-open: a launch failure is logged
 * and the text notify that follows still fires.
 */
async function maybeLaunchCommandPicker(
  pi: ExtensionAPI,
  def: DiscoveredCommand,
  value: Record<string, unknown>,
  label: string,
  ctx: ExtensionContext,
  commands: Map<string, DiscoveredCommand>,
): Promise<void> {
  const pick = parsePickPayload(value.pick);
  if (pick !== null && ctx.hasUI && ctx.mode === "tui") {
    await launchCommandPicker(pi, def, pick, label, ctx, commands);
  }
}

/**
 * Notify the user with the surface text (fail-open: a failed notify must not
 * break the command path; command output is for the user, not the agent).
 */
function notifySurfaceText(text: string, ctx: ExtensionContext): void {
  if (text.length === 0) return;
  try {
    ctx?.ui?.notify(text, "info");
  } catch {
    // Notification is best-effort; a failed notify must not break the command path.
  }
}

/**
 * Surface the command result: notify the user with the content (never injected
 * into the conversation), apply the `sendMessage`/`pick` directives, and launch
 * the picker in TUI mode — all fail-open so a stale runtime never crashes pi.
 */
async function surfaceResult(
  pi: ExtensionAPI,
  def: DiscoveredCommand,
  value: Record<string, unknown>,
  ctx: ExtensionContext,
  commands: Map<string, DiscoveredCommand>,
): Promise<void> {
  const { label, stale } = prepareCommandExecution(pi, def, value, ctx);
  if (stale) {
    // A stale runtime can no longer honor the send: fail open and return.
    return;
  }
  const text = surfaceTextOf(value.content);
  await maybeLaunchCommandPicker(pi, def, value, label, ctx, commands);
  notifySurfaceText(text, ctx);
}

/**
 * Parse a trimmed stdout string into a single JSON object. Returns null on
 * invalid JSON or a non-object top-level value (fail-open).
 */
function parseStdoutJson(out: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Parse and validate a command handler's stdout: the trimmed output must be
 * a single JSON object. Fail-open: an empty, invalid, or non-object stdout
 * is logged as a warning and yields null (the caller returns).
 */
function parseCommandStdout(
  res: ScriptExecResult,
  label: string,
  ctx: ExtensionContext,
): Record<string, unknown> | null {
  const out = res.stdout.trim();
  if (out.length === 0) {
    logFailure(`${label}: produced no JSON output on stdout`, ctx);
    return null;
  }
  const value = parseStdoutJson(out);
  if (value === null) {
    logFailure(
      `${label}: stdout JSON must be an object with a 'content' array`,
      ctx,
    );
    return null;
  }
  return value;
}

interface TokenRead {
  token: string;
  next: number;
}

/** Read a single-quoted token: everything until the closing ' is literal. */
function readSingleQuoted(cmd: string, i: number): TokenRead {
  let token = "";
  i++; // skip opening '
  while (i < cmd.length && cmd[i] !== "'") {
    token += cmd[i];
    i++;
  }
  if (i < cmd.length) i++; // skip closing '
  return { token, next: i };
}

/** True when `cmd[i]` is a backslash that escapes the next character and
 * that next character is a double-quote or backslash (the escape sequences
 * valid inside a double-quoted token). */
function isDoubleQuoteEscape(cmd: string, i: number): boolean {
  return (
    cmd[i] === "\\" &&
    i + 1 < cmd.length &&
    (cmd[i + 1] === '"' || cmd[i + 1] === "\\")
  );
}

/** Read a double-quoted token: \" and \\ are escape sequences. */
function readDoubleQuoted(cmd: string, i: number): TokenRead {
  let token = "";
  i++; // skip opening "
  while (i < cmd.length && cmd[i] !== '"') {
    if (isDoubleQuoteEscape(cmd, i)) {
      token += cmd[i + 1];
      i += 2;
    } else {
      token += cmd[i];
      i++;
    }
  }
  if (i < cmd.length) i++; // skip closing "
  return { token, next: i };
}

/** True when `cmd[i]` is a backslash that escapes the next character
 * (valid in unquoted token context). */
function isBackslashEscape(cmd: string, i: number): boolean {
  return cmd[i] === "\\" && i + 1 < cmd.length;
}

/** Read an unquoted token: until whitespace or a quote, \ escapes next char. */
function readUnquoted(cmd: string, i: number): TokenRead {
  let token = "";
  while (i < cmd.length && !/\s/.test(cmd[i])) {
    if (isBackslashEscape(cmd, i)) {
      token += cmd[i + 1];
      i += 2;
    } else {
      token += cmd[i];
      i++;
    }
  }
  return { token, next: i };
}

/**
 * Tokenize a command string into an argv array (shell-style: whitespace
 * separates tokens; single-quoted strings are literal; double-quoted strings
 * allow \" and \\ escapes; backslash outside quotes escapes the next char).
 * No shell is invoked — pure string manipulation.
 */
// fallow-ignore-next-line unused-export -- intentional test-facing export; only cross-module consumers are the ignored **/*.test.ts files (see .fallowrc.json ignorePatterns)
export function splitArgv(cmd: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    // Skip whitespace between tokens.
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    if (i >= cmd.length) break;

    const read = readNextToken(cmd, i);
    result.push(read.token);
    i = read.next;
  }
  return result;
}

/** Dispatch to the correct token reader based on the current character
 * (single-quoted, double-quoted, or unquoted). */
function readNextToken(cmd: string, i: number): TokenRead {
  if (cmd[i] === "'") {
    return readSingleQuoted(cmd, i);
  } else if (cmd[i] === '"') {
    return readDoubleQuoted(cmd, i);
  }
  return readUnquoted(cmd, i);
}

/**
 * Spawn a command template: interpolate {param} placeholders from the
 * picker item's fields, tokenize the result into an argv array, and spawn
 * the binary directly (detached, stdio ignore, no shell). Fail-open:
 * spawn errors and child errors are logged and swallowed.
 */
// fallow-ignore-next-line unused-export -- intentional test-facing export; only cross-module consumers are the ignored **/*.test.ts files (see .fallowrc.json ignorePatterns)
export function spawnCommandTemplate(
  template: string,
  item: PickerItem,
  ctx: ExtensionContext,
  label: string,
): void {
  const cmd = interpolateTemplate(template, item);
  const argv = splitArgv(cmd);
  if (argv.length === 0) return;

  let child: ChildProcess;
  try {
    child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: "ignore",
    });
  } catch (err) {
    logFailure(
      `${label}: spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      ctx,
    );
    return;
  }

  // Kill on session abort.
  ctx.signal?.addEventListener(
    "abort",
    () => {
      try {
        child.kill();
      } catch {
        // fail-open
      }
    },
    { once: true },
  );

  // Fail-open: swallow spawn errors (e.g. binary not found).
  child.on("error", (err) => {
    logFailure(
      `${label}: spawn error: ${err instanceof Error ? err.message : String(err)}`,
      ctx,
    );
  });

  child.unref(); // don't keep the event loop alive
}

/**
 * Handle command exit errors (timeout, non-zero exit): logs the failure and
 * returns true when the caller should return early (not proceed to stdout
 * parsing/surfacing).
 */
function handleCommandExitError(
  res: ScriptExecResult,
  label: string,
  ctx: ExtensionContext,
): boolean {
  if (res.timedOut) {
    logFailure(`${label}: timed out`, ctx);
    return true;
  }
  if (res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || "";
    logFailure(
      `${label}: failed (exit ${res.code})${detail ? `: ${detail}` : ""}`,
      ctx,
    );
    return true;
  }
  return false;
}

/**
 * Run the command handler and surface its result, failing open on every
 * error mode (timeout, non-zero exit, empty/invalid/non-object JSON, missing
 * content). Never throws: a broken command handler must not crash pi. The
 * `commands` parameter is the live command registry (name → def) used by
 * picker action effects (run: invoke the current or a named command).
 */
export async function executeCommand(
  pi: ExtensionAPI,
  def: DiscoveredCommand,
  args: string,
  ctx: ExtensionContext,
  commands: Map<string, DiscoveredCommand>,
): Promise<void> {
  const label = commandExecutionLabel(def);

  // Template commands are spawned via the picker's run effect (see
  // buildPickerEffects.runCommand → spawnCommandTemplate). When invoked
  // directly (slash/shortcut) there is no picker item to interpolate,
  // so the template path is a no-op (fail-open).
  if (def.commandTemplate) {
    logFailure(
      `${label}: command template requires a picker selection (no item available)`,
      ctx,
    );
    return;
  }

  const payload = buildCommandPayload(def, args, ctx);

  let res: ScriptExecResult;
  try {
    res = await runScript(def.scriptPath, payload, {
      // Commands run to completion (no timeout), mirroring tools.
      timeoutMs: 0,
      signal: ctx.signal,
      cwd: ctx.cwd,
      args: def.args,
    });
  } catch (err) {
    logFailure(
      `${label}: failed to spawn handler: ${
        err instanceof Error ? err.message : String(err)
      }`,
      ctx,
    );
    return;
  }

  if (handleCommandExitError(res, label, ctx)) {
    return;
  }

  const value = parseCommandStdout(res, label, ctx);
  if (value === null) {
    return;
  }

  await surfaceResult(pi, def, value, ctx, commands);
}