import { z } from "zod";

import { db } from "@/lib/db/client";
import { publishDraft, type PublishResult } from "@/lib/db/publish";

import { publishResponseSchema, type PublishResponse } from "./schema";

/**
 * The HTTP shell for the publish gate. The rule lives in `publishDraft`, and this route
 * is the only way to reach it: the review screen's disabled button is a convenience that
 * shows the same refusal early, never the thing enforcing it.
 */

export type PublishDeps = { publish: (recipeId: string) => Promise<PublishResult> };

export const deps: PublishDeps = {
  // The transaction opens here, as Intake's does, so the recipe and its job move together.
  publish: (recipeId) => db.transaction((tx) => publishDraft(tx, recipeId)),
};

const idSchema = z.guid();

function toResponse(result: PublishResult): { status: number; body: PublishResponse } {
  switch (result.kind) {
    case "published":
      return { status: 200, body: { ok: true } };
    case "unresolved":
      return { status: 409, body: { error: "unresolved_ingredients", lines: result.lines } };
    case "already_published":
      return { status: 409, body: { error: "already_published" } };
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
  }
}

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/review/[id]/publish">,
): Promise<Response> {
  const { id } = await ctx.params;
  // An id that isn't a uuid names no recipe. Handed to Postgres it would be a cast error,
  // and a 500 for what is simply an unknown id.
  if (!idSchema.safeParse(id).success) {
    return Response.json(publishResponseSchema.parse({ error: "not_found" }), { status: 404 });
  }

  try {
    const { status, body } = toResponse(await deps.publish(id));
    return Response.json(publishResponseSchema.parse(body), { status });
  } catch (error) {
    // Nothing was published: the transaction rolled back or never committed. A failure
    // here is loud, not a 409 dressed up as a reason the reviewer could fix (§6).
    console.error("[review] publish failed before a response could be validated", error);
    return Response.json({ error: "publish_failed" }, { status: 500 });
  }
}
