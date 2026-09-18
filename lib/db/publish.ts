import "server-only";

import type { Tx } from "./drafts";

export type UnresolvedLine = { id: string; rawText: string };

export type PublishResult =
  | { kind: "published" }
  | { kind: "not_found" }
  | { kind: "already_published" }
  | { kind: "unresolved"; lines: UnresolvedLine[] };

export async function publishDraft(_tx: Tx, _recipeId: string): Promise<PublishResult> {
  throw new Error("publishDraft is not implemented yet (#81)");
}
