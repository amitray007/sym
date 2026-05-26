declare const brand: unique symbol;

/**
 * Nominal branding for primitives. `Brand<string, 'WorkspaceId'>` is a string
 * at runtime but is NOT assignable to a plain string or to another brand, so
 * the type system catches "passed a channel id where a user id was expected".
 *
 * Construction happens at trust boundaries: the Slack adapter casts inbound ids
 * as it normalizes them; the agent casts workspace/team ids from config.
 * There is no runtime constructor — this is a pure type.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
