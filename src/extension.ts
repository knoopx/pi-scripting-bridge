/**
 * scripting-bridge — consolidated Pi extension owning the script surface
 * (tools, hooks, commands). Frontmatter `type:` is authoritative (not
 * directory). Tools THROW (isError); commands fail open. Stale pi →
 * silent one-time teardown.
 */
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Text,
  type Component,
  type KeyId,
} from "@earendil-works/pi-tui";
import {
  BRIDGEABLE_EVENTS,
  DEFAULT_SKILLS_ROOT,
  THINKING_LEVELS,
  type BridgeableEvent,
} from "./constants.js";
import type {
  CommandDiscovery,
  DiscoveredCommand,
  DiscoveredHook,
  DiscoveredTool,
  ToolDiscovery,
} from "./discovery.js";
import { discoverCommands, discoverHooks, discoverTools } from "./discovery.js";
import { combineResult } from "./hook-combine.js";
import { buildContextPayload, serializeForJson } from "./hook-payload.js";
import { createParameterSchema } from "./schema.js";
import { runScript, type ScriptExecResult } from "./script-exec.js";
import { applyTerminateSession, executeTool } from "./tool-exec.js";
import { executeCommand } from "./command-exec.js";
import { isStaleError, logFailure, runSendMessage } from "./failure.js";
import { closeWatchers, startWatchers, type WatchState } from "./watcher.js";

// ---------------------------------------------------------------------------
// Instance state
// ---------------------------------------------------------------------------

interface BridgeState {
  skillsRoot: string;
  currentTools: Map<string, DiscoveredTool>;
  currentCommands: Map<string, DiscoveredCommand>;
  hooksByEvent: Map<BridgeableEvent, DiscoveredHook[]>;
  discovered: boolean;
  hookHandlersRegistered: boolean;
  closed: boolean;
  /** Most recent event-handler-passed ctx; valid while the instance is not stale. */
  latestCtx: ExtensionContext | undefined;
  staleLogged: boolean;
  lastSkipped: { name: string; error: string }[];
  watchers: WatchState["watchers"];
  debounceTimer: WatchState["debounceTimer"];
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export async function scriptingBridgeExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const skillsRoot =
    process.env.PI_SCRIPTING_BRIDGE_SKILLS_ROOT ?? DEFAULT_SKILLS_ROOT;

  const state: BridgeState = {
    skillsRoot,
    currentTools: new Map(),
    currentCommands: new Map(),
    hooksByEvent: new Map(),
    discovered: false,
    hookHandlersRegistered: false,
    closed: false,
    latestCtx: undefined,
    staleLogged: false,
    lastSkipped: [],
    watchers: new Map(),
    debounceTimer: undefined,
  };

  pi.on("session_start", onSessionStart(state));
  pi.on("session_shutdown", onSessionShutdown(state));

  // Persistent notify lines: the "bridge-status" entry renderer is
  // registered once at setup (same pre-bind no-op semantics as the
  // registerTool/registerCommand/on calls above). Each
  // pi.appendEntry("bridge-status", {message}) from the persistent path
  // of applyNotifyDirective appends a dim chat line that survives the
  // dedup/replace single status slot of ctx.ui.notify.
  pi.registerEntryRenderer("bridge-status", (entry, _options, theme) => {
    const data = entry.data as { message?: unknown } | undefined;
    const line = typeof data?.message === "string" ? data.message : "";
    return new Text(theme.fg("dim", line), 1, 0);
  });

  // Initial discovery runs in the factory, which the SDK awaits before TUI
  // setup, so tools, commands, and hook handlers are all registered before
  // the TUI builds its slash-command autocomplete list (a session_start-time
  // fire-and-forget discovery lost the race and commands never appeared in
  // the "/" autocomplete). rediscover is safe here: on a first call the
  // active-set diff is empty (no getActiveTools call), and pre-bind
  // registerTool/registerCommand/on are no-ops that write to the
  // extension's maps.
  state.discovered = true; // so logSkipped reports skipped files
  await rediscover(pi, state);
  registerHookHandlers(pi, state);

  startWatchers(state, skillsRoot, () => void rediscover(pi, state));
}

// ---------------------------------------------------------------------------
// Staleness handling
// ---------------------------------------------------------------------------
// SDK contract: after a session replacement (new/fork/resume) or a reload,
// the factory-captured `pi` (and any captured ctx) is stale. Only `pi`
// exposes registerTool/getActiveTools/setActiveTools, so staleness is
// terminal for this instance: stop all activity immediately and log at
// most once. No "rediscovery failed" error spam.

function teardownStale(state: BridgeState, ctx?: ExtensionContext): void {
  if (state.closed) {
    return;
  }
  state.closed = true;
  closeWatchers(state);
  if (!state.staleLogged) {
    state.staleLogged = true;
    logFailure(
      "scripting-bridge: instance stale, shutting down rediscovery",
      ctx,
    );
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTool(
  pi: ExtensionAPI,
  def: DiscoveredTool,
  state: BridgeState,
): boolean {
  const schemaResult = createParameterSchema(def.parameters);
  if (schemaResult.error) {
    logFailure(
      `scripting-bridge: skipped tool '${def.name}': ${schemaResult.error}`,
    );
    return false;
  }

  pi.registerTool({
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: schemaResult.schema,
    executionMode: def.executionMode ?? "parallel",
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) => {
      state.latestCtx = ctx;
      return executeTool(def, toolCallId, params, signal, ctx);
    },
    renderResult: (result, options, theme, context) =>
      renderToolResult(result, options.isPartial, theme, context.lastComponent),
  });
  return true;
}

/**
 * The "running…" indicator for a partial (streaming) tool result:
 * theme.fg warning style, mirroring pi's bash tool pattern. Reuses the
 * previous Text component via setText, creates a new one otherwise.
 */
function renderRunningIndicator(
  theme: Theme,
  lastComponent: Component | undefined,
): Component {
  const running = theme.fg("warning", "running…");
  if (lastComponent instanceof Text) {
    lastComponent.setText(running);
    return lastComponent;
  }
  return new Text(running, 0, 0);
}

/** The result's text content blocks joined with "\n" for Markdown rendering. */
function extractResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * The Markdown component for a final tool result: reuse the previous
 * Markdown component via setText, create a new one otherwise (themed via
 * getMarkdownTheme, the same theme source pi's own components use).
 */
function renderMarkdownText(
  text: string,
  lastComponent: Component | undefined,
): Component {
  if (lastComponent instanceof Markdown) {
    lastComponent.setText(text);
    return lastComponent;
  }
  return new Markdown(text, 0, 0, getMarkdownTheme());
}

/**
 * Pass-through Markdown rendering: text blocks are fed unmodified to pi-tui
 * Markdown (no TSV-to-table, no code-fencing). Model-facing content is never
 * touched; partial results show a "running…" indicator.
 */
function renderToolResult(
  result: AgentToolResult<unknown>,
  isPartial: boolean,
  theme: Theme,
  lastComponent: Component | undefined,
): Component {
  if (isPartial) {
    return renderRunningIndicator(theme, lastComponent);
  }
  const text = extractResultText(result);
  if (text.trim().length === 0) {
    return new Text("", 0, 0);
  }
  return renderMarkdownText(text, lastComponent);
}

// ---------------------------------------------------------------------------
// Command registration (type: command skills -> user-invocable slash commands)
// ---------------------------------------------------------------------------

/**
 * Register a `type: command` skill as a user-invocable slash command via
 * pi.registerCommand. The handler builds the tool-shaped stdin payload
 * (command name, raw argument string and param defaults under `params`, plus
 * the live session context), spawns the `.nu` handler, and surfaces the
 * result exactly like a tool result (fail-open, sendMessage directive
 * applied). It also passes the live command registry (state.currentCommands,
 * name → def) so picker action effects can re-run the current command or
 * invoke a named one. Returns false when a staleness error terminated the
 * instance.
 */
function registerCommand(
  pi: ExtensionAPI,
  def: DiscoveredCommand,
  state: BridgeState,
): boolean {
  try {
    pi.registerCommand(def.name, {
      description: def.description || undefined,
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        state.latestCtx = ctx;
        await executeCommand(pi, def, args, ctx, state.currentCommands);
      },
    });
    return true;
  } catch (err) {
    if (isStaleError(err)) {
      teardownStale(state, state.latestCtx);
      return false;
    }
    logFailure(
      `scripting-bridge: failed to register command '${def.name}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Register new/changed commands. Same-name registration overwrites in the
 * SDK, so a changed command re-registers cleanly. The SDK exposes no
 * command-removal API, so a command that disappears from the tree stays
 * registered until /reload (intentional, documented). Returns false when a
 * staleness error terminated the instance.
 */
function syncCommandRegistry(
  pi: ExtensionAPI,
  state: BridgeState,
  commands: Map<string, DiscoveredCommand>,
): boolean {
  for (const [name, def] of commands) {
    const prev = state.currentCommands.get(name);
    if (prev === undefined || prev.fingerprint !== def.fingerprint) {
      if (!registerCommand(pi, def, state)) {
        return false;
      }
      state.currentCommands.set(name, def);
    }
  }
  return true;
}

/**
 * Register `shortcut` key bindings from frontmatter. The trigger re-resolves
 * the live def so watcher rediscovery stays in sync. Colliding built-in
 * actions are unbound in keybindings.json to free the keys.
 */
/**
 * Register the frontmatter `shortcut` key bindings for whichever commands
 * are currently discovered. Same-name shortcut registration overwrites in
 * the SDK, so repeated calls (watcher rediscovery) are idempotent. Returns
 * false when a staleness error terminated the instance.
 */
function registerShortcuts(pi: ExtensionAPI, state: BridgeState): boolean {
  for (const def of state.currentCommands.values()) {
    if (def.shortcut === undefined) {
      continue;
    }
    try {
      pi.registerShortcut(def.shortcut as KeyId, {
        description: `Run /${def.name} (${def.description})`,
        handler: async (ctx: ExtensionContext) => {
          const live = state.currentCommands.get(def.name);
          if (live === undefined) {
            return;
          }
          await executeCommand(pi, live, "", ctx, state.currentCommands);
        },
      });
    } catch (err) {
      if (isStaleError(err)) {
        teardownStale(state, state.latestCtx);
        return false;
      }
      logFailure(
        `scripting-bridge: failed to register shortcut '${def.shortcut}' for '${def.name}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hook execution
// ---------------------------------------------------------------------------

function buildHookPayload(eventObj: unknown, ctx: ExtensionContext): string {
  // Key order matters here: this nushell build's `from json` silently
  // drops top-level keys that follow a key whose value holds a non-empty
  // JSON array. `event` carries a non-empty `messages` array on agent_end,
  // so `context` must be emitted before `event` to survive parsing. JSON
  // key order is semantically irrelevant to consumers.
  return JSON.stringify({
    context: serializeForJson(buildContextPayload(ctx)),
    event: serializeForJson(eventObj),
  });
}

interface HookStepResult {
  /**
   * How the hook's output resolved: `failure` (timeout / non-zero exit /
   * invalid JSON — fail-open, no contribution), `noop` (empty stdout), or
   * `ok` (a valid JSON object).
   */
  status: "failure" | "noop" | "ok";
  value: Record<string, unknown> | undefined;
}

/**
 * Validate one hook script's output. Failures (timeout, non-zero exit,
 * empty output, invalid JSON, non-object JSON) are logged and treated as
 * no-op (fail-open). A signal kill from a user-initiated abort
 * (res.signal set + ctx.signal aborted) is suppressed entirely — no TUI
 * warning, no debug log.
 */
function processHookOutput(
  hook: DiscoveredHook,
  event: string,
  res: ScriptExecResult,
  ctx: ExtensionContext,
): HookStepResult {
  const label = `scripting-bridge: hook '${hook.name}' (${event})`;
  if (res.timedOut) {
    logFailure(`${label}: timed out`, ctx);
    return { status: "failure", value: undefined };
  }
  if (res.code !== 0) {
    // A signal kill (code null) from the user-initiated abort
    // (ctx.signal aborted via wireAbort → makeKiller) is an expected
    // interruption, not a hook failure: the TUI "failed (exit null)"
    // warning is suppressed entirely (silent). Non-abort signal kills
    // fall through to the warning below; the "timed out" check above
    // stays untouched.
    if (res.signal !== undefined && ctx.signal?.aborted === true) {
      return { status: "failure", value: undefined };
    }
    logFailure(`${label}: failed (exit ${res.code})`, ctx);
    return { status: "failure", value: undefined };
  }

  const out = res.stdout.trim();
  if (out.length === 0) {
    return { status: "noop", value: undefined }; // empty output = no-op
  }

  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    logFailure(`${label}: invalid JSON`, ctx);
    return { status: "failure", value: undefined };
  }

  if (typeof value !== "object" || value === null) {
    logFailure(`${label}: invalid JSON`, ctx);
    return { status: "failure", value: undefined };
  }

  return { status: "ok", value: value as Record<string, unknown> };
}

/**
 * Run a pi API call that may surface a staleness error: on a stale error the
 * instance is torn down; any other error is logged (fail-open). Shared by the
 * setThinkingLevel and persistent-notify directive handlers, which differ only
 * in the API call and the label used in the error line.
 */
function runStaleGuardedApi(
  state: BridgeState,
  ctx: ExtensionContext,
  hook: DiscoveredHook,
  event: BridgeableEvent,
  label: string,
  call: () => void,
): void {
  try {
    call();
  } catch (err) {
    if (isStaleError(err)) {
      teardownStale(state, ctx);
    } else {
      logFailure(
        `scripting-bridge: hook '${hook.name}' (${event}) ${label} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        ctx,
      );
    }
  }
}

/**
 * The shared context for applying a hook's directives: the pi API, the
 * bridge state, the hook, the triggering event, and the extension context.
 * Bundled so every directive helper takes a single context plus the value,
 * instead of redeclaring the six parameters each.
 */
interface DirectiveContext {
  pi: ExtensionAPI;
  state: BridgeState;
  hook: DiscoveredHook;
  event: BridgeableEvent;
  ctx: ExtensionContext;
}

/**
 * A per-directive actor: validate the raw directive value, run the side
 * effect (an API call, a notify, ...), and return the final value. The
 * shared {@link applyDirective} skeleton hands it the raw value, the
 * key-stripped `rest`, the full original `value` (for failure logging), and
 * the {@link DirectiveContext}.
 */
type DirectiveActor = (
  raw: unknown,
  rest: Record<string, unknown>,
  value: Record<string, unknown>,
  d: DirectiveContext,
) => Record<string, unknown>;

/**
 * The shared directive-application skeleton: when the key is absent from the
 * value, return it unchanged; otherwise build the key-stripped `rest` and
 * delegate to `act` (which validates the raw value and runs the side
 * effect), returning its result. Every directive helper is this skeleton
 * with a per-key `act`, so the guard + stripping live in one place.
 */
function applyDirective(
  d: DirectiveContext,
  value: Record<string, unknown>,
  key: string,
  act: DirectiveActor,
): Record<string, unknown> {
  if (!(key in value)) {
    return value;
  }
  const rest: Record<string, unknown> = { ...value };
  delete rest[key];
  return act(value[key], rest, value, d);
}

/**
 * A guarded-directive spec: the key to guard and strip, the display name
 * used in the "invalid <label> directive" failure message, a validator
 * over the raw value, and the side effect to run on a validated value.
 * Bundled so {@link applyGuardedDirective} takes a single spec instead of
 * four separate parameters.
 */
interface GuardedDirectiveSpec {
  /** The directive key to guard against and strip from the value. */
  key: string;
  /** Display name of the directive, used in the invalid-directive failure message. */
  label: string;
  /** Returns true when the raw directive value is valid. */
  validate: (raw: unknown) => boolean;
  /** Runs the directive's side effect on a validated raw value. */
  run: (raw: unknown, dc: DirectiveContext) => void;
}

/**
 * The shared guarded-directive skeleton: delegate to {@link applyDirective}
 * (guard + strip) with an actor that, on an invalid raw value, logs the
 * standard "invalid <label> directive" failure and returns the stripped
 * rest; on a valid value, runs `spec.run` and returns the stripped rest.
 * Every guarded directive helper is this skeleton with a per-key spec, so
 * the guard + validation + stripping live in one place.
 */
function applyGuardedDirective(
  d: DirectiveContext,
  value: Record<string, unknown>,
  spec: GuardedDirectiveSpec,
): Record<string, unknown> {
  return applyDirective(d, value, spec.key, (raw, rest, orig, dc) => {
    if (!spec.validate(raw)) {
      logFailure(
        `scripting-bridge: hook '${dc.hook.name}' (${dc.event}) set an invalid ${spec.label} directive: ${JSON.stringify(orig)}`,
        dc.ctx,
      );
      return rest;
    }
    spec.run(raw, dc);
    return rest;
  });
}

/**
 * Apply the optional `setThinkingLevel` directive from a hook's output and
 * strip the directive key from the value. An invalid level is logged and
 * ignored (the API is not called). A staleness error from the API call
 * tears the instance down; any other error is logged. The returned value
 * never carries the directive key, so it cannot leak into combined
 * result payloads.
 */
function applyThinkingLevelDirective(
  d: DirectiveContext,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return applyGuardedDirective(d, value, {
    key: "setThinkingLevel",
    label: "thinkingLevel",
    validate: (raw) =>
      typeof raw === "string" &&
      (THINKING_LEVELS as readonly string[]).includes(raw),
    run: (raw, dc) =>
      runStaleGuardedApi(dc.state, dc.ctx, dc.hook, dc.event, "setThinkingLevel", () =>
        dc.pi.setThinkingLevel(raw as (typeof THINKING_LEVELS)[number]),
      ),
  });
}

/**
 * Apply the optional `sendMessage` directive from a hook's output and
 * strip the directive key from the value. An invalid value (present but
 * not a non-null object) is logged and the API is not called. A staleness
 * error from the API call tears the instance down; any other error is
 * logged. The returned value never carries the directive key, so it
 * cannot leak into combined result payloads.
 */
function applySendMessageDirective(
  d: DirectiveContext,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return applyGuardedDirective(d, value, {
    key: "sendMessage",
    label: "sendMessage",
    validate: (raw) => typeof raw === "object" && raw !== null,
    run: (raw, dc) =>
      runSendMessage(
        dc.pi,
        raw as object,
        `scripting-bridge: hook '${dc.hook.name}' (${dc.event})`,
        dc.ctx,
        () => teardownStale(dc.state, dc.ctx),
      ),
  });
}

/**
 * Apply the `notify` directive: string or {message, type?, persistent?}.
 * `persistent: true` appends a "bridge-status" chat entry (survives later
 * status lines) instead of the dedup/replace ctx.ui.notify slot.
 */
function applyNotifyDirective(
  d: DirectiveContext,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return applyDirective(d, value, "notify", (raw, rest, orig, dc) => {
    let message: string;
    let type: "info" | "warning" | "error" = "info";
    if (typeof raw === "string") {
      message = raw;
    } else if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.message !== "string") {
        logFailure(
          `scripting-bridge: hook '${dc.hook.name}' (${dc.event}) set an invalid notify directive (message must be a string): ${JSON.stringify(orig)}`,
          dc.ctx,
        );
        return rest;
      }
      message = obj.message;
      if (obj.type === "warning" || obj.type === "error") {
        type = obj.type;
      }
      if (obj.persistent === true) {
        runStaleGuardedApi(dc.state, dc.ctx, dc.hook, dc.event, "persistent notify", () =>
          dc.pi.appendEntry("bridge-status", { message }),
        );
        return rest;
      }
    } else {
      logFailure(
        `scripting-bridge: hook '${dc.hook.name}' (${dc.event}) set an invalid notify directive (must be a string or {message, type?, persistent?}): ${JSON.stringify(orig)}`,
        dc.ctx,
      );
      return rest;
    }
    try {
      dc.ctx?.ui?.notify(message, type);
    } catch {
      // Notification is best-effort; a failed notify must not break hooks.
    }
    return rest;
  });
}

/**
 * Apply all directive helpers in order (setThinkingLevel, sendMessage,
 * notify), stripping the directive keys from the value. Returns the
 * keys that were present in the hook's output (for the visibility line)
 * plus the directive-free value that flows into result combination.
 */
function applyDirectives(
  d: DirectiveContext,
  value: Record<string, unknown>,
): {
  applied: {
    setThinkingLevel: string | undefined;
    sendMessage: boolean;
    notify: boolean;
  };
  rest: Record<string, unknown>;
} {
  const applied = {
    setThinkingLevel:
      "setThinkingLevel" in value ? String(value.setThinkingLevel) : undefined,
    sendMessage: "sendMessage" in value,
    notify: "notify" in value,
  };
  const afterThinking = applyThinkingLevelDirective(d, value);
  const afterSend = applySendMessageDirective(d, afterThinking);
  const rest = applyNotifyDirective(d, afterSend);
  return { applied, rest };
}

/**
 * Build the visibility parts for a hook's applied directives: the
 * setThinkingLevel value (when applied), a sendMessage marker, the
 * terminateSession marker (applying the in-process termination and
 * stripping the key), and a "result applied" marker when the directive-
 * free value is non-empty.
 */
function buildHookReportParts(
  applied: {
    setThinkingLevel: string | undefined;
    sendMessage: boolean;
    notify: boolean;
  },
  rest: Record<string, unknown>,
  hook: DiscoveredHook,
  ctx: ExtensionContext,
): string[] {
  const parts: string[] = [];
  if (applied.setThinkingLevel !== undefined) {
    parts.push(`setThinkingLevel=${applied.setThinkingLevel}`);
  }
  if (applied.sendMessage) {
    parts.push("sendMessage");
  }
  // terminateSession: exact boolean `true` only (same contract as the tool
  // path). Reuses the tool path's in-process termination helper and strips
  // the key so it never leaks into combined result payloads — also on
  // no-result events where the combined result is discarded.
  if (rest.terminateSession === true) {
    delete rest.terminateSession;
    parts.push("terminateSession");
    applyTerminateSession(hook.name, ctx, { content: [], details: {} });
  }
  if (Object.keys(rest).length > 0) {
    parts.push("result applied");
  }
  return parts;
}

/**
 * Run one hook script and map its stdout onto the hook step result:
 * runs the script with the event payload, and validates the output
 * (fail-open, per processHookOutput).
 */
async function executeHookStep(
  hook: DiscoveredHook,
  event: BridgeableEvent,
  payload: string,
  ctx: ExtensionContext,
): Promise<HookStepResult> {
  const res = await runScript(hook.scriptPath, payload, {
    timeoutMs: hook.timeoutMs,
    signal: ctx.signal,
    cwd: ctx.cwd,
    args: hook.args,
  });
  return processHookOutput(hook, event, res, ctx);
}

/**
 * Apply both directives to a hook's output and surface the visibility line
 * for what the hook did (silent when no directive was applied and nothing
 * was contributed — no "no-op" toast). Returns the directive-free value
 * that flows into result combination.
 */
function applyHookContribution(
  d: DirectiveContext,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { applied, rest } = applyDirectives(d, value);
  // Handle the terminateSession directive (apply in-process termination and
  // strip the key) so it never leaks into the combined result.
  buildHookReportParts(applied, rest, d.hook, d.ctx);

  return rest;
}

/** The running state of the per-event hook chain: the combined
 * accumulator, whether the chain stopped, and the name of the hook whose
 * result first requested a stop. */
interface HookChainState {
  acc: unknown;
  stop: boolean;
  stoppedAfter: string | undefined;
}

/** Fold one hook's directive-free value into the chain via the per-event
 * result combiner, recording the first hook that requested a stop. */
function combineChainStep(
  event: BridgeableEvent,
  chain: HookChainState,
  rest: Record<string, unknown>,
  sanitizedEvent: Record<string, unknown> | undefined,
  hookName: string,
): void {
  const outcome = combineResult(event, chain.acc, rest, sanitizedEvent);
  chain.acc = outcome.value;
  if (outcome.stop && !chain.stop) {
    chain.stoppedAfter = hookName;
  }
  chain.stop = outcome.stop;
}

async function runEventHooks(
  pi: ExtensionAPI,
  state: BridgeState,
  event: BridgeableEvent,
  eventObj: unknown,
  ctx: ExtensionContext,
): Promise<unknown> {
  const hooks = state.hooksByEvent.get(event);
  if (hooks === undefined || hooks.length === 0) {
    return undefined;
  }

  const payload = buildHookPayload(eventObj, ctx);
  const sanitizedEvent =
    (eventObj as Record<string, unknown> | undefined) ?? undefined;
  const chain: HookChainState = {
    acc: undefined,
    stop: false,
    stoppedAfter: undefined,
  };

  for (const hook of hooks) {
    if (chain.stop) break;

    const step = await executeHookStep(hook, event, payload, ctx);
    if (step.status !== "ok") {
      // A failure already surfaced a visible warning via logFailure; an
      // empty-stdout noop means the hook changed nothing: stay silent so
      // the TUI is not spammed with "no-op" toasts.
      continue;
    }

    // A valid JSON object: apply the directives, report what the hook did,
    // and let the directive-free value flow into result combination.
    const d: DirectiveContext = { pi, state, hook, event, ctx };
    const rest = applyHookContribution(d, step.value!);
    combineChainStep(event, chain, rest, sanitizedEvent, hook.name);
  }

  return chain.acc;
}

function registerHookHandlers(pi: ExtensionAPI, state: BridgeState): void {
  if (state.hookHandlersRegistered) {
    return;
  }
  state.hookHandlersRegistered = true;

  const onAny = pi.on.bind(pi) as (
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>,
  ) => void;

  for (const eventName of BRIDGEABLE_EVENTS) {
    onAny(eventName, (event, ctx) => {
      state.latestCtx = ctx;
      if (eventName !== "project_trust") {
        return runEventHooks(pi, state, eventName, event, ctx);
      }
      // The Pi runner dereferences the project_trust handler result
      // (handlerResult.trusted === "undecided"), so the handler must
      // never return undefined for that event: fall back to "undecided"
      // when no hook contributes a value.
      return (async () =>
        (await runEventHooks(pi, state, eventName, event, ctx)) ?? {
          trusted: "undecided",
        })();
    });
  }
}

// ---------------------------------------------------------------------------
// Discovery and live reload
// ---------------------------------------------------------------------------

function applyHookDiscovery(state: BridgeState, hooks: DiscoveredHook[]): void {
  state.hooksByEvent.clear();
  // A hook may be bound to multiple events (the frontmatter `event` field
  // accepts a single string or a list): register it into a bucket for every
  // bound event, so the one script runs for each of them. A hook bound to
  // both session_start and session_compact thus fires on session start AND
  // after compaction.
  for (const hook of hooks) {
    for (const event of hook.events) {
      const list = state.hooksByEvent.get(event) ?? [];
      list.push(hook);
      state.hooksByEvent.set(event, list);
    }
  }
}

/**
 * Register new/changed tools (fingerprint-gated). Same-name registration
 * overwrites in the SDK and triggers a tool registry refresh.
 */
function registerChangedTools(
  pi: ExtensionAPI,
  state: BridgeState,
  tools: Map<string, DiscoveredTool>,
): void {
  for (const [name, def] of tools) {
    const prev = state.currentTools.get(name);
    if (prev === undefined || prev.fingerprint !== def.fingerprint) {
      if (registerTool(pi, def, state)) {
        state.currentTools.set(name, def);
      }
    }
  }
}

/**
 * Register new/changed tools and drop vanished ones from the active set.
 * Returns false when a staleness error terminated the instance.
 */
function syncToolRegistry(
  pi: ExtensionAPI,
  state: BridgeState,
  tools: Map<string, DiscoveredTool>,
  notifyCtx: ExtensionContext | undefined,
): boolean {
  registerChangedTools(pi, state, tools);
  return removeVanishedTools(pi, state, tools, notifyCtx);
}

/**
 * Delete the given tool names from the active set and prune them from the
 * SDK's active-tools list. Extension tools are auto-activated by the SDK;
 * the registry itself drops them on the next refresh. Returns false when a
 * staleness error terminated the instance.
 */
function pruneVanishedTools(
  pi: ExtensionAPI,
  state: BridgeState,
  removed: string[],
  notifyCtx: ExtensionContext | undefined,
): boolean {
  for (const name of removed) {
    state.currentTools.delete(name);
  }
  try {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((n) => !removed.includes(n)));
  } catch (err) {
    if (isStaleError(err)) {
      teardownStale(state, notifyCtx);
      return false;
    }
    // Best-effort; the LLM still sees the stale name until /reload.
  }
  return true;
}

/**
 * Remove vanished tools from the active set (extension tools are
 * auto-activated by the SDK; the registry itself drops them on the next
 * refresh). Returns false when a staleness error terminated the instance.
 */
function removeVanishedTools(
  pi: ExtensionAPI,
  state: BridgeState,
  tools: Map<string, DiscoveredTool>,
  notifyCtx: ExtensionContext | undefined,
): boolean {
  const removed = [...state.currentTools.keys()].filter(
    (name) => !tools.has(name),
  );
  if (removed.length === 0) {
    return true;
  }
  return pruneVanishedTools(pi, state, removed, notifyCtx);
}

function logSkipped(
  state: BridgeState,
  notifyCtx: ExtensionContext | undefined,
): void {
  if (!state.discovered) {
    return;
  }
  for (const { name, error } of state.lastSkipped) {
    logFailure(`scripting-bridge: skipped '${name}': ${error}`, notifyCtx);
  }
}

/**
 * Run the early-return sync chain: syncToolRegistry → syncCommandRegistry →
 * registerShortcuts. Returns false when any step terminated the instance
 * via a staleness error.
 */
function syncRegistries(
  pi: ExtensionAPI,
  state: BridgeState,
  toolDiscovery: ToolDiscovery,
  commandDiscovery: CommandDiscovery,
  notifyCtx: ExtensionContext | undefined,
): boolean {
  if (!syncToolRegistry(pi, state, toolDiscovery.tools, notifyCtx)) {
    return false;
  }
  if (!syncCommandRegistry(pi, state, commandDiscovery.commands)) {
    return false;
  }
  if (!registerShortcuts(pi, state)) {
    return false;
  }
  return true;
}

/**
 * Perform the full discovery-and-sync cycle: run the three discoverers in
 * parallel, sync the tool/command/shortcut registries, apply hook
 * discovery, and log skipped files. Returns true on success (including
 * non-stale errors that were logged), false when a staleness error
 * terminated the instance.
 */
async function runRediscovery(
  pi: ExtensionAPI,
  state: BridgeState,
  notifyCtx: ExtensionContext | undefined,
): Promise<boolean> {
  try {
    const [toolDiscovery, hookDiscovery, commandDiscovery] = await Promise.all([
      discoverTools(state.skillsRoot),
      discoverHooks(state.skillsRoot),
      discoverCommands(state.skillsRoot),
    ]);

    if (!syncRegistries(pi, state, toolDiscovery, commandDiscovery, notifyCtx)) {
      return false;
    }

    applyHookDiscovery(state, hookDiscovery.hooks);

    state.lastSkipped = [
      ...toolDiscovery.skipped,
      ...hookDiscovery.skipped,
      ...commandDiscovery.skipped,
    ];
    logSkipped(state, notifyCtx);
    return true;
  } catch (err) {
    if (isStaleError(err)) {
      teardownStale(state, notifyCtx);
      return false;
    }
    logFailure(
      `scripting-bridge: rediscovery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

async function rediscover(
  pi: ExtensionAPI,
  state: BridgeState,
  ctx?: ExtensionContext,
): Promise<void> {
  if (state.closed) {
    return;
  }
  // The event ctx passed in is preferred; the watcher-triggered path falls
  // back to the most recent handler-passed ctx, which is valid as long as
  // this instance is not stale (staleness is handled in runRediscovery).
  const notifyCtx = ctx ?? state.latestCtx;
  await runRediscovery(pi, state, notifyCtx);
}

// ---------------------------------------------------------------------------
// Event registration
// ---------------------------------------------------------------------------

function onSessionStart(
  state: BridgeState,
): (event: unknown, ctx: ExtensionContext) => void {
  return (event, ctx) => {
    // Initial discovery already ran in the factory (before TUI setup). This
    // handler captures the session's ctx so watcher-triggered rediscovery
    // has a valid notification channel, and surfaces the initial
    // discovery's skipped files (the factory-time rediscover had no ctx,
    // so its logSkipped pass was console-only).
    state.latestCtx = ctx;
    void event;
  };
}

function onSessionShutdown(
  state: BridgeState,
): (event: unknown, ctx: ExtensionContext) => void {
  return (event, ctx) => {
    // The runtime is torn down for every shutdown reason ("quit", "reload",
    // "new", "resume", "fork"); the ctx in this handler is still valid at
    // fire time. Stop all activity (watchers + debounce) unconditionally.
    state.latestCtx = ctx;
    state.closed = true;
    closeWatchers(state);
    void event;
  };
}
