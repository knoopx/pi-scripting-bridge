/**
 * Parameter schema generation from skill frontmatter `parameters`
 * (ShellToolProperty format, `required: true/false`) to a TypeBox TSchema.
 */
import type { TSchema } from "typebox";
import { Type } from "typebox";

export interface ShellToolProperty {
  type: "string" | "number" | "boolean" | "array";
  required?: boolean;
  description?: string;
  default?: unknown;
  title?: string;
  examples?: unknown[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  additionalItems?: boolean;
}

type ShellToolOpts = Omit<ShellToolProperty, "type" | "required">;

/** Dispatch table: frontmatter type → TypeBox builder. */
const TYPE_BUILDERS: Record<string, (opts: ShellToolOpts) => TSchema> = {
  string: (opts) => Type.String(opts),
  number: (opts) => Type.Number(opts),
  boolean: (opts) => Type.Boolean(opts),
  array: (opts) => Type.Array(Type.String(), opts),
};

const VALID_TYPES = new Set(Object.keys(TYPE_BUILDERS));

export function createParameterSchema(
  parameters: Record<string, ShellToolProperty>,
): { schema: TSchema; error: null } | { schema: never; error: string } {
  const fields: Record<string, TSchema> = {};

  for (const [key, prop] of Object.entries(parameters)) {
    if (typeof prop !== "object" || prop === null) {
      continue;
    }
    const { type: propType, required, ...opts } = prop as ShellToolProperty;
    const build = TYPE_BUILDERS[propType];
    if (build === undefined) {
      return {
        schema: null!,
        error: `Parameter '${key}' has invalid type '${propType}'. Must be one of: ${[...VALID_TYPES].join(", ")}`,
      };
    }

    let schema = build(opts as ShellToolOpts);
    if (!required) {
      schema = Type.Optional(schema);
    }
    fields[key] = schema;
  }

  return { schema: Type.Object(fields), error: null };
}
