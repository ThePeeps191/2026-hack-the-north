# Facing the judges

Everything you need in your head when someone walks up to the table. Read the
first two sections even if you read nothing else.

Every number here is real and checked against this build. If you are not sure
about something, say you are not sure — a judge who catches one bluff discounts
everything else you said.

---

## 1 · The 20-second version

Say this before you touch the laptop:

> "Working with an AI agent is turn-based — you type, you wait, and if it went
> the wrong way three minutes ago you throw the work away and start over.
> Huddle is a voice call with three AI engineers who keep working while you
> talk. You can interrupt one mid-task and it changes course without losing
> what it already verified."

Then open the laptop. Do not explain the architecture until they ask.

**If you only get one sentence:** *"It's a voice room where you can talk over
AI agents while they're working, and the work actually changes."*

---

## 2 · The live demo, 3 minutes

Different from the video: judges interrupt, so be ready to abandon the script.

| Beat | Do | Say |
| --- | --- | --- |
| **Open** | Room already running, three tiles moving | "Three AI engineers, real repo, own git branches. Every line on these tiles is a tool call that really happened." |
| **Broadcast** | Say: *"Everyone, keep API spend under five dollars while you test."* | "That reached all three — not a router picking one. And it's stored as a standing rule, so a teammate I add later is bound by it too." |
| **THE MOMENT** | Give Maya a task. **Wait for her chip to read `THINKING`/`EDITING`.** Then talk over her. | "Watch — she answers out loud while her tools are still running, and her next actions switch from writes to reads." |
| **Proof** | Click her tile → Terminal, then Code | "Her own worktree and branch. Real command, real exit code. And her report says `[Redirected 1 time mid-run]` — so it's auditable." |

### The one rule that decides whether this works

**Only interrupt a teammate that is actually working.** If the chip says `IDLE`,
your instruction is an ordinary message — it works, but there is nothing to see
and no redirect marker.

I tested both: interrupting a `thinking` agent fired the steer event and produced
the marker; interrupting an `idle` one produced a polite reply and nothing else.

**If they go idle and you're on the spot:** give a fresh task, keep talking
about architecture for ten seconds, then interrupt. Do not interrupt an idle
agent to save time — the beat won't land.

---

## 3 · Architecture, in judge-answerable form

Three processes plus a helper. ~30,000 lines of TypeScript.

```
renderer ──typed IPC──▶ RoomService (state) ◀── HuddleBus ── runtime · exec · browser · voice
                                                                              │
                                                              main ──spawn──▶ voice helper
                                                                              ├── Silero VAD
                                                                              └── faster-whisper
```

### The interjection channel — the thing that makes it different

This is what they'll ask about. Know it cold.

The work loop is: model picks a tool → tool runs for real → result goes back in →
repeat. Up to **24 turns** per task, up to **4 tool calls in parallel**, up to
**5 teammates running at once** in a room.

The loop drains a separate interjection queue **before every model turn and after
every tool call**. If something lands mid-batch, the remaining planned tool calls
are **dropped** rather than executed against instructions that no longer hold.

> **Why it isn't just a queue:** my first version pushed everything — handoffs,
> instructions, work — into one queue per agent. That failed in exactly the way
> I was trying to fix: the agent finished what it was doing before reading the
> correction, then had to work out how much of its finished work was now
> invalid. That's turn-based again with extra steps. Interjection is a separate
> channel precisely so it can land *inside* a run.

The agent that was redirected reports it: `[Redirected N times mid-run; this
report is against the latest instruction.]` — generated from a counter in the
run, not from the model claiming it.

### Voice

- **Silero VAD + faster-whisper run locally**, in a helper process. Microphone
  audio never leaves the machine — there is no cloud speech-to-text path in the
  code at all.
- The helper is a separate Node process because **onnxruntime-node and the
  Python runtime can't share one**. It supervises a Python child that keeps
  faster-whisper resident so there's no per-utterance model load.
- **Knowing when you stopped talking** is the hard part, and the cost of being
  wrong is asymmetric — too early and agents answer an unfinished sentence, too
  late and every turn has a dead pause. Solved with **two thresholds**: enter
  speech at 0.5, stay in it down to 0.35, end the utterance after **700 ms** of
  silence.
- **Barge-in has its own, higher bar: 0.65, sustained over five 32 ms frames.**
  Talking over a teammate cuts its audio immediately — but never cancels its
  work. Those two states are deliberately independent.
- ElevenLabs is **synthesis only**, a distinct voice per teammate, streamed as
  PCM. First chunk arrives in about 180 ms.

### Workspaces

Each teammate gets a **real git worktree and branch** (`huddle/maya`). The Team
view is the integration workspace where branches are merged and the project's
own checks run against that exact revision.

Why: three agents editing one folder is a merge conflict with extra steps. This
way their work is genuinely parallel and every change is attributable.

### State

An atomic JSON store plus an append-only event log. Two rules:

- **Durability before announcement** — anything you asked for is written to disk
  *before* the event announcing it goes out. A failed write is rolled back and
  reported, never shown as saved.
- **Ephemeral events never touch disk** — audio levels, model tokens, job output
  and playback ticks are broadcast and dropped. They're not state.

### Model backends

Two behind one adapter, chosen by model id: `deepseek-*` → DeepSeek, `gpt-*` →
OpenAI (Responses API, falling back to chat completions). A model whose backend
has no key is **refused**, never silently answered by the other vendor — a model
id is a claim about which model did the work.

---

## 4 · Questions they will actually ask

**"How is this different from Devin / Cursor agents / a multi-agent framework?"**
> Those are turn-based. You submit, you wait, you review. The difference here is
> that you can talk *during* the run and it changes course — the instruction
> lands inside the loop rather than in a queue behind it. And it's a room, so a
> correction can reach all three at once.

**"Isn't this just a wrapper around an LLM API?"**
> The model picks tools. Everything the model is graded on is real: a git
> worktree per agent, a real process with a real exit code, a real remote
> browser. The interesting engineering is the interjection channel, the voice
> endpointing, and the rule that nothing reports a result that didn't happen.

**"How do you stop them hallucinating that they did something?"**
> Every state on screen comes from a committed tool run. A job killed by a
> restart is `unknown`, never "still running". Speech cut off is `interrupted`,
> not `played`. A failing check is reported as failing at the revision that
> produced it. Those are invariants with tests, not prompt instructions.

**"What happens when two agents edit the same file?"**
> They can't — separate worktrees. They negotiate the interface in the room
> instead, and you can watch it. In a run this morning the frontend engineer
> caught that the systems engineer's protocol change hadn't landed on main and
> quoted the exact TypeScript error her typecheck produced.

**"Does the voice actually work or is it typed?"**
> It's real. Local VAD and Whisper, ElevenLabs out. Happy to say something to
> the room right now. *(Then do it.)*

**"How much did you build vs. the AI?"**
> Be straight: you designed the architecture, the agent design, and the product;
> LLMs wrote much of the code under that design. That's a normal 2026 answer and
> judges respect it far more than a dodge. What you should be able to do is
> explain any part of it — which is what section 3 is for.

**"What's the hardest bug you hit?"**
> Good ones to tell: teammates introducing themselves with each other's names
> (personas were generated from a different list than the names); "everyone"
> reaching exactly one agent because the router collapsed room-wide messages to
> a single owner; and a context trimmer that could cut between a tool call and
> its result, which every provider rejects — that one made long runs end with no
> report at all.

**"What would you do with another week?"**
> Teammates interrupting each other — same channel, but I haven't solved
> stopping three agents derailing each other in a loop. Then persistent agents
> across sessions.

---

## 5 · Sponsor tracks — say the specific thing

Generic praise scores nothing. Each sponsor judge wants to hear how their thing
was load-bearing.

**ElevenLabs**
> A distinct voice per teammate, streamed as PCM, with playback-driven speaking
> indicators — the tile shows speaking because audio is actually playing, not
> because tokens arrived. Barge-in cuts the stream mid-sentence and the message
> is marked `interrupted`, not `played`. Without distinct voices you can't tell
> who's talking in a room, and the whole premise collapses.

**Browserbase**
> I considered a VM per teammate and rejected it as too resource-heavy. What a
> VM actually gives an agent is computer use and browser automation — which
> Browserbase gives you directly. So a session *is* the QA teammate's operating
> environment: it navigates, interacts, screenshots and inspects network
> payloads against the running app. That last one matters — the QA agent checks
> the payload, not just the rendered UI, which is how it proves voter names
> aren't leaking.

**OpenAI**
> *(Only say the version that's true when you demo.)* The adapter speaks the
> OpenAI wire format and routes `gpt-*` there; I built the whole project on the
> Codex + API promotion. If you're running on OpenAI at demo time, say so
> plainly. If you're not, say "OpenAI and DeepSeek behind one adapter, chosen
> per model id" — which is a better engineering answer anyway.

---

## 6 · Do not claim

The project is strong enough without stretching:

- Teammates **cannot** interrupt each other yet — only you can.
- Agents **do not** persist across sessions.
- It is **not** a sandbox — commands are real commands on your machine.
- Whisper `base.en` **does** mis-hear words sometimes. If it garbles one on
  stage, laugh and retype it. It's a small model chosen for latency.

Saying these unprompted makes everything else more credible.

---

## 7 · Sixty seconds before they arrive

- [ ] `npm run demo:check` — all green
- [ ] Provider has credit (a run costs ~$0.12)
- [ ] Room already open with three teammates **working**, not idle
- [ ] Headphones on
- [ ] Gallery view showing, not a workspace
- [ ] Laptop plugged in, notifications off
