# Huddle — the demo

A five-minute run that shows the one thing nothing else does: **you can talk to
a team of agents while they are working, and the work changes.**

Everything below is a real behaviour backed by a real record. Nothing here is
scripted output, and every claim the team makes on stage can be opened and
checked in the same window.

---

## The argument you are making

Judges have seen agents that do work. The three beats below are the ones they
have not seen, in the order that makes them land:

1. **You say something to the room and the whole room hears it.**
   Not "the orchestrator picked the best agent". All of them.
2. **You interrupt one teammate mid-task and it changes course without
   restarting.** The instruction lands *inside* the loop that is already
   running. The tile pulses, the teammate answers out loud, the work adjusts,
   and nothing already verified is thrown away.
3. **You can watch it happen.** Every tile is that teammate's screen: the file
   they are on, the command they ran, the request they inspected.

Say this in one sentence before you touch anything:

> "This is a voice room with three AI engineers working on a real repo. Watch
> what happens when I talk over them."

---

## Before you start (10 minutes, do it early)

| Check | Command | What "ready" looks like |
| --- | --- | --- |
| Credits | `npm run verify:openai` | a real tool call comes back — **this is the one that has failed before** |
| Voice | `npm run verify:voice` | 5/5 probes pass, including local Whisper |
| Browser | `npm run verify:browser` | a real Browserbase session opens and closes |
| Build | `npm run build && npm test` | clean, 333 tests |

Then:

- **Headphones on.** Speaker audio will barge-in on itself and cut the team off
  mid-sentence.
- **Delete `.data/`** so the room list is clean and the demo room is the only
  one on screen.
- Window at **1440×900 or larger**. Below that the gallery drops to two columns.
- Have the Devpost tab closed. Nothing on screen but Huddle.

---

## The run

### 0 · Open the room (20 seconds, no talking)

Create a room, give it the goal, click **Use the demo project**.

> Goal: `Make voting anonymous in Sketch Night`

Three teammates introduce themselves and each takes a first slice of work. Let
that happen in silence — it is the first time the judge sees three screens light
up at once. Point at the tiles, not the chat.

> "Maya owns the interface, Alex owns the server, Sam owns verification. Each
> one has a real git worktree in that repo — those are real branch names."

### 1 · The room hears you (45 seconds)

Say, out loud:

> **"Everyone, if you can hear me, say your name and one thing you'll own."**

All three answer, in three distinct voices. This is the beat that used to route
to exactly one agent and silently drop the other two.

Then, while they are still working:

> **"Everyone, keep API spend under five dollars while you test."**

A notice appears: *Standing rule recorded for the room.* Say why that matters:

> "That is not a message they'll forget in four turns. It is recorded on the
> room, and it goes into every prompt from here — including a teammate I add an
> hour from now."

### 2 · Interrupt someone mid-task (90 seconds — **this is the demo**)

Wait until Maya's tile shows `EDITING` and a real file path on her screen. Then
talk over her:

> **"Maya, actually stop and research the payload shape before you write any
> more code."**

Three things happen, and you should name them as they happen:

- Her tile pulses and the state chip reads **Heard you** — the instruction
  reached the loop that is already running.
- She answers out loud in one sentence, *while the work continues*.
- Her next action on screen is a read, not a write.

> "That instruction didn't go into a queue behind her current task. It went
> into the model turn she was about to take. She didn't restart — she kept the
> files she'd already read."

When she reports, the message ends with `[Redirected 1 time mid-run…]`. Open it.
That line is generated from a counter in the run, not from the model.

### 3 · Change the requirement under them (60 seconds)

> **"Change of requirement: voter names must never reach the client — not even
> in the websocket payload."**

The room records a decision revision, marks affected work stale, notifies the
owners, and drops queued speech that was written before the change. Show the
**Decisions** tab.

> "Anything they were about to say about the old requirement is dropped rather
> than played. It would have been true thirty seconds ago and wrong now."

### 4 · Open someone's screen (45 seconds)

Click **Sam**. You get Sam's browser, code, terminal and files, plus a private
side channel.

> "This is a real Browserbase session, and Sam checks the network payload, not
> just the rendered page — because names leak where the interface doesn't show
> them."

### 5 · Land it (20 seconds)

Back to the gallery.

> "Three engineers, one repo, one conversation. I never waited for a turn to
> end, and I never lost work I'd already paid for."

---

## What to do when something goes wrong

Say what happened. Huddle is built not to lie about state, and a judge who sees
you read a real error out loud trusts the rest of the demo more.

| If this happens | Say this, then |
| --- | --- |
| A teammate reports a provider error | "That's a real API error, and notice it says so instead of inventing a result." Retry the instruction. |
| Nobody responds to voice | Type the same sentence in the composer. Every beat above works typed. |
| The browser session will not open | Skip beat 4. Beats 1–3 are the demo; 4 is a bonus. |
| A command fails in a teammate's terminal | Leave it. A failing check that is *reported* as failing is the point. |

**Do not** restart the app mid-demo to "get a cleaner run". The room recovers,
but the thirty seconds of silence costs more than whatever you were fixing.

---

## The questions you will be asked

**"Isn't this just N agents in a loop?"**
No — the loop is interruptible. Point at `src/main/runtime/executor.ts`: an
instruction is drained into the model input before every turn and between tool
calls, so a redirect lands mid-run and the remaining planned tool calls are
dropped rather than executed against instructions that no longer hold.

**"How do you know it actually did the work?"**
Every line on a tile is a committed tool run with a status. Open the Work tab
for the command, its exit code and its output. A job that was interrupted is
recorded as `unknown`, never as "still running".

**"Does the microphone audio go to a server?"**
No. Silero VAD and faster-whisper run locally, in a helper process. There is no
cloud speech-to-text path in the code. ElevenLabs is synthesis only.

**"What is actually yours versus the model's?"**
The room, the routing, the interruption channel, the task graph, decision
revisions, the worktrees, the truthfulness rules. The model picks tools.

---

## One-line pitch, if you only get one

> "Huddle is a voice room where you can interrupt your AI team mid-task and the
> work changes course instead of starting over."
