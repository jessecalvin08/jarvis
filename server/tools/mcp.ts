import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { config } from "../config.js";
import { truncate, type ToolDef, type ToolImage, type ToolOutput } from "./types.js";

/**
 * Same shape as Claude Desktop's claude_desktop_config.json, so servers can be copied across.
 * Extra keys: `disabled`, and `autoApprove` (true, or a list of tool names that skip confirmation).
 */
interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: boolean | string[];
}

const clients: Client[] = [];

function toolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function toOutput(result: { content?: unknown; isError?: boolean; structuredContent?: unknown }): ToolOutput {
  const parts = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  const texts: string[] = [];
  const images: ToolImage[] = [];
  for (const p of parts) {
    if (p.type === "text") texts.push(String(p.text));
    else if (p.type === "image" && (p.mimeType === "image/png" || p.mimeType === "image/jpeg")) images.push({ mediaType: p.mimeType, data: String(p.data) });
    else if (p.type === "resource") texts.push(JSON.stringify(p.resource));
  }
  if (!texts.length && result.structuredContent) texts.push(JSON.stringify(result.structuredContent));
  const text = truncate(`${result.isError ? "Error: " : ""}${texts.join("\n") || "(no output)"}`, 20_000);
  return images.length ? { text, images } : text;
}

async function connect(name: string, s: ServerConfig): Promise<ToolDef[]> {
  let transport: Transport;
  if (s.url) {
    transport = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers } });
  } else if (s.command) {
    transport = new StdioClientTransport({
      command: s.command,
      args: s.args ?? [],
      env: { ...getDefaultEnvironment(), ...(s.env ?? {}) },
      stderr: "ignore",
    });
  } else {
    throw new Error("needs either `command` or `url`");
  }
  const client = new Client({ name: "jarvis", version: "2.0.0" });
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 45s")), 45_000)),
  ]);
  clients.push(client);

  const defs: ToolDef[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      const approved = s.autoApprove === true || (Array.isArray(s.autoApprove) && s.autoApprove.includes(t.name));
      const schema: Record<string, unknown> = { ...(t.inputSchema as Record<string, unknown>), type: "object" };
      delete schema.$schema;
      defs.push({
        name: toolName(name, t.name),
        category: "mcp",
        description: `[${name}] ${t.description ?? t.name}`.slice(0, 1000),
        schema: z.record(z.string(), z.unknown()),
        jsonSchema: schema,
        risky: !approved && t.annotations?.readOnlyHint !== true,
        summarize: (input) => `${name} → ${t.name} ${truncate(JSON.stringify(input), 300)}`,
        async run(input, ctx) {
          const res = await client.callTool({ name: t.name, arguments: input as Record<string, unknown> }, undefined, {
            signal: ctx.signal,
            timeout: 180_000,
          });
          return toOutput(res as { content?: unknown; isError?: boolean });
        },
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return defs;
}

/** Starts every MCP server in mcp.json. Failures are reported, not fatal. */
export async function loadMcpTools(log: (msg: string) => void): Promise<ToolDef[]> {
  if (!fs.existsSync(config.mcpConfigPath)) return [];
  let servers: Record<string, ServerConfig>;
  try {
    servers = (JSON.parse(fs.readFileSync(config.mcpConfigPath, "utf8")) as { mcpServers?: Record<string, ServerConfig> }).mcpServers ?? {};
  } catch (err) {
    log(`mcp.json is not valid JSON: ${(err as Error).message}`);
    return [];
  }
  const entries = Object.entries(servers).filter(([, s]) => !s.disabled);
  const results = await Promise.allSettled(entries.map(([name, s]) => connect(name, s)));
  const tools: ToolDef[] = [];
  results.forEach((r, i) => {
    const name = entries[i][0];
    if (r.status === "fulfilled") {
      tools.push(...r.value);
      log(`MCP "${name}" connected with ${r.value.length} tools.`);
    } else {
      log(`MCP "${name}" failed to start: ${(r.reason as Error).message}`);
    }
  });
  return tools;
}

export async function closeMcp(): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
}
