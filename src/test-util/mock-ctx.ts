/**
 * Mock ExtensionContext for scripting-bridge tests: a TUI-mode context whose
 * sessionManager/model/shutdown surfaces are inert stubs and whose ui.notify
 * records into a caller-provided array. The shared surface lives in
 * ctx-base.ts (sharedCtx); this builder only supplies the optional shutdown
 * hook. Used by the bridge helpers (via the current fixture root) and
 * directly by tests that build a bespoke root.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sharedCtx, type Notified } from "./ctx-base.js";

export function createMockCtx(
  cwd: string,
  notified?: Notified,
  shutdown?: () => void,
): ExtensionContext {
  return sharedCtx(cwd, notified ?? [], {
    shutdown: shutdown ?? (() => {}),
  });
}
