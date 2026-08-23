# before_provider_request

Fired before a provider request is sent. The handler can replace the outgoing request payload.

## When it fires

After the request body is assembled but before the HTTP call is made to the LLM provider (OpenAI, Anthropic, etc.).

## Payload

| Field | Type | Description |
|---|---|---|
| `payload` | `unknown` | The outgoing request body (provider-specific shape) |

## Result

Chaining, last wins: handlers run in sorted-filename order. The last handler that returns a value replaces the payload.

| Field | Type | Description |
|---|---|---|
| *(return value)* | `unknown` | Replacement payload; the last defined value wins |

## Use cases

- Modify the request before it reaches the provider (e.g., add a system-level instruction to the body).
- Route requests to a different model or endpoint by mutating the payload.
- Log or inspect outgoing requests for debugging.
