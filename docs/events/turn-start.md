# turn_start

Fired at the start of each turn in the agent loop.

## When it fires

At the beginning of every turn. A turn is one iteration of the agent loop: the model generates a response, tools are called, and the results are fed back.

## Payload

| Field | Type | Description |
|---|---|---|
| `turnIndex` | `number` | Zero-based turn index within the agent run |
| `timestamp` | `number` | Unix timestamp (ms) when the turn started |

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Track turn progression (how many turns the agent is on).
- Update a progress indicator.
- Inject per-turn state (e.g., a "you are on turn 5" reminder).
