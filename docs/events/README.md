# Bridgeable hook events

The bridgeable events a `type: hook` skill can subscribe to. `message_update` and `tool_execution_update` are excluded on purpose and stay TS-only.

The `event` frontmatter field accepts a single event or a list of them: a multi-event hook runs the same script under every bound event (duplicates dropped, first entry is the primary event for run-order sorting).

Each event has its own documentation file. The files are grouped by the phase of the agent lifecycle they fire in.

## Session lifecycle

Fired as the session is created, switched, forked, compacted, navigated, or torn down.

- [project-trust](project-trust.md) — decide whether the project is trusted
- [resources-discover](resources-discover.md) — register additional skill/prompt/theme paths
- [session-start](session-start.md) — react to session creation or reload
- [session-info-changed](session-info-changed.md) — react to session name changes
- [session-before-switch](session-before-switch.md) — gate or customize a session switch
- [session-before-fork](session-before-fork.md) — gate or customize a session fork
- [session-before-compact](session-before-compact.md) — gate or customize context compaction
- [session-compact](session-compact.md) — react to a successful compaction
- [session-shutdown](session-shutdown.md) — run finalization before the runtime tears down
- [session-before-tree](session-before-tree.md) — gate or customize session-tree navigation
- [session-tree](session-tree.md) — react to a completed tree navigation

## Provider and context

Fired around the LLM call: context assembly, request construction, and response handling.

- [context](context.md) — modify the message array before the LLM call
- [before-provider-request](before-provider-request.md) — replace the outgoing provider request payload
- [before-provider-headers](before-provider-headers.md) — mutate request headers in place
- [after-provider-response](after-provider-response.md) — inspect the provider response status and headers

## Agent loop

Fired at the boundaries of the agent run and its individual turns and messages.

- [before-agent-start](before-agent-start.md) — transform the prompt or system prompt before the agent loop
- [agent-start](agent-start.md) — react to agent loop start
- [agent-end](agent-end.md) — react to agent loop end
- [agent-settled](agent-settled.md) — react when the agent is truly done (no retry, compaction, or continuation pending)
- [turn-start](turn-start.md) — react to the start of a turn
- [turn-end](turn-end.md) — react to the end of a turn
- [message-start](message-start.md) — react to the start of a message
- [message-end](message-end.md) — modify or replace a finalized message

## Tool lifecycle

Fired at tool execution boundaries and for the tool call/result intercept points.

- [tool-execution-start](tool-execution-start.md) — react to a tool starting execution
- [tool-execution-end](tool-execution-end.md) — react to a tool finishing execution
- [tool-call](tool-call.md) — intercept and potentially block or modify a tool call
- [tool-result](tool-result.md) — modify a tool's result before it enters the conversation

## Model and thinking

Fired when the user changes the active model or thinking level.

- [model-select](model-select.md) — react to model selection
- [thinking-level-select](thinking-level-select.md) — react to thinking level changes

## User input

Fired for direct user actions that bypass or precede the agent loop.

- [user-bash](user-bash.md) — intercept `!` / `!!` bash commands
- [input](input.md) — intercept or transform user input before agent processing
