# turn_end

Fired at the end of each turn in the agent loop. The handler receives the turn's final message and tool results.

## When it fires

When a turn completes: the model has generated its response and all tool calls in that turn have finished.

## Payload

| Field | Type | Description |
|---|---|---|
| `turnIndex` | `number` | Zero-based turn index within the agent run |
| `message` | `AgentMessage` | The assistant message that ended the turn |
| `toolResults` | `ToolResultMessage[]` | Tool results from this turn (empty if no tools were called) |

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Analyze turn outcomes (did the agent make progress or stall?).
- Log tool usage per turn.
- Track how many turns a task takes to complete.
