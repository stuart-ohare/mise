// @gate resolution
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AddAliasResult } from "@/lib/db/aliases";

import type { AliasRequest } from "./schema";

/**
 * The HTTP shell only: which status and body each outcome of `addAliasAndReresolve`
 * becomes, and that a malformed body never reaches it. The SQL is pinned by
 * lib/db/aliases.db.test.ts. The database client is mocked because importing it needs
 * `DATABASE_URL`.
 */

vi.mock("@/lib/db/client", () => ({
  db: {
    transaction: () => Promise.reject(new Error("no database in this test")),
  },
}));

const { POST, deps } = await import("./route");

const CLARIFIED_BUTTER = "3f2b8c1e-9a4d-4e6f-8b2a-1c5d7e9f0a3b";
const calls: AliasRequest[] = [];
let outcome: AddAliasResult = { kind: "added", reresolved: 0 };

beforeEach(() => {
  calls.length = 0;
  deps.add = (input) => {
    calls.push(input);
    return Promise.resolve(outcome);
  };
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/aliases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/aliases", () => {
  it("answers an added alias with 200 and the number of lines it re-resolved", async () => {
    outcome = { kind: "added", reresolved: 2 };

    const response = await post({ alias: "ghee", canonicalId: CLARIFIED_BUTTER });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, reresolved: 2 });
    expect(calls).toEqual([{ alias: "ghee", canonicalId: CLARIFIED_BUTTER }]);
  });

  it("answers an alias that already means something with 409", async () => {
    outcome = { kind: "alias_exists" };

    const response = await post({ alias: "ghee", canonicalId: CLARIFIED_BUTTER });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "alias_exists" });
  });

  it("answers an alias pointing at no ingredient with 422", async () => {
    outcome = { kind: "unknown_ingredient" };

    const response = await post({ alias: "ghee", canonicalId: CLARIFIED_BUTTER });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "unknown_ingredient" });
  });

  it.each([
    ["a blank alias", { alias: "   ", canonicalId: CLARIFIED_BUTTER }],
    ["an id that isn't a uuid", { alias: "ghee", canonicalId: "clarified butter" }],
    ["no alias at all", { canonicalId: CLARIFIED_BUTTER }],
    ["a body that isn't JSON", "ghee"],
  ])("rejects %s with 400, writing nothing", async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(calls).toEqual([]);
  });
});
