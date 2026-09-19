# Huddle — build and verification report

This is the record of what was built in the `65b3d6a` checkout, how it was
verified, and what remains unverified. Nothing here is inferred from a green
build: every verification line names the command that produced it and, where a
provider or the hardware is involved, the raw result.

## 1. What shipped

| System | Where | State |
| --- | --- | --- |
| Room state, persistence, migration, recovery, typed IPC, composition root | `src/main/{room-service,json-store,migrate,event-log,paths,ipc,index,app-main,contracts}.ts`, `src/main/config/**`, `src/preload/**` | Complete |
| Agent runtime: OpenAI provider (Responses API with chat fallback), 30 tools, work loop, conversation path, router, mailboxes, task graph, spoken/written split | `src/main/runtime/**` | Complete |
| Execution: project binding, git worktrees, files, patch apply, real diffs, jobs, process-tree cancellation, serialised integration with real checks, preview tunnel | `src/main/exec/**` | Complete |
| Browser: real Browserbase sessions over CDP with Playwright, observations, interactions, screenshots, network evidence, cleanup | `src/main/browser/**` | Complete |
| Voice: helper process (Silero VAD, faster-whisper worker, ElevenLabs streaming PCM), floor control, capture/playback in the renderer, captions, barge-in | `src/main/voice/**`, `src/main/voice-helper.ts`, `src/renderer/src/voice/**`, `src/renderer/public/**` | Complete |
| Call-first UI: gallery tiles, dock, sidebar, right rail, spotlight, share frame, settings | `src/renderer/src/call/**`, `src/renderer/src/styles/**` | Complete |
| Workspace surfaces: code, terminal, files, browser | `src/renderer/src/share/**` | Complete |
| Demo project with real bugs and a real requirements contradiction | `demo/sketch-night/**` | Complete |
| Live verification tooling | `scripts/live-smoke.ts`, `scripts/demo-run.ts`, `scripts/ui-check.ts`, `src/main/runtime/probe.ts`, `src/main/browser/verify.ts`, `tools/voice-lab/scripts/verify-live.ts` | Complete |

## 2. How the work was split

The integration lead (this session's primary agent) owned `src/shared/**`,
`src/main/{contracts,index,app-main,ipc,room-service,json-store,migrate,paths,event-log,huddle-error}.ts`,
`src/main/config/**`, `src/preload/**`, the renderer shell (`App.tsx`,
`useHuddle.ts`, `apply-event.ts`, `state/**`), root configuration, tests and the
README. Five subagents worked in exclusive directories: agent runtime
(`src/main/runtime/**`), voice (`src/main/voice/**`, `src/main/voice-helper.ts`,
`src/renderer/src/voice/**`, `tools/voice-lab/**`), execution
(`src/main/exec/**`, `src/renderer/src/share/{code,terminal,files}/**`), browser
(`src/main/browser/**`, `src/renderer/src/share/browser/**`), and the call UI
(`src/renderer/src/call/**`, `src/renderer/src/styles/**`, `src/renderer/src/App.css`).
The demo project (`demo/sketch-night/**`) was prepared in a sixth workstream.
No two writers shared a file. The integration lead then reconciled every seam,
compiled the whole tree, and fixed the defects listed in §5.

## 3. Verification results

### 3.1 Local gates (all re-run after the last change)

| Gate | Command | Result |
| --- | --- | --- |
| Root tests | `npm test` | **290 tests, 61 suites, 0 failures** (baseline: 13 tests, 3 passing) |
| Root typecheck | `npm run typecheck` | clean (main/preload/shared + renderer) |
| Root build | `npm run build` | clean: `out/main/index.js`, `out/main/voice-helper.js`, `out/preload/index.js`, `out/renderer/**` |
| Voice lab tests | `cd tools/voice-lab; npm test` | **35 tests, 0 failures** (baseline: 31) |
| Voice lab typecheck | `cd tools/voice-lab; npm run typecheck` | clean |
| Demo tests | `cd demo/sketch-night; npm test` | **13 tests, 0 failures** |
| Demo build | `cd demo/sketch-night; npm run build` | clean |
| Demo dev server | start `npm run dev`, fetch `/` and `/api/health` | page 200; `{"ok":true,"phase":"lobby",...}`; ports released after kill |

### 3.2 Live providers and hardware

| Check | Command | Raw result |
| --- | --- | --- |
| OpenAI transport and tool calling | `npm run verify:openai` | Responses API accepted: 126 models listed; `gpt-5.6-luna` returned a real tool call; a full tool round trip returned text. Chat-completions fallback answered `incomplete` at the probe's 200-token cap (reasoning tokens count against it) — the adapter keeps a 2400-token budget for real turns |
| ElevenLabs voices + streaming | `node tools/voice-lab/scripts/verify-live.ts` | 21 voices on the account; **all five preset voice ids valid** (Laura/Maya, Eric/Alex, Alice/Sam, Charlie/Rio, River/Nova); streaming synthesis produced 167 chunks / 171,642 bytes / 3.58 s of 24 kHz PCM, first chunk after 146 ms |
| Local VAD + local transcription | same script | Silero ONNX loaded (2,327,524 bytes); VAD fired speech-start on the synthesized audio (peak probability 1.0); faster-whisper transcribed it locally as “Maya here, the build passed, and I push the branch for review.” (6/7 content words matched) — no cloud STT involved |
| Browserbase | `npm run verify:browser` | Real session `7b7cd37b` in us-west-2 at 1440×900: navigate HTTP 200, accessibility observation with element refs, real mouse strokes (2 pointerdown / 21 pointermove / 1 pointerup), a click that changed the URL to iana.org, a screenshot written as a real 1440×900 PNG (148,525 bytes, header verified), 12 captured responses with bodies, session closed and confirmed `COMPLETED` by the provider, reconcile wrote back a terminal status, local URLs refused with an explanation |
| Agent work on the demo project (headless) | `node --experimental-transform-types scripts/live-smoke.ts --model=gpt-5.6-luna` | Real tool runs (`list_files`, `read_file README.md`, `read_file FEATURE_NOTES.md`, `update_task`), a grounded written report quoting that voter names are deliberately public, a task moved to `awaiting_review`, and two speech intents (`ack`, `result`) with the spoken form stripped of file names |
| The real app, driven through its own UI | `node --experimental-transform-types scripts/ui-check.ts` | 13/13 checks on a fresh room (call-first shell, 4 participant tiles, honest “Connected/Idle” states, real dock controls with disabled reasons, independent panel scrolling, no horizontal overflow at 1266×763 or 987×663, no console errors); in a focused-share room the stage-mode checks pass as well (owner, branch, verified revision, fixed shell, rail scrolling) |
| The real app, one agent turn through the UI | `node --experimental-transform-types scripts/demo-run.ts` | see §4: 27 real tool calls, a real `npm test` job (exit 0), a grounded report, a recorded decision revision, stale-speech invalidation, handoffs with file/line evidence and a report artifact |

### 3.3 Not verified (stated plainly)

- **Microphone hardware.** Capture is exercised through the worklet path and the
  host's frame pipeline in tests; no physical microphone was recorded in this
  environment. Headphones are recommended for the first live run (speaker echo
  will trigger barge-in).
- **ElevenLabs audio actually coming out of a speaker.** Synthesis was verified
  end to end over the wire and decoded to PCM; the final audible step depends on
  the machine's output device.
- **Packaged build** (`electron-builder`/installer) — the repo has no packaging
  configuration; `npm run build` produces the runnable output directory.
- **Screenshots in the current window state.** Screenshots and window resizing
  worked while the window was producing frames (four PNGs were captured at
  1280×800 and 1000×700 during the checks above). In a later session the window
  stopped producing frames — over CDP, `page.screenshot` then times out — so the
  final pass relied on DOM measurements instead. The tool reports this honestly
  rather than silently passing.
- **The full Sketch Night story** (anonymous-voting *implementation*, a QA finding
  routed to an owner, the fix retested against the exact revision) is reachable
  from the product and its pieces are verified above — decision revisions, stale
  marking, handoffs, per-agent worktrees, real commands, browser verification and
  integration checks — but the end-to-end narrative was not run to completion in
  this session.

## 4. The application, end to end

`scripts/demo-run.ts` drives the running Electron app over the Chrome DevTools
Protocol: it clicks the real “Use demo” control, types into the real composer and
prints what the team actually did. Two runs are recorded in this build.

### 4.1 A review request, answered from real files

Instruction (typed into the composer): *“Sam, read FEATURE_NOTES.md and
BUG_REPORT.md in this project, then tell me exactly how voting works today and
whether the written notes and the code agree. Do not change any files.”*

What the app did, from its own state: the room bound
`.data/projects/sketch-night-14e5799a` (a real git repository, initialise with one
commit) and created Sam a real worktree at
`.data/rooms/<room>/worktrees/sam` on branch `huddle/sam`. Sam then ran **27 real
tool calls** — `list_files`, `read_file` on `FEATURE_NOTES.md`, `BUG_REPORT.md`,
`server/game.ts`, `server/index.ts`, `src/useGame.ts`,
`src/components/VoteGallery.tsx`, `shared/protocol.ts`, `test/game.test.ts`,
`package.json`, `src/App.tsx` and the README, `search_text "vot"` (100 hits, and
it reported that the search stopped early) — then **started a real command**,
`npm test`, labelled “Read-only voting regression check”, waited for it through
`wait_for_job` and saw it exit 0, checked `inspect_diff` (“No changes in Sam's
worktree”) and closed the task.

Its written report was grounded in what it read: *“Voting is deliberately public
today. The notes and code agree on that, but ‘one vote per player’ is not
enforced by the server.”* — then the timing, eligibility and visibility rules it
had actually verified, with twelve file references attached. That last sentence
is the demo project's seeded duplicate-vote bug, found by reading the code rather
than trusting the notes.

### 4.2 A requirement change, in the middle of work

Instruction: *“Change of requirement: voting must be anonymous — voter names must
never reach the client. Record that as a decision and tell me which existing work
it affects.”*

The app recorded decision **r1 “Voting must be anonymous”**, then told the human
what it had done:

- *“Requirement change recorded (revision 1). Queued speech from before it was
  dropped.”* — stale speech invalidation, exactly as specified.
- *“Decision r1 applied: 1 teammate(s) notified, 0 queued handoff(s) dropped,
  stale tasks flagged.”*

Sam reviewed the impact against the real code and **handed work to the right
owners** with `message_teammate`:

- to Alex: “shared/protocol.ts `Sketch.voters`, server/game.ts vote/snapshot/scoring,
  server/index.ts broadcasts, and test/game.test.ts wire identity assertions must
  change together; **UI-only hiding cannot satisfy it**. Existing double-vote bug
  remains separate.”
- to Maya: “VoteGallery.tsx:36-37 public-voting copy and :66-69 voter-name
  rendering are affected, including results; coordinate with server/protocol
  changes rather than hiding names only in UI.”

Alex — working in its own worktree `huddle/alex`, which the app created and
announced — replied with a grounded analysis: “`shared/protocol.ts:17` exposes
voter names, `server/game.ts:120` stores them, snapshots copy them at lines 39–42,
and scoring counts them at line 192. `server/index.ts:34–41` broadcasts those
snapshots, so anonymity must hold in outbound data — not just the UI. … no files
changed or tests run by me.” A report artifact (“Anonymous voting — r1 impact
review”) was written and attached to the room.

Speech states in both runs read `cancelled`, not `played`, because the voice layer
was not joined: Huddle never claims the human heard something it did not play.

## 5. Defects found and fixed during integration

Everything below was a real failure observed by a test or a live run, not a
style preference.

1. **The concurrency guard did not guard.** `Semaphore.drain()` woke every waiter
   while only reserving one slot, so a limit of 1 ran two tools at once. Caught by
   `tools.test.ts`, fixed by reserving the slot before waking a waiter.
2. **A busy teammate could not be asked anything.** `pickOwner` scored a busy
   agent at −1 against an initial best of −1, so a single busy agent produced “no
   teammate was available” and the question was dropped. Fixed to keep a candidate
   below zero and to say honestly that the agent is already working.
3. **Investigation instructions never started work.** “Read the missing file”,
   “check the payload”, “inspect the diff” were routed to the conversational path,
   which has no tools. Added investigation verbs (`read`, `inspect`, `check`,
   `audit`, `trace`, …) to the work router.
4. **Partials were transcribed from silence.** `UtteranceSegmenter` seeded
   `lastPartialAt` with `0`, so the first frame looked like a whole interval had
   passed and a partial was requested from silence.
5. **Two clock domains in the voice host.** VAD events used the wall clock while
   frame cadence used the renderer's capture clock, so partials drifted and
   segmentation mixed time bases. The frame clock is now published for the frame
   being processed and used consistently; reported timing labels stay wall-clock.
6. **`write_file` and `apply_patch` silently trimmed their input.** Every string
   argument was `.trim()`ed, which removed a file's trailing newline and the
   newline a patch needs. Added a `raw` option and used it for both.
7. **Real `git diff` output was rejected by the patch parser.** Splitting on
   `\n` leaves one empty element for a patch that ends with a newline, and the
   parser treated it as a stray line.
8. **Spoken text mangled file names.** The sentence splitter broke `README.md`
   into “README.” *and* “md” before paths were softened, so the voice read out
   “According to README. md”. Paths are now softened before sentence splitting.
9. **The tiles contradicted themselves.** After `attachRoom`, agents were marked
   `connected: true` while their work state stayed `offline`, so a tile showed
   “Connected / Offline”. Attaching now moves an idle teammate to `idle`, and
   detaching puts it back to `offline`.
10. **Foundation repairs** (the reason the baseline was red): `RoomService.open()`
    did not exist while IPC and tests called it; IPC registered five channels out
    of forty; the preload exposed five of the bridge's methods; `electron.vite.config.ts`
    referenced a missing `src/main/voice-helper.ts`; `migrate.ts` had typing that
    could not compile; the v1 → v2 path dropped nothing but was never exercised;
    error shapes disagreed between layers. All of this was replaced with one
    coherent contract, and the stale calls and tests were updated rather than
    preserved.
11. **Real migration observed in the wild.** On this machine the app found a v1
    state file written by the previous build, migrated it, wrote
    `huddle-state.json.v1-<stamp>.bak` beside it, and carried the rooms, agents
    and messages across (verified against the backup: the v1 room's empty
    `description` correctly became an empty goal).

## 6. Known limitations

- Huddle confines file paths to the bound workspace and validates every IPC
  payload, but a shell command an agent runs is a real command on your machine.
  A project folder plus a shell is not a sandbox, and the UI says so.
- One human and one audible room at a time; multi-human calling, authentication,
  billing and cloud operation are out of scope.
- The renderer bundle is large (Monaco ships its language set): ~6.5 MB of
  JavaScript in `out/renderer`. It loads from disk, not the network.
- Windows is the tested platform (process-tree kill, atomic-write retries). The
  POSIX paths exist but were not exercised here.
- Model ids are configurable; the shipped defaults are the two models this
  account can actually reach, and a model is only shown as verified once it has
  answered a real request.

## 7. Reproducing the verification

```bash
npm install
npm test && npm run typecheck && npm run build

cd tools/voice-lab && npm test && npm run typecheck && cd ../..
node tools/voice-lab/scripts/verify-live.ts      # ElevenLabs + local VAD/Whisper
cd demo/sketch-night && npm run build && npm test && cd ../..

npm run verify:openai        # live OpenAI transport and tool calling
npm run verify:browser       # live Browserbase session
npm run smoke                # headless agent run against the demo project

npm run dev                  # then, from another shell:
npm run ui-check             # 13 checks against the running window
npm run demo-run             # one real turn through the app's own UI
```
