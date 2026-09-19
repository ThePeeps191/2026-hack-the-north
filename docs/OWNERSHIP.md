# Huddle — build ownership map

One shared working tree. Ownership is by **directory**, and it is exclusive. There are no
merge conflicts because no two workers write the same file.

## Rules for every worker

1. **Only create or edit files inside the directories listed against your name.** Never touch
   anything else — especially not `package.json`, `package-lock.json`, `tsconfig*.json`,
   `electron.vite.config.ts`, `src/shared/**`, `src/main/contracts.ts`, `src/main/ipc.ts`,
   `src/main/index.ts`, `src/main/room-service.ts`, `src/preload/**`,
   `src/renderer/src/App.tsx`, `src/renderer/src/useHuddle.ts`, `src/renderer/src/apply-event.ts`.
2. **Never run `npm install`, `npm uninstall`, or any dependency change.** Everything you need is
   already installed. If something genuinely is missing, say so in your report instead of installing it.
3. **Never run `git add`, `git commit`, `git checkout`, `git branch`, `git stash`, or `git reset`.**
4. If you need a change to a shared type, an IPC channel, or `contracts.ts`, **write it in your report**
   and code against the existing contract in the meantime. Do not edit the contract yourself.
5. Do not reformat, refactor, or "tidy" files you do not own.
6. Do not leave background processes running when you finish.

## Contract files (read these first, edit none of them)

| File | What it defines |
| --- | --- |
| `src/shared/types.ts` | Every domain entity, the runtime event union, the snapshot and persistence shape |
| `src/shared/api.ts` | IPC channel names, the preload `HuddleApi`, and cross-layer payload shapes |
| `src/shared/voice.ts` | Audio transport, playback truth events, speech priority |
| `src/shared/presets.ts` | Agent identities: name, role, persona, colour, avatar key, ElevenLabs voice |
| `src/main/contracts.ts` | `HuddleBus`, `ExecutionHost`, `BrowserHost`, `VoiceHost`, `AgentRuntime` |
| `src/main/paths.ts` | Every Huddle-owned filesystem location |
| `src/main/config/secrets.ts` | Backend-only secret access and redaction |

## Ownership

| Worker | Owns | Implements |
| --- | --- | --- |
| **Integration lead** (primary) | `src/shared/**`, `src/main/index.ts`, `src/main/ipc.ts`, `src/main/room-service.ts`, `src/main/json-store.ts`, `src/main/event-log.ts`, `src/main/paths.ts`, `src/main/contracts.ts`, `src/main/config/**`, `src/preload/**`, `src/renderer/src/App.tsx`, `useHuddle.ts`, `apply-event.ts`, `src/renderer/src/state/**`, root config, README, tests for its own files | `HuddleBus`, persistence + migration, IPC, capabilities, composition |
| **A — Call UI** | `src/renderer/src/call/**`, `src/renderer/src/styles/**`, `src/renderer/src/App.css` | Gallery, tiles, dock, sidebar, chat, focused share shell, spotlight, settings dialog |
| **B — Agent runtime** | `src/main/runtime/**` | `AgentRuntime`: provider adapter, executor loop, tools, mailboxes, task graph, decisions |
| **C — Voice** | `src/main/voice/**`, `src/main/voice-helper.ts`, `src/renderer/src/voice/**`, `src/renderer/public/**` | `VoiceHost`: helper process, VAD, local STT, ElevenLabs, floor control, capture + playback |
| **D — Execution** | `src/main/exec/**`, `src/renderer/src/share/code/**`, `src/renderer/src/share/terminal/**`, `src/renderer/src/share/files/**` | `ExecutionHost`: workspaces, worktrees, files, patches, jobs, integration, preview |
| **E — Browser** | `src/main/browser/**`, `src/renderer/src/share/browser/**` | `BrowserHost`: Browserbase sessions, Playwright automation, live view, evidence |
| **F — Demo project** | `demo/sketch-night/**` | The Sketch Night starter app used as a disposable demo workspace |

## Process model

```
Electron main  ── owns room state, runtime, exec, browser; no native audio deps
   │  IPC (typed, validated)
   ├── Renderer  ── React UI, AudioWorklet capture, Web Audio playback, Monaco, xterm
   │
   ├── Voice helper  (separate Node process, stdio frames)
   │      ├── Silero VAD via onnxruntime-node
   │      ├── ElevenLabs streaming synthesis
   │      └── python/transcribe_worker.py  (faster-whisper, model stays resident)
   │
   ├── Job processes  (builds, dev servers, tests) in project workspaces
   └── Browserbase    (remote sessions driven with playwright-core over CDP)
```

The voice helper runs under a standalone Node process rather than Electron main so that
`onnxruntime-node` never has to match Electron's ABI, and so native inference cannot block the
UI lifecycle.
