/** Minimal JSON value type — avoids a dependency for the common shape. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
// Interface (not `Record<string, JsonValue>`) to break the alias self-reference
// that TS rejects (TS2456) for recursive JSON.
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * A pragmatic JSON Schema subset for tool parameter descriptors. Not a full
 * Draft 2020-12 model — just enough to describe tool inputs to the provider.
 * The exact provider-side shape (Fireworks vs OpenAI) is pinned in S5 (D2).
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: JsonValue[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: JsonValue | JsonSchema | Record<string, JsonSchema> | string[] | undefined;
}
