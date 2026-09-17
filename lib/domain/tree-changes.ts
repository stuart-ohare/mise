export type TreeNode = { name: string; parent: string | null; allergenTags: readonly string[] };
export type TreeChange = {
  name: string;
  parent?: { from: string | null; to: string | null };
  tags?: { from: string[]; to: string[] };
};

export function findTreeChanges(_existing: readonly TreeNode[], _files: readonly TreeNode[]): TreeChange[] {
  return [];
}
