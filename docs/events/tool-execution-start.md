# tool_execution_start

Fired when a tool starts executing. The handler is invoked for side effects only.

## When it fires

When the Pi runtime begins running a tool (after the model has requested it and the `tool_call` intercept point has passed).

## Payload

| Field | Type | Description |
|---|---|---|
| `toolCallId` | `string` | Unique identifier for this tool call |
| `toolName` | `string` | The tool being executed |
| `args` | `any` | The arguments passed to the tool |

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Log tool invocations (which tools are being called, with what arguments).
- Track tool usage frequency.
- Start a per-tool-call timer.
