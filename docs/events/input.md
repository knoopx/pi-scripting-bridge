# input

Fired when user input is received, before agent processing. The handler can continue, transform, or fully handle the input.

## When it fires

When the user submits input (typed, RPC, or from an extension), before the agent loop processes it.

## Payload

| Field | Type | Description |
|---|---|---|
| `text` | `string` | The input text |
| `images` | `ImageContent[]?` | Attached images, if any |
| `source` | `"interactive" \| "rpc" \| "extension"` | Where the input came from |
| `streamingBehavior` | `"steer" \| "followUp"?` | How the input will be delivered during streaming; `undefined` when idle |

## Result

Chaining, last wins: handlers run in sorted-filename order. The last handler that returns an `action` wins.

| Field | Type | Description |
|---|---|---|
| `action` | `"continue" \| "transform" \| "handled"` | `continue`: pass through unchanged. `transform`: replace `text` (and optionally `images`). `handled`: the extension fully handled the input; the agent loop does not process it |

## Use cases

- Transform user input (e.g., expand shorthand commands, normalize whitespace).
- Handle specific input patterns programmatically (e.g., `/compact` as a custom command).
- Route input based on its `source` (e.g., handle RPC input differently from typed input).
- Block or rewrite input that matches a sensitive pattern.
