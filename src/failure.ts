/**
 * Shared failure-handling helpers for the scripting-bridge execution paths:
 * staleness detection, user-visible failure logging, the pi.sendMessage
 * directive application core, and content-entry validation. Used by the
 * tool, command, and hook bridges.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** True when an error is the SDK's staleness assertion (context replaced). */
export function isStaleError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("stale");
}

/**
 * User-visible failure line: a best-effort TUI warning only — no console
 * output (the console.error line was removed). A missing ctx.ui (some
 * contexts) never crashes the fail-open path.
 */
export function logFailure(
  message: string,
  ctx?: ExtensionContext,
): void {
  try {
    ctx?.ui?.notify(message, "warning");
  } catch {
    // Notification is best-effort.
  }
}

/**
 * Send a validated `sendMessage` directive value via pi.sendMessage. This is
 * the shared core of the directive handling across the command and hook
 * paths. When the send throws a staleness error, `onStale` is invoked and
 * true is returned (the caller decides its teardown semantics: the command
 * path stops surfacing, the hook path tears the instance down). Any other
 * send failure is logged as a warning via logFailure and false is returned.
 * A successful send returns false.
 */
export function runSendMessage(
  pi: ExtensionAPI,
  msg: object,
  label: string,
  ctx: ExtensionContext | undefined,
  onStale: () => void,
): boolean {
  try {
    pi.sendMessage(msg as Parameters<ExtensionAPI["sendMessage"]>[0]);
    return false;
  } catch (err) {
    if (isStaleError(err)) {
      onStale();
      return true;
    }
    logFailure(
      `${label}: sendMessage failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      ctx,
    );
    return false;
  }
}

/**
 * Validate one content entry: a non-null object that is either a text entry
 * (a string `text`) or an image entry. Shared across the tool and command
 * execution paths.
 */
export function isContentEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const c = entry as { type?: unknown; text?: unknown };
  if (c.type === "image") {
    return true;
  }
  return c.type === "text" && typeof c.text === "string";
}