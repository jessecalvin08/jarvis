/**
 * First-run setup: asks a few questions, writes .env, checks the Claude key and (optionally)
 * downloads the offline voice models. Jarvis.cmd runs this automatically when .env is missing.
 *
 *   npm run setup
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const TEMPLATE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

// The line iterator queues input, so this works when answers are typed or piped in.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string, fallback = ""): Promise<string> {
  process.stdout.write(question);
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

console.log(`
  ─────────────────────────────────────────────
   J.A.R.V.I.S.  first-time setup
  ─────────────────────────────────────────────
  Press Enter to accept the [default] shown.
`);

if (fs.existsSync(ENV_PATH) && !yes(await ask("  A .env file already exists. Replace it? [y/N] "))) {
  console.log("  Keeping your existing .env.\n");
  process.exit(0);
}

const answers: Record<string, string> = {};

console.log("  Jarvis thinks with Claude. You need an API key from https://console.anthropic.com");
console.log("  (API usage is billed separately from a Claude.ai subscription).\n");
const key = await ask("  Paste your Anthropic API key (or Enter to add it later): ");
if (key) {
  if (!key.startsWith("sk-ant-")) console.log("  ! That doesn't look like an Anthropic key (they start with sk-ant-). Saving it anyway.");
  answers.ANTHROPIC_API_KEY = key;
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
if (key) await checkClaudeKey(key);

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
