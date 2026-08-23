# scripting-bridge

scripting-bridge (v1.0.0) is a Pi extension. It runs executable skills from the skills tree as Pi tools and event handlers over a stdin/stdout JSON protocol. A recursive walk of the skills tree registers `type: tool` skills as Pi tools, `type: hook` skills as handlers for Pi events, and `type: command` skills as user-invocable slash commands. You author skills as Markdown plus a script file instead of TypeScript.

## Install

The scripting-bridge lives at `~/.pi/agent/extensions/scripting-bridge/`, which is Pi's global auto-discovery location. Pi finds it on its own, so there is no install command and no settings entry. `package.json` declares the entry point through the `pi.extensions` manifest:

```json
{ "pi": { "extensions": ["./src/index.ts"] } }
```

Pi loads `src/index.ts` directly, with no build step (TypeScript compiles on the fly).

Install the dependencies from the scripting-bridge directory:

```bash
bun install
```

Runtime dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`, `yaml`. Development dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `@types/node`.

The bridge reads only the skills tree and has no config files of its own.

### Hot reload

Pi reloads auto-discovered extensions with the `/reload` command. You rarely need this, because the skills root is watched and editing a skill file takes effect on its own (see [Live reload](#live-reload)).

## Configuration

One environment variable: `PI_SCRIPTING_BRIDGE_SKILLS_ROOT` overrides the skills root, which defaults to `~/.pi/agent/skills`.

## Skill format

A skill is one Markdown file with YAML frontmatter plus an implementation script referenced by `command`. The `command` is an absolute path or a path relative to the skill file's directory, never the process cwd. Trailing whitespace-delimited tokens in `command` pass to the script as positional arguments, so `command: ./spawn-agent.nu career-manager` runs `spawn-agent.nu` with `career-manager` as its first argument. The script must exist and be executable, or the bridge skips the skill and reports the skip — except for `type: command` skills, where a `command` string that resolves to no file becomes an executable command template instead (see [Command skills](#command-skills)).

The `type:` field in the frontmatter is the only discriminator. The bridge does not look at the file's directory, so it finds a skill wherever it lives in the tree.

### Tool skills

Frontmatter fields:

- `type`: `tool`.
- `name`: optional, the tool name. Falls back to the `.md` basename with spaces replaced by underscores and lowercased. Duplicate names skip (the first file wins), and the bridge reports the skip.
- `description`: required.
- `command`: required, the script to run.
- `parameters`: optional, a map of parameter name to property (`type: string|number|boolean|array`, `required`, `default`, plus standard JSON-Schema constraints).
- `executionMode`: optional, `"sequential"` or `"parallel"` (default `"parallel"`), forwarded to pi's tool registration so parallel-capable tools may run concurrently. An invalid value silently falls back to `"parallel"`.

At call time the bridge sends the validated params plus a sanitized `context` block to the script on stdin, applying `default` values for absent params:

```json
{ "toolCallId": "...", "params": { ... }, "context": { "cwd", "mode", "hasUI", "sessionManager", "model", "hasSignal", "isProjectTrusted", "contextUsage", "systemPrompt" } }
```

The script prints a JSON object on stdout that maps onto the tool result:

```json
{ "content": [{ "type": "text", "text": "..." }], "details": { ... }, "terminate": false }
```

`content` (an array of text entries) is required. `details` defaults to `{}`. `terminate` and `addedToolNames` are optional. Tool scripts run with no timeout, so a long-running script runs until it completes. A non-zero exit, empty stdout, invalid stdout JSON, a non-object top level, or a missing `content` makes the bridge **throw**, mirroring the pi `bash` tool: pi marks the result `isError=true` and the message carries the script output (stderr on failure, exit-code status, stderr on empty output).

#### Script entry point: `def main`

All tool and hook scripts define a `def main` function. Nushell auto-invokes `main` when it spawns a script file, so **no trailing `main` call is needed** (adding one causes double invocation) and **no top-level `exit 0`** — `main`'s final expression is the emitted stdout payload (a hook no-op is `main` returning `null`, i.e. empty stdout). The script's top-level body should contain only `def` declarations plus the single `def main` that carries the entry-point logic.

### Hook skills

Frontmatter fields:

- `type`: `hook`.
- `event`: required, one of the bridgeable events (listed below) — or a list of them, in which case the same script is registered under every event in the list (a multi-event hook; duplicates are dropped, first-seen order kept, and the first entry is the hook's primary event, used for run-order sorting). `message_update` and `tool_execution_update` are excluded on purpose and stay TS-only.
- `command`: required, the same resolution rules as tool skills.
- `timeout`: optional, in milliseconds. Defaults to 10000 and clamps to [1, 300000].

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

On each event the hook script receives `{"event": {...}, "context": {...}}` on stdin (sanitized). `context` carries `cwd`, `mode`, `hasUI`, `sessionManager`, `model`, `hasSignal`, `isProjectTrusted`, `contextUsage`, and `systemPrompt`. The bridge sanitizes event and context values before serialization (it drops non-finite numbers, functions, cycles, and undefineds).

A hook prints a JSON object on stdout. When several hooks are bound to the same event, they run in deterministic order (the hook's primary event, then file path) and the bridge combines their results per the event's semantics:

- cancel short-circuit: `session_before_switch`, `session_before_compact`
- first-defined wins per key: `session_before_fork` (`skipConversationRestore`), `session_before_tree` (`summary`, `customInstructions`, `replaceInstructions`, `label`)
- first-wins: `project_trust`, `user_bash`, `tool_call`
- chaining, last wins: `context`, `before_provider_request`, `message_end`, `input`
- `before_agent_start`: `message` is first-defined (one handler result carries one message); `systemPrompt` chains, last-defined wins
- accumulation: `resources_discover`
- field-wise merge: `tool_result`
- no result consumed: `session_start`, `session_info_changed`, `session_compact`, `session_shutdown`, `session_tree`, `before_provider_headers`, `after_provider_response`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `tool_execution_start`, `tool_execution_end`, `model_select`, `thinking_level_select`

Empty script output is a no-op. A hook failure (non-zero exit, invalid JSON, timeout) is logged and treated as a no-op (fail-open).

### Event payloads

Each bridgeable event has its own documentation file under [docs/events/](docs/events/), grouped by the phase of the agent lifecycle it fires in (session lifecycle, provider and context, agent loop, tool lifecycle, model and thinking, user input). Each file covers when the event fires, its payload fields, result combination semantics, and concrete use cases. The payload shapes are grounded in the pi-coding-agent `types.d.ts` event interfaces.

### Command skills

Frontmatter fields:

- `type`: `command`.
- `name`: required, the slash-command name, invoked as `/name`.
- `description`: optional.
- `command`: required. When it resolves to an existing executable script it is the handler script (same resolution rules as tool skills); when it is a string that does not resolve to a file it is treated as an **executable command template** — spawned directly via Node `child_process` (no shell, no script) when a picker item is selected, with `{field}` placeholders interpolated from the focused item's fields.
- `shortcut`: optional, a pi-tui keybinding (e.g. `ctrl+p`) the bridge binds to the command in addition to the `/name` invocation. Absent or invalid yields no key binding (the command still registers).
- `parameters`: optional, same format as tool skills; their `default` values are applied into `params`.
- `picker`: optional, the item-picker config for the command's `pick` payload (see [Item picker](#item-picker)).

At call time the bridge sends `{ "command": "<name>", "params": { ...defaults, "args": "<raw argument string>" }, "context": { "sessionId", "sessionFile", "cwd", "tui" } }` on stdin. `context.tui` is true only when the runtime has a TUI — the flag that tells the handler the bridge can launch the picker overlay. The script prints one JSON object on stdout: `content` (a text array) is surfaced to the user via a TUI notification — command output is for the user, never injected into the conversation — and an optional top-level `pick` field launches the item picker (below). Command execution fails open: a handler error, empty stdout, or invalid JSON is surfaced as a user-visible warning and the command returns; it never crashes pi.

## Directives

Beyond the standard result payload, tool, hook, and command scripts can emit a small set of top-level directives. The bridge acts on each and then strips it from the payload, so it never reaches the model, the event payload, or the user-surfaced text. (The command path honors `sendMessage` and `terminateSession`; the picker's `pick` field is a payload field, not a directive.)

### Tool directives

- `"terminateSession": true`: the exact boolean `true` ends the session in-process (the bridge appends a visibility line to the result content and then calls `process.exit(0)`, fail-open on failure — a stale context is a silent no-op). The key is stripped so it never reaches the model. Any non-`true` value is ignored. Live example: the `terminate-session-agent-end` hook pair (skills/meta/hooks/terminate-session-agent-end.md + .nu) — a clean subagent turn emits the terminateSession directive.

### Hook directives

A hook's stdout JSON may include these top-level directive keys (stripped from the combined result, never leaked to the event payload):

- `"setThinkingLevel": "low"`: one of `off|minimal|low|medium|high|xhigh|max`. Sets the session's thinking level (also honored on no-result events).
- `"sendMessage": { ... }`: sends a message to the session.
- `"notify"`: a TUI notification — a plain string (info) or an object `{ "message": "...", "type": "info|warning|error", "persistent": true }`. A plain string or `message` surfaces via `ctx.ui.notify` (best-effort, dedup/replace status slot); `persistent: true` appends a `bridge-status` chat entry that survives later status lines. An invalid value is logged and the hook result proceeds (fail-open).
- `"terminateSession": true`: the exact boolean `true` ends the session in-process, reusing the tool path's termination helper (the same mechanism as the tool directive). The key is stripped from the combined result and is also honored on no-result events (e.g. `agent_end`), where the combined result would otherwise be discarded. Any non-`true` value is ignored.

### TUI notification

A hook execution is mostly silent: an empty stdout is a no-op with no toast (no "no-op" spam), and a result that carries neither a directive nor a contribution contributes to the chain without a visible line. What the user does see: a warning line for a hook failure (non-zero exit, invalid JSON, timeout), and, for applied directives, the directive's own surface (`notify`'s TUI line, a persistent `bridge-status` entry). The `notify` directive is the one explicit user-facing surface a hook controls.

## Item picker

A command can let the user pick one item instead of acting on everything. The command's stdout JSON may carry a top-level `pick` field:

```json
{ "content": [{ "type": "text", "text": "Stashed sessions: 8; pick one to restore (--all restores all)" }],
  "pick": { "title": "Unstash session",
            "items": [ { "id": "01a038cc-09d8-7eae-96c3-c27e703bbf09", "label": "~/.pi", "rel_time": "38m", "hint": "Fix the build" } ],
            "open": true, "actions": [ { "shortcut": "enter", "effect": "run", "args": "{id}" } ] },
  "details": { "status": "pick", "count": 8 } }
```

Each item carries a required `id` and `label` (both strings; items missing either are dropped silently) plus any extra string columns. `title` is optional (the command name is the default). `open: true` opts the command into opening the picker even with an empty item list (e.g. a search with a blank query that still wants the filterable picker); without it, zero surviving items makes the `pick` field ignored. A payload-level `actions` list, when present and non-empty, replaces the base picker actions (per-mode keybinds the script chose); an absent or empty one falls back to the base config. In TUI mode the bridge mounts the picker overlay (95% width, centered) before the text notification fires: type to filter the list, up/down and page keys move the focus, and the footer help line lists the bound keys. After the picker closes, the human-readable `content` text is notified exactly as in non-TUI mode.

The picker is configured by the command's optional `picker` frontmatter block:

```yaml
picker:
  title: "Unstash session"
  columns:                      # aligned column layout; first entry is the primary column
    - field: rel_time
    - field: hint
      width: 12                 # visible width in columns (auto-sized when absent)
      align: right              # left (default) | right
  actions:
    - shortcut: enter           # a pi-tui keybinding; the pre-rename `key` field is a hard error
      effect: run               # run the current command with the args template below
      args: "{id}"
    - shortcut: ctrl+a
      label: "restore all"      # help-line label (default: "select" for enter, else the effect name)
      effect: run
      args: "--all"
  split: true                   # two-pane picker: list on the left, preview on the right
  splitWidth: 0.4               # left-pane share of terminal width (0, 1]; default 0.28
  previewCommand: cat {path}  # /bin/sh -c command, {field} interpolated from the focused item; its stdout renders in the preview pane
```

- `columns`: each entry is an object with a required `field` (trimmed non-empty string) and optional `width` (positive finite number, floored), `align` (`left` default | `right`), `style`, and `focusedStyle` (strings). Invalid entries are skipped while valid siblings are kept; an absent or fully invalid list yields the default `{field: "label"}` column, so the picker always has a primary column.
- `actions`: each entry needs a valid `shortcut` keybinding and an `effect` of `paste` or `run`, with strict per-effect fields: a `paste` entry may carry string `text`/`label`; a `run` entry may carry string `command`/`args`/`label`; any cross-effect field (or a leftover `key` field) invalidates the entry, which is dropped while its valid siblings are kept.
- `{field}` placeholders in `args`, `text`, and `previewCommand` interpolate from the focused item. The available effects:
  - `paste` — inserts the interpolated `text` template (or the `label` field when `text` is absent) into the pi editor and closes the picker
  - `run` — runs a bridge-registered command (named by the optional `command` field; absent means the current command) with the interpolated `args`. When the target command is a template (see [Command skills](#command-skills)), the selected item is spawned through the template directly
  - `cancel` — closes the picker (a hardcoded escape action, not a configured effect)

With no `picker` block the zero-config default applies: the command name as title, the `label` field as the sole column, type-to-filter, the default actions `enter` and `tab` both use the `paste` effect (inserting the focused item's `label` into the pi editor and closing the picker), and escape is a hardcoded cancel — not a configured action; no script-side picker logic required. The live example is `unstash-session` under `~/.pi/agent/skills/meta/agents/subtask/commands/`: its bare TUI invocation emits the `pick` payload above, its enter action re-runs the command with the focused session id (restoring just that session), and its `ctrl+a` action re-runs it with `--all`.

The whole path fails open in both directions: in non-TUI modes, or when `items` is empty (without `open: true`) or invalid, the `pick` field is ignored and the human-readable text notification is the only surface; a picker launch or action failure is logged (and an effect failure leaves the picker open) while the command's text output is preserved. The picker never crashes pi.

## Worked examples

Two skills run in the default skills root (`~/.pi/agent/skills`), one per registered type. The frontmatter and scripts below come verbatim from these files:

```
~/.pi/agent/skills/
└── engineering/
    ├── tools/duckdb-eval.md     # tool
    │   └── duckdb-eval.nu
    └── hooks/nu-check.md        # hook
        └── nu-check.nu
```

For these two examples: tools read `type`, `name`, `description`, `command`, `parameters`, and `executionMode` (tools have no timeout); hooks read `type`, `name`, `command`, `timeout`, and `event` (a hook `description` is not consumed by the bridge — skills-index metadata). (Commands additionally read `description`, `shortcut`, the `picker` block, and the template form of `command`.) The other fields (`category`, `keywords`, `related`) are skills-index metadata. The `command` paths above are relative to each skill file's own directory (never the process cwd); an absolute path would also work.

### Tool skill: `duckdb-eval`

```yaml
# ~/.pi/agent/skills/engineering/tools/duckdb-eval.md
name: duckdb-eval
type: tool
command: ./duckdb-eval.nu
description: Evaluate DuckDB SQL code inline.
category: Engineering
subcategory: DuckDB
keywords: duckdb, sql, eval
related: duckdb-engineer
parameters:
  command:
    type: string
    required: true
    description: DuckDB SQL query to evaluate.
```

```nushell
# ~/.pi/agent/skills/engineering/tools/duckdb-eval.nu (chmod 755)
#!/usr/bin/env nu
def main [] {
    let payload = (^cat | from json)

    try {
        let code = $payload.params.command
        let r = (^duckdb ":memory:" "-no-init" "-c" $code | complete)
        let out = ($r.stdout | default "") + ($r.stderr | default "")
        let text = if $out == "" { "(no output)" } else { $out }

        if $r.exit_code != 0 {
            let status = $"Command exited with code ($r.exit_code)"
            { content: [{ type: "text", text: $"($text)

($status)" }], details: { status: "failed", exit_code: $r.exit_code, stdout: ($r.stdout | default ""), stderr: ($r.stderr | default "") }
        } else {
            { content: [{ type: "text", text: $text }], details: { status: "ok", exit_code: $r.exit_code } }
        }
    } catch { |e|
        { content: [{ type: "text", text: $"[error] ($e.msg)" }], details: { error: ($e.msg) } }
    }
    | to json
}
```

The agent invokes `duckdb-eval(command="select 1 + 1 as two")`. The script receives

```json
{ "toolCallId": "...", "params": { "command": "select 1 + 1 as two" }, "context": { ... } }
```

on stdin (defaults applied for absent params) and prints

```json
{ "content": [{ "type": "text", "text": "..." }], "details": { "status": "ok", "exit_code": 0 } }
```

### Hook skill: `nu-check`

```yaml
# ~/.pi/agent/skills/engineering/agents/nu-engineer/hooks/nu-check.md
name: nu-check
type: hook
event: tool_result
timeout: 10000
command: ./nu-check.nu
description: Syntax-checks edited nushell files with `nu --ide-check` and surfaces diagnostics.
category: Engineering
subcategory: Nushell
keywords: nu-check, nushell, syntax, ide-check, tool_result, write, edit, nu
related: prettier, shfmt, alejandra
```

```nushell
# ~/.pi/agent/skills/engineering/agents/nu-engineer/hooks/nu-check.nu (chmod 755)
def file-ext [f] {
  let parts = ($f | split row ".")
  if ($parts | length) > 1 { $parts | last } else { "" }
}

def extract-paths [details] {
  if $details == null {
    return []
  }
  let paths = $details.paths?
  if $paths != null {
    if ($paths | describe) == "string" { [$paths] } else { $paths | where {|p| ($p | describe) == "string" } }
  } else {
    $details
    | transpose key value
    | where {|r| $r.value != null and (($r.value | describe) | str starts-with "list") }
    | where {|r| $r.value | all {|x| ($x | describe) == "string" } }
    | get value
    | default []
    | flatten
  }
}

def main [] {
  try {
    let payload = (^cat | from json)
    let tool = $payload.event?.toolName?
    if ($tool != null) and ($tool in ["write" "edit"]) {
      let details = $payload.event?.details?
      let paths = extract-paths $details
      for file in $paths {
        let ext = (file-ext $file)
        if $ext == "nu" {
          let r = (^timeout 5s nu --ide-check 10 $file) | complete
          let output = if $r.stderr != "" { $r.stdout + "\n" + $r.stderr } else { $r.stdout }
          let diags = ($output | lines) | where {|l| $l | str contains '"diagnostic"' }
          if ($diags | length) > 0 {
            let msg = $"nu-check for ($file): " + ($diags | str join "\n")
            { content: [{ type: "text", text: $msg }], details: { hook: "nu-check" } } | to json | print
          }
        }
      }
    }
  } catch { null }
}
```

On every `tool_result` event from `write`/`edit` the hook receives `{"event": {...}, "context": {...}}` on stdin. It syntax-checks each edited `.nu` file with `nu --ide-check 10` (5s per-check timeout) and prints `{"content": [{"type": "text", "text": "nu-check for <file>: ..."}], "details": {"hook": "nu-check"}}` only when diagnostics are present. A clean file or a non-nushell path prints nothing (empty stdout is a no-op for the bridge).

## Agent skills

`type: agent` skills are not registered by the bridge. They resolve to the shared `spawn-agent.nu` command and are invoked by name via the `spawn-agent` tool.

## Live reload

The bridge watches the skills root recursively. It debounces `.md` changes (300 ms) and re-registers them fingerprint-based (content hash plus script path, so untouched files are skipped). It drops removed tools from the active set and refreshes hook subscriptions in place. The walk skips `node_modules`, `.git`, and all dot-directories. Skipped files (missing script, missing description, duplicate tool name, non-bridgeable event) are reported as a warning at session start. In normal use you edit skill files and the change takes effect without `/reload`.

## Contribute

There is no build step. Run these commands from the scripting-bridge directory:

```bash
bun install     # install dependencies
bun run test    # run the vitest suite with v8 coverage (coverage -> coverage/)
bun run tsc     # typecheck (tsc --noEmit)
```

The test suite runs the extension against a mocked Pi API and a fixture skills tree pointed at via `PI_SCRIPTING_BRIDGE_SKILLS_ROOT`. Coverage (v8 provider) goes to `coverage/`.
