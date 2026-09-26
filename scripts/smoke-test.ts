/**
 * End-to-end check of the agent loop without spending API credits: a fake model server speaks the
 * Anthropic (or OpenAI) streaming protocol, asks for tools, and we assert what Jarvis does.
 *
 *   npm test
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.env.SMOKE_CHILD;

if (!mode) {
  const self = fileURLToPath(import.meta.url);
  let failed = false;
  for (const provider of ["anthropic", "openai"]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", self], { env: { ...process.env, SMOKE_CHILD: provider }, stdio: "inherit" });
    if (r.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

type Json = Record<string, unknown>;
const requests: Json[] = [];
const headers: http.IncomingHttpHeaders[] = [];

function sse(res: http.ServerResponse, events: Array<[string | null, Json | string]>): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const [name, data] of events) res.write(`${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  res.end();
}

/** Scripted replies, one per request: tool call(s) first, then a spoken answer. */
const script: Array<{ text: string; tool?: { name: string; input: Json } }> = [
  { text: "Pulling that up now, sir.", tool: { name: "find_files", input: { query: "smoke marker" } } },
  { text: "", tool: { name: "write_file", input: { path: "Documents/should-not-exist.txt", content: "nope" } } },
  { text: "Found it and opened nothing risky. Done, sir." },
];

function anthropicReply(res: http.ServerResponse, step: number): void {
  const s = script[step];
  const events: Array<[string, Json]> = [
    ["message_start", { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } } }],
  ];
  let i = 0;
  if (s.text) {
    events.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
    for (const word of s.text.split(/(?<= )/)) events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: word } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index: i }]);
    i++;
  }
  if (s.tool) {
    events.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: `toolu_${step}`, name: s.tool.name, input: {} } }]);
    const json = JSON.stringify(s.tool.input);
    events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(0, 8) } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(8) } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  }
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: s.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  sse(res, events);
}

function openaiReply(res: http.ServerResponse, step: number): void {
  const s = script[step];
  const chunk = (delta: Json, finish: string | null = null): [null, Json] => [null, { id: `c${step}`, object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] }];
  const events: Array<[null, Json | string]> = [];
  // Exercise the <think> filter the way local reasoning models emit it.
  if (s.text) events.push(chunk({ role: "assistant", content: "<think>internal musing</think>" }), chunk({ content: s.text }));
  if (s.tool) {
    const json = JSON.stringify(s.tool.input);
    events.push(chunk({ tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: s.tool.name, arguments: json.slice(0, 5) } }] }));
    events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(5) } }] }));
  }
  events.push(chunk({}, s.tool ? "tool_calls" : "stop"));
  events.push([null, "[DONE]"]);
  sse(res, events);
}

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const step = requests.length;
    requests.push(JSON.parse(body) as Json);
    headers.push(req.headers);
    if (mode === "anthropic") anthropicReply(res, step);
    else openaiReply(res, step);
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
const port = (fake.address() as { port: number }).port;

// A throwaway home folder so the search has something real to find.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-smoke-"));
fs.mkdirSync(path.join(home, "Documents", "Projects"), { recursive: true });
fs.writeFileSync(path.join(home, "Documents", "Projects", "Smoke_Marker_2026.txt"), "hello");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.JARVIS_VAULT_DIR = path.join(home, "vault");
process.env.LLM_PROVIDER = mode;
process.env.LLM_MODEL = mode === "anthropic" ? "claude-opus-5" : "test-model";
process.env.ANTHROPIC_API_KEY = "test";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OPENAI_API_KEY = "test";
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;

const { Session } = await import("../server/session.js");
const { fileTools } = await import("../server/tools/files.js");
type Ev = import("../server/events.js").ServerEvent;

const events: Ev[] = [];
let session!: InstanceType<typeof Session>;
const done = new Promise<void>((resolve) => {
  session = new Session(fileTools, (e) => {
    events.push(e);
    // Decline the risky write so we can check the model is told.
    if (e.type === "approval") setTimeout(() => session.handle({ type: "approve", id: e.id, approved: false }), 20);
    if (e.type === "turn_end") resolve();
  });
});
session.handle({ type: "user", text: "pull up my smoke marker file" });
await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 20_000))]);
fake.close();

const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (!ok) failures.push(what);
};
const types = events.map((e) => e.type);
const spoken = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
const toolEnds = events.filter((e): e is Extract<Ev, { type: "tool_end" }> => e.type === "tool_end");
const panel = events.find((e): e is Extract<Ev, { type: "panel" }> => e.type === "panel");

check(requests.length === 3, `expected 3 model requests, got ${requests.length}`);
check(toolEnds.some((e) => e.ok && e.summary.includes("smoke marker")), "find_files ran");
check(panel?.panel.items.some((i) => i.label === "Smoke_Marker_2026.txt"), "search panel lists the file");
check(types.includes("approval"), "write_file asked for approval");
check(toolEnds.some((e) => !e.ok && e.summary.startsWith("Declined")), "declined write reported");
check(!fs.existsSync(path.join(home, "Documents", "should-not-exist.txt")), "declined write did not happen");
check(spoken.includes("Pulling that up now") && spoken.includes("Done, sir."), "text streamed to HUD");
check(!spoken.includes("internal musing"), "<think> content hidden");
check(types.at(-1) === "state" && types.includes("turn_end"), "turn ended cleanly");

const serialized = JSON.stringify(requests);
check(serialized.includes("Smoke_Marker_2026.txt"), "tool result sent back to the model");
check(serialized.includes("declined"), "decline sent back to the model");
if (mode === "anthropic") {
  const first = requests[0];
  check(first.fallbacks === "default", "fallbacks: default set");
  check(String(headers[0]["anthropic-beta"]).includes("server-side-fallback-2026-07-01"), "fallback beta header sent");
  check((first.output_config as Json)?.effort === "low", "effort low");
  check((first.cache_control as Json)?.type === "ephemeral", "prompt caching on");
  const tools = first.tools as Json[];
  check(tools.every((t) => t.type === "web_search_20260209" || t.eager_input_streaming === true), "eager input streaming on client tools");
  check(tools.some((t) => t.type === "web_search_20260209"), "web search tool offered");
  check(!("$schema" in ((tools[0].input_schema as Json) ?? {})), "schema cleaned");
  const turnEnd = events.find((e): e is Extract<Ev, { type: "turn_end" }> => e.type === "turn_end");
  check((turnEnd?.sessionCostUsd ?? 0) > 0, "cost estimated");
}

fs.rmSync(home, { recursive: true, force: true });
if (failures.length) {
  console.error(`✗ ${mode}: ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  console.error(JSON.stringify(events, null, 1).slice(0, 3000));
  process.exit(1);
}
console.log(`✓ ${mode}: agent loop, tools, approvals and streaming all behave (${requests.length} model calls, ${events.length} HUD events)`);
process.exit(0);
