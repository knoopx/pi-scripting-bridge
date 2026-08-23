# resources_discover

Fired after `session_start` to allow extensions to register additional resource paths (skills, prompts, themes) that Pi should load.

## When it fires

Immediately after `session_start`, once per session. The `reason` field distinguishes a fresh startup from a `/reload`.

## Payload

| Field | Type | Description |
|---|---|---|
| `cwd` | `string` | The working directory |
| `reason` | `"startup" \| "reload"` | Why discovery is running |

## Result

Accumulation: all handlers' path arrays are concatenated per key. Every handler can contribute additional paths; they are all loaded.

| Field | Type | Description |
|---|---|---|
| `skillPaths` | `string[]?` | Additional skill directories |
| `promptPaths` | `string[]?` | Additional prompt template paths |
| `themePaths` | `string[]?` | Additional theme paths |

## Use cases

- Register a project-local skills directory in addition to the global one.
- Load custom prompt templates from a per-project path.
- Add a user-specific theme directory.
