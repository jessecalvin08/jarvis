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

// Gemini's OpenAI-compatible endpoint accepts only a subset of JSON Schema and rejects the rest
// (additionalProperties, format, length limits…), so tool schemas are trimmed to that subset.
const GEMINI_SCHEMA_KEYS = new Set(["type", "description", "properties", "required", "items", "enum", "minimum", "maximum", "minItems", "maxItems", "nullable", "anyOf"]);

function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties") {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, geminiSchema(sub)]));
    } else if (key === "items" || key === "anyOf") {
      out[key] = geminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toolFor(t: TurnContext["tools"][number]): OpenAI.Chat.Completions.ChatCompletionTool {
  const schema = toJsonSchema(t);
  if (config.provider !== "gemini") return { type: "function", function: { name: t.name, description: t.description, parameters: schema } };
  const trimmed = geminiSchema(schema) as Record<string, unknown>;
  const empty = !trimmed.properties || Object.keys(trimmed.properties).length === 0;
  // Gemini rejects an object schema with no properties; a tool without parameters is fine.
  return { type: "function", function: { name: t.name, description: t.description, ...(empty ? {} : { parameters: trimmed }) } };
}

interface CallSlot {
  id: string;
  name: string;
  args: string;
}

/**
 * Streamed tool calls arrive in pieces. OpenAI keys them by `index`; Gemini may omit `index`
 * or reuse index 0 for parallel calls with different ids, so match on id when it disagrees.
 */
class CallAssembler {
  private slots = new Map<string, CallSlot>();
  private lastKey = "";

  add(tc: { index?: number; id?: string; function?: { name?: string; arguments?: string } }): void {
    let key: string;
    const byIndex = tc.index !== undefined ? this.slots.get(`i${tc.index}`) : undefined;
    if (tc.index !== undefined && !(tc.id && byIndex?.id && byIndex.id !== tc.id)) key = `i${tc.index}`;
    else if (tc.id) key = `d${tc.id}`;
    else key = this.lastKey || "i0";
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { id: "", name: "", args: "" };
      this.slots.set(key, slot);
    }
    this.lastKey = key;
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name && !slot.name) slot.name = tc.function.name;
    if (tc.function?.arguments) slot.args += tc.function.arguments;
  }

  calls(round: number): CallSlot[] {
    return [...this.slots.values()].filter((c) => c.name).map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
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
    const tools = ctx.tools.map(toolFor);

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
      const assembler = new CallAssembler();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          const visible = filter.push(delta.content);
          text += visible;
          if (visible) ctx.onText(visible);
        }
        for (const tc of delta?.tool_calls ?? []) assembler.add(tc);
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

      const valid = assembler.calls(round);
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
