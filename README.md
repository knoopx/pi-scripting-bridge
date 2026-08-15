# scripting-bridge

A Pi extension that bridges executable skills from the skills tree to the Pi
runtime over a stdin/stdout JSON payload protocol. A single recursive walk of
the skills tree classifies every `.md` file by its frontmatter `type:`:

- `type: tool` or `type: agent` — registered as a Pi tool
- `type: hook` — registered as a handler for one Pi event

The frontmatter `type:` is the only discriminator; the file's directory is not
consulted, so a skill is discovered wherever it lives in the tree.

## Skill format

A skill is one Markdown file with YAML frontmatter plus an implementation
script referenced by `command`. `command` may be an absolute path or relative
to the skill file's directory (never the process cwd). The script must exist
and be executable; otherwise the skill is skipped and the skip is reported.

### Tool and agent skills

Frontmatter fields:

- `type` — `tool` or `agent`. Agent skills are spawn-agent wrappers; they
  register as tools and conventionally declare `timeout: 0` (no timeout).
- `name` — optional; the tool name. Falls back to the `.md` basename (spaces
  replaced with underscores, lowercased). Duplicate names are skipped (the
  first file wins) and reported.
- `description` — required.
- `command` — required; the script to execute.
- `timeout` — optional, milliseconds. Overrides the 120000ms default; `0`
  disables the timeout entirely.
- `parameters` — optional; a map of parameter name to property (`type:
  string|number|boolean|array`, `required`, plus standard constraints and
  `default`).

At call time the script receives the validated params (with `default` values
applied for absent params) on stdin:

```json
{ "toolCallId": "...", "params": { ... } }
```

and must print a JSON object on stdout that maps onto the tool result:

```json
{ "content": [{ "type": "text", "text": "..." }], "details": { ... }, "terminate": false }
```

`content` (an array of text entries) is required; `details` defaults to `{}`;
`terminate` and `addedToolNames` are optional. A non-zero exit, timeout, empty
stdout, or invalid stdout JSON produces an error result with the script's
stderr surfaced in `content` (plus exit code, killed/timed-out flags, stderr,
and stdout in `details`).

Tool scripts run with the session's cwd. The default timeout is 120s,
overridable per-skill via the frontmatter `timeout` field or globally via
`PI_SCRIPTING_BRIDGE_TOOL_TIMEOUT_MS`. A timed-out or interrupted script is
sent SIGTERM, escalating to SIGKILL after 5s if it does not exit.

### Hook skills

Frontmatter fields:

- `type` — `hook`.
- `event` — required; one of the 31 bridgeable events (listed below).
  `message_update` and `tool_execution_update` are intentionally excluded and
  stay TS-only.
- `command` — required; same resolution rules as tool skills.
- `timeout` — optional, milliseconds; default 10000, clamped to a maximum of
  300000.

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

On each event the hook script receives on stdin:

```json
{ "event": { ... }, "context": { "cwd": "...", "mode": "...", "hasUI": true, "sessionManager": { "sessionId": "...", "sessionFile": "...", "cwd": "...", "leafId": "...", "branchEntryCount": 1 }, "model": "...", "hasSignal": false, "isProjectTrusted": true, "contextUsage": { ... }, "systemPrompt": "..." } }
```

Event and context values are sanitized before serialization (non-finite
numbers, functions, cycles, and undefineds are dropped).

A hook prints a JSON object on stdout; when several hooks subscribe to the
same event they run in sorted-filename order and their results are combined
per the event's semantics:

- cancel short-circuit: `session_before_switch`, `session_before_fork`,
  `session_before_compact`, `session_before_tree`
- first-wins: `project_trust`, `user_bash`, `tool_call`
- chaining, last wins: `context`, `before_provider_request`, `message_end`,
  `input`
- accumulation: `resources_discover`
- field-wise merge: `tool_result`
- no result consumed: `session_start`, `session_info_changed`,
  `session_compact`, `session_shutdown`, `session_tree`,
  `before_provider_headers`, `after_provider_response`, `agent_start`,
  `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`,
  `tool_execution_start`, `tool_execution_end`, `model_select`,
  `thinking_level_select`

Empty script output is a no-op. A hook failure (non-zero exit, invalid JSON,
timeout) is logged and treated as a no-op (fail-open).

## Example Implementations

Three skills that actually run in the default skills root
(`~/.pi/agent/skills`), one per type. All frontmatter fields and scripts
below are taken verbatim from these files:

```
~/.pi/agent/skills/
├── engineering/
│   ├── tools/duckdb-eval.md     # tool
│   │   └── duckdb-eval.nu
│   └── hooks/nu-check.md        # hook
│       └── nu-check.nu
└── meta/agents/
    ├── content-authoring.md     # agent
    └── content-authoring.nu
```

Only `type`, `name`, `description`, `command`, `timeout`, and
`parameters` (plus `event` for hooks) are read by the bridge; the other
fields (`category`, `keywords`, `related`) are skills-index metadata. The
bridge-usable fields each example relies on are all in the frontmatter
shown. `command` is an absolute path here; relative paths would resolve
against the skill file's own directory (never the process cwd).

### Tool Skill: `duckdb-eval`

```markdown
# ~/.pi/agent/skills/engineering/tools/duckdb-eval.md
---
name: duckdb-eval
type: tool
command: /home/knoopx/.pi/agent/skills/engineering/tools/duckdb-eval.nu
description: Evaluate DuckDB SQL code inline.
category: Tool
subcategory: Eval
keywords: duckdb, sql, eval
related: duckdb-engineer
parameters:
  command:
    type: string
    required: true
    description: DuckDB SQL query to evaluate.
---

Evaluate DuckDB SQL by spawning `duckdb :memory: -no-init -c`.

…(full documentation in the file)
```

```bash
# ~/.pi/agent/skills/engineering/tools/duckdb-eval.nu (chmod 755)
#!/usr/bin/env nu
# duckdb-eval — scripting-bridge tool script.
# stdin:  {"toolCallId": "...", "params": {"command": "<query>"}}
# stdout: AgentToolResult JSON {"content":[{"type":"text","text":"..."}],"details":{...}}
# Spawns: duckdb :memory: -no-init -c <query>

let payload = (^cat | from json)
let code = $payload.params.command

let r = (^duckdb ":memory:" "-no-init" "-c" $code | complete)
let out = ($r.stdout | default "") + ($r.stderr | default "")
let text = if $out == "" { "(no output)" } else { $out }

if $r.exit_code != 0 {
    let status = $"Command exited with code ($r.exit_code)"
    { content: [{ type: "text", text: $"($text)\n\n($status)" }], details: { status: "failed", exit_code: $r.exit_code, stdout: ($r.stdout | default ""), stderr: ($r.stderr | default "") } } | to json
} else {
    { content: [{ type: "text", text: $text }], details: { status: "ok", exit_code: $r.exit_code } } | to json
}
```

Produces: given this stdin

```json
{ "toolCallId": "call_1", "params": { "command": "select 1 + 1 as two" } }
```

it runs `duckdb :memory: -no-init -c` on the query and prints the tool
result, i.e. the DuckDB table plus status details:

```json
{
  "content": [
    {
      "type": "text",
      "text": "┌───────┐\n│  two  │\n│ int32 │\n├───────┤\n│     2 │\n└───────┘\n"
    }
  ],
  "details": { "status": "ok", "exit_code": 0 }
}
```

### Agent Skill: `content-authoring`

```markdown
# ~/.pi/agent/skills/meta/agents/content-authoring.md
---
name: content-authoring
type: agent
timeout: 0
command: /home/knoopx/.pi/agent/skills/meta/agents/content-authoring.nu
description: Writes blog posts, drafts emails, produces documentation, proofreads prose, and curates news records.
category: Meta
subcategory: Agent
parameters:
  task:
    type: string
    description: Task description to execute
    required: true
keywords: agent, blog, email, documentation, writing, proofreading, prose, news
related: orchestration

---

Write blog posts, draft emails, produce project documentation, proofread
and edit prose, curate and persist news records, and handle any writing
or document-related task.

…(full agent instructions in the file)
```

```bash
# ~/.pi/agent/skills/meta/agents/content-authoring.nu (chmod 755)
#!/usr/bin/env nu

# content-authoring — spawn-agent wrapper (stdin/stdout JSON payload protocol).
# stdin:  {"toolCallId": "...", "params": {"task": "..."}} (scripting-bridge payload)
# stdout: AgentToolResult JSON: {"content": [{"type": "text", "text": "..."}]}

def main [] {
    let payload = (^cat | from json)
    let task = $payload.params.task
    let home = ($nu.home-dir)
    let spawn = ($home | path join ".pi" "agent" "skills" "orchestration" "scripts" "spawn-agent.nu")
    let system_md = ($home | path join ".pi" "agent" "skills" "meta" "agents" "content-authoring.md")
    let res = (^$spawn --agent content-authoring --task $task --tools "read,write,edit,bash,web-fetch,duckdb-eval,python-eval" --system-prompt $system_md | complete)
    if ($res.exit_code != 0) {
        let err = ($res.stderr | str trim)
        let text = if $err != "" { $"[error] spawn-agent exited with code ($res.exit_code): ($err)" } else { $"[error] spawn-agent exited with code ($res.exit_code)" }
        { content: [{ type: "text", text: $text }], details: { exit_code: $res.exit_code } } | to json
    } else {
        let out = ($res.stdout | str trim)
        if ($out | is-empty) {
            { content: [{ type: "text", text: "[error] spawn-agent produced no output" }], details: { exit_code: 0 } } | to json
        } else {
            { content: [{ type: "text", text: $out }], details: { exit_code: 0 } } | to json
        }
    }
}
```

Produces: registered as a tool named `content-authoring` with `timeout: 0`
(disables the timeout, so the wrapper can run a full agent session);
invoking it with `task: "..."` spawns `spawn-agent.nu --agent
content-authoring --task <task> --tools read,write,edit,bash,web-fetch,
duckdb-eval,python-eval --system-prompt content-authoring.md` and returns
the spawned agent's last text response as an AgentToolResult.

### Hook Skill: `nu-check`

```markdown
# ~/.pi/agent/skills/engineering/hooks/nu-check.md
---
name: nu-check
type: hook
event: tool_result
timeout: 10000
command: /home/knoopx/.pi/agent/skills/engineering/hooks/nu-check.nu
description: Syntax-checks edited nushell files with `nu --ide-check` and surfaces diagnostics.
category: Hooks
subcategory: Check
keywords: nu-check, nushell, syntax, ide-check, tool_result, write, edit, nu
related: prettier, shfmt, alejandra
---

Post-tool_result hook that syntax-checks edited nushell files.

…(full documentation in the file)
```

```bash
# ~/.pi/agent/skills/engineering/hooks/nu-check.nu (chmod 755) — handler excerpt;
# the file-ext/extract-paths helpers are in the full file
try {
  let payload = (^cat | from json)
  let tool = $payload.event?.toolName?
  if ($tool != null) and ($tool in ["write" "edit"]) {
    let details = $payload.event?.result?.details?
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

Produces: on every `tool_result` event from `write`/`edit` it receives
`{"event", "context"}` on stdin, syntax-checks each edited `.nu` file with
`nu --ide-check 10` (5s per-check timeout), and prints
`{"content": [{"type": "text", "text": "nu-check for <file>: ..."}], "details": {"hook": "nu-check"}}`
only when diagnostics are present — a clean file or non-nushell path prints
nothing (empty stdout is a no-op for the bridge).

## Live reload

The skills root is watched with a single recursive `fs.watch`. Watch events
for `.md` files are debounced (300ms) before rediscovery. Changed `.md` files
re-register their tools (re-registration is fingerprint-based: the file
content hash plus script path, so untouched files are skipped); removed tools
are dropped from the active tool set; hook subscriptions refresh in place —
no `/reload` needed. The watcher is closed on `session_shutdown` for every
shutdown reason (`quit`, `reload`, `new`, `resume`, `fork`).

The walk skips `node_modules`, `.git`, and all other dot-directories.

## Configuration

- `PI_SCRIPTING_BRIDGE_SKILLS_ROOT` — override the skills root (default
  `~/.pi/agent/skills`; used by the test suite).
- `PI_SCRIPTING_BRIDGE_TOOL_TIMEOUT_MS` — override the default tool script
  timeout in milliseconds (default 120000); per-skill frontmatter `timeout`
  takes precedence.

## Development

The extension is a TypeScript module that Pi loads directly from source;
`package.json` declares it via the `pi.extensions` field:

```json
{ "pi": { "extensions": ["./index.ts"] } }
```

Module layout (all files at the package root):

- `index.ts` — entry point; re-exports the extension factory
- `extension.ts` — factory: tool/hook registration, rediscovery, staleness
  teardown, `session_start`/`session_shutdown` wiring
- `constants.ts` — skills root, timeouts, the 31 bridgeable events
- `frontmatter.ts` — shared YAML frontmatter extraction and `command`
  resolution
- `schema.ts` — TypeBox parameter schema generation
- `discovery.ts` — recursive walk and tool/hook skill parsing
- `script-exec.ts` — script spawning (stdin payload, timeout, abort)
- `tool-exec.ts` — tool execution and AgentToolResult mapping
- `hook-payload.ts` — `{"event", "context"}` payload building
- `hook-combine.ts` — per-event hook result combination
- `watcher.ts` — recursive skills-root watch and debounce
- `index.test.ts` — vitest suite with coverage

Runtime dependencies: `@earendil-works/pi-coding-agent`, `typebox`, `yaml`.
Development dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`,
`@types/node`.

```sh
bun install     # install dependencies
bun run test    # run the vitest suite with v8 coverage
bun run tsc     # typecheck (tsc --noEmit)
```

The test suite (`index.test.ts`) runs the extension against a mocked Pi API
and a fixture skills tree pointed at via `PI_SCRIPTING_BRIDGE_SKILLS_ROOT`.
