# tool_result

Fired after a tool executes. The handler can modify the result before it enters the conversation.

## When it fires

After the tool has run and produced a result, before the result is added to the conversation.

## Payload

The event is a discriminated union by `toolName`. All variants share:

| Field | Type | Description |
|---|---|---|
| `toolCallId` | `string` | Unique identifier for this tool call |
| `toolName` | `string` | The tool that was called |
| `input` | `Record<string, unknown>` | The tool's input arguments |
| `content` | `(TextContent \| ImageContent)[]` | The tool's result content |
| `isError` | `boolean` | `true` when the tool execution failed |
| `details` | tool-specific \| `undefined` | Tool-specific result details |
| `usage` | `Usage?` | Usage from the tool execution itself, if available |

## Result

Field-wise merge: handlers run in sorted-filename order. For each key (`content`, `details`, `isError`, `usage`), the last handler that defines the key wins. Keys not defined by any handler pass through from the original result.

| Field | Type | Description |
|---|---|---|
| `content` | `(TextContent \| ImageContent)[]?` | Replacement result content |
| `details` | `unknown?` | Replacement tool-specific details |
| `isError` | `boolean?` | Override the error flag |
| `usage` | `Usage?` | Replacement usage data |

## Use cases

- Redact sensitive data from tool output (e.g., strip secrets from `bash` stdout).
- Truncate long tool results to save context.
- Enrich results with additional context (e.g., add a file path to a `grep` result).
- Convert error results into actionable suggestions.
