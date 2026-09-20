# Facing the judges

Everything you need in your head when someone walks up to the table, plus the
five-minute presentation structure. Read sections 1, 2 and 3 even if you read
nothing else.

Every number here is real and checked against this build. If you are not sure
about something, say you are not sure — a judge who catches one bluff discounts
everything else you said.

---

## 1 · The two rules that decide whether the demo lands

### Rule 1 — only interrupt a teammate that is actually working

The headline feature is that an instruction lands *inside* a running loop. If
the teammate has gone idle, your instruction is an ordinary message. It still
works, but nothing visible happens and the `[Redirected 1 time mid-run]` marker
never appears.

> **Look at the state chip on the tile. Speak while it reads `THINKING`,
> `READING`, `EDITING` or `RUNNING`. Never while it reads `IDLE`.**

Verified both ways on this build: interrupting a `thinking` teammate fired the
steer event and produced the marker; interrupting an `idle` one produced a
polite reply and nothing else.

### Rule 2 — speak in short command sentences

Transcription is local Whisper `base.en`, chosen for latency. It is accurate on
short, clear, command-shaped speech and **unreliable on long sentences**.

Measured on this build — what was said versus what it heard:

| Said | Heard |
| --- | --- |
| "Maya here, the build has passed and I pushed the branch for review." | "Maya here, the build **a past** and I push the branch for review." |

The name came through perfectly. The long tail did not. So:

- **Start with the name.** "Maya, ..." routes correctly every time.
- **One clause.** "Maya, stop and research the payload shape first." not
  "Maya, I'd like you to hold off on the implementation because I think we
  should understand the payload shape before committing to an approach."
- If it mis-hears on stage, **laugh and retype it**. Say "small model, runs
  locally, that's the tradeoff." Judges respect the honesty and it costs you
  nothing.

---

## 2 · The 20-second version

Say this before you touch the laptop:

> "Working with an AI agent is turn-based — you type, you wait, and if it went
> the wrong way three minutes ago you throw the work away and start over.
> Huddle is a voice call with three AI engineers who keep working while you
> talk. You can interrupt one mid-task and it changes course without losing
> what it already verified."

**If you only get one sentence:** *"It's a voice room where you can talk over AI
agents while they're working, and the work actually changes."*

---

## 3 · The five-minute presentation

Structured so the strongest thing happens at 2:00, while you still have their
attention, and so the slow parts are covered by talking rather than silence.

### 0:00–0:30 · Open on motion

The room is **already running** before they arrive — three tiles, real tool
lines scrolling. Never open on a static screen or a launch page.

> "Three AI engineers, working on a real repo right now, each in their own git
> branch. Every line you see on these tiles is a tool call that actually
> happened — no mock-ups."

### 0:30–1:15 · The problem, while they watch it move

> "Normally you work with an agent one turn at a time. You type, you wait, and
> if it took a wrong turn three minutes ago, the only fix is to throw the work
> away and start again. That's not how a team works. On a real team you talk
> while the work is happening."

Point at the tiles as you talk. Motion holds attention while you explain.

### 1:15–1:45 · Say it to the room

Speak, don't type:

> "Everyone, keep API spend under five dollars while you test."

All three answer in their own words.

> "That reached all three — not a router picking one winner. And it's recorded
> as a standing rule on the room, so a teammate I add an hour from now is bound
> by it too."

### 1:45–3:00 · The moment — this is the whole pitch

1. Give someone real work: *"Maya, implement the anonymous vote UI and update
   the tests."*
2. **Wait for her chip to change to `THINKING` or `EDITING`.** This takes
   10–20 seconds. **Fill it by talking** — use the git-worktree explanation from
   section 4. Never stand in silence.
3. While she is working, talk over her:

> "Maya — actually stop, and research the payload shape before you write any
> more code."

Point at each thing as it happens:

- tile **pulses**, chip flips to **"Heard you"**
- she answers **out loud in one sentence** while her tools are still running
- her next actions switch from **writes to reads**
- her report ends with **`[Redirected 1 time mid-run]`**

> "She didn't finish the old thing first, and she didn't start over. The
> instruction landed inside the loop that was already running. And the report
> says so — so I can audit it rather than take her word for it."

**Say that last line slowly. It is the whole project.**

### 3:00–4:00 · Prove it is real

Click her tile → **Terminal**, then **Code**.

> "Her own worktree, her own branch. Real command, real exit code — including
> when it fails. Nothing in this app reports a result that didn't happen."

If Sam has a browser session: show it. A real Chromium in Browserbase with the
app running in it.

### 4:00–4:30 · One honest limitation, volunteered

This buys more credibility than anything else you can say:

> "Teammates can't interrupt each other yet — only I can. The channel is the
> same one; I just haven't solved stopping three agents derailing each other in
> a loop."

### 4:30–5:00 · Close and hand over

> "Three AI engineers on a real codebase, in a room you can talk over. Built
> solo, this weekend. Happy to take questions."

Then **stop talking.** Let them ask.

---

## 4 · Architecture, in judge-answerable form

Three processes plus a helper. ~30,000 lines of TypeScript.

```
renderer ──typed IPC──▶ RoomService (state) ◀── HuddleBus ── runtime · exec · browser · voice
                                                                              │
                                                              main ──spawn──▶ voice helper
                                                                              ├── Silero VAD
                                                                              └── faster-whisper
```

### The interjection channel — know this cold

The work loop is: model picks a tool → tool runs for real → result goes back in
→ repeat. Up to **24 turns** per task, **4 tool calls in parallel**, **5
teammates running at once**.

The loop drains a separate interjection queue **before every model turn and
after every tool call**. If something lands mid-batch, the remaining planned
tool calls are **dropped** rather than run against instructions that no longer
hold.

> **Why it isn't just a queue:** my first version pushed everything — handoffs,
> instructions, work — into one queue per agent. That failed in exactly the way
> I was trying to fix: the agent finished what it was doing before reading the
> correction, then had to work out how much of its finished work was now
> invalid. That's turn-based again with extra steps. Interjection is a separate
> channel precisely so it can land *inside* a run.

The redirect marker is generated from a counter in the run, not from the model
claiming it.

### Voice

- **Silero VAD and faster-whisper run locally**, in a helper process.
  Microphone audio never leaves the machine — there is no cloud speech-to-text
  path in the code at all.
- The helper is a **separate Node process** because onnxruntime-node and the
  Python runtime can't share one. It supervises a Python child that keeps
  faster-whisper resident, so there's no per-utterance model load.
- **Endpointing** is the hard part, and being wrong is asymmetric: too early and
  agents answer an unfinished sentence, too late and every turn has a dead
  pause. Solved with **two thresholds** — enter speech at 0.5, stay in it down
  to 0.35, close the utterance after **700 ms** of silence.
- **Barge-in has its own higher bar: 0.65, sustained over five 32 ms frames.**
  Talking over a teammate cuts its audio immediately but never cancels its work.
  Those two states are deliberately independent.
- ElevenLabs is **synthesis only** — a distinct voice per teammate, streamed as
  PCM, first chunk in about **180 ms**.

### Workspaces

Each teammate gets a **real git worktree and branch** (`huddle/maya`). The Team
view is the integration workspace where branches merge and the project's own
checks run against that exact revision.

Why: three agents editing one folder is a merge conflict with extra steps. This
way the work is genuinely parallel and every change is attributable.

### State

An atomic JSON store plus an append-only event log. Two rules:

- **Durability before announcement** — anything you asked for is on disk
  *before* the event announcing it goes out. A failed write is rolled back and
  reported, never shown as saved.
- **Ephemeral events never touch disk** — audio levels, model tokens, job output
  and playback ticks are broadcast and dropped. They aren't state.

### Model backends

Two behind one adapter, chosen by model id: `deepseek-*` → DeepSeek, `gpt-*` →
OpenAI (Responses API, falling back to chat completions). A model whose backend
has no key is **refused**, never silently answered by the other vendor — a model
id is a claim about which model did the work.

---

## 5 · Questions they will actually ask

**"How is this different from Devin / Cursor agents / a multi-agent framework?"**
> Those are turn-based. You submit, you wait, you review. Here you can talk
> *during* the run and it changes course — the instruction lands inside the loop
> rather than in a queue behind it. And it's a room, so one correction reaches
> all three.

**"Isn't this just a wrapper around an LLM API?"**
> The model picks tools; everything it's graded on is real. A git worktree per
> agent, a real process with a real exit code, a real remote browser. The
> engineering is the interjection channel, the voice endpointing, and the rule
> that nothing reports a result that didn't happen.

**"How do you stop them hallucinating that they did something?"**
> Every state on screen comes from a committed tool run. A job killed by a
> restart is `unknown`, never "still running". Speech cut off is `interrupted`,
> not `played`. Those are invariants with tests, not prompt instructions.

**"What happens when two agents edit the same file?"**
> They can't — separate worktrees. They negotiate the interface in the room
> instead, and you can watch it happen. In a run this morning the frontend
> engineer caught that the systems engineer's protocol change hadn't landed on
> main, and quoted the exact TypeScript error her typecheck produced.

**"Does the voice actually work, or is it typed?"**
> It's real — local VAD and Whisper in, ElevenLabs out. *(Then do it.)*

**"How much did you build versus the AI?"**
> Be straight: you designed the architecture, the agent design and the product;
> LLMs wrote much of the code under that design. That's a normal 2026 answer and
> judges respect it far more than a dodge. What matters is that you can explain
> any part of it — which is what section 4 is for.

**"What's the hardest bug you hit?"**
> Teammates introducing themselves with each other's names (personas were
> generated from a different list than the names); "everyone" reaching exactly
> one agent because the router collapsed room-wide messages to a single owner;
> and a context trimmer that could cut between a tool call and its result, which
> every provider rejects — that one made long runs end with no report at all.

**"What would you do with another week?"**
> Teammates interrupting each other — same channel, but I haven't solved
> stopping three agents derailing each other in a loop. Then persistent agents
> across sessions.

---

## 6 · Sponsor tracks — say the specific thing

Generic praise scores nothing. Each sponsor judge wants to hear how their thing
was load-bearing.

**ElevenLabs**
> A distinct voice per teammate, streamed as PCM, with playback-driven speaking
> indicators — the tile shows speaking because audio is actually playing, not
> because tokens arrived. Barge-in cuts the stream mid-sentence and the message
> is marked `interrupted`, not `played`. Without distinct voices you can't tell
> who's talking in a room, and the premise collapses.

**Browserbase**
> I considered a VM per teammate and rejected it as too resource-heavy. What a
> VM actually gives an agent is computer use and browser automation — which
> Browserbase gives directly. So a session *is* the QA teammate's operating
> environment: it navigates, interacts, screenshots and inspects network
> payloads against the running app. That last part matters — it checks the
> payload, not just the rendered UI, which is how it proves voter names aren't
> leaking.

**OpenAI**
> Only say the version that is true when you demo. If you're running on OpenAI,
> say so plainly. If you're not, say "OpenAI and DeepSeek behind one adapter,
> chosen per model id" — which is a better engineering answer anyway.

---

## 7 · Do not claim

- Teammates **cannot** interrupt each other yet — only you can.
- Agents **do not** persist across sessions.
- It is **not** a sandbox — commands are real commands on your machine.
- Whisper `base.en` **does** mis-hear. Own it if it happens.

Volunteering these makes everything else more credible.

---

## 8 · Sixty seconds before they arrive

- [ ] `npm run demo:check` — all green
- [ ] Provider has credit (a run costs ~$0.12)
- [ ] `node scripts/demo-warm.mjs` — team working, gallery showing
- [ ] Headphones on
- [ ] Laptop plugged in, notifications off
- [ ] Chip on at least one tile is **not** `IDLE`
