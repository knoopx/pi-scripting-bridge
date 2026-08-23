/**
 * Mock Pi surface for scripting-bridge tests: a stand-in ExtensionAPI whose
 * registerTool/registerCommand/registerShortcut/on/setActiveTools/... calls
 * are captured so tests can assert on discovery and execution. A `stale`
 * flag makes every api-surface call throw the SDK staleness assertion,
 * modeling a pi captured by a session that was replaced or reloaded.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface MockCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface MockShortcut {
  key: string;
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}

export interface MockTool {
  name: string;
  description: string;
  parameters: unknown;
  executionMode?: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | null | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
}

export interface MockPi {
  api: ExtensionAPI;
  tools: MockTool[];
  toolsByName: Map<string, MockTool>;
  commands: MockCommand[];
  commandsByName: Map<string, MockCommand>;
  shortcuts: Map<string, MockShortcut>;
  events: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
  active: Set<string>;
  activeSetCalls: string[][];
  notified: { msg: string; type?: string }[];
  /** When true, the api surface throws the SDK staleness assertion error. */
  stale: boolean;
  /** Levels passed to the api surface's setThinkingLevel, in call order. */
  thinkingCalls: string[];
  /** Messages passed to the api surface's sendMessage, in call order. */
  sendMessageCalls: unknown[];
  /** Entry renderers registered on the api surface (customType → renderer). */
  entryRenderers: Map<string, unknown>;
  /** appendEntry calls on the api surface, in call order. */
  appendEntryCalls: { customType: string; data: unknown }[];
}

export function createMockPi(): MockPi {
  const tools: MockTool[] = [];
  const toolsByName = new Map<string, MockTool>();
  const commands: MockCommand[] = [];
  const commandsByName = new Map<string, MockCommand>();
  const shortcuts = new Map<string, MockShortcut>();
  const events = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >();
  const active = new Set<string>();
  const activeSetCalls: string[][] = [];
  const notified: { msg: string; type?: string }[] = [];
  const thinkingCalls: string[] = [];
  const sendMessageCalls: unknown[] = [];
  const entryRenderers = new Map<string, unknown>();
  const appendEntryCalls: { customType: string; data: unknown }[] = [];

  const mock: MockPi = {
    api: null as unknown as ExtensionAPI,
    tools,
    toolsByName,
    commands,
    commandsByName,
    shortcuts,
    events,
    active,
    activeSetCalls,
    notified,
    stale: false,
    thinkingCalls,
    sendMessageCalls,
    entryRenderers,
    appendEntryCalls,
  };

  const guard = (): void => {
    if (mock.stale) {
      throw new Error(
        "This extension ctx is stale after session replacement or reload",
      );
    }
  };

  mock.api = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      guard();
      const list = events.get(event) ?? [];
      list.push(handler);
      events.set(event, list);
    },
    registerTool(tool: {
      name: string;
      description?: string;
      parameters?: unknown;
      executionMode?: string;
      execute: MockTool["execute"];
    }) {
      guard();
      const captured: MockTool = {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters,
        executionMode: tool.executionMode,
        execute: tool.execute.bind(tool),
      };
      tools.push(captured);
      toolsByName.set(tool.name, captured);
      active.add(tool.name);
    },
    getActiveTools: () => {
      guard();
      return [...active];
    },
    setActiveTools(names: string[]) {
      guard();
      activeSetCalls.push([...names]);
      for (const n of [...active]) {
        if (!names.includes(n)) active.delete(n);
      }
      for (const n of names) active.add(n);
    },
    setThinkingLevel(level: string) {
      guard();
      thinkingCalls.push(level);
    },
    sendMessage(msg: unknown) {
      guard();
      sendMessageCalls.push(msg);
    },
    registerEntryRenderer(customType: string, renderer: unknown) {
      guard();
      entryRenderers.set(customType, renderer);
    },
    appendEntry(customType: string, data?: unknown) {
      guard();
      appendEntryCalls.push({ customType, data });
    },
    registerCommand(name: string, options: { description?: string; handler: MockCommand["handler"] }) {
      guard();
      const captured: MockCommand = {
        name,
        description: options.description,
        handler: options.handler,
      };
      commands.push(captured);
      commandsByName.set(name, captured);
    },
    registerShortcut(shortcut: string, options: { description?: string; handler: MockShortcut["handler"] }) {
      guard();
      shortcuts.set(shortcut, {
        key: shortcut,
        description: options.description,
        handler: options.handler,
      });
    },
  } as unknown as ExtensionAPI;

  return mock;
}
