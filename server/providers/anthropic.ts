import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { toJsonSchema } from "../tools/types.js";
import { MAX_TOOL_ROUNDS, RefusalError, type ChatProvider, type ToolRunResult, type TurnContext } from "./types.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

// Capability gates by model family, so switching LLM_MODEL in .env never produces a 400.
const supportsEffort = (m: string) => /^claude-(opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|fable|mythos)/.test(m);
const supportsDefaultFallback = (m: string) => /^claude-(opus-5|fable-5-1)/.test(m);
const modernWebSearch = (m: string) => /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/.test(m);

/**
 * After a mid-output fallback, blocks before the last `fallback` marker came from the model
 * that declined: only its text may be echoed back. Everything after the marker is normal.
 */
function echoable(content: ContentBlock[]): ContentBlock[] {
  let boundary = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") boundary = i;
  });
  if (boundary < 0) return content;
  return [...content.slice(0, boundary).filter((b) => b.type === "text"), ...content.slice(boundary + 1)];
}

function toToolResult(id: string, r: ToolRunResult): Anthropic.Beta.BetaToolResultBlockParam {
  const content: Anthropic.Beta.BetaToolResultBlockParam["content"] = r.images?.length
    ? [
        { type: "text", text: r.text },
        ...r.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.data } })),
      ]
    : r.text;
  return { type: "tool_result", tool_use_id: id, content, ...(r.isError ? { is_error: true } : {}) };
}

export class AnthropicProvider implements ChatProvider {
  private client = new Anthropic({ apiKey: config.anthropicApiKey || undefined, maxRetries: 2, timeout: 120_000 });
  private history: MessageParam[] = [];

  reset(): void {
    this.history = [];
  }

  private request(ctx: TurnContext) {
    const model = config.model;
    const tools: Anthropic.Beta.BetaToolUnion[] = ctx.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toJsonSchema(t) as Anthropic.Beta.BetaTool.InputSchema,
      // Stream tool inputs as they're generated; inputs are validated in the session before running.
      eager_input_streaming: true,
    }));
    if (config.webSearch) {
      tools.push(
        modernWebSearch(model)
          ? { type: "web_search_20260209", name: "web_search", max_uses: 5 }
          : { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      );
    }
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: ctx.system.stable }];
    if (ctx.system.dynamic) system.push({ type: "text", text: ctx.system.dynamic });

    return {
      model,
      max_tokens: 16_000,
      system,
      tools,
      messages: this.history,
      // Caches tools + system + history up to the newest turn, so follow-ups are fast and cheap.
      cache_control: { type: "ephemeral" as const },
      ...(supportsEffort(model) ? { output_config: { effort: config.effort } } : {}),
      // If a safety classifier declines, the API retries on Anthropic's recommended model instead of failing.
      ...(supportsDefaultFallback(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
  }

  async send(userText: string, ctx: TurnContext): Promise<void> {
    this.history.push({ role: "user", content: userText });
    let badJson = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = this.client.beta.messages.stream(this.request(ctx), { signal: ctx.signal });
      stream.on("text", (delta) => ctx.onText(delta));

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        badJson = 0;
      } catch (err) {
        // Only a tool input the SDK couldn't parse as JSON is retried; API errors and aborts propagate.
        if (ctx.signal.aborted || err instanceof Anthropic.APIError || ++badJson > 2) throw err;
        continue;
      }

      const u = message.usage;
      ctx.onUsage({
        model: message.model,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        webSearches: u.server_tool_use?.web_search_requests ?? 0,
      });

      // Check stop_reason before touching content: a refusal may carry a partial answer to discard.
      if (message.stop_reason === "refusal") {
        throw new RefusalError(message.stop_details?.explanation ?? "declined");
      }

      const content = echoable(message.content);
      if (content.length) this.history.push({ role: "assistant", content: content as Anthropic.Beta.BetaContentBlockParam[] });

      // A server tool (web search) hit its per-turn limit; sending the history back resumes it.
      if (message.stop_reason === "pause_turn") continue;

      const toolUses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!toolUses.length) return;

      const results =
        message.stop_reason === "max_tokens"
          ? toolUses.map((t) => toToolResult(t.id, { text: "Tool input was cut off by the output limit. Try again with a shorter input.", isError: true }))
          : await Promise.all(toolUses.map(async (t) => toToolResult(t.id, await ctx.runTool(t.id, t.name, t.input))));
      this.history.push({ role: "user", content: results });
      if (ctx.signal.aborted) return;
    }
    ctx.onText(" I've reached my step limit for this request.");
  }
}
