# session_before_compact

Fired before context compaction. The handler can cancel the compaction or customize what gets compacted.

## When it fires

Before the Pi runtime compacts the conversation context. The `reason` field tells you what triggered it: a manual `/compact`, the context threshold being hit, or an overflow recovery after an aborted turn.

## Payload

| Field | Type | Description |
|---|---|---|
| `preparation` | `CompactionPreparation` | Compaction preparation data (entries to summarize, etc.) |
| `branchEntries` | `SessionEntry[]` | The session entries being compacted |
| `customInstructions` | `string?` | Custom compaction instructions, if any |
| `reason` | `"manual" \| "threshold" \| "overflow"` | What triggered the compaction |
| `willRetry` | `boolean` | `true` when the aborted turn will be retried after compaction (overflow recovery) |
| `signal` | `AbortSignal` | Aborts if the session is interrupted during compaction |

## Result

Two-part combination:

1. **Cancel short-circuit**: the first handler returning `{ cancel: true }` stops the chain and cancels the compaction.
2. **`compaction` field**: the handler can provide a `CompactionResult` to replace the default compaction output.

| Field | Type | Description |
|---|---|---|
| `cancel` | `boolean?` | Set `true` to cancel the compaction |
| `compaction` | `CompactionResult?` | Custom compaction result to use instead of the default |

## Use cases

- Prevent compaction when the context is below a threshold you consider safe.
- Inject custom compaction instructions (e.g., "preserve all file paths and variable names").
- Log compaction events with the trigger reason.
- Skip compaction during overflow recovery when the retry will happen automatically.
