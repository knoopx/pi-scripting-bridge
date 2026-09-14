# scripting-bridge

scripting-bridge is a Pi extension that runs skills from the skills tree as Pi tools, event hooks, and slash commands. A skill is a Markdown file with YAML frontmatter plus a Nushell script — no TypeScript, no build step.

One recursive walk of the skills tree does all the registration. The frontmatter `type` field is the only discriminator — the file's directory does not matter:

| `type:` | registers as |
| --- | --- |
| `tool` | a Pi tool the model can call |
| `hook` | a handler for one (or several) bridgeable Pi events |
| `command` | a slash command the user invokes |
| `agent` | nothing — agent definitions are consumed by the `agent-spawn` tool ([Agent skills](#agent-skills)) |

## Install

The extension lives at `~/.pi/agent/extensions/scripting-bridge/`, which is Pi's global auto-discovery location. No install command, no settings entry — Pi loads `src/index.ts` (the `pi.extensions` entry in `package.json`) directly.

```bash
bun install
```

Runtime deps: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`, `yaml`. One environment variable: `PI_SCRIPTING_BRIDGE_SKILLS_ROOT` overrides the skills root (default `~/.pi/agent/skills`). The bridge has no config files of its own.

## Your first tool skill

Two files next to each other:

```
~/.pi/agent/skills/meta/tools/my-tool.md
~/.pi/agent/skills/meta/tools/my-tool.nu    # must be executable (chmod +x)
```

`my-tool.md`:

```yaml
name: my-tool
type: tool
description: Greets the caller.
command: ./my-tool.nu
parameters:
  who:
    type: string
    required: true
```

`my-tool.nu`:

```nushell
#!/usr/bin/env nu
def main [] {
    let payload = (^cat | from json)
    { content: [{ type: "text", text: $"hello ($payload.params.who)" }], details: { status: "ok" } }
    | to json
}
```

The model can now call `my-tool(who="pi")`. That is the whole contract:

- **stdin** — `{ "toolCallId", "params": {...}, "context": {...} }`, with `default` values applied to absent params.
- **stdout** — one JSON object: `content` (text array, required), `details` (optional, defaults to `{}`), `terminate` / `addedToolNames` (optional).
- **failure** — non-zero exit, empty stdout, invalid JSON, a non-object top level, or missing `content` makes the bridge throw; pi marks the result `isError: true` and the message carries the script output (same as pi's `bash` tool).
- **timeout** — none. A long-running tool runs until it completes.

Script convention: one `def main` per script. Nushell auto-invokes `main` when it spawns a script file — no trailing `main` call (double invocation) and no top-level `exit`. `main`'s final expression is the payload; a hook no-op is `main` returning `null` (empty stdout).

## Tool skills

Frontmatter fields:

| field | required | notes |
| --- | --- | --- |
| `type` | yes | `tool` |
| `name` | no | falls back to the `.md` basename (lowercased, spaces → underscores). Duplicate names skip — first file wins, the skip is reported |
| `description` | yes | shown to the model |
| `command` | yes | absolute, or relative to the skill file's directory (never the process cwd). Trailing tokens become positional args: `command: ../../meta/tools/agent-spawn.nu duckdb-engineer` spawns `agent-spawn.nu` with argv `["duckdb-engineer"]` |
| `parameters` | no | name → `{ type: string|number|boolean|array, required, default, ... }`; JSON-Schema constraints pass through |
| `executionMode` | no | `"sequential"` \| `"parallel"` (default). Invalid values silently fall back to `"parallel"` |

`command` must resolve to an existing executable script, or the bridge skips the skill and reports the skip — except for `type: command`, where an unresolvable `command` becomes a command template ([Command skills](#command-skills)).

## Hook skills

Frontmatter fields:

| field | required | notes |
| --- | --- | --- |
| `type` | yes | `hook` |
| `name` | no | falls back to the file stem |
| `event` | yes | one bridgeable event, or a list — a multi-event hook. Duplicates are dropped, first-seen order kept; the first entry is the primary event (run-order sort key) |
| `command` | yes | same resolution rules as tool skills |
| `timeout` | no | milliseconds; default 10000, clamped to [1, 300000] |

The bridgeable events:

```
project_trust resources_discover session_start session_info_changed
session_before_switch session_before_fork session_before_compact
session_compact session_shutdown session_before_tree session_tree
context before_provider_request before_provider_headers
after_provider_response before_agent_start agent_start agent_end
agent_settled turn_start turn_end message_start message_end
tool_execution_start tool_execution_end model_select
thinking_level_select tool_call tool_result user_bash input
```

Each event has a documentation page under [docs/events/](docs/events/) — when it fires, its payload fields, its result-combination semantics, and use cases (grounded in the pi-coding-agent `types.d.ts` event interfaces). `message_update` and `tool_execution_update` are excluded on purpose and stay TS-only.

I/O contract:

- **stdin** — `{ "event": {...}, "context": {...} }`, sanitized before serialization (non-finite numbers, functions, cycles, and undefineds are dropped).
- **stdout** — a JSON result, or nothing. Empty output is a no-op.
- **several hooks, one event** — they run in deterministic order (primary event, then file path) and the bridge combines their results per the event's semantics:

| semantics | events |
| --- | --- |
| cancel short-circuit | `session_before_switch`, `session_before_compact` |
| first-defined wins per key | `session_before_fork`, `session_before_tree` |
| first-wins | `project_trust`, `user_bash`, `tool_call` |
| chaining, last wins | `context`, `before_provider_request`, `message_end`, `input` |
| `message` first-defined, `systemPrompt` last-wins | `before_agent_start` |
| accumulation | `resources_discover` |
| field-wise merge | `tool_result` |
| result not consumed | everything else |

- **failure** — a hook failure (non-zero exit, invalid JSON, timeout) is logged and treated as a no-op (fail-open).

## Command skills

Frontmatter fields:

| field | required | notes |
| --- | --- | --- |
| `type` | yes | `command` |
| `name` | yes | the slash name, invoked as `/name` |
| `description` | no | |
| `command` | yes | a handler script — or, when it does not resolve to a file, an **executable command template** |
| `shortcut` | no | a pi-tui keybinding (e.g. `ctrl+p`); absent or invalid → no key binding, the command still registers |
| `parameters` | no | same format as tool skills; their `default` values are applied into `params` |
| `picker` | no | item-picker config ([Item picker](#item-picker)) |

A template `command` (a command string that is not a file) is spawned directly via Node `child_process` when a picker item is selected — no shell, with `{field}` placeholders interpolated from the focused item's fields.

I/O contract:

- **stdin** — `{ "command": "<name>", "params": { ...defaults, "args": "<raw argument string>" }, "context": { sessionId, sessionFile, cwd, tui } }`. `context.tui` is true only when a TUI is present — the flag that tells the handler the picker overlay is available.
- **stdout** — one JSON object. `content` (text array) is surfaced to the user as a TUI notification: command output is for the user, never injected into the conversation. An optional top-level `pick` field launches the item picker.
- **failure** — a handler error, empty stdout, or invalid JSON surfaces as a user-visible warning and the command returns. It never crashes pi.

## Item picker

The `pick` field of a command's stdout:

```json
{ "content": [{ "type": "text", "text": "Stashed sessions: 8 — pick one (--all restores all)" }],
  "pick": { "title": "Unstash session",
            "items": [ { "id": "01a038cc-09d8-7eae-96c3-c27e703bbf09", "label": "~/.pi", "rel_time": "38m" } ],
            "open": true,
            "actions": [ { "shortcut": "enter", "effect": "run", "args": "{id}" } ] } }
```

Rules:

- Items need `id` + `label` (strings); items missing either are dropped silently. Extra string fields become columns.
- `title` is optional (default: the command name).
- `open: true` opens the picker even with zero items; without it, zero items → `pick` is ignored.
- A non-empty payload `actions` list replaces the base picker actions; absent or empty → base config.
- In TUI mode the overlay (95% width, centered) mounts before the text notification fires: type to filter, arrows/page keys move focus, the footer lists the bound keys.

The `picker` frontmatter block configures the picker:

```yaml
picker:
  title: "Unstash session"
  columns:                      # first entry is the primary column
    - field: rel_time
    - field: hint
      width: 12                 # visible width in columns (auto-sized when absent)
      align: right              # left (default) | right
  actions:
    - shortcut: enter
      effect: run               # run the current command with the args template
      args: "{id}"
    - shortcut: ctrl+a
      label: "restore all"      # help-line label (default: "select" for enter, else the effect name)
      effect: run
      args: "--all"
  split: true                   # two-pane picker: list left, preview right
  splitWidth: 0.4               # left-pane share of terminal width, (0, 1]; default 0.28
  previewCommand: cat {path}  # /bin/sh -c command, {field} interpolated; stdout renders in the preview pane
```

- `columns` — required `field`; optional `width` (floored), `align`, `style`, `focusedStyle`. Invalid entries are dropped, valid siblings kept; a fully invalid list yields the default `{field: "label"}` column.
- `actions` — a valid `shortcut` keybinding plus an `effect`: `paste` (string `text`/`label`) or `run` (string `command`/`args`/`label`). A cross-effect field (or a leftover `key` field) invalidates the entry; siblings are kept.
- `{field}` placeholders in `args`, `text`, and `previewCommand` interpolate from the focused item. Effects:
  - `paste` — inserts the interpolated text into the pi editor, closes the picker.
  - `run` — runs a bridge-registered command (optional `command` field; absent = the current command) with the interpolated `args`. For a template command, the selected item is spawned through the template.
  - `cancel` — closes the picker (hardcoded escape action, not a configured effect).
- No `picker` block → zero-config defaults: command name as title, single `label` column, `enter`/`tab` → `paste`, `escape` → cancel.

Live example: `unstash-session` under `~/.pi/agent/skills/meta/commands/` — bare TUI invocation opens the picker; enter restores one session, `ctrl+a` restores all.

The whole path fails open both ways: in non-TUI modes, or with empty/invalid `items` (and no `open: true`), only the text notification shows; a picker launch or action failure is logged (an effect failure leaves the picker open) and the text output is preserved.

## Directives

Top-level stdout keys the bridge acts on, then strips from the payload — they never reach the model, the event payload, or user-surfaced text:

| directive | tool | hook | command | effect |
| --- | --- | --- | --- | --- |
| `terminateSession: true` | ✓ | ✓ (incl. no-result events) | ✓ | ends the session in-process (`process.exit(0)` after a visibility line). The exact boolean `true`; any other value is ignored |
| `setThinkingLevel` | | ✓ | | one of `off|minimal|low|medium|high|xhigh|max`; also honored on no-result events |
| `sendMessage` | | ✓ | ✓ | sends a message to the session |
| `notify` | | ✓ | | a TUI notification: a plain string (info) or `{ "message", "type": "info|warning|error", "persistent": true }`. `persistent: true` appends a `bridge-status` chat entry that survives later status lines |

A hook is silent by default: no toast for a no-op, no visible line for a plain chain contribution. What the user sees: a warning line for a hook failure, and the directives' own surfaces (`notify`'s line, a persistent `bridge-status` entry).

## Agent skills

`type: agent` files (an agent's `SYSTEM.md` under `<domain>/agents/<name>/`) are ignored by the discovery walk. They are invoked through the `agent-spawn` tool (`~/.pi/agent/skills/meta/tools/agent-spawn.nu`): you call it with an agent name and a task; it resolves the agent's `SYSTEM.md`, reads its `exclude-tools` and `protocols` frontmatter, and spawns the child pi session in a new kitty tab with the frontmatter body plus a protocols block as the system prompt. Delegation depth is capped at 2 (`PI_DELEGATION_CHAIN`).

## Live reload

The bridge watches the skills root recursively: 300 ms debounce, fingerprint-based re-registration (content hash + script path — untouched files are skipped), removed tools dropped, hook subscriptions refreshed in place. The walk skips `node_modules`, `.git`, and dot-directories. Skipped files (missing script, missing description, duplicate tool name, non-bridgeable event) surface as warnings at session start. In normal use you edit a skill file and the change just takes effect — Pi's `/reload` re-loads the extension itself, which you rarely need.

## Development

No build step. From the scripting-bridge directory:

```bash
bun run test   # vitest suite, v8 coverage -> coverage/
bun run tsc    # typecheck (tsc --noEmit)
```

The test suite runs the extension against a mocked Pi API and a fixture skills tree pointed at via `PI_SCRIPTING_BRIDGE_SKILLS_ROOT`.
