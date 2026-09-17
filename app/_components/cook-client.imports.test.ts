import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The server/client boundary as a fact about the import graph rather than a hope about
 * tree-shaking. Gate 2's recursive CTE lives in lib/db/candidates.ts; the Cook screen is
 * a client component. Nothing a client entry point imports for its value may reach that
 * module, because "the bundler drops it" is an optimisation, not a boundary — a
 * module-scope env read or a `server-only` marker added upstream would turn the same
 * graph into a build failure a long way from whatever caused it.
 *
 * The entry points are discovered rather than listed, so a client component added later
 * is covered the day it appears instead of the day someone remembers this file.
 *
 * Deliberately offline and build-free: a guard only worth having is one that runs in
 * `pnpm test`.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_DIR = resolve(REPO_ROOT, "app");

const FORBIDDEN_DIR = "lib/db/";
const FORBIDDEN_PACKAGES = ["drizzle-orm", "postgres"];
const LOCAL_PREFIXES = ["@/", "./", "../"];

const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

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
 *
 * `import { type X }` is erased only because tsconfig.json doesn't set
 * `verbatimModuleSyntax`; under that flag the emitted code keeps a bare `import "x"` and
 * this would under-report. Revisit here if that flag is ever turned on.
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
function valueImports(source: ts.SourceFile): string[] {
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

/** A `"use client"` directive has to be the first statement to mean anything. */
function isClientEntry(source: ts.SourceFile): boolean {
  const [first] = source.statements;
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client"
  );
}

function clientEntries(): string[] {
  return readdirSync(APP_DIR, { recursive: true, encoding: "utf8" })
    .map((name) => resolve(APP_DIR, name))
    .filter((file) => /\.tsx?$/.test(file) && statSync(file).isFile())
    .filter((file) => isClientEntry(parse(file)))
    .sort();
}

/** Every local file, and every package, these entry points pull in at runtime. */
function valueGraph(entries: readonly string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);

    for (const specifier of valueImports(parse(file))) {
      const local = resolveLocal(specifier, file);
      if (local === null) packages.add(specifier);
      else if (!files.has(local)) queue.push(local);
    }
  }

  return { files, packages };
}

describe("the client import graph", () => {
  it("reaches no database module from any client entry point", () => {
    const entries = clientEntries();
    // Discovery that found nothing would leave this passing while checking nothing.
    expect(entries.map((file) => relative(REPO_ROOT, file))).toContain(
      "app/_components/cook-client.tsx",
    );

    const { files, packages } = valueGraph(entries);

    // A local specifier the walk couldn't resolve gets filed under `packages` and then
    // skipped, which would leave the checks below unsound rather than merely failing. An
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
