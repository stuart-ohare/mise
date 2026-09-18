import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The HTTP shell only: the branches that exist in `route.ts` rather than in `runIntake`.
 * The database client is mocked because importing it needs `DATABASE_URL`, and what is
 * asserted here is which bodies get past the boundary, not that Postgres accepts a row.
 */

const transactions: unknown[] = [];

vi.mock("@/lib/db/client", () => ({
  db: {
    transaction: (fn: unknown) => {
      transactions.push(fn);
      return Promise.reject(new Error("no database in this test"));
    },
  },
}));

const { MAX_IMAGE_DATA_URI_LENGTH } = await import("@/lib/domain/image-input");
const { POST } = await import("./route");

beforeEach(() => {
  transactions.length = 0;
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/intake", () => {
  it("rejects a body that isn't the request shape, without extracting anything", async () => {
    // #73 made `image` a valid sourceKind, so the unknown kind here is a third one. The
    // case is still worth keeping: it is what proves the discriminant is closed rather
    // than a string the union waves through.
    const response = await post({ sourceKind: "audio", raw: "…" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    // Nothing downstream ran: no model call, no query, no write.
    expect(transactions).toEqual([]);
  });

  it("rejects a payload that isn't an image before the model sees it", async () => {
    // A PDF is a document the capable model could read — but not through an image block,
    // and not on a route that promised a photograph.
    for (const raw of [
      "data:application/pdf;base64,JVBERi0xLjQK",
      "data:text/plain;base64,aGVsbG8=",
      "https://example.com/card.jpg",
    ]) {
      const response = await post({ sourceKind: "image", raw });

      expect(response.status, raw).toBe(400);
      expect(transactions, raw).toEqual([]);
    }
  });

  it("rejects an oversized image at the boundary, not at the API", async () => {
    const prefix = "data:image/jpeg;base64,";
    const raw = prefix + "A".repeat(MAX_IMAGE_DATA_URI_LENGTH - prefix.length + 1);

    const response = await post({ sourceKind: "image", raw });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    // The point of the cap: a 4 MiB body costs nothing, because no call was made.
    expect(transactions).toEqual([]);
  });

  it("rejects a request with no sourceKind at all", async () => {
    const response = await post({ raw: "150g plain flour" });

    expect(response.status).toBe(400);
    expect(transactions).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/intake", { method: "POST", body: "not json" }),
    );

    expect(response.status).toBe(400);
    expect(transactions).toEqual([]);
  });

  it("answers a blank paste with an outcome rather than a 400", async () => {
    // An empty textarea is something the cook did, not a malformed request, so it takes
    // the same route a failed extraction does — and it never reaches the model.
    const response = await post({ sourceKind: "text", raw: "   " });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      kind: "not_extracted",
      reason: "empty_input",
    });
    expect(transactions).toEqual([]);
  });
});
