# scripting-bridge

scripting-bridge (v1.0.0) is a Pi extension. It runs executable skills from the skills tree as Pi tools and event handlers over a stdin/stdout JSON protocol. A recursive walk of the skills tree registers `type: tool` skills as Pi tools and `type: hook` skills as handlers for Pi events. You author skills as Markdown plus a script file instead of TypeScript.

## Install

The scripting-bridge lives at `~/.pi/agent/extensions/scripting-bridge/`, which is Pi's global auto-discovery location. Pi finds it on its own, so there is no install command and no settings entry. `package.json` declares the entry point through the `pi.extensions` manifest:

```json
{ "pi": { "extensions": ["./index.ts"] } }
```

Pi loads `index.ts` directly, with no build step (TypeScript compiles on the fly).

Install the dependencies from the scripting-bridge directory:

```bash
bun install
```

Runtime dependencies: `@earendil-works/pi-coding-agent`, `typebox`, `yaml`. Development dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `@types/node`.

The bridge reads only the skills tree and has no config files of its own.

### Hot reload

Pi reloads auto-discovered extensions with the `/reload` command. You rarely need this, because the skills root is watched and editing a skill file takes effect on its own (see [Live reload](#live-reload)).

## Configuration

One environment variable: `PI_SCRIPTING_BRIDGE_SKILLS_ROOT` overrides the skills root, which defaults to `~/.pi/agent/skills`.

## Skill format

A skill is one Markdown file with YAML frontmatter plus an implementation script referenced by `command`. The `command` is an absolute path or a path relative to the skill file's directory, never the process cwd. Trailing whitespace-delimited tokens in `command` pass to the script as positional arguments, so `command: ./spawn-agent.nu career-manager` runs `spawn-agent.nu` with `career-manager` as its first argument. The script must exist and be executable, or the bridge skips the skill and reports the skip.

The `type:` field in the frontmatter is the only discriminator. The bridge does not look at the file's directory, so it finds a skill wherever it lives in the tree.

### Tool skills

Frontmatter fields:

- `type`: `tool`.
- `name`: optional, the tool name. Falls back to the `.md` basename with spaces replaced by underscores and lowercased. Duplicate names skip (the first file wins), and the bridge reports the skip.
- `description`: required.
- `command`: required, the script to run.
- `parameters`: optional, a map of parameter name to property (`type: string|number|boolean|array`, `required`, `default`, plus standard JSON-Schema constraints).

At call time the bridge sends the validated params to the script on stdin, applying `default` values for absent params:

```json
{ "toolCallId": "...", "params": { ... } }
```

The script prints a JSON object on stdout that maps onto the tool result:

```json
{ "content": [{ "type": "text", "text": "..." }], "details": { ... }, "terminate": false }
```

`content` (an array of text entries) is required. `details` defaults to `{}`. `terminate` and `addedToolNames` are optional. Tool scripts run with no timeout, so a long-running script runs until it completes. A non-zero exit, empty stdout, or invalid stdout JSON produces an error result that surfaces the script's stderr in `content` (plus exit code, killed flag, stderr, and stdout in `details`).

### Hook skills

Frontmatter fields:

- `type`: `hook`.
- `event`: required, one of the 31 bridgeable events (listed below). `message_update` and `tool_execution_update` are excluded on purpose and stay TS-only.
- `command`: required, the same resolution rules as tool skills.
- `timeout`: optional, in milliseconds. Defaults to 10000 and clamps to a maximum of 300000.

The 31 bridgeable events:

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

A hook prints a JSON object on stdout. When several hooks subscribe to the same event, they run in sorted-filename order and the bridge combines their results per the event's semantics:

- cancel short-circuit: `session_before_switch`, `session_before_compact`
- first-defined wins per key: `session_before_fork` (`skipConversationRestore`), `session_before_tree` (`summary`, `customInstructions`, `replaceInstructions`, `label`)
- first-wins: `project_trust`, `user_bash`, `tool_call`
- chaining, last wins: `context`, `before_provider_request`, `message_end`, `input`
- `before_agent_start`: `message` is first-defined (one handler result carries one message); `systemPrompt` chains, last-defined wins
- accumulation: `resources_discover`
- field-wise merge: `tool_result`
- no result consumed: `session_start`, `session_info_changed`, `session_compact`, `session_shutdown`, `session_tree`, `before_provider_headers`, `after_provider_response`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `tool_execution_start`, `tool_execution_end`, `model_select`, `thinking_level_select`

Empty script output is a no-op. A hook failure (non-zero exit, invalid JSON, timeout) is logged and treated as a no-op (fail-open).

## Directives

Beyond the standard result payload, tool and hook scripts can emit a small set of top-level directives. The bridge acts on each and then strips it from the payload, so it never reaches the model or the event payload.

### Tool directives

- `"terminateSession": true`: the exact boolean `true` ends the session in-process. The bridge appends a visibility line to the result content, emits an info notification, and strips the key so it never reaches the model. Any non-`true` value is ignored. Live example: the `terminate-session` tool skill, where a subagent calls `terminate-session()` to end its session cleanly.

### Hook directives

A hook's stdout JSON may include these top-level directive keys (stripped from the combined result, never leaked to the event payload):

- `"setThinkingLevel": "low"`: one of `off|minimal|low|medium|high|xhigh|max`. Sets the session's thinking level (also honored on no-result events).
- `"sendMessage": { ... }`: sends a message to the session.

### TUI notification

Every hook execution emits exactly one user-visible TUI line: an info line for a success, no-op, result, or chain-stop, and a warning line for a failure.

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

Only `type`, `name`, `description`, `command`, `timeout`, and `parameters` (plus `event` for hooks) are read by the bridge. The other fields (`category`, `keywords`, `related`) are skills-index metadata. `command` is an absolute path here, but a relative path would resolve against the skill file's own directory (never the process cwd).

### Tool skill: `duckdb-eval`

```yaml
# ~/.pi/agent/skills/engineering/tools/duckdb-eval.md
name: duckdb-eval
type: tool
command: /home/knoopx/.pi/agent/skills/engineering/tools/duckdb-eval.nu
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
    { content: [{type: "text", text: $"[error] ($e.msg)"}], details: {error: ($e.msg)} }
}
| to json | print
```

The agent invokes `duckdb-eval(command="select 1 + 1 as two")`. The script receives

```json
{ "toolCallId": "...", "params": { "command": "select 1 + 1 as two" } }
```

on stdin (defaults applied for absent params) and prints

```json
{ "content": [{ "type": "text", "text": "..." }], "details": { "status": "ok", "exit_code": 0 } }
```

### Hook skill: `nu-check`

```yaml
# ~/.pi/agent/skills/engineering/hooks/nu-check.md
name: nu-check
type: hook
event: tool_result
timeout: 10000
command: /home/knoopx/.pi/agent/skills/engineering/hooks/nu-check.nu
description: Syntax-checks edited nushell files with `nu --ide-check` and surfaces diagnostics.
category: Engineering
subcategory: Nushell
keywords: nu-check, nushell, syntax, ide-check, tool_result, write, edit, nu
related: prettier, shfmt, alejandra
```

```nushell
# ~/.pi/agent/skills/engineering/hooks/nu-check.nu (chmod 755)
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
exit 0
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
bun run test    # run the vitest suite with v8 coverage (35 tests; coverage -> coverage/)
bun run tsc     # typecheck (tsc --noEmit)
```

The test suite runs the extension against a mocked Pi API and a fixture skills tree pointed at via `PI_SCRIPTING_BRIDGE_SKILLS_ROOT`. Coverage (v8 provider) goes to `coverage/`.