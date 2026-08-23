# thinking_level_select

Fired when a new thinking level is selected.

## When it fires

When the thinking level changes (via the `setThinkingLevel` directive or user interaction). The `level` values are: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

## Payload

| Field | Type | Description |
|---|---|---|
| `level` | `ThinkingLevel` | The newly selected thinking level |
| `previousLevel` | `ThinkingLevel` | The thinking level before the change |

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Log thinking level changes.
- Adjust output expectations (higher thinking levels produce longer reasoning).
- Update a UI indicator showing the current thinking level.
