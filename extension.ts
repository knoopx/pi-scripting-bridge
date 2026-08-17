/**
 * scripting-bridge — consolidated Pi extension owning the script surface.
 *
 * Tool bridge:
 * - Discovers `type: tool` and `type: agent` skill files anywhere in the
 *   skills tree via a single recursive walk. The frontmatter `type:` field
 *   is authoritative — the file's directory is not consulted to decide its
 *   role.
 * - Registers each as a Pi tool (executionMode "sequential") with a TypeBox
 *   parameter schema generated from the skill's `parameters` field
 *   (ShellToolProperty format, `required: true/false`)
 * - Executes the skill's `command` script with the stdin payload
 *   {"toolCallId", "params"} (validated params, defaults applied) and maps
 *   the stdout JSON onto AgentToolResult (`content` required, `details`
 *   defaults to {}, optional `terminate`/`addedToolNames`)
 * - Non-zero exit or invalid stdout JSON produces an error result with the
 *   script stderr surfaced in `content`; tool scripts run with a 120s
 *   timeout unless the skill frontmatter declares `timeout` (ms; 0 = no
 *   timeout)
 *
 * Hook bridge:
 * - Discovers `type: hook` skill files anywhere in the skills tree via the
 *   same recursive, type-authoritative walk, each declaring its .nu handler
 *   via the frontmatter `command` field, same convention as tool skills
 * - Frontmatter `event` declares the Pi event; `timeout` (ms) defaults to
 *   10000, max 300000
 * - On each event the script receives the stdin payload {"event", "context"}
 *   and its stdout JSON maps onto the event result per the per-event
 *   combination semantics (cancel short-circuit, first-wins, chaining,
 *   field-wise merge, accumulation, replacement)
 * - 31 of the 33 events are bridgeable; `message_update` and
 *   `tool_execution_update` stay TS-only and are never registered
 * - Empty script output is a no-op; script failures are logged and treated
 *   as no-op (fail-open)
 *
 * Live reload:
 * - The skills tree is watched with fs.watch; changed .md files re-register
 *   their tools and refresh hook subscriptions without /reload. On
 *   session_shutdown the watchers are closed for every shutdown reason
 *   ("quit", "reload", "new", "resume", "fork"): the extension runtime is
 *   torn down after each of them, so the instance stops all activity.
 * - If a captured `pi` throws a staleness error after a session
 *   replacement, the instance performs a silent one-time teardown
 *   (watchers + debounce closed, at most one log line) instead of spamming
 *   "rediscovery failed". Per-event work always uses the ctx passed to the
 *   handler; the extension never calls session-replacement APIs itself.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BRIDGEABLE_EVENTS,
  DEFAULT_SKILLS_ROOT,
  type BridgeableEvent,
} from "./constants.js";
import type { DiscoveredHook, DiscoveredTool } from "./discovery.js";
import { discoverHooks, discoverTools } from "./discovery.js";
import { combineResult } from "./hook-combine.js";
import { buildContextPayload, serializeForJson } from "./hook-payload.js";
import { createParameterSchema } from "./schema.js";
import { runScript, type ScriptExecResult } from "./script-exec.js";
import { executeTool } from "./tool-exec.js";
import {
  closeWatchers,
  startWatchers,
  type WatchState,
} from "./watcher.js";

// ---------------------------------------------------------------------------
// Instance state
// ---------------------------------------------------------------------------

interface BridgeState {
  skillsRoot: string;
  currentTools: Map<string, DiscoveredTool>;
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

  pi.on("session_start", onSessionStart(pi, state));
  pi.on("session_shutdown", onSessionShutdown(state));

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

function isStaleError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("stale");
}

function logFailure(message: string, ctx?: ExtensionContext): void {
  console.error(message);
  try {
    ctx?.ui?.notify(message, "warning");
  } catch {
    // Notification is best-effort.
  }
}

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
    executionMode: "sequential",
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) => {
      state.latestCtx = ctx;
      return executeTool(def, toolCallId, params, signal, ctx, def.timeoutMs);
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Hook execution
// ---------------------------------------------------------------------------

function buildHookPayload(eventObj: unknown, ctx: ExtensionContext): string {
  return JSON.stringify({
    event: serializeForJson(eventObj),
    context: serializeForJson(buildContextPayload(ctx)),
  });
}

interface HookStepResult {
  /** True when the hook contributed nothing (fail-open / no-op). */
  skip: boolean;
  value: Record<string, unknown> | undefined;
}

/**
 * Validate one hook script's output. Failures (timeout, non-zero exit,
 * empty output, invalid JSON, non-object JSON) are logged and treated as
 * no-op (fail-open).
 */
function processHookOutput(
  hook: DiscoveredHook,
  event: string,
  res: ScriptExecResult,
  ctx: ExtensionContext,
): HookStepResult {
  const label = `scripting-bridge: hook '${hook.name}' (${event})`;
  if (res.timedOut) {
    logFailure(`${label} timed out after ${hook.timeoutMs}ms`, ctx);
    return { skip: true, value: undefined };
  }
  if (res.code !== 0) {
    logFailure(
      `${label} failed with exit code ${res.code}${res.stderr ? `: ${res.stderr.trim()}` : ""}`,
      ctx,
    );
    return { skip: true, value: undefined };
  }

  const out = res.stdout.trim();
  if (out.length === 0) {
    return { skip: true, value: undefined }; // empty output = no-op
  }

  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    logFailure(`${label} produced invalid JSON on stdout`, ctx);
    return { skip: true, value: undefined };
  }

  if (typeof value !== "object" || value === null) {
    logFailure(`${label} stdout JSON must be an object`, ctx);
    return { skip: true, value: undefined };
  }

  return { skip: false, value: value as Record<string, unknown> };
}

async function runEventHooks(
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
  let acc: unknown;
  let stop = false;

  for (const hook of hooks) {
    if (stop) break;

    const res = await runScript(hook.scriptPath, payload, {
      timeoutMs: hook.timeoutMs,
      signal: ctx.signal,
      cwd: ctx.cwd,
      args: hook.args,
    });

    const step = processHookOutput(hook, event, res, ctx);
    if (step.skip) {
      continue;
    }
    const outcome = combineResult(event, acc, step.value!, sanitizedEvent);
    acc = outcome.value;
    stop = outcome.stop;
  }

  return acc;
}

function registerHookHandlers(pi: ExtensionAPI, state: BridgeState): void {
  if (state.hookHandlersRegistered) {
    return;
  }
  state.hookHandlersRegistered = true;

  const onAny = pi.on as (
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>,
  ) => void;

  for (const eventName of BRIDGEABLE_EVENTS) {
    onAny(eventName, (event, ctx) => {
      state.latestCtx = ctx;
      return runEventHooks(state, eventName, event, ctx);
    });
  }
}

// ---------------------------------------------------------------------------
// Discovery and live reload
// ---------------------------------------------------------------------------

function applyHookDiscovery(
  state: BridgeState,
  hooks: DiscoveredHook[],
): void {
  state.hooksByEvent.clear();
  for (const hook of hooks) {
    const list = state.hooksByEvent.get(hook.event) ?? [];
    list.push(hook);
    state.hooksByEvent.set(hook.event, list);
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
  // Same-name registration overwrites in the SDK and triggers a tool
  // registry refresh.
  for (const [name, def] of tools) {
    const prev = state.currentTools.get(name);
    if (prev === undefined || prev.fingerprint !== def.fingerprint) {
      if (registerTool(pi, def, state)) {
        state.currentTools.set(name, def);
      }
    }
  }
  return removeVanishedTools(pi, state, tools, notifyCtx);
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
  // this instance is not stale (staleness is handled in the catch below).
  const notifyCtx = ctx ?? state.latestCtx;
  try {
    const [toolDiscovery, hookDiscovery] = await Promise.all([
      discoverTools(state.skillsRoot),
      discoverHooks(state.skillsRoot),
    ]);

    if (!syncToolRegistry(pi, state, toolDiscovery.tools, notifyCtx)) {
      return;
    }

    applyHookDiscovery(state, hookDiscovery.hooks);

    state.lastSkipped = [...toolDiscovery.skipped, ...hookDiscovery.skipped];
    logSkipped(state, notifyCtx);
  } catch (err) {
    if (isStaleError(err)) {
      teardownStale(state, notifyCtx);
      return;
    }
    logFailure(
      `scripting-bridge: rediscovery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Event registration
// ---------------------------------------------------------------------------

function onSessionStart(
  pi: ExtensionAPI,
  state: BridgeState,
): (event: unknown, ctx: ExtensionContext) => void {
  return (event, ctx) => {
    state.latestCtx = ctx;
    if (state.discovered) {
      return;
    }
    state.discovered = true;
    void rediscover(pi, state, ctx).then(() =>
      afterInitialDiscovery(pi, state, ctx),
    );
    void event;
  };
}

function afterInitialDiscovery(
  pi: ExtensionAPI,
  state: BridgeState,
  ctx: ExtensionContext,
): void {
  if (state.closed) {
    return;
  }
  try {
    registerHookHandlers(pi, state);
    if (state.lastSkipped.length > 0) {
      ctx.ui.notify(
        `scripting-bridge: skipped ${state.lastSkipped.length} file(s): ${state.lastSkipped
          .map((s) => `${s.name}: ${s.error}`)
          .join("; ")}`,
        "warning",
      );
    }
  } catch (err) {
    if (isStaleError(err)) {
      // Staleness after a session replacement: silent one-time teardown,
      // no error spam.
      teardownStale(state, ctx);
    }
  }
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
