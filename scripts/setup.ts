/**
 * First-run setup: asks a few questions, writes .env, checks the model key and (optionally)
 * downloads the offline voice models.
 *
 *   npm run setup                 ask everything
 *   npm run setup -- --if-needed  only if .env is missing or has no key (Jarvis.cmd uses this)
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const TEMPLATE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

// The line iterator queues input, so this works when answers are typed or piped in.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string, fallback = ""): Promise<string> {
  // In a real terminal readline redraws the line with its own prompt, which would wipe a plain
  // stdout.write - so the question has to be readline's prompt.
  rl.setPrompt(question);
  rl.prompt();
  const { value, done } = await lines.next();
  if (done) {
    process.stdout.write("\n");
    return fallback;
  }
  return String(value).trim() || fallback;
}

const yes = (answer: string) => /^y(es)?$/i.test(answer);

function quote(value: string): string {
  if (!/[\s#'"]/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/** Fills answers into the commented template so the result is still self-documenting. */
function render(answers: Record<string, string>): string {
  return TEMPLATE.split("\n")
    .map((line) => {
      const m = /^([A-Z0-9_]+)=/.exec(line);
      return m && m[1] in answers ? `${m[1]}=${quote(answers[m[1]])}` : line;
    })
    .join("\n");
}

function save(answers: Record<string, string>): void {
  fs.writeFileSync(ENV_PATH, render(answers), "utf8");
}

async function checkClaudeKey(key: string): Promise<void> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  try {
    await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
    console.log("  ✓ Claude accepted the key.\n");
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.log("  ✗ Anthropic rejected that key. Fix ANTHROPIC_API_KEY in .env (or run npm run setup again).\n");
    } else if (err instanceof Anthropic.APIConnectionError) {
      console.log("  ! Couldn't reach Anthropic to check the key (no internet?). Saved it anyway.\n");
    } else {
      console.log(`  ! Couldn't verify the key: ${(err as Error).message}\n`);
    }
  }
}

const KEY_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * Checks a key against an OpenAI-compatible /models endpoint and picks the first preferred model
 * the key can use, so a retired model name never breaks a fresh install.
 */
async function pickModel(baseURL: string, key: string, preferred: string[]): Promise<string | null> {
  try {
    const res = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      console.log("  ✗ That key was rejected. Copy it again and run npm run setup.\n");
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = ((await res.json()) as { data?: Array<{ id: string }> }).data?.map((m) => m.id.replace(/^models\//, "")) ?? [];
    const model = preferred.find((p) => ids.includes(p));
    console.log(`  ✓ Key works.${model ? ` Using ${model}.` : ""}\n`);
    return model ?? null;
  } catch (err) {
    console.log(`  ! Couldn't check the key (${(err as Error).message}). Saved it anyway.\n`);
    return null;
  }
}

// With --if-needed, stay silent unless the saved settings can't reach a model.
if (process.argv.includes("--if-needed") && fs.existsSync(ENV_PATH)) {
  const saved = dotenv.parse(fs.readFileSync(ENV_PATH));
  const provider = (saved.LLM_PROVIDER || "anthropic").toLowerCase();
  const keyVar = KEY_VARS[provider];
  if (!keyVar || saved[keyVar]?.trim()) process.exit(0);
  console.log(`\n  No ${keyVar} in .env yet, so let's finish setting up.`);
} else if (process.argv.includes("--if-needed") || !fs.existsSync(ENV_PATH)) {
  // first run: fall through to the questions
} else if (!yes(await ask("  A .env file already exists. Replace it? [y/N] "))) {
  console.log("  Keeping your existing .env.\n");
  process.exit(0);
}

console.log(`
  ─────────────────────────────────────────────
   J.A.R.V.I.S.  setup
  ─────────────────────────────────────────────
  Press Enter to accept the [default] shown.
`);

const answers: Record<string, string> = {};

console.log("  Which brain should Jarvis think with?");
console.log("    1) Claude  - best at using tools and screen vision. Paid: needs API credit.");
console.log("    2) Gemini  - FREE with a Google account, no card. Roughly 80+ commands a day.");
console.log("    3) Groq    - FREE and very fast, but the free tier runs out after ~15 commands a day.");
console.log("    4) Ollama  - FREE and private, runs on this PC. Needs a strong PC and Ollama installed.\n");
const brain = (await ask("  Choose 1-4 [1] ", "1")).trim();
let key = "";

if (brain === "2") {
  answers.LLM_PROVIDER = "gemini";
  console.log("\n  Get a free key: https://aistudio.google.com/apikey  (sign in with Google, then Create API key).");
  console.log("  Note: on the free tier Google may use your conversations to improve its products.\n");
  key = await ask("  Paste your Gemini API key: ");
  if (key) {
    answers.GEMINI_API_KEY = key;
    const model = await pickModel("https://generativelanguage.googleapis.com/v1beta/openai", key, [
      "gemini-2.5-flash",
      "gemini-flash-latest",
      "gemini-3-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ]);
    if (model) answers.LLM_MODEL = model;
  }
} else if (brain === "3") {
  answers.LLM_PROVIDER = "groq";
  console.log("\n  Get a free key: https://console.groq.com/keys\n");
  key = await ask("  Paste your Groq API key: ");
  if (key) {
    answers.GROQ_API_KEY = key;
    const model = await pickModel("https://api.groq.com/openai/v1", key, ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b"]);
    if (model) answers.LLM_MODEL = model;
  }
} else if (brain === "4") {
  answers.LLM_PROVIDER = "ollama";
  console.log("\n  Install Ollama from https://ollama.com first. The model must support tool calling.");
  answers.LLM_MODEL = await ask("  Ollama model [qwen3:8b] ", "qwen3:8b");
  try {
    const tags = (await (await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(5000) })).json()) as { models?: Array<{ name: string }> };
    const have = tags.models?.some((m) => m.name === answers.LLM_MODEL || m.name === `${answers.LLM_MODEL}:latest`);
    console.log(have ? "  ✓ Ollama is running and has that model.\n" : `  ! Ollama is running but doesn't have it yet. Run: ollama pull ${answers.LLM_MODEL}\n`);
  } catch {
    console.log(`  ! Ollama isn't running. Start it, then run: ollama pull ${answers.LLM_MODEL}\n`);
  }
} else {
  answers.LLM_PROVIDER = "anthropic";
  console.log("\n  Get a key at https://console.anthropic.com (API usage is billed separately from a Claude.ai subscription).\n");
  key = await ask("  Paste your Anthropic API key (or Enter to add it later): ");
  if (key) {
    if (!key.startsWith("sk-ant-")) console.log("  ! That doesn't look like an Anthropic key (they start with sk-ant-). Saving it anyway.");
    answers.ANTHROPIC_API_KEY = key;
    await checkClaudeKey(key);
  }
}

answers.JARVIS_USER_TITLE = await ask("  What should Jarvis call you? [sir] ", "sir");
const name = await ask("  Your first name (optional): ");
if (name) answers.JARVIS_USER_NAME = name;
const city = await ask("  Your city for weather, e.g. Chennai, India (optional): ");
if (city) answers.JARVIS_LOCATION = city;

console.log("\n  Gmail lets Jarvis read, search and reply to your email.");
console.log("  It needs an App Password: https://myaccount.google.com/apppasswords (2-Step Verification required).");
const gmail = await ask("  Gmail address (optional, Enter to skip): ");
if (gmail) {
  answers.GMAIL_ADDRESS = gmail;
  const pass = await ask("  Gmail App Password (16 letters): ");
  if (pass) answers.GMAIL_APP_PASSWORD = pass.replace(/\s+/g, "");
}

console.log("\n  Offline voice keeps your microphone audio on this PC (Whisper + a British Kokoro voice).");
console.log("  It downloads about 250 MB once. Without it, Chrome/Edge send your voice to Google/Microsoft.");
const offline = !/^n(o)?$/i.test(await ask("  Use offline voice? [Y/n] ", "y"));

// Save now, so nothing is lost if the download below is interrupted.
save(answers);
console.log(`\n  ✓ Saved settings to ${ENV_PATH}\n`);

if (offline) {
  console.log("  Downloading offline voice models (first run only)…");
  try {
    const { loadKokoro, loadWhisper } = await import("../server/voice/local.js");
    const log = (msg: string) => console.log(`    ${msg}`);
    await loadWhisper(log);
    await loadKokoro(log);
    answers.STT_PROVIDER = "local";
    answers.TTS_PROVIDER = "kokoro";
    save(answers);
    console.log("  ✓ Offline voice is on.\n");
  } catch (err) {
    console.log(`\n  ✗ ${(err as Error).message}`);
    console.log("  Jarvis will use the browser voice for now. Run \"npm run setup\" again when you're online.\n");
  }
}

console.log("  Setup complete. Starting Jarvis…\n");
rl.close();
process.exit(0);
