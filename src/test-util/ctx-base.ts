/**
 * Shared base fields for the TUI-mode mock ExtensionContext used by
 * createMockCtx (mock-ctx.ts) and createPickerCtx (picker-ctx.ts). Both
 * contexts share an inert sessionManager/model/shutdown surface and a
 * ui.notify that records into a caller-provided array; keeping that surface
 * in one place (this module) lets the two builders supply only their unique
 * differences (the picker's ui.custom/pasteToEditor + mode/hasUI, and a
 * different session branch).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The notification records captured by a mock ctx's ui.notify. */
export type Notified = { msg: string; type?: string }[];

/** A session branch entry (sessionManager.getBranch). */
type SessionBranch = { id: string; type: string }[];

/** Default session branch: two message entries (fresh array per call). */
const defaultBranch = (): SessionBranch => [
  { id: "e1", type: "message" },
  { id: "e2", type: "message" },
];

/**
 * Build the shared TUI-mode ExtensionContext fields. `overrides` replaces any
 * top-level field after the base is built (e.g. a custom ui surface, mode,
 * hasUI, or shutdown hook); `sessionBranch` supplies sessionManager.getBranch.
 */
export function sharedCtx(
  cwd: string,
  notified: Notified,
  overrides: Partial<Record<keyof ExtensionContext, unknown>> = {},
  sessionBranch: () => SessionBranch = defaultBranch,
): ExtensionContext {
  const base = {
    ui: {
      notify: (msg: string, type?: "info" | "warning" | "error") => {
        notified.push({ msg, type });
      },
    },
    mode: "tui" as const,
    hasUI: true,
    cwd,
    sessionManager: {
      getCwd: () => cwd,
      getSessionDir: () => cwd,
      getSessionId: () => "sess-1",
      getSessionFile: () => "/tmp/sess-1.jsonl",
      getLeafId: () => "leaf-1",
      getLeafEntry: () => null,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getBranch: sessionBranch,
      buildContextEntries: () => [],
      getHeader: () => ({}),
      getEntries: () => [],
      getTree: () => ({}),
      getSessionName: () => "test",
    },
    modelRegistry: {},
    model: { id: "test-model" },
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => ({ tokens: 100, contextWindow: 200, percent: 50 }),
    compact: () => {},
    getSystemPrompt: () => "test system prompt",
  };
  return { ...base, ...overrides } as unknown as ExtensionContext;
}
