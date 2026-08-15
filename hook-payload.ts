/**
 * Hook payload building: JSON-safe sanitization of event objects and the
 * extension context, which together form the {"event", "context"} stdin
 * payload handed to every hook script.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Strip JSON-hostile values: non-finite numbers become null, circular
 * references and functions/undefined are dropped (arrays are compacted).
 */
function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  if (seen.has(value as object)) {
    return undefined;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value
      .map((v) => sanitize(v, seen))
      .filter((v) => v !== undefined);
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "function" || v === undefined) {
      continue;
    }
    const s = sanitize(v, seen);
    if (s !== undefined) {
      out[k] = s;
    }
  }
  return out;
}

export function serializeForJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(sanitize(value, new WeakSet())));
  } catch {
    return null;
  }
}

export function buildContextPayload(
  ctx: ExtensionContext,
): Record<string, unknown> {
  const safe = (fn: () => unknown): unknown => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  return {
    cwd: ctx.cwd,
    mode: ctx.mode,
    hasUI: ctx.hasUI,
    sessionManager: buildSessionManagerPayload(ctx, safe),
    model: safe(() => (ctx.model as { id?: string } | undefined)?.id ?? null),
    hasSignal: ctx.signal !== undefined && ctx.signal !== null,
    isProjectTrusted: safe(() => ctx.isProjectTrusted()),
    contextUsage: safe(() => ctx.getContextUsage() ?? null),
    systemPrompt: safe(() => ctx.getSystemPrompt() ?? null),
  };
}

function buildSessionManagerPayload(
  ctx: ExtensionContext,
  safe: (fn: () => unknown) => unknown,
): unknown {
  const s = ctx.sessionManager as unknown as Record<string, unknown>;
  const branch = safe(() => (s.getBranch as () => unknown[])()) as
    | unknown[]
    | null;
  return {
    sessionId: safe(() => (s.getSessionId as () => string)()),
    sessionFile: safe(() => (s.getSessionFile as () => string)()),
    cwd: safe(() => (s.getCwd as () => string)()),
    leafId: safe(() => (s.getLeafId as () => string)()),
    branchEntryCount: Array.isArray(branch) ? branch.length : null,
  };
}
