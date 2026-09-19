# Integration notes

These modules are the contract for later Electron work. The lab UI is disposable; the helper process and `src/modules` are not.

## Processes

```
Renderer / lab UI
    WebSocket JSON + binary PCM
Node helper (`src/server`)
    Silero VAD (onnxruntime-node, in-process)
    ElevenLabs streaming TTS (server-side API key)
    Child process: python/transcribe_worker.py  (faster-whisper, model kept loaded)
```

Do not move the ElevenLabs key into renderer or preload code. The helper already hides it.

## Module interfaces

### Transcription

`FasterWhisperProcess` (`src/server/whisper-process.ts`)

- `start(): Promise<SttInfo>` — spawn the worker and wait until the model is resident
- `transcribe(pcm: Float32Array, isFinal: boolean): Promise<string>` — 16 kHz mono float32
- `dispose(): Promise<void>` — send `shutdown`, then kill the child

`TranscribeQueue` drops stale partials for the same `utteranceId` so overlapping windows do not pile up. Finals always run.

`TranscriptLog` replaces provisional text for an utterance id instead of appending, and revises a final in place.

### VAD

`SileroVadEngine` plus `loadSileroVadSession(modelPath).createInferencer()`

- Push 16 kHz float32. Internally framed at 512 samples (32 ms).
- Events: `speech-start`, `speech-end`
- Create one inferencer **per session** so LSTM/state is not shared
- `reset()` when the mic stops

`InterruptPolicy` turns local VAD into barge-in. It does not wait for a transcript. Interruption only stops playback.

### Synthesis

`ElevenLabsSynthesizer.speak({ text, voiceId, generationId, signal, onChunk })`

- Streams `pcm_24000` from `POST /v1/text-to-speech/{id}/stream`
- Aborting `signal` cancels the HTTP body so late chunks are not read
- Missing API key throws; it never returns silence as success

### Playback

`PlaybackSession`

- `attach(generationId)` / `begin()`
- `push(generationId, pcm)` ignores any other generation
- `stop()` clears the sink and invalidates the current generation so in-flight chunks cannot restart audio

`GenerationGuard` is the server-side twin: `accepts(id)` is false after `stop()`.

### Timing

`TimingTracker` records:

- interruption: VAD speech-start → playback stop
- final transcript: VAD speech-end → final text
- first audible: speak request → first accepted PCM scheduled on the client

## Resource cleanup

Call these on window close, room leave, or helper shutdown:

1. `VoiceSession.dispose()` — abort TTS, reset VAD, drop the socket
2. `FasterWhisperProcess.dispose()` — one shared worker for the app is enough; do not leak extra Pythons
3. Stop `MediaStream` tracks and disconnect the AudioWorklet
4. `PlaybackSession.stop()` then close the `AudioContext` if you created a dedicated one

The ONNX session can live for the process lifetime. VAD *state* must not.

## Electron mapping

| Lab | Electron |
| --- | --- |
| `src/server` | main-process service, not renderer |
| WebSocket `/ws` | IPC or an existing local socket |
| `src/client/main.ts` capture + playback | renderer, via preload |
| `.env` `ELEVENLABS_API_KEY` | main-process env / secure store |

Keep the same generation id on both sides. That is what prevents cancelled agent speech from coming back.
