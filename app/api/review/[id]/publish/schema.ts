import { z } from "zod";

/**
 * The publish boundary, as the schema the handler and the review screen share (CLAUDE.md
 * §6). There is no request body: the recipe id in the path is the whole input, so there
 * is nothing a page could send that changes the answer.
 */

export const publishResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    error: z.literal("unresolved_ingredients"),
    // At least one: a refusal that names no line gives the reviewer nothing to fix.
    lines: z.array(z.object({ id: z.string().min(1), rawText: z.string().min(1) })).min(1),
  }),
  z.object({ error: z.literal("already_published") }),
  z.object({ error: z.literal("not_found") }),
]);

export type PublishResponse = z.infer<typeof publishResponseSchema>;
