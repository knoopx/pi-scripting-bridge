/**
 * Shared constants and event taxonomy for the scripting-bridge extension.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SKILLS_ROOT = resolve(homedir(), ".pi/agent/skills");
export const HOOK_DEFAULT_TIMEOUT_MS = 10_000;
export const HOOK_MAX_TIMEOUT_MS = 300_000;
export const WATCH_DEBOUNCE_MS = 300;
/** Directory names skipped during the recursive skill walk. */
export const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * The 31 scripting-bridge-able Pi events. `message_update` (per-token,
 * awaited in the stream loop) and `tool_execution_update` (high-volume) are
 * intentionally excluded — they stay TS-only.
 */
export const BRIDGEABLE_EVENTS = [
  "project_trust",
  "resources_discover",
  "session_start",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
  "session_before_tree",
  "session_tree",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
  "tool_call",
  "tool_result",
  "user_bash",
  "input",
] as const;

export type BridgeableEvent = (typeof BRIDGEABLE_EVENTS)[number];

/**
 * Top-level directive keys that a hook may emit in its stdout JSON. The
 * bridge applies each in-process via the Extension API and strips the key
 * from the combined result so it never leaks into event result payloads.
 */
export const HOOK_DIRECTIVE_KEYS = ["setThinkingLevel", "sendMessage"] as const;

/**
 * The canonical `setThinkingLevel` directive levels; mirrors the levels
 * accepted by the Extension API's `setThinkingLevel` method.
 */
export const THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"] as const;

/**
 * Events whose hook results carry no return value: their handlers are
 * invoked for side effects only and always contribute `undefined`.
 */
export const NO_RESULT_EVENTS = new Set<BridgeableEvent>([
  "session_start",
  "session_info_changed",
  "session_compact",
  "session_shutdown",
  "session_tree",
  "before_provider_headers",
  "after_provider_response",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "tool_execution_start",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
]);
