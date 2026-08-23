# tool_execution_end

Fired when a tool finishes executing. The handler is invoked for side effects only.

## When it fires

When the Pi runtime completes a tool execution, with the result and error status.

## Payload

| Field | Type | Description |
|---|---|---|
| `toolCallId` | `string` | Unique identifier for this tool call |
| `toolName` | `string` | The tool that was executed |
| `result` | `any` | The tool's result |
| `isError` | `boolean` | `true` when the tool execution failed |

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Track tool success/failure rates.
- Log tool execution duration (pair with `tool_execution_start`).
- Flag failed tools for review.
