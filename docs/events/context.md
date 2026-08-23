# context

Fired before each LLM call. The handler can modify the message array that will be sent to the model.

## When it fires

Every time the Pi runtime is about to send a conversation to the LLM. This is the last hook point before the request leaves the process.

## Payload

| Field | Type | Description |
|---|---|---|
| `messages` | `AgentMessage[]` | The full message array (system prompt + conversation) |

## Result

Chaining, last wins: handlers run in sorted-filename order. Each handler can return `{ messages: [...] }` to replace the array. The last handler that defines `messages` wins.

| Field | Type | Description |
|---|---|---|
| `messages` | `AgentMessage[]?` | Replacement message array |

## Use cases

- Inject project-specific context (conventions, file structure) into every LLM call.
- Redact sensitive information (API keys, personal data) before it reaches the model.
- Add a "memory" message that persists across turns.
- Limit conversation length by truncating old messages.
