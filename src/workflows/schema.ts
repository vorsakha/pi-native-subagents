import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { WorkflowStructuredTransport } from "./types.ts";

/** Error text shared by the native and portable structured-output paths so callers cannot tell transports apart from the failure message alone. */
export const SCHEMA_MISMATCH = "Agent output did not match the requested JSON Schema";

/**
 * Bounded recursive JSON Schema validator: rejects `$ref`/`$dynamicRef`
 * (no external resolution), prototype-polluting keys, and any node beyond
 * 2,000 total nodes or depth 16. Used identically to compile the schema sent
 * to a provider-native structured-result channel and to validate the
 * portable prompt/parse fallback, so both transports enforce the same policy.
 */
export function workflowSchema(value: unknown): TSchema | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  const annotations = new Set(["$id", "$schema", "title", "description", "default", "examples", "readOnly", "writeOnly"]);
  const numeric = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
  const nonnegative = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
  const seen = new WeakSet<object>();
  let nodes = 0;
  const schema = (current: unknown, depth: number): boolean => {
    if (current === true || current === false) return true;
    if (!current || typeof current !== "object" || Array.isArray(current) || seen.has(current) || ++nodes > 2_000 || depth > 16) return false;
    seen.add(current);
    let constraint = false;
    for (const [key, item] of Object.entries(current)) {
      if (["__proto__", "prototype", "constructor", "$ref", "$dynamicRef"].includes(key)) return false;
      if (annotations.has(key)) {
        if (["$id", "$schema", "title", "description"].includes(key) && typeof item !== "string") return false;
        continue;
      }
      if (key === "type") {
        const values = Array.isArray(item) ? item : [item];
        if (!values.length || !values.every((entry) => typeof entry === "string" && types.has(entry))) return false;
        constraint = true;
      } else if (["properties", "patternProperties", "$defs", "dependentSchemas"].includes(key)) {
        if (!item || typeof item !== "object" || Array.isArray(item) || !Object.values(item).every((entry) => schema(entry, depth + 1))) return false;
        constraint = true;
      } else if (["items", "contains", "additionalProperties", "unevaluatedProperties", "propertyNames", "not", "if", "then", "else"].includes(key)) {
        if (!schema(item, depth + 1)) return false;
        constraint = true;
      } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) {
        if (!Array.isArray(item) || !item.length || !item.every((entry) => schema(entry, depth + 1))) return false;
        constraint = true;
      } else if (key === "required" || key === "dependentRequired") {
        const valid = key === "required"
          ? Array.isArray(item) && item.every((entry) => typeof entry === "string")
          : !!item && typeof item === "object" && !Array.isArray(item) && Object.values(item).every((entry) => Array.isArray(entry) && entry.every((name) => typeof name === "string"));
        if (!valid) return false;
        constraint = true;
      } else if (key === "enum") {
        if (!Array.isArray(item) || !item.length) return false;
        constraint = true;
      } else if (key === "const") {
        constraint = true;
      } else if (numeric.has(key)) {
        if (typeof item !== "number" || !Number.isFinite(item) || nonnegative.has(key) && (!Number.isInteger(item) || item < 0) || key === "multipleOf" && item <= 0) return false;
        constraint = true;
      } else if (key === "pattern") {
        if (typeof item !== "string") return false;
        try { new RegExp(item); } catch { return false; }
        constraint = true;
      } else if (key === "format") {
        if (typeof item !== "string") return false;
        constraint = true;
      } else if (key === "uniqueItems") {
        if (typeof item !== "boolean") return false;
        constraint = true;
      } else {
        return false;
      }
    }
    seen.delete(current);
    return constraint;
  };
  return schema(value, 0) ? value as TSchema : undefined;
}

/** Fallback text extraction: strips a markdown fence, if present, and parses the remainder as JSON. Never used on a native transport's authoritative terminal payload. */
export function parseStructuredOutput(output: string): unknown {
  const text = output.trim();
  const candidate = text.startsWith("```")
    ? text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : text;
  try { return JSON.parse(candidate); } catch { return undefined; }
}

/** Validates an already-parsed value (native terminal payload) or `undefined` (missing) against the bounded schema. Shared by both transports so an invalid or missing payload fails identically either way. */
export function validateWorkflowStructured(schema: TSchema, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (value === undefined || !Check(schema, value)) return { ok: false, error: SCHEMA_MISMATCH };
  return { ok: true, value };
}

/**
 * Resolves a completed job's structured result for the transport that was
 * actually selected. Native never falls back to reading `final.output` as
 * text: a missing terminal payload is a distinct, explicit failure. Portable
 * always parses `final.output`, exactly as it did before native existed.
 */
export function resolveWorkflowStructured(
  schema: TSchema,
  transport: WorkflowStructuredTransport | undefined,
  final: { output: string; structured?: unknown },
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (transport === "native") {
    if (final.structured === undefined) {
      return { ok: false, error: "Native structured output was requested but the runtime reported no terminal structured result" };
    }
    return validateWorkflowStructured(schema, final.structured);
  }
  return validateWorkflowStructured(schema, parseStructuredOutput(final.output));
}
