# agent_settled

Fired after an agent run has fully settled — no automatic retry, compaction, or queued continuation will run. This is the "truly done" signal.

## When it fires

After `agent_end`, but only when the Pi runtime confirms that no follow-up action (retry after overflow, compaction, queued message) is pending. Use this instead of `agent_end` when you need to know the agent is completely finished.

## Payload

No payload fields beyond the event type.

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- Trigger a "session complete" notification only when the agent is truly done (not mid-retry or mid-compaction).
- Release per-run resources that should outlive a single turn but not the whole session.
- End a "run in progress" indicator.
