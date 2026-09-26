import OpenAI from "openai";
import { config } from "../config.js";
import { toJsonSchema } from "../tools/types.js";
import { MAX_TOOL_ROUNDS, type ChatProvider, type TurnContext } from "./types.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Hides <think>…</think> reasoning that local models (Qwen, DeepSeek) print into their answer. */
class ThinkFilter {
  private buf = "";
  private inside = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inside) {
        const end = this.buf.indexOf("</think>");
        if (end < 0) {
          this.buf = this.buf.slice(-8);
          return out;
        }
        this.buf = this.buf.slice(end + 8);
        this.inside = false;
      } else {
        const start = this.buf.indexOf("<think>");
        if (start < 0) {
          // Hold back a possible partial "<think" at the end.
          const safe = this.buf.length - 7;
          if (safe > 0) {
            out += this.buf.slice(0, safe);
            this.buf = this.buf.slice(safe);
          }
          return out;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inside = true;
      }
    }
  }

  flush(): string {
    const rest = this.inside ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

/** OpenAI, Groq, OpenRouter, Gemini, Ollama, LM Studio - anything speaking the Chat Completions protocol. */
export class OpenAICompatibleProvider implements ChatProvider {
  private client = new OpenAI({
    apiKey: config.openaiCompat?.apiKey || "none",
    baseURL: config.openaiCompat?.baseURL,
    maxRetries: 2,
    timeout: 120_000,
  });
  private history: Msg[] = [];

  reset(): void {
    this.history = [];
  }

  async send(userText: string, ctx: TurnContext): Promise<void> {
    this.history.push({ role: "user", content: userText });
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = ctx.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: toJsonSchema(t) },
    }));

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = await this.client.chat.completions.create(
        {
          model: config.model,
          messages: [{ role: "system", content: `${ctx.system.stable}\n\n${ctx.system.dynamic}`.trim() }, ...this.history],
          ...(tools.length ? { tools } : {}),
          stream: true,
          ...(config.provider === "openai" || config.provider === "openrouter" ? { stream_options: { include_usage: true } } : {}),
        },
        { signal: ctx.signal },
      );

      const filter = new ThinkFilter();
      let text = "";
      const calls: Array<{ id: string; name: string; args: string }> = [];
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          const visible = filter.push(delta.content);
          text += visible;
          if (visible) ctx.onText(visible);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name && !slot.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        if (chunk.usage) {
          ctx.onUsage({
            model: config.model,
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            webSearches: 0,
          });
        }
      }
      const tail = filter.flush();
      if (tail) {
        text += tail;
        ctx.onText(tail);
      }

      const valid = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
      this.history.push({
        role: "assistant",
        content: text || null,
        ...(valid.length
          ? { tool_calls: valid.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } })) }
          : {}),
      });
      if (!valid.length) return;

      const results = await Promise.all(
        valid.map(async (c) => {
          let input: unknown;
          try {
            input = c.args ? JSON.parse(c.args) : {};
          } catch {
            return { id: c.id, text: `Invalid JSON arguments: ${c.args}` };
          }
          const r = await ctx.runTool(c.id, c.name, input);
          return { id: c.id, text: r.images?.length ? `${r.text}\n[image omitted: this provider can't receive images]` : r.text };
        }),
      );
      for (const r of results) this.history.push({ role: "tool", tool_call_id: r.id, content: r.text });
      if (ctx.signal.aborted) return;
    }
    ctx.onText(" I've reached my step limit for this request.");
  }
}
