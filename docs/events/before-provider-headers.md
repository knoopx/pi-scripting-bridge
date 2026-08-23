# before_provider_headers

Fired after request headers are assembled, before the provider HTTP call. Handlers mutate `headers` in place; the return value is ignored.

## When it fires

Immediately after the Pi runtime has built the HTTP headers for a provider request. Set a header to `null` to delete it.

## Payload

| Field | Type | Description |
|---|---|---|
| `headers` | `ProviderHeaders` | The outgoing request headers (mutable) |

## Result

No result consumed. The handler mutates `event.headers` in place (e.g., inject a tracing header). Setting a key to `null` deletes that header. The return value is discarded.

## Use cases

- Inject a `X-Session-Id` header for tracing.
- Add custom authentication headers (e.g., a per-user API key).
- Override a provider header for a specific deployment.
