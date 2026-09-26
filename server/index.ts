import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { config, describeModel, modelSetupProblem, ROOT } from "./config.js";
import type { ClientEvent, ServerEvent } from "./events.js";
import { Session } from "./session.js";
import { currentStats, startStats } from "./stats.js";
import { emailTools, gmailConfigured, unreadCount } from "./tools/email.js";
import { fileTools } from "./tools/files.js";
import { hudTools } from "./tools/hud.js";
import { closeMcp, loadMcpTools } from "./tools/mcp.js";
import { memoryTools } from "./tools/memory.js";
import { openTarget } from "./tools/open.js";
import { systemTools } from "./tools/system.js";
import type { ToolDef } from "./tools/types.js";
import { getWeather, webTools } from "./tools/web.js";

const builtins: ToolDef[] = [...fileTools, ...systemTools, ...emailTools, ...webTools, ...memoryTools, ...hudTools];

const allowedOrigins = new Set([`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);

/**
 * Jarvis can run commands on this machine, so only the HUD served by this process may talk to it.
 * Without this, any website open in the browser could connect to localhost and drive it.
 */
function trustedOrigin(origin: string | undefined, fetchSite: string | undefined): boolean {
  if (origin) return allowedOrigins.has(origin);
  return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use("/api", (req, res, next) => {
  if (!trustedOrigin(req.headers.origin, req.headers["sec-fetch-site"] as string | undefined)) {
    res.status(403).json({ error: "forbidden origin" });
    return;
  }
  next();
});
app.use(express.static(path.join(ROOT, "hud"), { extensions: ["html"] }));

app.get("/api/weather", async (_req, res) => {
  if (!config.location) {
    res.json({ error: "JARVIS_LOCATION not set" });
    return;
  }
  try {
    res.json(await getWeather(config.location));
  } catch (err) {
    res.json({ error: (err as Error).message });
  }
});

app.post("/api/tts", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 2000) : "";
  if (!config.tts.elevenLabsKey || !text) {
    res.status(400).json({ error: "ElevenLabs not configured" });
    return;
  }
  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.tts.elevenLabsVoice)}/stream?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": config.tts.elevenLabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: config.tts.elevenLabsModel,
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
        }),
      },
    );
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `ElevenLabs ${upstream.status}: ${(await upstream.text()).slice(0, 300)}` });
      return;
    }
    res.setHeader("Content-Type", "audio/mpeg");
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (info: { origin: string; req: http.IncomingMessage }) =>
    trustedOrigin(info.origin || undefined, info.req.headers["sec-fetch-site"] as string | undefined),
});

function broadcast(event: ServerEvent): void {
  const data = JSON.stringify(event);
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
}

const session = new Session(builtins, broadcast);
let lastInbox: ServerEvent | null = null;

wss.on("connection", (ws) => {
  const send = (e: ServerEvent) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(e));
  send(session.hello());
  send({ type: "stats", stats: currentStats() });
  if (lastInbox) send(lastInbox);

  ws.on("message", (raw) => {
    let ev: ClientEvent;
    try {
      ev = JSON.parse(String(raw)) as ClientEvent;
    } catch {
      return;
    }
    session.handle(ev);
  });
});

startStats((stats) => {
  if (wss.clients.size) broadcast({ type: "stats", stats });
});

async function pollInbox(): Promise<void> {
  if (!gmailConfigured()) return;
  try {
    lastInbox = { type: "inbox", unread: await unreadCount() };
  } catch (err) {
    lastInbox = { type: "inbox", unread: null, error: (err as Error).message };
  }
  broadcast(lastInbox);
}
void pollInbox();
setInterval(() => void pollInbox(), 3 * 60_000).unref();

server.listen(config.port, "127.0.0.1", () => {
  const url = `http://localhost:${config.port}`;
  const problem = modelSetupProblem();
  console.log(`\n  ${config.assistantName} online  ·  ${url}`);
  console.log(`  model: ${describeModel()}${problem ? `\n  ! ${problem}` : ""}`);
  console.log(`  gmail: ${gmailConfigured() ? config.gmail.address : "not configured"}  ·  voice: ${config.tts.provider}\n`);
  if (config.openBrowser) openTarget(url).catch(() => console.log(`  Open ${url} in Chrome or Edge.`));
});

void loadMcpTools((msg) => {
  console.log(`  [mcp] ${msg}`);
  broadcast({ type: "notice", message: msg });
}).then((mcp) => {
  if (mcp.length) session.setTools([...builtins, ...mcp]);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void closeMcp().finally(() => process.exit(0));
  });
}
