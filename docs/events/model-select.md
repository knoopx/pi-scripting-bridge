# model_select

Fired when a new model is selected.

## When it fires

When the user (or an extension) changes the active model. The `source` field tells you how: `set` (explicit selection), `cycle` (cycling through the model list), or `restore` (restoring a saved model).

## Payload

| Field | Type | Description |
|---|---|---|
| `model` | `Model<any>` | The newly selected model |
| `previousModel` | `Model<any> \| undefined` | The model that was active before the change |
| `source` | `"set" \| "cycle" \| "restore"` | How the model was selected |

## Result

No result consumed. The handler runs for side effects and its return value is discarded.

## Use cases

- React to model changes: adjust behavior per model (e.g., different system prompts for different models).
- Log model selection events for analytics.
- Update a UI indicator showing the active model.
