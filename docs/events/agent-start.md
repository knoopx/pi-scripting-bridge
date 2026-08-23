# agent_start

Fired when an agent loop starts. The handler is invoked for side effects only.

## When it fires

When the Pi runtime begins an agent run (the loop that processes messages, calls tools, and streams responses).

## Payload

No payload fields beyond the event type.

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Start a per-run timer or counter.
- Initialize telemetry for the agent run.
- Set up a "run in progress" indicator in the UI.
