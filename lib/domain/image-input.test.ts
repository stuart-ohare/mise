// @gate resolution
import { describe, expect, it } from "vitest";

import {
  imageDataUriSchema,
  MAX_IMAGE_DATA_URI_LENGTH,
  parseImageDataUri,
} from "./image-input";

/**
 * The boundary that decides whether a payload becomes an image block at all. Everything
 * here is about rejecting before the model call, not after it.
 */

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("imageDataUriSchema", () => {
  it("accepts each media type the API's base64 image source accepts", () => {
    for (const type of ["jpeg", "png", "gif", "webp"]) {
      const uri = `data:image/${type};base64,iVBORw0KGgo=`;
      expect(imageDataUriSchema.safeParse(uri).success, type).toBe(true);
    }
  });

  it("rejects a payload that isn't an image", () => {
    // A PDF is the interesting case: a real data URI, real base64, and a document the
    // model could read — but not through an image block.
    for (const uri of [
      "data:application/pdf;base64,JVBERi0xLjQK",
      "data:text/plain;base64,aGVsbG8=",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "not a data uri at all",
      "data:image/png;base64,",
      "data:image/png,iVBORw0KGgo=",
    ]) {
      expect(imageDataUriSchema.safeParse(uri).success, uri).toBe(false);
    }
  });

  it("rejects an oversized image before anything downstream sees it", () => {
    const prefix = "data:image/jpeg;base64,";
    const oversized = prefix + "A".repeat(MAX_IMAGE_DATA_URI_LENGTH - prefix.length + 1);

    const result = imageDataUriSchema.safeParse(oversized);
    expect(result.success).toBe(false);
    expect(oversized.length).toBeGreaterThan(MAX_IMAGE_DATA_URI_LENGTH);
    // One character under the cap is fine: the limit is a limit, not a rounding.
    expect(imageDataUriSchema.safeParse(oversized.slice(0, -1)).success).toBe(true);
  });
});

describe("parseImageDataUri", () => {
  it("splits a valid URI into the two fields the image block wants", () => {
    expect(parseImageDataUri(PIXEL)).toEqual({
      mediaType: "image/png",
      data: PIXEL.slice("data:image/png;base64,".length),
    });
  });

  it("returns null rather than throwing on anything else", () => {
    expect(parseImageDataUri("data:application/pdf;base64,JVBERi0=")).toBeNull();
    expect(parseImageDataUri("")).toBeNull();
  });
});
