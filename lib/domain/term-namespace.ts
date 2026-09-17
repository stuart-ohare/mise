export type TermClaim = { term: string; ingredient: string };
export type TermCollision = { term: string; ingredients: string[] };

export function findTermCollisions(_claims: readonly TermClaim[]): TermCollision[] {
  return [];
}
