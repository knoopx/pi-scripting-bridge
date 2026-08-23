/**
 * JSON-safe fallback wrapper: run `fn` and return its value; on any throw,
 * return `null`. Used by the session/context payload builders (the command
 * and hook payloads) so a broken or unavailable session getter never crashes
 * payload construction — it just yields null.
 */
export function safe(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return null;
  }
}
