import { z } from "zod";
import type { ServerEvent } from "../events.js";

export type ToolCategory = "files" | "apps" | "system" | "comms" | "web" | "memory" | "display" | "mcp";

export interface ToolImage {
  mediaType: "image/png" | "image/jpeg";
  data: string; // base64
}

export type ToolOutput = string | { text: string; images?: ToolImage[] };

export interface ToolContext {
  /** Push an event straight to the HUD (panels, notices). */
  emit: (event: ServerEvent) => void;
  signal: AbortSignal;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  category: ToolCategory;
  description: string;
  schema: S;
  /** Risky tools pause for the user's approval in the HUD before they run. */
  risky?: boolean | ((input: z.infer<S>) => boolean);
  /** One line shown in the HUD feed and the approval prompt. */
  summarize?: (input: z.infer<S>) => string;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput>;
  /** Raw JSON Schema; MCP tools supply this instead of a zod schema. */
  jsonSchema?: Record<string, unknown>;
  /** Only offer this tool to these providers (e.g. vision needs Claude). */
  providers?: Array<"anthropic" | "openai">;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function toJsonSchema(def: ToolDef): Record<string, unknown> {
  if (def.jsonSchema) return def.jsonSchema;
  const schema = z.toJSONSchema(def.schema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function isRisky(def: ToolDef, input: unknown): boolean {
  if (typeof def.risky === "function") return def.risky(input);
  return def.risky === true;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]` : text;
}
