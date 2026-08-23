# agent_end

Fired when an agent loop ends. The handler receives the messages from the run.

## When it fires

When the agent loop completes (all queued messages processed, no further turns pending).

## Payload

| Field | Type | Description |
|---|---|---|
| `messages` | `AgentMessage[]` | The messages from the agent run |

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Summarize what the agent did in this run.
- Persist run results (messages, tool calls) to an external store.
- Trigger a post-run action (e.g., send a notification when the agent finishes).
