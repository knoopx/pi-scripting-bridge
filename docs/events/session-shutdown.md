# session_shutdown

Fired before the extension runtime is torn down. The handler is the last chance to flush state.

## When it fires

When Pi is quitting, reloading (`/reload`), or replacing the current session (switch/fork). The `reason` field tells you which path is being taken.

## Payload

| Field | Type | Description |
|---|---|---|
| `reason` | `"quit" \| "reload" \| "new" \| "resume" \| "fork"` | Why the runtime is being torn down |
| `targetSessionFile` | `string?` | Destination session file when shutting down due to session replacement |

## Result

No result consumed. The handler runs for side effects (flush, cleanup) and its return value is discarded.

## Use cases

- Flush buffered logs or telemetry before the process exits.
- Release file locks, close database connections, or clean up temp files.
- Record session duration or final state before shutdown.
