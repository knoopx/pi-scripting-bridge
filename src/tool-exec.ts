/**
 * Tool execution: build the stdin payload (validated params with defaults
 * applied), run the tool script, and map its stdout JSON onto
 * AgentToolResult. Non-zero exit, empty stdout, invalid stdout JSON, or
 * non-object JSON THROW, mirroring the pi `bash` tool so the pi core marks
 * the result `isError=true` (the message carries the script output plus the
 * exit-code status).
 */
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { DiscoveredTool } from "./discovery.js";
import type { ScriptExecResult } from "./script-exec.js";
import { runScript } from "./script-exec.js";
import { buildContextPayload } from "./hook-payload.js";
import { isContentEntry, isStaleError, logFailure } from "./failure.js";

/**
 * User-visible line appended to a tool result when its `terminateSession`
 * directive is applied, so the shutdown is never a silent exit.
 */
const TERMINATE_SESSION_NOTICE =
  "scripting-bridge: terminateSession directive applied (pi shutdown initiated)";

function buildToolPayload(
  def: DiscoveredTool,
  toolCallId: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext | undefined,
): string {
  const payload: Record<string, unknown> = {
    toolCallId,
    params: applyDefaults(def, params),
  };
  if (ctx) {
    payload.context = buildContextPayload(ctx);
  }
  return JSON.stringify(payload);
}

function applyDefaults(
  def: DiscoveredTool,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(def.defaults)) {
    if (out[key] === undefined && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function executeTool(
  def: DiscoveredTool,
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext | undefined,
): Promise<AgentToolResult<unknown>> {
  const payload = buildToolPayload(def, toolCallId, params, ctx);

  return runScript(def.scriptPath, payload, {
    // Tools have no timeout; the script runs to completion.
    timeoutMs: 0,
    signal,
    cwd: ctx?.cwd,
    args: def.args,
  }).then((res) => {
    if (res.code === null) {
      throw new Error(
        `tool '${def.name}' was killed (${res.signal}) before emitting JSON`,
      );
    }
    if (res.code !== 0) {
      const detail = res.stderr.trim() || res.stdout.trim() || "";
      const status = `Command exited with code ${res.code}`;
      throw new Error(detail ? `${detail}\n\n${status}` : status);
    }
    const trimmed = res.stdout.trim();
    if (trimmed.length === 0) {
      const stderr = res.stderr.trim();
      throw new Error(
        `tool '${def.name}' produced no JSON output on stdout` +
          (stderr ? ` (stderr: ${stderr.slice(0, 500)})` : " (no stderr output)"),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`tool '${def.name}' produced invalid JSON on stdout`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `tool '${def.name}' stdout JSON must be an object mapping onto AgentToolResult`,
      );
    }
    return mapToolOutput(def.name, res, ctx);
  });
}

function mapToolOutput(
  name: string,
  res: ScriptExecResult,
  ctx: ExtensionContext | undefined,
): AgentToolResult<unknown> {
  const trimmed = res.stdout.trim();
  if (trimmed.length === 0) {
    const stderr = res.stderr.trim();
    throw new Error(
      `tool '${name}' produced no JSON output on stdout` +
        (stderr ? ` (stderr: ${stderr.slice(0, 500)})` : " (no stderr output)"),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`tool '${name}' produced invalid JSON on stdout`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `tool '${name}' stdout JSON must be an object mapping onto AgentToolResult`,
    );
  }

  const p = parsed as Record<string, unknown>;
  if (!isValidContent(p.content)) {
    throw new Error(
      `tool '${name}' result is missing required 'content' (array of text content)`,
    );
  }

  const result: AgentToolResult<unknown> = {
    content: p.content as AgentToolResult<unknown>["content"],
    details:
      typeof p.details === "object" && p.details !== null ? p.details : {},
  };
  if (typeof p.terminate === "boolean") {
    result.terminate = p.terminate;
  }
  if (Array.isArray(p.addedToolNames)) {
    result.addedToolNames = p.addedToolNames.filter(
      (n): n is string => typeof n === "string",
    );
  }

  // terminateSession directive: honored only when the top-level key is the
  // exact boolean `true`. The key is never copied into the result (content,
  // details, terminate and addedToolNames are the only mapped fields), so it
  // is structurally stripped and cannot leak to the LLM. Any other value is
  // invalid: the directive is ignored (no shutdown) and the normal result is
  // kept.
  if (p.terminateSession === true) {
    applyTerminateSession(name, ctx, result);
  }
  return result;
}

/**
 * Apply the tool's `terminateSession` directive: append the user-visible
 * notice to the result content, call ctx.shutdown() in-process (a stale
 * context is a silent no-op; any other error is surfaced as a warning and the
 * result still returns, fail-open), and notify best-effort. The directive key
 * never reaches the returned result, so the LLM only sees the visibility line.
 */
export function applyTerminateSession(
  name: string,
  ctx: ExtensionContext | undefined,
  result: AgentToolResult<unknown>,
): void {
  // Make the execution visible to the agent: the notice is appended to the
  // result content so the termination is never a silent exit.
  result.content.push({ type: "text", text: TERMINATE_SESSION_NOTICE });

  try {
    // NOTE: ctx.shutdown(); is not the right approach, doesn't immediately terminate the session and the agent gets another turn to reply with another random gibberish message that misses the full final response details
    process.exit(0);
  } catch (err) {
    if (isStaleError(err)) {
      // A stale context can no longer honor the shutdown request; the instance
      // is already terminal. Fail-open: the result still returns.
      return;
    }
    const message = `scripting-bridge: tool '${name}' terminateSession failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logFailure(message, ctx);
    return;
  }
}

function isValidContent(content: unknown): content is {
  type: "text" | "image";
}[] {
  return Array.isArray(content) && content.every(isContentEntry);
}
