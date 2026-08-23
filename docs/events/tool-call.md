# tool_call

Fired before a tool executes. The handler can block the call or modify arguments by mutating `event.input` in place.

## When it fires

When the model requests a tool call, before the tool runs. This is the primary guardrail event: it is where you intercept, inspect, and potentially block tool invocations.

`event.input` is mutable. Mutate it in place to patch tool arguments before execution. Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.

## Payload

The event is a discriminated union by `toolName`. All variants share:

| Field | Type | Description |
|---|---|---|
| `toolCallId` | `string` | Unique identifier for this tool call |
| `toolName` | `string` | The tool being called |
| `input` | `Record<string, unknown>` | The tool's input arguments (mutable) |

Built-in tools narrow automatically (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `powershell`); custom tools use the generic variant.

## Result

First-wins: the first handler that defines `block`, `reason`, or `terminate` wins. Later handlers are skipped for that key.

| Field | Type | Description |
|---|---|---|
| `block` | `boolean?` | Set `true` to block the tool call |
| `reason` | `string?` | Human-readable reason for blocking (shown to the user) |
| `terminate` | `boolean?` | Hint that the agent should stop after the current tool batch when this call is blocked |

## Use cases

- **Guardrails**: block `bash` calls that contain `rm -rf`, `curl | sh`, or other dangerous patterns.
- **Argument sanitization**: strip or replace sensitive values in tool arguments before execution.
- **Access control**: block file writes outside a designated directory.
- **Audit**: log every tool call for compliance.
