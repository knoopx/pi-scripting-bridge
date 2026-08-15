/**
 * Per-event hook result combination semantics: cancel short-circuit,
 * first-wins, chaining (last wins), field-wise merge, accumulation, and
 * replacement. Events in NO_RESULT_EVENTS contribute nothing.
 */
import {
  NO_RESULT_EVENTS,
  type BridgeableEvent,
} from "./constants.js";

export interface CombineOutcome {
  value: unknown;
  stop: boolean;
}

interface CombineInput {
  acc: unknown;
  value: Record<string, unknown>;
  eventObj: Record<string, unknown> | undefined;
}

type Combiner = (input: CombineInput) => CombineOutcome;

/** Continue the chain with the unchanged accumulator. */
function passthrough({ acc }: CombineInput): CombineOutcome {
  return { value: acc, stop: false };
}

/**
 * Cancel short-circuit: the first hook answering `{cancel: true}` stops the
 * chain; anything else passes the accumulator through.
 */
function cancelShortCircuit({ acc, value }: CombineInput): CombineOutcome {
  if (value.cancel === true) {
    return { value: { cancel: true }, stop: true };
  }
  return { value: acc, stop: false };
}

/**
 * First-defined wins per key: each listed key is merged as `acc ?? value`
 * only when the incoming value defines it.
 */
function mergeFirstDefined(
  keys: string[],
  { acc, value }: CombineInput,
): CombineOutcome {
  const a = (acc ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) {
      merged[key] = a[key] ?? value[key];
    }
  }
  return { value: merged, stop: false };
}

/** Arrays accumulate per key. */
function accumulateArrays(
  keys: string[],
  { acc, value }: CombineInput,
): CombineOutcome {
  const a = (acc ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const parts = [
      ...(Array.isArray(a[key]) ? (a[key] as unknown[]) : []),
      ...(Array.isArray(value[key]) ? (value[key] as unknown[]) : []),
    ];
    if (parts.length > 0) {
      merged[key] = parts;
    }
  }
  return { value: merged, stop: false };
}

/** Full-array replacement: chaining means last wins. */
function replaceWithInput({ value }: CombineInput): CombineOutcome {
  return { value, stop: false };
}

function combineBeforeAgentStart({ acc, value }: CombineInput): CombineOutcome {
  // Messages accumulate (first-defined kept; a single handler result
  // carries one message), systemPrompt chains (last-defined wins).
  const a = (acc ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  if (value.message !== undefined) {
    merged.message = a.message ?? value.message;
  }
  if (typeof value.systemPrompt === "string") {
    merged.systemPrompt = value.systemPrompt;
  }
  return { value: merged, stop: false };
}

function combineMessageEnd({ acc, value, eventObj }: CombineInput): CombineOutcome {
  // Chaining applies (last wins). The role must be preserved; a
  // replacement changing the role is dropped.
  if (
    value.message !== undefined &&
    eventObj?.message !== undefined &&
    typeof eventObj.message === "object" &&
    value.message !== null &&
    typeof value.message === "object"
  ) {
    const originalRole = (eventObj.message as { role?: unknown }).role;
    const newRole = (value.message as { role?: unknown }).role;
    if (originalRole !== undefined && newRole !== originalRole) {
      return { value: acc, stop: false };
    }
  }
  return { value, stop: false };
}

function combineUserBash({ acc, value }: CombineInput): CombineOutcome {
  // First non-undefined result wins; `operations` is not bridgeable.
  if (value.result === undefined) {
    return { value: acc, stop: false };
  }
  const { operations: _dropped, ...rest } = value;
  return { value: acc ?? { result: rest.result }, stop: true };
}

function combineInput({ acc, value }: CombineInput): CombineOutcome {
  // Transforms chain (last transform wins); "handled" fully suppresses
  // input and stops the chain.
  if (value.action === "handled") {
    return { value: { action: "handled" }, stop: true };
  }
  if (value.action === "transform") {
    return {
      value: {
        action: "transform",
        text: value.text,
        ...(value.images !== undefined ? { images: value.images } : {}),
      },
      stop: false,
    };
  }
  return { value: acc, stop: false };
}

function combineToolCall({ acc, value }: CombineInput): CombineOutcome {
  // First block wins; empty/passthrough results continue the chain.
  if (value.block !== true) {
    return { value: acc, stop: false };
  }
  return { value: { block: true, reason: value.reason }, stop: true };
}

function combineToolResult({ acc, value }: CombineInput): CombineOutcome {
  // Field-wise merge.
  return {
    value: mergeToolResult(acc as Record<string, unknown> | undefined, value),
    stop: false,
  };
}

function mergeToolResult(
  acc: Record<string, unknown> | undefined,
  v: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(acc ?? {}) };
  if (Array.isArray(v.content) || Array.isArray(acc?.content)) {
    out.content = [
      ...(Array.isArray(acc?.content) ? (acc!.content as unknown[]) : []),
      ...(Array.isArray(v.content) ? (v.content as unknown[]) : []),
    ];
  }
  if (
    typeof v.details === "object" &&
    v.details !== null &&
    !Array.isArray(v.details)
  ) {
    out.details = {
      ...((out.details as Record<string, unknown> | undefined) ?? {}),
      ...(v.details as Record<string, unknown>),
    };
  }
  if (v.isError === true || acc?.isError === true) {
    out.isError = true;
  }
  return out;
}

/**
 * Dispatch table: bridgeable event → combiner. Events absent from the
 * table (and from NO_RESULT_EVENTS) continue the chain unchanged.
 */
const COMBINERS: Partial<Record<BridgeableEvent, Combiner>> = {
  // First decisive answer wins.
  project_trust: ({ acc, value }) => ({ value: acc ?? value, stop: true }),
  // Arrays accumulate.
  resources_discover: ({ acc, value, eventObj }) =>
    accumulateArrays(
      ["skillPaths", "promptPaths", "themePaths"],
      { acc, value, eventObj },
    ),
  // The bridge exposes only `cancel` (compaction object not bridgeable).
  session_before_switch: cancelShortCircuit,
  session_before_compact: cancelShortCircuit,
  session_before_fork: ({ acc, value, eventObj }) =>
    mergeFirstDefined(["skipConversationRestore"], { acc, value, eventObj }),
  session_before_tree: ({ acc, value, eventObj }) =>
    mergeFirstDefined(
      ["summary", "customInstructions", "replaceInstructions", "label"],
      { acc, value, eventObj },
    ),
  context: replaceWithInput,
  // Any defined JSON return replaces the payload; chaining applies.
  before_provider_request: replaceWithInput,
  before_agent_start: combineBeforeAgentStart,
  message_end: combineMessageEnd,
  user_bash: combineUserBash,
  input: combineInput,
  tool_call: combineToolCall,
  tool_result: combineToolResult,
};

export function combineResult(
  event: BridgeableEvent,
  acc: unknown,
  value: Record<string, unknown>,
  eventObj: Record<string, unknown> | undefined,
): CombineOutcome {
  if (NO_RESULT_EVENTS.has(event)) {
    return { value: undefined, stop: false };
  }
  const combine = COMBINERS[event];
  if (combine === undefined) {
    return passthrough({ acc, value, eventObj });
  }
  return combine({ acc, value, eventObj });
}
