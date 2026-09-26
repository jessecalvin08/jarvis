import type { ToolDef, ToolImage } from "../tools/types.js";

export interface ToolRunResult {
  text: string;
  images?: ToolImage[];
  isError: boolean;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export interface TurnContext {
  tools: ToolDef[];
  /** Stable instructions (cache-friendly) and the part that changes (memory). */
  system: { stable: string; dynamic: string };
  signal: AbortSignal;
  onText: (delta: string) => void;
  onUsage: (usage: Usage) => void;
  runTool: (id: string, name: string, input: unknown) => Promise<ToolRunResult>;
}

export interface ChatProvider {
  /** Runs one user turn to completion, including any tool calls, and keeps the history. */
  send(userText: string, ctx: TurnContext): Promise<void>;
  reset(): void;
}

/** A spoken fallback when the model declines. */
export class RefusalError extends Error {}

export const MAX_TOOL_ROUNDS = 25;
