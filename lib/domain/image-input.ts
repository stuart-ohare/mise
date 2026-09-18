import { z } from "zod";

/**
 * The image half of Intake's input boundary: what counts as a photograph of a recipe
 * card, and how to take it apart for the model.
 *
 * A photograph arrives as a data URI rather than a file upload or an object-storage key.
 * That is a deliberate trade (#73): storage is a "deliberately absent" item in
 * CLAUDE.md §2, and a key pointing into a bucket that doesn't exist in a fresh clone
 * would break the §5 path and leave a reviewer looking at a dead link where the card
 * should be. The URI goes in `extraction_job.raw_input` whole, so /review can show the
 * actual card the model read.
 *
 * The cost is that a few megabytes of base64 live in a text column, which is why the cap
 * below is a boundary rule and not a suggestion.
 */

/**
 * The four the Anthropic API's base64 image source accepts. Anything else — a PDF, an
 * SVG, a text file wearing a data URI — fails here rather than at the API, so the
 * rejection is ours to explain and never costs a call.
 */
export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * 6 MiB of data URI, roughly 4.7 MB of image once the base64 is decoded — still under the
 * API's 5 MB per-image limit, so a payload that passes this boundary is one the model will
 * accept: an oversized card is rejected in one place, with one reason.
 *
 * The first cut was 4 MiB. Three real photographed cards put that right: one was 3.2 MB
 * and bounced, and the one that passed had 22% to spare. A cap that rejects an ordinary
 * phone photo of a recipe card is not protecting anything — resizing is out of scope
 * (#73), so the number moves instead.
 */
export const MAX_IMAGE_DATA_URI_LENGTH = 6 * 1024 * 1024;

/**
 * The same cap as a picture size, for anything that has to say it to a person. Base64
 * carries three bytes in four characters, so the limit a photographer experiences is
 * smaller than the limit the column holds — telling them "4 MB" would reject a 3.5 MB
 * JPEG while claiming it was within the rule.
 */
export const MAX_IMAGE_MB = Math.floor((MAX_IMAGE_DATA_URI_LENGTH * 3) / 4 / 1_000_000);

const DATA_URI = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * The schema Intake's request uses. Length is checked before the pattern so an oversized
 * payload reports its size rather than failing as "malformed".
 */
export const imageDataUriSchema = z
  .string()
  .max(MAX_IMAGE_DATA_URI_LENGTH, "image is larger than 4 MiB")
  .regex(DATA_URI, "expected a base64 data URI for a JPEG, PNG, GIF or WebP image");

export type ParsedImage = { mediaType: ImageMediaType; data: string };

/**
 * Split a URI that has already passed `imageDataUriSchema` into the two fields the
 * Anthropic image block wants. Returns null rather than throwing on anything else, so a
 * caller that skipped the schema has to handle the miss instead of inheriting an
 * exception.
 */
export function parseImageDataUri(uri: string): ParsedImage | null {
  const match = DATA_URI.exec(uri);
  if (!match) return null;

  const [, mediaType, data] = match;
  // The pattern's first group is exactly the union, but the match is strings to
  // TypeScript, and §6 says parse rather than assert.
  const parsed = z.enum(IMAGE_MEDIA_TYPES).safeParse(mediaType);
  if (!parsed.success || data === undefined) return null;

  return { mediaType: parsed.data, data };
}
