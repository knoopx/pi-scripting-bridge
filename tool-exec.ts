/**
 * Tool execution: build the stdin payload (validated params with defaults
 * applied), run the tool script, and map its stdout JSON onto
 * AgentToolResult. Non-zero exit or invalid stdout JSON produces an error
 * result with the script stderr surfaced in `content`.
 */
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiscoveredTool } from "./discovery.js";
import type { ScriptExecResult } from "./script-exec.js";
import { runScript } from "./script-exec.js";

function buildToolPayload(
  def: DiscoveredTool,
  toolCallId: string,
  params: Record<string, unknown>,
): string {
  return JSON.stringify({
    toolCallId,
    params: applyDefaults(def, params),
  });
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
  toolTimeoutMs: number,
): Promise<AgentToolResult<unknown>> {
  const payload = buildToolPayload(def, toolCallId, params);

  return runScript(def.scriptPath, payload, {
    timeoutMs: toolTimeoutMs,
    signal,
    cwd: ctx?.cwd,
  }).then((res) => {
    if (res.timedOut) {
      return toolErrorResult(def.name, `timed out after ${toolTimeoutMs}ms`, res);
    }
    if (res.code !== 0) {
      return toolErrorResult(def.name, `exited with code ${res.code}`, res);
    }
    return mapToolOutput(def.name, res);
  });
}

function mapToolOutput(
  name: string,
  res: ScriptExecResult,
): AgentToolResult<unknown> {
  const trimmed = res.stdout.trim();
  if (trimmed.length === 0) {
    return toolErrorResult(name, "produced no JSON output on stdout", res);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return toolErrorResult(name, "produced invalid JSON on stdout", res);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return toolErrorResult(
      name,
      "stdout JSON must be an object mapping onto AgentToolResult",
      res,
    );
  }

  const p = parsed as Record<string, unknown>;
  if (!isValidContent(p.content)) {
    return toolErrorResult(
      name,
      "result is missing required 'content' (array of text content)",
      res,
    );
  }

  const result: AgentToolResult<unknown> = {
    content: p.content as AgentToolResult<unknown>["content"],
    details:
      typeof p.details === "object" && p.details !== null
        ? (p.details as unknown)
        : {},
  };
  if (typeof p.terminate === "boolean") {
    result.terminate = p.terminate;
  }
  if (Array.isArray(p.addedToolNames)) {
    result.addedToolNames = p.addedToolNames.filter(
      (n): n is string => typeof n === "string",
    );
  }
  return result;
}

function isValidContent(content: unknown): content is {
  type: "text" | "image";
}[] {
  return (
    Array.isArray(content) &&
    content.every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
  );
}

function toolErrorResult(
  name: string,
  reason: string,
  res: ScriptExecResult,
): AgentToolResult<unknown> {
  const detail = res.stderr.trim() || res.stdout.trim() || "";
  return {
    content: [
      {
        type: "text",
        text: detail
          ? `scripting-bridge: tool '${name}' ${reason}\n${detail}`
          : `scripting-bridge: tool '${name}' ${reason}`,
      },
    ],
    details: {
      error: reason,
      exitCode: res.code,
      killed: res.killed,
      timedOut: res.timedOut,
      stderr: res.stderr,
      stdout: res.stdout,
    },
  };
}
