# before_agent_start

Fired after the user submits a prompt but before the agent loop starts. The handler receives the prompt, attached images, and the fully assembled system prompt.

## When it fires

Once per user prompt, after prompt expansion (template/skill command expansion) but before the agent loop begins processing.

## Payload

| Field | Type | Description |
|---|---|---|
| `prompt` | `string` | The raw user prompt text (after expansion) |
| `images` | `ImageContent[]?` | Images attached to the user prompt, if any |
| `systemPrompt` | `string` | The fully assembled system prompt string |
| `systemPromptOptions` | `BuildSystemPromptOptions` | Structured options used to build the system prompt |

## Result

Two-part combination:

1. **`message` first-defined**: the first handler that defines a `message` wins. One handler result carries one injected message.
2. **`systemPrompt` chains, last wins**: handlers run in order; each can return a replacement `systemPrompt`. The last defined value wins.

| Field | Type | Description |
|---|---|---|
| `message` | `{ customType, content, display, details }?` | A custom message to inject before the agent loop |
| `systemPrompt` | `string?` | Replacement system prompt for this turn |

## Use cases

- Inject a "context reminder" message (e.g., current file, recent changes) before the agent starts.
- Override the system prompt for a specific project or task type.
- Log the prompt and system prompt for audit.
