import { db } from "@/lib/db/client";
import { publishDraft, type PublishResult } from "@/lib/db/publish";

export type PublishDeps = { publish: (recipeId: string) => Promise<PublishResult> };

export const deps: PublishDeps = {
  publish: (recipeId) => db.transaction((tx) => publishDraft(tx, recipeId)),
};

export async function POST(
  _request: Request,
  _ctx: RouteContext<"/api/review/[id]/publish">,
): Promise<Response> {
  return Response.json({ error: "not_implemented" }, { status: 501 });
}
