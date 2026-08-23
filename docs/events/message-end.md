# message_end

Fired when a message ends. The handler can replace the finalized message.

## When it fires

When a message is fully generated and finalized. For assistant messages, this is after streaming completes.

## Payload

| Field | Type | Description |
|---|---|---|
| `message` | `AgentMessage` | The finalized message |

## Result

Chaining, last wins: handlers run in sorted-filename order. Each can return `{ message: ... }` to replace the finalized message. The last handler that defines `message` wins. The replacement must keep the original message role.

| Field | Type | Description |
|---|---|---|
| `message` | `AgentMessage?` | Replacement message (must keep the original role) |

## Use cases

- Redact sensitive content from assistant messages before they're stored.
- Append a footer (e.g., a disclaimer or a source citation) to assistant messages.
- Transform tool result messages (e.g., truncate long output).
