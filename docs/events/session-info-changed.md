# session_info_changed

Fired when the current session's metadata changes. In practice this fires when the session name is set or cleared.

## When it fires

Whenever the normalized session name changes. The `name` field is `undefined` when the name is cleared.

## Payload

| Field | Type | Description |
|---|---|---|
| `name` | `string \| undefined` | The current normalized session name; `undefined` when cleared |

## Result

No result consumed. The handler runs for side effects only.

## Use cases

- React to session renaming (update external labels, log the change).
- Track naming conventions or enforce naming rules.
- Update a UI badge or status line that shows the session name.
