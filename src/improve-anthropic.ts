import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { MODEL_FOR, type ModelStage } from "./improve-schema";

export type ModelEnv = Pick<Env, "ANTHROPIC_API_KEY">;


// Per million tokens. Estimate only. Unknown models cost at the highest listed rate, not zero.
const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // The documented fallback target for a policy decline on Opus 5.
  "claude-opus-4-8": { input: 5, output: 25 },
};

const HIGHEST_RATE = { input: 5, output: 25 };

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costOf(model: string, usage: UsageLike): number {
  const rate = RATES[model] ?? HIGHEST_RATE;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input * rate.input + cacheWrite * rate.input * 1.25 + cacheRead * rate.input * 0.1 + output * rate.output) /
    1_000_000
  );
}

export interface ModelCall {
  stage: ModelStage;
  system: string;
  user: string;
  // A JSON Schema. The response is constrained to it (output_config.format, a
  // guarantee rather than a prompt request) and `parsed` carries the object.
  schema?: Record<string, unknown>;
  maxTokens?: number;
  // Content stable across a run (the repository context), cached. A separate field
  // because prompt caching is a prefix match: the stable bytes must precede the
  // growing attempt history. See the ordering note in src/improve-attempt.ts.
  cachedPrefix?: string;
}

export interface ModelResult {
  model: string;
  text: string;
  parsed: unknown;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  // Surfaced so a cache that stops working is visible (reads stay 0). Logged by the
  // attempt path.
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // A policy decline is neither an error nor an empty answer; each caller decides what
  // it means. A field, so no caller mistakes an empty `text` for "nothing to say".
  refused: boolean;
  refusalCategory: string | null;
}

// These stages run on Opus 5, whose safety classifiers can decline a request, so they
// opt in to fallbacks ("default", which follows the refusal category).
const OPUS_STAGES = new Set<ModelStage>(["abstract", "meta"]);
// Haiku 4.5 rejects the effort parameter and adaptive thinking with a 400.
const NO_EFFORT_STAGES = new Set<ModelStage>(["triage", "monitor"]);

export function clientFor(env: ModelEnv): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "improve_mode is 'api' but ANTHROPIC_API_KEY is not set. Set it with `wrangler secret put ANTHROPIC_API_KEY`, or switch the mode to 'subscription' or 'off'."
    );
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export async function callModel(env: ModelEnv, call: ModelCall): Promise<ModelResult> {
  const client = clientFor(env);
  const model = MODEL_FOR[call.stage];
  const isOpus = OPUS_STAGES.has(call.stage);
  const noEffort = NO_EFFORT_STAGES.has(call.stage);

  // Keeps a non-streaming request under the SDK's HTTP timeout. The attempt stage
  // streams instead (callModelStreaming).
  const maxTokens = call.maxTokens ?? 16_000;

  const outputConfig: Record<string, unknown> = {};
  // xhigh is the documented setting for coding and agentic work.
  if (!noEffort) outputConfig.effort = "xhigh";
  if (call.schema) outputConfig.format = { type: "json_schema", schema: call.schema };

  const response = await client.beta.messages.create({
    model,
    max_tokens: maxTokens,
    system: call.system,
    messages: [{ role: "user", content: call.user }],
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    ...(isOpus ? { betas: ["server-side-fallback-2026-07-01" as const], fallbacks: "default" as const } : {}),
  });

  return readResponse(model, response);
}

// The attempt stage, streamed, because a code change can run long enough to hit the
// SDK's HTTP timeout.
export async function callModelStreaming(env: ModelEnv, call: ModelCall): Promise<ModelResult> {
  const client = clientFor(env);
  const model = MODEL_FOR[call.stage];

  // Two cache breakpoints, at the end of the system prompt and of the cached prefix,
  // both fixed for a whole run. The volatile part (attempt history, any transferred
  // skill) goes after both, so later attempts in the run read the cache.
  const cache = { type: "ephemeral" as const };
  const messages = call.cachedPrefix
    ? [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: call.cachedPrefix, cache_control: cache },
            { type: "text" as const, text: call.user },
          ],
        },
      ]
    : [{ role: "user" as const, content: call.user }];

  const stream = client.beta.messages.stream({
    model,
    max_tokens: call.maxTokens ?? 64_000,
    system: [{ type: "text", text: call.system, cache_control: cache }],
    messages,
    output_config: {
      effort: "xhigh",
      ...(call.schema ? { format: { type: "json_schema", schema: call.schema } } : {}),
    },
  });
  return readResponse(model, await stream.finalMessage());
}

// One reader for both call paths, so the refusal check and cost cannot diverge.
function readResponse(requestedModel: string, response: Anthropic.Beta.BetaMessage): ModelResult {
  // Checked before content is read: on a decline `content` is empty or partial.
  const refused = response.stop_reason === "refusal";
  const refusalCategory = refused ? (response.stop_details?.category ?? null) : null;

  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // With structured outputs the text is the JSON. A parse failure gives null, which a
  // caller reads as "the model did not answer".
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  // Summed over iterations when present: top-level usage covers only the attempt that
  // produced the message, not a declined attempt before a fallback.
  const iterations = (response.usage as { iterations?: Array<{ usage?: UsageLike; model?: string }> }).iterations;
  const costUsd =
    Array.isArray(iterations) && iterations.length > 0
      ? iterations.reduce((sum, entry) => sum + costOf(entry.model ?? response.model ?? requestedModel, entry.usage ?? {}), 0)
      : costOf(response.model ?? requestedModel, response.usage);

  return {
    // With fallbacks on, not always the model asked for.
    model: response.model ?? requestedModel,
    text,
    parsed,
    costUsd,
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    refused,
    refusalCategory,
  };
}
