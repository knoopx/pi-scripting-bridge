# session_before_switch

Fired before switching to another session. The handler can cancel the switch.

## When it fires

When the user or an extension requests a switch to a new or resumed session, before the switch is committed.

## Payload

| Field | Type | Description |
|---|---|---|
| `reason` | `"new" \| "resume"` | Whether the target is a new session or a resume |
| `targetSessionFile` | `string?` | The destination session file path |

## Result

Cancel short-circuit: the first handler returning `{ cancel: true }` stops the chain and cancels the switch. All other handlers pass through.

| Field | Type | Description |
|---|---|---|
| `cancel` | `boolean?` | Set `true` to cancel the switch |

## Use cases

- Gate session switches: block switching away from an active, unsaved session.
- Log which session the user is switching to.
- Run cleanup before a switch (flush buffers, release locks).
