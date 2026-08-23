# session_before_tree

Fired before navigating in the session tree. The handler can cancel the navigation or customize the branch summary.

## When it fires

When the user navigates the session tree (jumping to a different branch), before the navigation is committed.

## Payload

| Field | Type | Description |
|---|---|---|
| `preparation` | `TreePreparation` | Navigation preparation data (see below) |
| `signal` | `AbortSignal` | Aborts if the session is interrupted |

`TreePreparation` fields:

| Field | Type | Description |
|---|---|---|
| `targetId` | `string` | The tree node to navigate to |
| `oldLeafId` | `string \| null` | The current leaf before navigation |
| `commonAncestorId` | `string \| null` | The common ancestor of old and new leaves |
| `entriesToSummarize` | `SessionEntry[]` | Entries that will be summarized into a branch entry |
| `userWantsSummary` | `boolean` | Whether the user requested a summary |
| `customInstructions` | `string?` | Custom summarization instructions |
| `replaceInstructions` | `boolean?` | If `true`, custom instructions replace the default prompt |
| `label` | `string?` | Label to attach to the branch summary entry |

## Result

Two-part combination:

1. **Cancel short-circuit**: the first handler returning `{ cancel: true }` stops the chain and cancels the navigation.
2. **First-defined wins per key**: `summary`, `customInstructions`, `replaceInstructions`, `label` — the first handler that defines each field wins.

| Field | Type | Description |
|---|---|---|
| `cancel` | `boolean?` | Set `true` to cancel the navigation |
| `summary` | `{ summary, details?, usage? }?` | Pre-computed branch summary to use instead of generating one |
| `customInstructions` | `string?` | Override summarization instructions |
| `replaceInstructions` | `boolean?` | Override whether instructions replace the default prompt |
| `label` | `string?` | Override the branch summary label |

## Use cases

- Provide a pre-computed summary when navigating to a known branch (avoids re-summarizing).
- Gate navigation to branches that contain sensitive context.
- Attach custom labels to branch summaries.
