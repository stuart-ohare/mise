import { db } from "@/lib/db/client";
import { addAliasAndReresolve, type AddAliasResult } from "@/lib/db/aliases";

import { aliasRequestSchema, aliasResponseSchema, type AliasRequest, type AliasResponse } from "./schema";

/**
 * The HTTP shell for the alias fix. The rules — an unknown ingredient refused, a
 * duplicate refused, only draft lines re-resolved, nothing published — live in
 * `addAliasAndReresolve`; this maps its answer to a status.
 */

export type AliasDeps = { add: (input: AliasRequest) => Promise<AddAliasResult> };

export const deps: AliasDeps = {
  // The transaction opens here, so the alias and the lines it unblocks land together.
  add: (input) => db.transaction((tx) => addAliasAndReresolve(tx, input)),
};

function toResponse(result: AddAliasResult): { status: number; body: AliasResponse } {
  switch (result.kind) {
    case "added":
    case "already_known":
      return { status: 200, body: { ok: true, reresolved: result.reresolved } };
    case "alias_exists":
      return { status: 409, body: { error: "alias_exists" } };
    // 422, not 404: the URL names nothing missing; the body names an ingredient that isn't.
    case "unknown_ingredient":
      return { status: 422, body: { error: "unknown_ingredient" } };
    case "no_unresolved_line":
      return { status: 422, body: { error: "no_unresolved_line" } };
  }
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = aliasRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const { status, body: response } = toResponse(await deps.add(parsed.data));
    return Response.json(aliasResponseSchema.parse(response), { status });
  } catch (error) {
    // The transaction rolled back: no alias, no line changed. Loud, not a 409 (§6).
    console.error("[aliases] alias fix failed before a response could be validated", error);
    return Response.json({ error: "alias_failed" }, { status: 500 });
  }
}
