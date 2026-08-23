# project_trust

Fired when the project trust state is first being determined for a working directory. An extension handler answers the trust decision; the bridge passes the combined result to the Pi runtime.

## When it fires

Once per session, before any project-specific configuration is loaded. The handler receives the working directory and decides whether the project is trusted.

## Payload

| Field | Type | Description |
|---|---|---|
| `cwd` | `string` | The working directory being trusted |

## Result

First-wins: the first handler that returns a defined `trusted` value wins.

| Field | Type | Description |
|---|---|---|
| `trusted` | `"yes" \| "no" \| "undecided"` | The trust decision |
| `remember` | `boolean?` | Whether to persist the decision |

## Use cases

- Auto-trust projects in a known list (e.g., a directory under `~/dev/`).
- Block untrusted projects from loading local settings.
- Log which projects are being opened and their trust status.
