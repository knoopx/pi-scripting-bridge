# user_bash

Fired when the user executes a bash command via the `!` or `!!` prefix.

## When it fires

When the user types `! command` (included in LLM context) or `!! command` (excluded from LLM context) in the Pi input.

## Payload

| Field | Type | Description |
|---|---|---|
| `command` | `string` | The bash command to execute |
| `excludeFromContext` | `boolean` | `true` when `!!` was used (command is excluded from LLM context) |
| `cwd` | `string` | The current working directory |

## Result

First-wins: the first handler that defines `operations` or `result` wins.

| Field | Type | Description |
|---|---|---|
| `operations` | `BashOperations?` | Custom operations to use for execution |
| `result` | `BashResult?` | Full replacement: the extension handled execution, use this result |

## Use cases

- Intercept dangerous `!` commands (e.g., block `rm -rf /`).
- Run user bash commands in a sandboxed environment via custom `operations`.
- Log all user-initiated bash commands for audit.
