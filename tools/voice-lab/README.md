# Huddle Voice Lab

Standalone voice prototype for Huddle. It lives entirely under `tools/voice-lab/` so the Electron app can be built in parallel.

Microphone audio is transcribed **locally**. It is never sent to a cloud speech-to-text API. ElevenLabs is used only to synthesize typed agent replies.

## What this machine suggested

Inspected 2026-09-19:

- Intel Core i5-1135G7 (4C/8T), 16 GB RAM, Intel Iris Xe (no NVIDIA / no CUDA)
- Python 3.10, Node 24, FFmpeg 8.1
- Realtek + Intel SST audio devices present

Chosen stack:

| Piece | Choice | Why |
| --- | --- | --- |
| Transcription | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) `base.en`, CPU `int8` | Official CTranslate2 path. Better CPU speed than Transformers.js ONNX on this laptop, stronger than `tiny.en` on names and code. Model stays loaded in a Python helper. |
| VAD / barge-in | [Silero VAD](https://github.com/snakers4/silero-vad) ONNX via `onnxruntime-node` | Local, <1 ms/frame, interrupts playback without waiting for a transcript. |
| Agent voices | ElevenLabs HTTP PCM stream (`eleven_flash_v2_5`, `pcm_24000`) | Real streaming synthesis. Credentials stay on the Node helper. |

There is **no cloud STT fallback**. If the local model fails to load, the helper exits with an error.

`small.en` is more accurate and slower. Set `WHISPER_MODEL=small.en` in `.env` if `base.en` struggles with coding terms.

## Setup

From this directory:

```bash
npm install
npm run setup
```

`npm run setup` will:

1. Create `.venv` and install `faster-whisper`
2. Download Silero VAD ONNX into `models/silero_vad.onnx`
3. Copy `.env.example` → `.env` if needed
4. Warm the Whisper model so the first utterance is not a download

Add your ElevenLabs key to `.env`:

```
ELEVENLABS_API_KEY=...
```

Without a key, microphone, VAD, and local transcription still run. **Speak** fails with a visible error instead of fake audio.

## Run

```bash
npm run dev
```

Opens the UI at `http://127.0.0.1:5173`. The helper listens on `http://127.0.0.1:8787`.

Use headphones first. Browser echo cancellation and a higher VAD threshold during playback are enabled, but speakers can still barge in on the agent’s own voice.

## Checks

```bash
npm test
npm run typecheck
npm run build
```

## Layout

```
src/modules/     UI-independent transcription log, VAD, TTS, playback, timing
src/server/      Node helper: Whisper child process, Silero, ElevenLabs, WebSocket
src/client/      Minimal lab UI
python/          faster-whisper worker (model stays resident)
```

See [INTEGRATION.md](./INTEGRATION.md) for the interfaces the Electron app should reuse, and how to clean up resources.
