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

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = env(name, fallback).toLowerCase() as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of: ${allowed.join(", ")} (got "${v}")`);
  return v;
}

const provider = env("LLM_PROVIDER", "anthropic").toLowerCase() as ProviderName;
if (provider !== "anthropic" && !(provider in OPENAI_COMPATIBLE)) {
  throw new Error(`Unknown LLM_PROVIDER "${provider}". Use one of: anthropic, ${Object.keys(OPENAI_COMPATIBLE).join(", ")}`);
}

const compat = provider === "anthropic" ? null : OPENAI_COMPATIBLE[provider];

/** Used when LLM_MODEL is empty. The free-tier picks can change; the setup wizard checks what's live. */
const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: "claude-opus-5",
  gemini: "gemini-2.5-flash",
  groq: "openai/gpt-oss-120b",
  ollama: "qwen3:8b",
};

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
  model: env("LLM_MODEL", DEFAULT_MODELS[provider] ?? ""),
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

  /** Speech-to-text: the browser's cloud recogniser, or Whisper running on this machine. */
  stt: {
    provider: oneOf("STT_PROVIDER", ["browser", "local"], "browser"),
    model: env("LOCAL_STT_MODEL", "Xenova/whisper-base.en"),
    /** If set, local STT goes to a running whisper.cpp server instead of the built-in Whisper. */
    whisperCppUrl: env("WHISPER_CPP_URL").replace(/\/+$/, ""),
  },

  tts: {
    provider: oneOf("TTS_PROVIDER", ["browser", "elevenlabs", "kokoro"], env("ELEVENLABS_API_KEY") ? "elevenlabs" : "browser"),
    elevenLabsKey: env("ELEVENLABS_API_KEY"),
    // "George" - a warm British male premade voice. Swap in any voice ID from your ElevenLabs library.
    elevenLabsVoice: env("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
    elevenLabsModel: env("ELEVENLABS_MODEL", "eleven_flash_v2_5"),
    // Kokoro runs on this machine. British voices: bm_george, bm_fable, bm_lewis, bm_daniel, bf_emma.
    kokoroVoice: env("KOKORO_VOICE", "bm_george"),
    kokoroSpeed: Number(env("KOKORO_SPEED", "1.05")),
  },

  /** Where downloaded speech models are cached, so later runs work offline. */
  modelsDir: path.resolve(ROOT, env("JARVIS_MODELS_DIR", "models")),

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
