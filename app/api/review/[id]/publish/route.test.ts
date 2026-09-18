// @gate resolution
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishResult } from "@/lib/db/publish";

/**
 * The HTTP shell only: which status and body each outcome of `publishDraft` becomes, and
 * that the decision is made from the path alone. The SQL is pinned by
 * lib/db/publish.db.test.ts. The database client is mocked because importing it needs
 * `DATABASE_URL`.
 */

vi.mock("@/lib/db/client", () => ({
  db: {
    transaction: () => Promise.reject(new Error("no database in this test")),
  },
}));

const { POST, deps } = await import("./route");

const RECIPE_ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c5d7e9f0a3b";
const calls: string[] = [];
let outcome: PublishResult = { kind: "published" };

beforeEach(() => {
  calls.length = 0;
  deps.publish = (recipeId) => {
    calls.push(recipeId);
    return Promise.resolve(outcome);
  };
});

// A bare POST: no body, no headers, no cookies. Whatever the review screen rendered, none
// of it reaches the handler — the id in the path is the only input.
function publish(id: string): Promise<Response> {
  return POST(new Request(`http://localhost/api/review/${id}/publish`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

describe("POST /api/review/:id/publish", () => {
  it("refuses a direct call to publish a draft with an unresolved line, naming the line", async () => {
    outcome = {
      kind: "unresolved",
      lines: [{ id: "a1b2c3d4-0000-4000-8000-000000000001", rawText: "2 tbsp ghee, melted" }],
    };

    const response = await publish(RECIPE_ID);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "unresolved_ingredients",
      lines: [{ id: "a1b2c3d4-0000-4000-8000-000000000001", rawText: "2 tbsp ghee, melted" }],
    });
    expect(calls).toEqual([RECIPE_ID]);
  });

  it("answers a publish with 200 ok", async () => {
    outcome = { kind: "published" };

    const response = await publish(RECIPE_ID);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("refuses a recipe that is already published with 409", async () => {
    outcome = { kind: "already_published" };

    const response = await publish(RECIPE_ID);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "already_published" });
  });

  it("answers an unknown id with 404", async () => {
    outcome = { kind: "not_found" };

    const response = await publish(RECIPE_ID);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("answers an id that isn't a uuid with 404, without querying", async () => {
    // It names no recipe, and handed to Postgres it would be a cast error and a 500.
    const response = await publish("not-a-uuid");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect(calls).toEqual([]);
  });
});
