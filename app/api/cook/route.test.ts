import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The HTTP shell only: the branches that exist in `route.ts` rather than in `runCook`.
 * The database client is mocked because importing it needs `DATABASE_URL`, and because
 * what is asserted here is which rows the sink builds, not that Postgres accepts them.
 */

const inserted: unknown[][] = [];

vi.mock("@/lib/db/client", () => ({
  db: {
    insert: () => ({
      values: (rows: unknown[]) => {
        inserted.push(rows);
        return Promise.resolve();
      },
    }),
  },
}));

const { POST, deps } = await import("./route");

beforeEach(() => {
  inserted.length = 0;
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/cook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/cook", () => {
  it("rejects a body that is neither request shape, without querying anything", async () => {
    const response = await post({ kind: "nonsense" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    // Nothing downstream ran: no extraction, no query, no model call.
    expect(inserted).toEqual([]);
  });

  it("rejects a request with no kind at all", async () => {
    const response = await post({ query: "something quick" });

    expect(response.status).toBe(400);
  });

  it("rejects constraints that are not the shape the domain defines", async () => {
    const response = await post({ kind: "constraints", constraints: { exclude: "dairy" } });

    expect(response.status).toBe(400);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/cook", { method: "POST", body: "not json" }),
    );

    expect(response.status).toBe(400);
  });

  // @gate output
  it("writes one output_violation row per matched term", async () => {
    await deps.recordViolation({
      attempt: 1,
      matchedTerms: ["ghee", "butter"],
      generated: '{"ranking":[{"rationale":"ghee and butter"}]}',
      retrySucceeded: false,
      constraints: { exclude: ["dairy"], avoid: [], have: [], maxMinutes: null },
      query: "no dairy",
      promptVersion: "1",
    });

    // The column is `matched_term`, singular: counting which foods the prose reaches
    // for is the reason the table exists, and one row naming two would not count.
    const [rows] = inserted;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({ matchedTerm: "ghee", promptVersion: "1", query: "no dairy" }),
      expect.objectContaining({ matchedTerm: "butter", retrySucceeded: false }),
    ]);
    expect(rows?.[0]).toMatchObject({ excluded: ["dairy"] });
  });
});
