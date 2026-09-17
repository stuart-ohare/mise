import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The server/client boundary as a fact about the import graph rather than a hope about
 * tree-shaking. Gate 2's recursive CTE lives in lib/db/candidates.ts; the Cook screen is
 * a client component. Nothing the screen imports for its value may reach that module,
 * because "the bundler drops it" is an optimisation, not a boundary — a module-scope env
 * read or a `server-only` marker added upstream would turn the same graph into a build
 * failure a long way from whatever caused it.
 *
 * Deliberately offline and build-free: a guard only worth having is one that runs in
 * `pnpm test`.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLIENT_ENTRY = resolve(REPO_ROOT, "app/_components/cook-client.tsx");

const FORBIDDEN_DIR = "lib/db/";
const FORBIDDEN_PACKAGES = ["drizzle-orm", "postgres"];
const LOCAL_PREFIXES = ["@/", "./", "../"];

const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveLocal(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(REPO_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (base === null) return null;

  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * True when the compiler erases the whole declaration. `import type` and
 * `import { type X }` carry no module into any bundle — a type-only edge is exactly how
 * a client component is allowed to know a server module's shape. `import "x"` has no
 * clause at all and is the realest edge there is, and `import {} from "x"` is the same
 * thing spelled differently, so neither counts as erased.
 */
function isErased(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function pushSpecifier(into: string[], node: ts.Expression): void {
  if (ts.isStringLiteral(node)) into.push(node.text);
}

/** The specifiers that survive to runtime, static and dynamic alike. */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isErased(node.importClause)) pushSpecifier(specifiers, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (!node.isTypeOnly) pushSpecifier(specifiers, node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // `await import("…")` puts the module in the bundle exactly as a static import does,
      // and it can appear anywhere, which is why this walks the tree rather than the
      // top-level statements.
      const [first] = node.arguments;
      if (first !== undefined) pushSpecifier(specifiers, first);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return specifiers;
}

/** Every local file, and every package, the entry point pulls in at runtime. */
function valueGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);

    for (const specifier of valueImports(file)) {
      const local = resolveLocal(specifier, file);
      if (local === null) packages.add(specifier);
      else if (!files.has(local)) queue.push(local);
    }
  }

  return { files, packages };
}

describe("the Cook client's import graph", () => {
  it("reaches no database module", () => {
    const { files, packages } = valueGraph(CLIENT_ENTRY);

    // A local specifier the walk couldn't resolve gets filed under `packages` and then
    // skipped, which would leave the check below unsound rather than merely failing. An
    // extension or a path alias this resolver doesn't know about shows up here first.
    const unresolved = [...packages]
      .filter((name) => LOCAL_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .sort();
    expect(unresolved).toEqual([]);

    const reached = [...files]
      .map((file) => relative(REPO_ROOT, file))
      .filter((path) => path.startsWith(FORBIDDEN_DIR))
      .sort();
    expect(reached).toEqual([]);

    const drivers = [...packages]
      .filter((name) => FORBIDDEN_PACKAGES.some((pkg) => name === pkg || name.startsWith(`${pkg}/`)))
      .sort();
    expect(drivers).toEqual([]);
  });

  // The graph test above is the guarantee; this one keeps the failure loud. Without the
  // marker, a client import of gate 2's module compiles and is silently dropped, and the
  // only thing standing between that and a shipped query builder is the optimiser.
  it("could not import gate 2's module without a build error", () => {
    const candidates = readFileSync(resolve(REPO_ROOT, "lib/db/candidates.ts"), "utf8");

    expect(candidates).toMatch(/^import "server-only";$/m);
  });
});
