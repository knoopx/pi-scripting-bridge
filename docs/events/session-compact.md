# session_compact

Fired after context compaction succeeds. The handler is invoked for side effects only.

## When it fires

Immediately after the Pi runtime finishes compacting the conversation context.

## Payload

| Field | Type | Description |
|---|---|---|
| `compactionEntry` | `CompactionEntry` | The compaction entry that was created |
| `fromExtension` | `boolean` | `true` when the compaction content came from a `session_before_compact` handler |
| `reason` | `"manual" \| "threshold" \| "overflow"` | What triggered the compaction |
| `willRetry` | `boolean` | `true` when the aborted turn will be retried after compaction |

## Result

No result consumed. The handler runs for side effects (logging, state update) and its return value is discarded.

## Use cases

- Log compaction events with the trigger reason.
- Track how often compaction happens (a signal that context is growing too fast).
- Update external dashboards with compaction frequency.

## Multi-event binding

This is a `NO_RESULT` side-effect event and a natural second binding for
session-start hooks: `event: [session_start, session_compact]` re-fires a
session-start handler here, after a compaction drops the context it had
announced (agent protocols, session metadata).
