import { readFileSync } from "node:fs";
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
    try {
      if (readFileSync(candidate)) return candidate;
    } catch {
      // Try the next extension; a specifier that matches none isn't a local module.
    }
  }
  return null;
}

/**
 * The specifiers that survive to runtime. `import type` and `import { type X }` are
 * erased by the compiler, so they carry no module into any bundle — a type-only edge is
 * exactly how a client component is allowed to know a server module's shape. A bare
 * `import "x"` has no clause at all and is the most real edge there is.
 */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        clause?.name === undefined &&
        bindings.elements.every((element) => element.isTypeOnly)
      ) {
        continue;
      }
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      if (statement.isTypeOnly) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }
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
