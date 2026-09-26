import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export type ProviderName = "anthropic" | "openai" | "groq" | "openrouter" | "gemini" | "ollama" | "custom";

/** OpenAI-compatible endpoints. Anthropic is handled by its own SDK, never through a shim. */
const OPENAI_COMPATIBLE: Record<Exclude<ProviderName, "anthropic">, { baseURL: string; keyVar: string }> = {
  openai: { baseURL: "https://api.openai.com/v1", keyVar: "OPENAI_API_KEY" },
  groq: { baseURL: "https://api.groq.com/openai/v1", keyVar: "GROQ_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyVar: "OPENROUTER_API_KEY" },
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", keyVar: "GEMINI_API_KEY" },
  ollama: { baseURL: "http://localhost:11434/v1", keyVar: "OLLAMA_API_KEY" },
  custom: { baseURL: "", keyVar: "LLM_API_KEY" },
};

const provider = env("LLM_PROVIDER", "anthropic").toLowerCase() as ProviderName;
if (provider !== "anthropic" && !(provider in OPENAI_COMPATIBLE)) {
  throw new Error(`Unknown LLM_PROVIDER "${provider}". Use one of: anthropic, ${Object.keys(OPENAI_COMPATIBLE).join(", ")}`);
}

const compat = provider === "anthropic" ? null : OPENAI_COMPATIBLE[provider];

export const config = {
  port: Number(env("JARVIS_PORT", "7777")),
  openBrowser: envBool("JARVIS_OPEN_BROWSER", true),

  assistantName: env("JARVIS_NAME", "JARVIS"),
  userName: env("JARVIS_USER_NAME", ""),
  userTitle: env("JARVIS_USER_TITLE", "sir"),
  location: env("JARVIS_LOCATION", ""),
  speechLang: env("JARVIS_SPEECH_LANG", "en-US"),
  wakeWord: env("JARVIS_WAKE_WORD", "jarvis").toLowerCase(),

  provider,
  model: env("LLM_MODEL", provider === "anthropic" ? "claude-opus-5" : ""),
  /** low | medium | high | xhigh | max. Low keeps spoken replies snappy; raise it for harder work. */
  effort: env("LLM_EFFORT", "low") as "low" | "medium" | "high" | "xhigh" | "max",
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  webSearch: envBool("JARVIS_WEB_SEARCH", true),
  openaiCompat: compat
    ? { baseURL: env("LLM_BASE_URL", compat.baseURL), apiKey: env(compat.keyVar, env("LLM_API_KEY", provider === "ollama" ? "ollama" : "")) }
    : null,

  /** Ask before running tools that change things (shell, writing files, sending email, unlisted MCP tools). */
  confirmRiskyActions: envBool("JARVIS_CONFIRM_ACTIONS", true),

  gmail: {
    address: env("GMAIL_ADDRESS"),
    appPassword: env("GMAIL_APP_PASSWORD").replace(/\s+/g, ""),
  },

  tts: {
    provider: env("TTS_PROVIDER", env("ELEVENLABS_API_KEY") ? "elevenlabs" : "browser") as "browser" | "elevenlabs",
    elevenLabsKey: env("ELEVENLABS_API_KEY"),
    // "George" - a warm British male premade voice. Swap in any voice ID from your ElevenLabs library.
    elevenLabsVoice: env("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
    elevenLabsModel: env("ELEVENLABS_MODEL", "eleven_flash_v2_5"),
  },

  vaultDir: path.resolve(ROOT, env("JARVIS_VAULT_DIR", "vault")),
  mcpConfigPath: path.resolve(ROOT, env("JARVIS_MCP_CONFIG", "mcp.json")),
  home: os.homedir(),
};

fs.mkdirSync(config.vaultDir, { recursive: true });

export function describeModel(): string {
  return `${config.provider}:${config.model || "(no model set)"}`;
}

/** Returns a human-readable problem with the model setup, or null when it looks usable. */
export function modelSetupProblem(): string | null {
  if (config.provider === "anthropic") {
    if (!config.anthropicApiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
      return "ANTHROPIC_API_KEY is not set. Add it to .env (get one at https://console.anthropic.com).";
    }
    return null;
  }
  if (!config.model) return `LLM_MODEL is not set for provider "${config.provider}".`;
  if (!config.openaiCompat?.baseURL) return "LLM_BASE_URL is not set.";
  if (!config.openaiCompat.apiKey) return `API key for "${config.provider}" is not set in .env.`;
  return null;
}
