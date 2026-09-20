# Huddle

**A live voice meeting where AI teammates do real software work with you.**

You join a room, talk out loud, and three AI engineers — Maya (frontend), Alex (systems and
integration) and Sam (quality) — work on a real project folder on your machine. They read the
actual files, run real commands, open the app in a real remote browser, disagree with you and each
other when requirements conflict, record decisions, and hand work to whoever owns it. You can
interrupt, redirect, open anyone's workspace, and watch the result being verified.

Huddle is a desktop Electron application. It is not a chatbot, not a dashboard of metrics, and not
scripted theatre: every activity in the interface is backed by a real tool run, a real command, a
real file, or a real browser session.

---

## Architecture

```
Electron main (src/main)
  ├── RoomService            room, message, task, decision and artifact state (HuddleBus)
  ├── runtime/               OpenAI agent sessions, tool loop, mailboxes, task graph, speech intents
  ├── exec/                  real workspaces, git worktrees, files, patches, jobs, integration, preview
  ├── browser/               real Browserbase sessions driven with Playwright over CDP
  ├── voice/ + voice-helper  local VAD + local Whisper, ElevenLabs synthesis, floor control
  └── config/                backend-only secrets, truthful capability probing
        │
        │ typed IPC (context isolation, sandboxed renderer, narrow preload API)
        ▼
Electron renderer (src/renderer)
  ├── call/                  call-first UI: gallery, tiles, dock, sidebar, chat, captions, spotlight
  ├── share/                 real code, terminal, files and browser surfaces
  └── voice/                 AudioWorklet capture, Web Audio playback, playback truth reporting

Electron main ──spawn──▶ voice helper (system Node, out/main/voice-helper.js)
                            ├── Silero VAD (onnxruntime-node)
                            ├── faster-whisper (python/transcribe_worker.py, model stays resident)
                            └── ElevenLabs streaming PCM
```

Design rules that the code actually enforces:

- **Durability before announcement.** Anything you asked for is written to disk before the event is
  broadcast; a failed write is rolled back and reported, never silently shown as saved.
- **Ephemeral events never touch the disk.** Audio levels, model tokens, job output and playback
  ticks are broadcast and dropped.
- **Work state and speech state are independent.** Interrupting speech never cancels work; muting
  your microphone never cancels work.
- **No invented results.** A tool that fails reports the real error; a job that is interrupted is
  `unknown`, never "still running"; speech that was cut off is marked interrupted, not played.
- **Microphone audio never leaves the machine.** Speech-to-text is local faster-whisper only. There
  is no cloud STT fallback in the code.
- **The renderer cannot reach the filesystem, Node, or raw IPC.** It gets a narrow typed API.

## Requirements

- Node.js 22+ (developed on Node 24) and npm.
- Windows, macOS or Linux. The Windows process-tree kill path is implemented and exercised in tests.
- Python 3.10+ **only** for the local speech helper (faster-whisper). Nothing else in Huddle is
  Python.

## Setup

```bash
npm install
```

Configuration lives in `.env` at the repo root (gitignored). All of these are optional — Huddle
starts and stays useful without them, and tells you what is missing:

| Variable | Used for | Without it |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | agent reasoning and tool selection — the default backend | the room still works: you can type, the state is real, but nobody thinks or works |
| `OPENAI_API_KEY` | the same, for `gpt-*` models | only needed if you point a model slot at OpenAI |
| `ELEVENLABS_API_KEY` | AI speech (voices for Maya, Alex, Sam, Rio, Nova) | replies are written only; captions still work |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | real remote browser sessions for QA | browser verification is reported as unavailable |
| `NGROK_AUTHTOKEN` | reserved for a stable preview tunnel | the localtunnel path is used |

**Two model backends, one adapter.** OpenAI and DeepSeek both speak the OpenAI wire format, so the
backend is chosen from the model id: `deepseek-*` goes to DeepSeek, everything else to OpenAI. A
model whose backend has no key is refused with a clear error rather than quietly answered by the
other one — a model id is a claim about which model did the work, and swapping it silently would
make every later report untrue.

Local speech (one-time, plus a model download):

```bash
node tools/voice-lab/scripts/setup.mjs        # python venv, faster-whisper worker, Silero VAD model
node tools/voice-lab/scripts/verify-live.ts   # optional: prove VAD + Whisper + ElevenLabs locally
```

## Run

```bash
npm run dev        # electron-vite dev with hot reload
npm run build      # build main, voice helper, preload and renderer
npm test           # root test suite (node --test)
npm run typecheck  # tsc for main/preload/shared and for the renderer
```

Agent models are configurable in Settings (or in the room state file). Both slots default to
`deepseek-flash`: it answers in about a second, holds up on tool selection, and a full demo run
costs cents. Point either slot at a `gpt-*` model and the adapter routes that slot to OpenAI
instead. Use **Settings → Refresh capabilities** to see which models your keys can actually reach —
a model is only shown as verified once it has answered a real request.

Before a demo, run the one command that checks the things that look like app bugs but are not —
empty provider accounts, a full disk, a missing Whisper model:

```bash
npm run demo:check
```

`docs/TESTING.md` is a hand-testing checklist: what to do, what you should see, and what it means
when you see something else.

### Verification commands

```bash
npm run verify:openai    # live OpenAI transport + a real tool call
npm run verify:browser   # live Browserbase session, with screenshots and network evidence
npm run verify:voice     # live ElevenLabs voices/synthesis + local VAD + local Whisper
npm run smoke            # headless agent run against the demo project (prints real tool runs)
npm run test:voice       # the voice lab's own suite
npm run test:demo        # the demo project's suite

npm run dev              # then, from a second shell:
npm run ui-check         # 13 checks against the running window over CDP
npm run demo-run         # types a real instruction into the app and reports what the team did
```

`ui-check` and `demo-run` need the app started with a debugging port:

```bash
npx electron . --remote-debugging-port=9222
```

## Using Huddle

1. **Create or open a room** in the left sidebar. A new room starts with Maya, Alex and Sam, all
   idle and honest about it.
2. **Bind the room to a real project.** Either *Choose folder* (any existing project) or *Use the
   demo project* — this copies `demo/sketch-night` into `.data/projects/` and gives the team a real
   repository with real bugs and contradictory notes.
3. **Join the call** from the dock. Huddle opens the microphone, runs local VAD, transcribes locally
   and shows your words as captions while you speak. You can also just type.
4. **Talk normally.** “Maya, take the vote gallery.” “Alex, what shape does the server expose?” “Sam,
   check whether voter names leak in the response.” Agents answer briefly out loud and keep working.
5. **Interrupt whenever you like.** Stop speaking cuts the audio immediately; your own speech cuts it
   by itself. Neither cancels the work.
6. **Click a face** to go one-on-one with that agent: its presence, its workspace, its private side
   channel, and a way back to the room.
7. **Change the requirement.** Say or type the change. Agents must record it as a new decision
   revision, mark affected work stale, and tell the people whose work is affected — the room shows
   the revision and who was notified.
8. **Watch the Team result.** Integration runs the project's own checks against the exact revision
   and records them, pass or fail, with real output. A failed check never replaces the last verified
   revision.

## Project, workspaces and safety

- The Team workspace is the project folder itself. Each agent gets a **real git worktree** and branch
  (`huddle/<name>`) when the project is a git repository with commits; when it is not, agents share
  the folder and Huddle says so plainly instead of pretending otherwise.
- Every path that arrives from a tool, a model or the UI is canonicalised and confined to the
  workspace root. `..`, absolute escapes and symlink escapes are refused.
- Huddle refuses to bind its own source tree as a target project.
- A project folder plus a shell is **not** a sandbox. Huddle confines paths and validates every IPC
  payload, but commands you ask an agent to run are real commands on your machine.

## Demo

`demo/sketch-night` is the demonstration project: a small multiplayer drawing-and-voting game. It is
a constructed starting scaffold, and the repository says so in its own README. It contains real
drawing, real voting, a real draw-timer bug, a real duplicate-vote-after-reload bug, and a real
contradiction: its notes describe *public* voting (voter identities visible), while the demo
requirement is that voting must become *anonymous*.

A good demo run: bind the demo project, ask the team to review it, let Sam find the contradiction,
settle it with one targeted question, watch the decision revision land, watch the real edits and the
real checks, and have Sam verify the running app in Browserbase.

Reset: delete `.data/` (Huddle's own state, demos, artifacts, logs) and start again. Nothing in your
own project folders is touched by that.

## Storage

- Development: `.data/huddle-state.json` (plus `huddle-events.jsonl`, `rooms/<id>/artifacts`,
  `rooms/<id>/worktrees`, `projects/`, `electron-profile/`).
- Packaged: the same layout under Electron's `userData`.
- Writes are serialised and atomic (temp file + replace, with retries on Windows lock contention).
- A corrupt state file is copied to `.corrupt-<timestamp>` beside the original and reported; a valid
  older schema is migrated with a `.v<n>-<timestamp>.bak` backup.
- Operations a restart interrupted are listed as resumable items. Huddle never re-runs them by
  itself and never claims a process survived.

## Sponsor integrations

- **OpenAI** — real reasoning and tool selection for every agent turn, the conversation path, task
  decomposition, requirement changes, failure recovery and coordination. Not decorative text.
- **ElevenLabs** — streaming PCM synthesis with a distinct voice per teammate, playback-driven
  speaking indicators, interruption and barge-in. Never used for transcription.
- **Browserbase** — real remote sessions for QA: navigation, interaction, screenshots, network
  payload inspection and evidence artifacts against the running preview.
- Local **faster-whisper** and **Silero VAD** keep speech private.

## Repository layout

```
src/main/            Electron main: room state, hosts, IPC, composition root
src/main/runtime/    agent runtime (OpenAI provider, tools, executor, conversation, tasks)
src/main/exec/       workspaces, worktrees, files, patching, jobs, integration, preview
src/main/browser/    Browserbase sessions and automation
src/main/voice/      voice host, floor control, helper protocol (helper/ runs in its own process)
src/preload/         the only bridge to the renderer
src/renderer/src/    call UI, workspace surfaces, voice capture/playback
src/shared/          domain types, IPC contract, voice transport, agent presets
tools/voice-lab/     standalone local-speech lab (VAD, Whisper worker, ElevenLabs probes, tests)
demo/sketch-night/   the demonstration project
docs/OWNERSHIP.md    who owns which directory while building
scripts/             live smoke runs against the real providers
```

## Known limitations

`docs/BUILD_REPORT.md` records exactly what was verified against real hardware and providers, what
was only unit-tested, and what could not be run in the build environment.
