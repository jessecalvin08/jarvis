# J.A.R.V.I.S. v2

A voice-driven desktop assistant with a holographic HUD. Jarvis runs locally on your PC, uses **Claude** by default (or OpenAI, Groq, Gemini, OpenRouter, or a local Ollama model), and can take real actions: find and open your files and folders, launch apps, read and send Gmail, search the web, run commands, look at your screen, control media, set timers, and remember things about you.

![HUD](docs/hud.png)

## Why v1 said "I cannot"

A chat model only *talks*. For an assistant to open a file, the app has to give the model **tools** and run the tool calls it makes. A small local model on Ollama either wasn't wired to tools or was too weak to call them reliably. It was also slow because it ran on your own CPU/GPU. v2 fixes both:

- Every action is a real tool (`find_files`, `open_path`, `launch_app`, `email_inbox`…) that the model calls and Jarvis runs.
- Claude runs in the cloud and streams its answer. Jarvis starts speaking after the first sentence, so it doesn't wait for the whole reply.
- The system prompt forbids "I can't access your files" and tells it to find, then open, in one go.

## Quick start (Windows)

1. Install **Node.js 20+** from https://nodejs.org (LTS).
2. Get a Claude API key at https://console.anthropic.com and add some credit.
   A Claude.ai Pro/Max subscription does **not** include API usage. The API is billed separately.
3. Double-click **`Jarvis.cmd`**. The first run installs dependencies (about 700 MB, mostly the offline speech engine) and opens `.env` in Notepad. Paste your key into `ANTHROPIC_API_KEY=` and save.
4. Jarvis opens at **http://localhost:7777**. Use **Chrome or Edge**, because voice input needs them. Click **ENGAGE** and allow the microphone.

macOS/Linux: `npm install`, `cp .env.example .env`, edit it, then `npm start`.

## Talking to it

| Do this | Result |
|---|---|
| Say **"Jarvis, pull up my resume"** | Wake word plus a command in one breath |
| Say **"Jarvis"**, pause, then speak | It chimes and listens for your request |
| Press **Space** or click the core / mic | Push-to-talk without a wake word |
| Just keep talking after it answers | A 7-second follow-up window, no wake word needed |
| **Esc**, or click the core while it talks | Stop talking and cancel the task |
| Say **"Jarvis, stop"** | Cancels a running task (it doesn't listen while it's speaking, so use Esc then) |
| **L** | Conversation log |
| Type in the bar and press Enter | Text instead of voice |

Things to try:

- "Open my Downloads folder" · "Pull up the jarvis project in Documents" · "Find my tax PDFs from 2025"
- "Summarise the PDF I downloaded today" · "What's on my screen?" · "Read this error for me"
- "Check my email" · "Any unread mail from Amazon this week?" · "Reply to that and say I'll call tomorrow"
- "Open Spotify" · "Pause the music" · "Volume up" · "Lock my PC"
- "What's the weather?" · "Search the web for the latest RTX 5090 price"
- "Remind me in 20 minutes to leave for the gym" · "Remember that my resume lives in Documents/Career"

## What it costs (Claude)

Estimates, not guarantees. The HUD shows a running session estimate bottom-right.

| Model (`LLM_MODEL`) | Price per million tokens (in / out) | A typical voice command |
|---|---|---|
| `claude-opus-5` (default) | $5 / $25 | roughly 1–5¢ |
| `claude-sonnet-5` | $2 / $10 | roughly 0.5–2¢ |
| `claude-haiku-4-5` | $1 / $5 | well under 1¢, fastest |

Prompt caching is on, so follow-up questions reuse the cached instructions at about a tenth of the price. Web search adds $0.01 per search. `LLM_EFFORT=low` (the default) keeps replies quick and cheap. Raise it for hard problems.

## Using a different model

Set `LLM_PROVIDER` and `LLM_MODEL` in `.env`:

| Provider | Needs | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Best at using tools reliably. Includes web search and screen vision. |
| `openai` | `OPENAI_API_KEY` | |
| `groq` | `GROQ_API_KEY` | Free tier, extremely fast. Pick a model that supports tool calling. |
| `gemini` | `GEMINI_API_KEY` | Through Google's OpenAI-compatible endpoint. |
| `openrouter` | `OPENROUTER_API_KEY` | One key for hundreds of models. |
| `ollama` | Ollama running locally | Free and private, but slow on most PCs and weak at tools. The model **must** support tool calling (e.g. Qwen 3, Llama 3.1+). |
| `custom` | `LLM_BASE_URL` (+ `LLM_API_KEY`) | LM Studio, vLLM, anything OpenAI-compatible. |

Screen vision (`look_at_screen`) and built-in web search are Claude-only. Every other tool works with every provider.

## Gmail

1. Turn on 2-Step Verification: https://myaccount.google.com/security
2. Create an App Password: https://myaccount.google.com/apppasswords
3. In `.env`: `GMAIL_ADDRESS=you@gmail.com` and `GMAIL_APP_PASSWORD=abcd efgh ijkl mnop`

Jarvis connects over IMAP/SMTP. It can list and search mail with full Gmail search syntax, read messages and send replies in-thread. Sending always asks you first. The unread count on the HUD refreshes every 3 minutes.

## A better voice

- **Free:** in **Edge**, open ⚙ Settings and pick *Microsoft Ryan Online (Natural) – English (United Kingdom)*. It is very close to the films.
- **Best:** add an `ELEVENLABS_API_KEY`. The default voice is "George" (British). Set `ELEVENLABS_VOICE_ID` to any voice from your ElevenLabs library, including community "JARVIS-style" voices. Audio is fetched sentence by sentence, so speech starts almost immediately.

Speech recognition uses the browser's Web Speech API. Chrome sends your audio to Google and Edge sends it to Microsoft. With "Always listen for wake word" on, that happens continuously while the tab is open. Turn it off in ⚙ Settings to use push-to-talk only.

## Offline voice (your audio stays on your PC)

By default, Chrome or Edge does the speech recognition in the cloud. To keep your voice on your machine, set in `.env`:

```
STT_PROVIDER=local
TTS_PROVIDER=kokoro
```

- **Hearing:** Whisper runs on your CPU. Jarvis detects when you start and stop talking, then transcribes that one utterance.
- **Speaking:** Kokoro's "George" voice (British). Change it with `KOKORO_VOICE`: `bm_fable`, `bm_lewis`, `bm_daniel`, `bf_emma`.
- **First run downloads about 250 MB of models** into `models/`, and after that it works offline. Run `npm run models` to download them ahead of time.
- **Already have whisper.cpp from v1?** Start its server (`whisper-server -m ggml-base.en.bin --port 8080`) and set `WHISPER_CPP_URL=http://127.0.0.1:8080`. It's usually faster than the built-in Whisper.

Trade-offs:
- The **thinking** still happens in the cloud (Claude). Fully offline also means `LLM_PROVIDER=ollama`, which is slow and unreliable with tools on most PCs.
- With "Always listen for wake word" on, Jarvis transcribes everything it hears. A TV or music playing keeps your CPU busy. Switch to push-to-talk in ⚙ Settings if that bothers you.
- Speech detection is volume-based. A headset works best, and in a noisy room it may wait for quiet before sending.
- Kokoro sounds good but less like the films than ElevenLabs.

## More abilities through MCP (same format as Claude Desktop)

Claude Desktop gets many of its abilities from **MCP servers**. Jarvis loads the same thing: copy `mcp.example.json` to `mcp.json` and add servers exactly as you would in `claude_desktop_config.json`. Their tools appear in the HUD's ARSENAL panel.

```json
{
  "mcpServers": {
    "memory-graph": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    "my-remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

Extras: `"disabled": true` skips a server. `"autoApprove": true` (or a list of tool names) lets its tools run without asking. Tools that declare themselves read-only never ask.

## Safety

- **Confirmation:** shell commands, writing files, sending email, sleep/restart/shutdown, and MCP tools that change things pop up an **AUTHORIZATION REQUIRED** card. Say "yes"/"no" or press Y/N. Set `JARVIS_CONFIRM_ACTIONS=false` at your own risk.
- **Local only:** the server listens on `127.0.0.1` and rejects any web page that isn't its own HUD, so other sites you visit can't drive it.
- **Prompt injection:** emails and web pages are treated as data. If a message says "run this command", Jarvis tells you instead of doing it.
- `write_file` only writes inside your home folder, and `fetch_url` refuses local-network addresses.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Banner says *SETUP NEEDED* | Add the key it names to `.env` and restart `Jarvis.cmd`. |
| "My API key was rejected" | Check the key, and that your Anthropic account has credit. |
| It doesn't hear me | Use Chrome/Edge. Allow the mic (lock icon in the address bar). Check Windows Settings → Privacy → Microphone. |
| It hears itself | Use headphones, or lower speaker volume. Recognition pauses while it speaks. |
| "Couldn't find an app called X" | Say the name as it appears in the Start menu. |
| Search misses a file | Say a folder: "find budget in D:\Work". Default search covers Desktop, Documents, Downloads, Pictures, Music, Videos, OneDrive and your home folder. |
| Weather widget missing | Set `JARVIS_LOCATION=Chennai, India` (your city). |
| "Whisper / Kokoro couldn't load" | The offline models download on first use, so connect to the internet once or run `npm run models`. |
| Local recognition misses words | Try `LOCAL_STT_MODEL=Xenova/whisper-small.en` (slower, more accurate), or run whisper.cpp and set `WHISPER_CPP_URL`. |

## How it's built

```
Jarvis.cmd            Windows launcher (installs, creates .env, starts)
server/
  index.ts            HTTP + WebSocket server, TTS proxy, weather, Gmail poller
  session.ts          The agent: system prompt, turn loop, approvals, tool execution
  providers/
    anthropic.ts      Claude: streaming, tool use, prompt caching, web search, refusal fallback
    openai.ts         OpenAI-compatible providers (OpenAI, Groq, Gemini, OpenRouter, Ollama)
  tools/              files · system/apps · email · web · memory · hud · mcp
  voice/local.ts      Offline voice: Whisper (or whisper.cpp) speech-to-text, Kokoro text-to-speech
hud/
  index.html, styles.css
  core.js             The animated neural core and reactor rings (canvas)
  voice.js            Wake word, speech recognition (browser or local), sentence-streamed TTS
  capture-worklet.js  Microphone capture for local recognition
  app.js              HUD wiring: panels, cards, approvals, vitals
scripts/smoke-test.ts End-to-end test against a fake model server (no API spend)
scripts/download-models.ts  npm run models: cache the offline speech models
vault/memory.json     What Jarvis remembers about you (git-ignored)
```

Checks: `npm run check` (types) and `npm test` (agent loop, tools, approvals, streaming for both provider types).
