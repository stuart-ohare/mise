import { db } from "@/lib/db/client";
import { addAliasAndReresolve, type AddAliasResult } from "@/lib/db/aliases";

import type { AliasRequest } from "./schema";

export type AliasDeps = { add: (input: AliasRequest) => Promise<AddAliasResult> };

export const deps: AliasDeps = {
  add: (input) => db.transaction((tx) => addAliasAndReresolve(tx, input)),
};

export async function POST(_request: Request): Promise<Response> {
  return Response.json({ error: "not_implemented" }, { status: 501 });
}
