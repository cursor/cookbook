import { join } from "node:path";
import { SKILL_ROOT, readJson } from "./util.ts";

type Schema = {
  $ref?: string;
  $defs?: Record<string, Schema>;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: Schema[];
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(actual: string, expected: string): boolean {
  return actual === expected || (expected === "number" && actual === "integer");
}

export function validate(value: unknown, schema: Schema, root: Schema = schema, path = "$"): string[] {
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(value, target, root, path);
  }
  const errors: string[] = [];
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(value, s, root, path).length === 0);
    if (!ok) errors.push(`${path}: matches none of anyOf`);
    return errors;
  }
  const actual = typeOf(value);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(actual, t))) {
      return [`${path}: expected ${types.join("|")}, got ${actual}`];
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items as Schema, root, `${path}[${i}]`)));
  }
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}: missing ${key}`);
    for (const [key, v] of Object.entries(obj)) {
      const prop = schema.properties?.[key];
      if (prop) errors.push(...validate(v, prop, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errors.push(...validate(v, schema.additionalProperties, root, `${path}.${key}`));
    }
  }
  return errors;
}

export function validateAgainst(name: "audit" | "report" | "roadmap", value: unknown): string[] {
  const schema = readJson<Schema>(join(SKILL_ROOT, "schema", `${name}.schema.json`));
  return validate(value, schema);
}
