# after_provider_response

Fired after a provider response is received, before the response stream is consumed. The handler is invoked for side effects only.

## When it fires

When the HTTP response from the LLM provider arrives. The response body has not been streamed yet.

## Payload

| Field | Type | Description |
|---|---|---|
| `status` | `number` | HTTP status code |
| `headers` | `Record<string, string>` | Response headers |

## Result

No result consumed. The handler runs for side effects (logging, rate-limit tracking) and its return value is discarded.

## Use cases

- Log provider response status codes (429 = rate limited, 500 = provider error).
- Track rate-limit headers (`x-ratelimit-remaining`, `x-ratelimit-reset`).
- Cache response metadata for later analysis.
