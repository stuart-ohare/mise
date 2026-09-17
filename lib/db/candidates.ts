import type { Db } from "./client";

export type CandidateRecipe = {
  id: string;
  title: string;
  summary: string | null;
  minutes: number | null;
  serves: number | null;
};

type Executor = Pick<Db, "execute">;

export async function excludedIngredientIds(
  db: Executor,
  excludedIds: readonly string[],
): Promise<Set<string>> {
  void db;
  void excludedIds;
  return new Set();
}

export async function findCandidateRecipes(
  db: Executor,
  excludedIds: readonly string[],
): Promise<CandidateRecipe[]> {
  void db;
  void excludedIds;
  return [];
}
