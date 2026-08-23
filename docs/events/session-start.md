# session_start

Fired when a session is started, loaded, or reloaded. The handler is invoked for side effects only; its return value is not consumed.

## When it fires

At the beginning of every session. The `reason` field tells you which path led here:

| Reason | Meaning |
|---|---|
| `startup` | Pi launched a fresh session |
| `reload` | The session was reloaded (e.g., after `/reload`) |
| `new` | A new session was created (previous session file is recorded) |
| `resume` | A previous session was resumed from disk |
| `fork` | A fork of an existing session was created |

## Payload

| Field | Type | Description |
|---|---|---|
| `reason` | `"startup" \| "reload" \| "new" \| "resume" \| "fork"` | Why the session started |
| `previousSessionFile` | `string?` | Previously active session file; present for `new`, `resume`, and `fork` |

## Result

No result consumed. The handler runs for side effects (logging, state initialization) and its return value is discarded.

## Use cases

- Initialize session-scoped state (timing counters, telemetry, logging).
- Detect fork vs. fresh start and adjust behavior.
- Record session provenance (which session this one was forked from).

## Multi-event binding

A hook's `event` field accepts a list, so one script can hook several events:
e.g. `event: [session_start, session_compact]` fires the handler both here and
after compaction (see `session_compact`). Session-start hooks that re-announce
context (agent protocols, session metadata) are commonly bound this way so they
re-run after a compaction that drops that context.
