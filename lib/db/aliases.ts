import "server-only";

import type { Tx } from "./drafts";

export type AddAliasResult =
  | { kind: "added"; reresolved: number }
  | { kind: "alias_exists" }
  | { kind: "unknown_ingredient" };

export async function addAliasAndReresolve(
  _tx: Tx,
  _input: { alias: string; canonicalId: string },
): Promise<AddAliasResult> {
  return { kind: "added", reresolved: 0 };
}
