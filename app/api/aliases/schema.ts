import { z } from "zod";

/**
 * The alias boundary, as the schemas the handler and the review screen share (CLAUDE.md
 * §6). The alias is a human's answer to "what is this term?", so it is required and
 * non-blank; the id it points at is checked against the tree before anything is written.
 */

export const aliasRequestSchema = z.object({
  alias: z.string().refine((value) => value.trim().length > 0, "must not be blank"),
  canonicalId: z.guid(),
});

export type AliasRequest = z.infer<typeof aliasRequestSchema>;

export const aliasResponseSchema = z.union([
  z.object({ ok: z.literal(true), reresolved: z.number().int().nonnegative() }),
  z.object({ error: z.literal("alias_exists") }),
  z.object({ error: z.literal("unknown_ingredient") }),
]);

export type AliasResponse = z.infer<typeof aliasResponseSchema>;
