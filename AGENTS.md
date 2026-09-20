# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

Huddle is an Electron desktop app: a live voice room where a small team of AI agents does real
software work on a real project folder on your machine. Agents read files, run commands, open the
app in a remote browser, record decisions and hand work to each other. The human talks out loud and
can redirect an agent *while it is working*.

This is a hackathon project. It is demoed live, so correctness you can see matters more than
elegance, and an honest failure beats a convincing lie.

## Commands

```bash
npm run dev            # electron-vite dev with hot reload
npm run build          # build main, preload, renderer, voice helper
npx electron .         # run the built app
npm test               # all tests (node --test over src/**/*.test.ts)
npm run typecheck      # tsc for main+shared, renderer, and scripts (three projects)

# A single test file — Node strips types natively, there is no build step for tests:
node --experimental-transform-types --test src/main/runtime/roster.test.ts

# A single test by name:
node --experimental-transform-types --test --test-name-pattern="stale" src/main/runtime/tasks.test.ts

# Prove things work against the real providers rather than a mock:
npm run demo:check     # preflight: node/git/disk + does each provider ACTUALLY serve a request
npm run verify:voice   # ElevenLabs stream, Silero VAD, local Whisper, real audio
npm run verify:browser # opens and releases a real Browserbase session
npm run smoke          # live end-to-end run against real providers
npm run ui-check       # checks against a running window over CDP
```

There is no lint script. `npm run check` = typecheck + test.

`npm run demo:check` is the first thing to run when something "is broken" — an empty provider
account or a full disk produces failures that look exactly like application bugs. This has already
happened twice.

## Architecture

Three processes plus a helper:

```
renderer ──typed IPC──▶ RoomService (state) ◀── HuddleBus ── runtime / exec / browser / voice
```

- **`src/main/app-main.ts` is the composition root.** It wires the hosts together and owns the
  shutdown chain (`before-quit` → dispose voice, browser, exec, runtime, service). Nothing here does
  product work. `src/main/index.ts` only exists because electron-vite names `index` as the entry.
- **`src/main/contracts.ts` is the module seam.** `HuddleBus`, `ExecutionHost`, `BrowserHost`,
  `VoiceHost` and `AgentRuntime` are the only way the subsystems talk. Subsystems implement these
  interfaces and must not import each other's internals. Changes here ripple everywhere — make them
  deliberately.
- **`src/shared/types.ts` is the single domain contract** across main, preload and renderer. The
  header says specialists request changes rather than editing it; respect that when adding to it.
- **The renderer cannot reach the filesystem, Node or raw IPC.** It gets the narrow typed API in
  `src/preload/index.ts`, handled by `src/main/ipc.ts`. Every IPC payload is narrowed before it
  reaches a host, so a renderer cannot smuggle an arbitrary path or command through.
- **`src/main/voice/helper/` runs in its own Node process**, because onnxruntime-node and the Python
  runtime cannot share one. It supervises a long-lived Python child
  (`tools/voice-lab/python/transcribe_worker.py`) that keeps faster-whisper resident, and runs
  Silero VAD in-process. The Node side talks to it over `voice/protocol.ts`. Microphone audio only
  travels main → helper → that child over a pipe, as base64 PCM. Nothing in this path touches a
  network.

### State and events

`RoomService` holds the snapshot; `HuddleBus.emit` broadcasts events that the renderer applies via
`src/renderer/src/apply-event.ts`. Two rules are load-bearing:

- **Durability before announcement.** Anything that was asked for is written to disk *before* the
  event announcing it goes out. A failed write is rolled back and reported, never shown as saved.
- **Ephemeral events never touch the disk.** Audio levels, model tokens, job output and playback
  ticks are broadcast and dropped.

### The agent runtime (`src/main/runtime/`)

- `executor.ts` is the work loop: model turn → tool call → real result → repeat, until the agent
  replies, runs out of turns, fails or is cancelled. Every state it reports comes from an action
  that actually happened.
- `router.ts` decides who an unaddressed message is for. A room-wide message goes to the whole
  roster; a named one goes to that agent.
- `mailbox.ts` carries handoffs between agents. `executor.interject()` is the separate channel that
  lets a human redirect an agent *mid-run* — it lands before the next model turn, and is the
  headline feature. Do not route human instructions through the mailbox instead.
- `tasks.ts` is the task graph; `plannedBefore()` marks work stale when a decision revision moves.
- `roster.ts` picks who staffs a room from its goal, with a model call falling back to keywords and
  then to a fixed order.

### Model backends

Two backends behind one adapter (`runtime/provider.ts`), chosen by model id: `deepseek-*` →
DeepSeek, `gpt-*`/`o1`/`o3`/`o4` → OpenAI (Responses API, falling back to chat completions). Both
slots default to `deepseek-flash`. A model whose backend has no key is **refused**, never silently
answered by the other vendor — a model id is a claim about which model did the work.

## Invariants

These are the product. Breaking one silently is worse than a crash.

- **No invented results.** A failing tool reports the real error. A job interrupted by a restart is
  `unknown`, never "still running". Speech that was cut off is `interrupted`, not `played`.
- **Work state and speech state are independent.** Interrupting speech never cancels work; muting
  the mic never cancels work.
- **Microphone audio never leaves the machine.** There is no cloud STT path in the code.
- **A teammate introduces itself as the name on its own tile.** Personas are generated from the
  name the room actually assigned. This was broken once and is the worst bug the app can have.

## Gotchas

- **Speech is deliberately cancelled when nobody is in the call.** `voice/floor.ts` cancels with
  reason `inactiveRoom` so ElevenLabs credits are not burned on audio nobody hears. A message
  sitting at `spoken: cancelled` while you are not in the call is correct, not a bug.
- **Do not force-kill the app.** `before-quit` runs the dispose chain that reaps job process trees.
  `Stop-Process -Force` skips it and orphans dev servers and localtunnel processes whose working
  directory is inside `.data`, which then makes `.data` undeletable. Kill anything whose command
  line mentions `.data` **or `localtunnel`** (the tunnel's command line points at the npx cache, not
  `.data`).
- **`.data/` is Huddle's own state** — rooms, worktrees, demo copies, logs. Deleting it resets the
  app and resets nothing else; it never touches a user's project folder. There is no `.data/.env`;
  secrets live in the repo-root `.env`.
- **Tests import with explicit `.ts` extensions** and run through Node's native type stripping
  (`--experimental-transform-types`). There is no compile step and no test framework.
- `src/main/runtime/test-hosts.ts` provides fakes (`FakeBus`, `fakeDeps`, `makeRoom`) — use it
  rather than standing up real hosts.

## Conventions

**Comments explain why, not what.** This codebase states the reasoning behind a decision, the
failure that motivated it, and what would break if it changed — often naming the real incident. A
comment that restates the code is worse than no comment; match the density and voice of the
surrounding file.

Docs worth knowing: `docs/OWNERSHIP.md` (who owns which directory), `docs/TESTING.md` (hand-testing
checklist), `docs/BUILD_REPORT.md` (what was verified against real hardware vs only unit-tested).
