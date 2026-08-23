# session_tree

Fired after navigating in the session tree. The handler is invoked for side effects only.

## When it fires

Immediately after the Pi runtime commits a tree navigation.

## Payload

| Field | Type | Description |
|---|---|---|
| `newLeafId` | `string \| null` | The new leaf after navigation |
| `oldLeafId` | `string \| null` | The leaf before navigation |
| `summaryEntry` | `BranchSummaryEntry?` | The branch summary entry created by the navigation, if any |
| `fromExtension` | `boolean?` | `true` when the summary came from a `session_before_tree` handler |

## Result

No result consumed. The handler runs for side effects (logging, state update) and its return value is discarded.

## Use cases

- Log tree navigation events.
- Track which branch the session is on.
- Update external state about the session's position in the tree.
