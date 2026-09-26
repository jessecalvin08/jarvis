import type { Usage } from "./types.js";

/** USD per million tokens [input, output]. Estimates only - check your provider's pricing page. */
const PRICES: Array<[RegExp, number, number]> = [
  [/^claude-(fable|mythos)/, 10, 50],
  [/^claude-opus-5-5/, 4, 20],
  [/^claude-opus-(5|4-[5-8])/, 5, 25],
  [/^claude-sonnet-5/, 2, 10],
  [/^claude-sonnet-4/, 3, 15],
  [/^claude-haiku-4/, 1, 5],
];

export function estimateCost(u: Usage): number {
  const price = PRICES.find(([re]) => re.test(u.model));
  if (!price) return 0; // unknown or local model
  const [, input, output] = price;
  const tokens =
    (u.inputTokens * input + u.cacheWriteTokens * input * 1.25 + u.cacheReadTokens * input * 0.1 + u.outputTokens * output) / 1_000_000;
  return tokens + u.webSearches * 0.01;
}
