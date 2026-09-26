/**
 * Offline voice: Whisper speech-to-text and Kokoro text-to-speech, both running on this machine.
 * Models download once from Hugging Face into ./models, and every later run works without internet.
 * If WHISPER_CPP_URL points at a running whisper.cpp server, transcription goes there instead.
 */
import path from "node:path";
import { config } from "../config.js";

export type Log = (msg: string) => void;

type Asr = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;
type Kokoro = { generate(text: string, options: { voice: string; speed: number }): Promise<{ toWav(): ArrayBuffer }> };

let transformersP: Promise<typeof import("@huggingface/transformers")> | null = null;

/** Adds the one thing people need to know when a model can't load: it downloads once, online. */
function explain(what: string, err: unknown): Error {
  const msg = (err as Error)?.message ?? String(err);
  if (/Cannot find (module|package)/.test(msg)) {
    return new Error(`${what} isn't installed. Run "npm install" again (it's an optional package that failed to install).`);
  }
  return new Error(`${what} couldn't load (${msg.replace(/\.$/, "")}). The first run needs internet to download it; "npm run models" does it ahead of time.`);
}

function transformers(): Promise<typeof import("@huggingface/transformers")> {
  transformersP ??= import("@huggingface/transformers").then((t) => {
    t.env.cacheDir = config.modelsDir;
    return t;
  });
  return transformersP;
}

interface Progress {
  status: string;
  file?: string;
  progress?: number;
  total?: number;
}

/** Reports big downloads in 25% steps so the HUD isn't flooded with toasts. */
function progressReporter(label: string, log: Log) {
  const reported = new Map<string, number>();
  return (p: Progress) => {
    if (p.status !== "progress" || !p.file || typeof p.progress !== "number" || (p.total ?? 0) < 5_000_000) return;
    const step = Math.floor(p.progress / 25);
    if (step > (reported.get(p.file) ?? 0)) {
      reported.set(p.file, step);
      log(`Downloading ${label}: ${path.basename(p.file)} ${Math.min(100, step * 25)}% (first run only)`);
    }
  };
}

// ───────────────────────────────────────── speech-to-text

let asrP: Promise<Asr> | null = null;

export function loadWhisper(log: Log): Promise<Asr> {
  asrP ??= (async () => {
    const { pipeline } = await transformers();
    log(`Loading Whisper speech recognition (${config.stt.model})…`);
    const asr = await pipeline("automatic-speech-recognition", config.stt.model, {
      dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
      device: "cpu",
      progress_callback: progressReporter("Whisper", log),
    });
    log("Whisper is ready. Speech recognition is running on this computer.");
    return asr as unknown as Asr;
  })().catch((err: unknown) => {
    asrP = null; // allow a retry on the next request
    throw explain("Whisper", err);
  });
  return asrP;
}

/** 16-bit mono WAV, the format whisper.cpp's server expects. */
export function toWav(pcm: Float32Array, sampleRate = 16_000): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 0x7fff), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function whisperCpp(pcm: Float32Array): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(toWav(pcm))], { type: "audio/wav" }), "speech.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  // An initial prompt nudges Whisper towards spelling the wake word correctly.
  form.append("prompt", `${config.assistantName[0]}${config.assistantName.slice(1).toLowerCase()}.`);
  const res = await fetch(`${config.stt.whisperCppUrl}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`whisper.cpp server returned ${res.status}`);
  const body = (await res.json()) as { text?: string; error?: string };
  if (body.error) throw new Error(`whisper.cpp: ${body.error}`);
  return body.text ?? "";
}

/** Whisper invents captions for noise ("[Music]", "Thanks for watching!"); drop those. */
export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|♪/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[a-z0-9]/i.test(text)) return "";
  if (/^(you|thanks for watching[.!]*|please subscribe[.!]*)$/i.test(text)) return "";
  return text;
}

let sttChain: Promise<unknown> = Promise.resolve();
let sttPending = 0;

/** Transcribes 16 kHz mono PCM. Requests run one at a time so they don't fight over the CPU. */
export async function transcribe(pcm: Float32Array, log: Log): Promise<string> {
  if (sttPending >= 3) throw new Error("Speech recognition is busy; try again in a moment.");
  sttPending++;
  const run = sttChain.then(async () => {
    if (config.stt.whisperCppUrl) return whisperCpp(pcm);
    const asr = await loadWhisper(log);
    const out = await asr(pcm);
    return Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text;
  });
  sttChain = run.catch(() => undefined);
  try {
    return cleanTranscript(await run);
  } finally {
    sttPending--;
  }
}

// ───────────────────────────────────────── text-to-speech

let kokoroP: Promise<Kokoro> | null = null;

export function loadKokoro(log: Log): Promise<Kokoro> {
  kokoroP ??= (async () => {
    await transformers(); // shares the cache directory setting with Whisper
    const { KokoroTTS } = await import("kokoro-js");
    log("Loading Kokoro voice…");
    const tts = (await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device: "cpu",
      progress_callback: progressReporter("Kokoro voice", log) as never,
    })) as unknown as Kokoro;
    await tts.generate("Ready.", { voice: config.tts.kokoroVoice, speed: config.tts.kokoroSpeed }); // warm up
    log(`Kokoro voice "${config.tts.kokoroVoice}" is ready. Speech is generated on this computer.`);
    return tts;
  })().catch((err: unknown) => {
    kokoroP = null;
    throw explain("The Kokoro voice", err);
  });
  return kokoroP;
}

let ttsChain: Promise<unknown> = Promise.resolve();

/** Returns a WAV file. Sentences are generated in order, one at a time. */
export function synthesize(text: string, log: Log): Promise<Buffer> {
  const run = ttsChain.then(async () => {
    const tts = await loadKokoro(log);
    const audio = await tts.generate(text, { voice: config.tts.kokoroVoice, speed: config.tts.kokoroSpeed });
    return Buffer.from(audio.toWav());
  });
  ttsChain = run.catch(() => undefined);
  return run;
}

/** Loads the local models in the background at startup so the first request isn't slow. */
export function warmUpLocalVoice(log: Log): void {
  const fail = (err: unknown) => log((err as Error)?.message ?? String(err));
  if (config.stt.provider === "local" && !config.stt.whisperCppUrl) loadWhisper(log).catch(fail);
  if (config.tts.provider === "kokoro") loadKokoro(log).catch(fail);
}
