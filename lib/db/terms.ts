import type { Db } from "./client";

export type ResolutionTerm = { term: string; canonicalId: string };

type Executor = Pick<Db, "select">;

export async function loadResolutionTerms(_db: Executor): Promise<ResolutionTerm[]> {
  return [];
}
