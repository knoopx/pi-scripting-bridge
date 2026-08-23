/**
 * Bridge-driving helpers for scripting-bridge tests. These boot the
 * extension against the current fixture tree (see fixtures.ts), fire session
 * events, and drive the registered tools/commands. They read the current
 * fixture's root + module via currentFixture(), so each test file's
 * beforeAll/afterAll (setupFixture/teardownFixture) works with them
 * unchanged.
 */

import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createMockCtx } from "./mock-ctx.js";
import { createMockPi, type MockPi } from "./mock-pi.js";
import { currentFixture } from "./fixtures.js";

/** Fire every registered handler for an event and return the last result. */
export function fireEvent(
  mock: MockPi,
  event: string,
  eventObj: unknown,
  ctx: ExtensionContext,
): unknown {
  const handlers = mock.events.get(event) ?? [];
  if (handlers.length === 0) {
    throw new Error(`no handlers registered for event '${event}'`);
  }
  let result: unknown;
  for (const handler of handlers) {
    result = handler(eventObj, ctx);
  }
  return result;
}

/** Poll `cond` (up to `ms`) until it holds, else throw. */
export async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Fire session_shutdown (reason "quit") on every registered handler. */
export function shutdownAll(mock: MockPi): void {
  const handlers = mock.events.get("session_shutdown") ?? [];
  for (const handler of handlers) {
    handler(
      { type: "session_shutdown", reason: "quit" },
      createMockCtx(currentFixture().fixtureRoot),
    );
  }
}

/**
 * Boot the extension against the current fixture skills tree, fire
 * session_start, and wait for `wait` to hold. Returns the mock plus the
 * handler ctx.
 */
export async function startBridge(
  wait: (mock: MockPi) => boolean,
): Promise<{ mock: MockPi; ctx: ExtensionContext }> {
  const mock = createMockPi();
  await currentFixture().extensionModule.default(mock.api);
  const ctx = createMockCtx(currentFixture().fixtureRoot, mock.notified);
  fireEvent(
    mock,
    "session_start",
    { type: "session_start", reason: "startup" },
    ctx,
  );
  await waitFor(() => wait(mock));
  return { mock, ctx };
}

/** Invoke the first registered handler of a hook event with the given ctx. */
export function fireFirstHandler(
  mock: MockPi,
  event: string,
  eventObj: unknown,
  ctx: ExtensionContext,
): Promise<unknown> {
  const handler = mock.events.get(event)![0] as (
    e: unknown,
    c: ExtensionContext,
  ) => Promise<unknown>;
  return handler(eventObj, ctx);
}

/** Execute a registered bridge tool with the given call id and params. */
export async function runTool(
  mock: MockPi,
  name: string,
  toolCallId: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
): Promise<unknown> {
  return mock.toolsByName
    .get(name)!
    .execute(toolCallId, params, null, null, ctx);
}

/**
 * Invoke a registered bridge command handler and return the sendMessage
 * calls it produced (the surfaced result). Fail-open: a broken handler
 * resolves without throwing and produces no sendMessage call.
 */
export async function runCommand(
  mock: MockPi,
  name: string,
  args: string,
  ctx: ExtensionContext,
): Promise<unknown[]> {
  const before = mock.sendMessageCalls.length;
  await mock.commandsByName
    .get(name)!
    .handler(args, ctx as unknown as ExtensionCommandContext);
  return mock.sendMessageCalls.slice(before);
}
