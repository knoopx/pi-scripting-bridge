# message_start

Fired when a message starts (user, assistant, or toolResult). The handler is invoked for side effects only.

## When it fires

At the beginning of every message in the conversation. For assistant messages, this fires before streaming begins.

## Payload

| Field | Type | Description |
|---|---|---|
| `message` | `AgentMessage` | The message that is starting (role: `user`, `assistant`, or `toolResult`) |

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Track message lifecycle (start → end pairs).
- Start a streaming display or progress indicator for assistant messages.
- Set up per-message state (e.g., a timer for how long the assistant takes to respond).
