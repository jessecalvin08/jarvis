// Voice I/O: wake-word speech recognition (Web Speech API) and streamed text-to-speech
// (browser voices, or ElevenLabs through the local server).

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Voices that sound most like the films, best first. Edge's "Natural" voices are excellent and free.
const PREFERRED_VOICES = [
  /Ryan.*Natural.*United Kingdom/i,
  /Thomas.*Natural.*United Kingdom/i,
  /Microsoft Ryan/i,
  /Google UK English Male/i,
  /Daniel/i,
  /Arthur/i,
  /en-GB.*Male/i,
  /Microsoft George/i,
  /en-GB/i,
];

export function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/[*_#`>|~]+/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export class Voice {
  constructor({ lang, wakeWord, onCommand, onInterim, onListenChange, onSpeakingChange, onLevel, onSpectrum, onError }) {
    this.lang = lang;
    this.wakeWord = wakeWord.toLowerCase();
    this.wakeRe = new RegExp(`\\b(?:hey |hi |ok |okay )?${this.wakeWord}\\b[,.!?]?`, "i");
    this.cb = { onCommand, onInterim, onListenChange, onSpeakingChange, onLevel, onSpectrum, onError };

    this.supported = !!SR;
    this.enabled = false; // recognition should be running
    this.wakeMode = true; // listen continuously for the wake word
    this.activeUntil = 0; // while > now, any speech is a command (no wake word needed)
    this.recognizing = false;
    this.restartTimer = null;

    this.speakEnabled = true;
    this.ttsProvider = "browser";
    this.voiceName = "";
    this.queue = [];
    this.speaking = false;
    this.buffer = "";
    this.audioCtx = null;
    this.fetches = [];
  }

  // ─────────────────────────────── audio setup (needs a user gesture)

  async init() {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.ttsAnalyser = this.audioCtx.createAnalyser();
    this.ttsAnalyser.fftSize = 256;
    this.ttsAnalyser.connect(this.audioCtx.destination);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const src = this.audioCtx.createMediaStreamSource(stream);
      this.micAnalyser = this.audioCtx.createAnalyser();
      this.micAnalyser.fftSize = 256;
      src.connect(this.micAnalyser);
    } catch (err) {
      this.cb.onError?.("Microphone access was blocked. Allow it in the address bar to talk to me.");
    }
    this.levelLoop();
  }

  levelLoop() {
    const buf = new Uint8Array(128);
    const tick = () => {
      let analyser = null;
      if (this.speaking && this.ttsProvider === "elevenlabs") analyser = this.ttsAnalyser;
      else if (this.isActive() || (!this.speaking && this.recognizing && this.hearing)) analyser = this.micAnalyser;
      if (analyser) {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 2; i < 64; i++) sum += buf[i];
        this.cb.onLevel?.(Math.min(1, (sum / 62 / 255) * 2.2));
        this.cb.onSpectrum?.(buf);
      } else if (this.speaking) {
        // Browser TTS exposes no audio, so animate from word boundaries.
        this.synthLevel = (this.synthLevel ?? 0) * 0.9;
        this.cb.onLevel?.(0.25 + this.synthLevel * 0.6 + Math.random() * 0.15);
        this.cb.onSpectrum?.(null);
      } else {
        this.cb.onLevel?.(0);
        this.cb.onSpectrum?.(null);
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ─────────────────────────────── recognition

  isActive() {
    return Date.now() < this.activeUntil;
  }

  /** Treat the next thing the user says as a command (after a wake word, push-to-talk, or a follow-up). */
  activate(ms = 8000) {
    this.activeUntil = Date.now() + ms;
    this.cb.onListenChange?.(true);
    clearTimeout(this.activeTimer);
    this.activeTimer = setTimeout(() => {
      if (!this.isActive()) {
        this.cb.onListenChange?.(false);
        this.cb.onInterim?.("");
      }
    }, ms + 50);
    this.ensureRecognition();
  }

  deactivate() {
    this.activeUntil = 0;
    clearTimeout(this.activeTimer);
    this.cb.onListenChange?.(false);
  }

  start() {
    this.enabled = true;
    this.ensureRecognition();
  }

  setWakeMode(on) {
    this.wakeMode = on;
    if (!on && !this.isActive()) this.stopRecognition();
    else this.ensureRecognition();
  }

  ensureRecognition() {
    if (!this.supported || !this.enabled || this.recognizing || this.speaking) return;
    if (!this.wakeMode && !this.isActive()) return;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;
    this.startedAt = Date.now();

    rec.onstart = () => (this.recognizing = true);
    rec.onspeechstart = () => (this.hearing = true);
    rec.onspeechend = () => (this.hearing = false);
    rec.onresult = (e) => this.handleResult(e);
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.enabled = false;
        this.cb.onError?.("Speech recognition is blocked. Allow the microphone for this page, and use Chrome or Edge.");
      } else if (e.error === "network") {
        this.cb.onError?.("Speech recognition needs an internet connection.");
      }
    };
    rec.onend = () => {
      this.recognizing = false;
      this.hearing = false;
      // Chrome ends sessions on silence; quietly restart (backing off if it keeps dying immediately).
      const quick = Date.now() - this.startedAt < 1500;
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.ensureRecognition(), quick ? 1500 : 150);
    };
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }

  stopRecognition() {
    clearTimeout(this.restartTimer);
    if (this.rec) {
      this.rec.onend = () => {
        this.recognizing = false;
        this.hearing = false;
      };
      try {
        this.rec.abort();
      } catch {
        /* ignore */
      }
    }
    this.recognizing = false;
  }

  handleResult(e) {
    if (this.speaking) return;
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript.trim();
      if (!r.isFinal) {
        interim += `${text} `;
        continue;
      }
      if (!text) continue;
      const m = text.match(this.wakeRe);
      if (this.isActive()) {
        const command = m ? text.slice(m.index + m[0].length).trim() || text : text;
        this.deactivate();
        this.cb.onInterim?.("");
        this.cb.onCommand?.(command, { wake: !!m });
      } else if (m) {
        const command = text.slice(m.index + m[0].length).trim();
        if (command.length > 1) {
          this.cb.onInterim?.("");
          this.cb.onCommand?.(command, { wake: true });
        } else {
          this.cb.onCommand?.("", { wake: true }); // just "Jarvis" - wait for the request
          this.activate(9000);
        }
      }
    }
    interim = interim.trim();
    if (interim && (this.isActive() || this.wakeRe.test(interim))) {
      this.cb.onInterim?.(interim.replace(this.wakeRe, "").trim() || "…");
    }
  }

  // ─────────────────────────────── speech output

  /** Feed streamed reply text; complete sentences are spoken as soon as they arrive. */
  feed(delta) {
    if (!this.speakEnabled) return;
    this.buffer += delta;
    for (;;) {
      const m = this.buffer.match(/^([\s\S]*?[.!?…:;])(\s+|$)(?=\S|$)/);
      const tooLong = this.buffer.length > 240;
      if (m && m[2]) {
        this.enqueue(m[1]);
        this.buffer = this.buffer.slice(m[0].length);
      } else if (tooLong) {
        const cut = Math.max(this.buffer.lastIndexOf(", ", 220), this.buffer.lastIndexOf(" ", 220));
        this.enqueue(this.buffer.slice(0, cut > 40 ? cut : 220));
        this.buffer = this.buffer.slice(cut > 40 ? cut : 220);
      } else break;
    }
  }

  flush() {
    if (this.buffer.trim()) this.enqueue(this.buffer);
    this.buffer = "";
  }

  say(text) {
    this.enqueue(text);
  }

  enqueue(raw) {
    const text = cleanForSpeech(raw);
    if (!text || !this.speakEnabled) return;
    const item = { text, audio: null };
    if (this.ttsProvider === "elevenlabs") item.audio = this.fetchAudio(text);
    this.queue.push(item);
    if (!this.speaking) this.next();
  }

  async fetchAudio(text) {
    const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `TTS ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  setSpeaking(on) {
    if (this.speaking === on) return;
    this.speaking = on;
    if (on) this.stopRecognition(); // don't transcribe ourselves
    else setTimeout(() => this.ensureRecognition(), 250);
    this.cb.onSpeakingChange?.(on);
  }

  async next() {
    const item = this.queue.shift();
    if (!item) {
      this.setSpeaking(false);
      return;
    }
    this.setSpeaking(true);
    try {
      if (item.audio) await this.playUrl(await item.audio);
      else await this.speakBrowser(item.text);
    } catch (err) {
      console.warn("TTS failed, falling back to the browser voice:", err);
      if (item.audio) {
        this.ttsProvider = "browser";
        await this.speakBrowser(item.text).catch(() => undefined);
      }
    }
    if (this.stopped) {
      this.stopped = false;
      return;
    }
    this.next();
  }

  playUrl(url) {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      this.current = audio;
      const src = this.audioCtx.createMediaElementSource(audio);
      src.connect(this.ttsAnalyser);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onerror = () => reject(new Error("audio playback failed"));
      audio.play().catch(reject);
    });
  }

  voices() {
    return speechSynthesis.getVoices().filter((v) => v.lang?.startsWith("en"));
  }

  pickVoice() {
    const all = speechSynthesis.getVoices();
    if (this.voiceName) {
      const chosen = all.find((v) => v.name === this.voiceName);
      if (chosen) return chosen;
    }
    for (const re of PREFERRED_VOICES) {
      const v = all.find((x) => re.test(`${x.name} ${x.lang}`));
      if (v) return v;
    }
    return all.find((v) => v.lang?.startsWith("en")) ?? null;
  }

  speakBrowser(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice();
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      }
      u.rate = 1.04;
      u.pitch = 0.92;
      u.onboundary = () => (this.synthLevel = 1);
      u.onend = () => resolve();
      u.onerror = () => resolve();
      this.current = u;
      speechSynthesis.speak(u);
    });
  }

  /** Stop talking immediately (Esc, or a new command). */
  stop() {
    this.queue = [];
    this.buffer = "";
    if (this.speaking) this.stopped = true;
    speechSynthesis.cancel();
    if (this.current instanceof HTMLAudioElement) this.current.pause();
    this.current = null;
    if (this.speaking) {
      this.setSpeaking(false);
      // next() is awaiting the cancelled item; it will see `stopped` and bail.
    }
  }

  // ─────────────────────────────── little interface sounds

  blip(kind) {
    if (!this.audioCtx || !this.sfx) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;
    const tones = { wake: [660, 990], send: [880], done: [990, 1320], error: [220, 180], approve: [520, 780] }[kind] ?? [880];
    tones.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.06, now + i * 0.09 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.09);
      o.stop(now + i * 0.09 + 0.16);
    });
  }
}
