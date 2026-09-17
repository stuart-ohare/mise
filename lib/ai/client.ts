import Anthropic from "@anthropic-ai/sdk";

/**
 * The Anthropic SDK, used directly. No LangChain, no in-house wrapper.
 *
 * Two sizes, one API. Constraint extraction has short input and a small schema
 * and runs on every Cook request, so it gets the fast model. Recipe extraction
 * has long, messy input where a mistake is expensive — and needs vision for the
 * handwritten-card path — so it gets the larger one. One model for both would be
 * either slow or sloppy.
 *
 * The abstraction here is thin enough that swapping providers is a day's work,
 * and the eval suite is what that decision would be made on.
 */

export const MODELS = {
  /** Constraint extraction: free text -> typed constraints. */
  fast: "claude-haiku-4-5",
  /** Recipe extraction and ranking: long input, vision, expensive mistakes. */
  capable: "claude-sonnet-4-5",
} as const;

export type ModelName = (typeof MODELS)[keyof typeof MODELS];

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local.");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}
