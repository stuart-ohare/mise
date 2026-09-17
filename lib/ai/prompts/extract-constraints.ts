import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";

import { anthropic } from "@/lib/ai/client";
import type { Constraints } from "@/lib/domain/constraints";

export const VERSION = "0";

export const SYSTEM = "";

export type ExtractionResult =
  | { ok: true; constraints: Constraints }
  | { ok: false; reason: "empty_query" | "refused" | "parse_failed" | "api_error" };

export interface ConstraintsClient {
  messages: {
    parse(params: MessageCreateParamsNonStreaming): PromiseLike<{ stop_reason: string | null; parsed_output: unknown }>;
  };
}

export async function extractConstraints(
  query: string,
  client: ConstraintsClient = anthropic(),
): Promise<ExtractionResult> {
  void query;
  void client;
  throw new Error("not implemented");
}
