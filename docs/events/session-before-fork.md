# session_before_fork

Fired before forking a session. The handler can cancel the fork or skip conversation restore.

## When it fires

When a session fork is requested, before the fork is created.

## Payload

| Field | Type | Description |
|---|---|---|
| `entryId` | `string` | The session entry to fork from |
| `position` | `"before" \| "at"` | Whether the fork branches before or at the entry |

## Result

Two-part combination:

1. **Cancel short-circuit**: the first handler returning `{ cancel: true }` stops the chain and cancels the fork.
2. **First-defined wins per key**: `skipConversationRestore` — the first handler that defines it wins.

| Field | Type | Description |
|---|---|---|
| `cancel` | `boolean?` | Set `true` to cancel the fork |
| `skipConversationRestore` | `boolean?` | Skip restoring the conversation history into the fork |

## Use cases

- Prevent forking a session that has sensitive context.
- Log fork events for audit trails.
- Skip conversation restore when forking for a clean-slate experiment.
