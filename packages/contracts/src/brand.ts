declare const brand: unique symbol;

/**
 * Nominal branding for primitives. `Brand<string, 'WorkspaceId'>` is a string
 * at runtime but is NOT assignable to a plain string or to another brand, so
 * the type system catches "passed a channel id where a user id was expected".
 *
 * Construction happens at trust boundaries: `@sym/db` applies brands to its id
 * columns via Drizzle `.$type<>()`, and the Slack adapter casts inbound ids as
 * it normalizes them. There is no runtime constructor — this is a pure type.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
