# The demo video

A shot-by-shot script for the Devpost video. Target **2:30–3:00**. Judges watch
the first fifteen seconds to decide whether to watch the rest, so the hook comes
before any explanation.

Everything below was verified working on this build. Where something is fragile,
it says so and gives the fallback.

---

## The one rule that decides whether this works

**You can only interrupt a teammate that is actually working.**

The headline feature is that an instruction lands *inside* a running loop. If the
teammate has gone idle, your instruction is just an ordinary message — it still
works, but there is nothing to see, and the `[Redirected 1 time mid-run]` marker
never appears.

So, before you send the interrupt:

> **Look at the state chip on the tile.** Send it while it reads `THINKING`,
> `READING`, `EDITING` or `RUNNING`. Never while it reads `IDLE`.

Verified on this build: interrupting a `thinking` Maya fired the steer event,
produced the redirect marker, and made her hold off code and run a read-only
probe instead. Interrupting an `idle` Maya produced a polite reply and no marker.

---

## Before you press record

| Step | Why |
| --- | --- |
| `npm run demo:check` | Catches an empty API account or a full disk — both look exactly like app bugs on camera. |
| Top up DeepSeek/OpenAI | A run costs roughly $0.12. Rehearsal plus recording needs a few dollars, not cents. |
| Delete `.data/` | Removes old rooms, stale worktrees and the "3 operations stopped before finishing" recovery banner. |
| `npm run build && npx electron .` | Record the built app, not the dev server. |
| Close the app **with the window button** | A force-kill orphans dev servers and tunnels, which then make `.data` undeletable. |
| Headphones on | On speakers the team hears itself and barge-in cuts them off mid-sentence. |
| Window at 1512×945 or larger | Below that the gallery drops to two columns. |

**Record the audio.** The whole pitch is that this is a voice room. A silent
screen capture with typed text throws away the premise.

---

## Shot list

### 0:00 – 0:15 · Hook

Open on the room with three teammates already working — tiles moving, real tool
lines scrolling.

> "This is a voice call with three AI engineers. They're working on a real repo
> right now, in their own git branches. Watch what happens when I talk over
> them."

Do not explain the architecture yet. Show the thing moving first.

### 0:15 – 0:40 · What you're looking at

Move the cursor across the tiles as you talk.

> "Every tile is that teammate's actual screen — the file they're reading, the
> command they just ran. Maya owns the frontend, Alex owns the server contract,
> Sam is quality and verifies in a real browser. Nothing here is a mock-up;
> every line is a tool call that really happened."

### 0:40 – 1:05 · Say it to the room

Say out loud, into the mic:

> "Everyone, keep API spend under five dollars while you test."

All three answer in their own words, and the rule is recorded on the room.

> "That reached all three, not one router picking a winner. And it's stored as a
> standing rule, so a teammate I add an hour from now is bound by it too."

**Fallback:** if voice transcription garbles it, type it instead and say the line
over the top. Do not re-record for this.

### 1:05 – 1:50 · The moment — interrupt mid-task

This is the whole video. Do not rush it.

1. Say: *"Maya, implement the anonymous vote UI — strip the voter names and show
   counts only."*
2. **Wait.** Watch Maya's tile until the chip reads `THINKING` or `EDITING` and
   real lines are scrolling. Usually 10–20 seconds. Let the silence sit; it
   makes the next beat land.
3. While she is still working, talk over her:

> "Maya — actually stop, and research the payload shape before you write any
> more code."

What to point at as it happens:

- Her tile **pulses** and the chip flips to **"Heard you"**
- She answers **out loud in one sentence** while her tools are still running
- Her next actions on screen become **reads and searches, not writes**
- Her report ends with **`[Redirected 1 time mid-run; this report is against the
  latest instruction.]`**

> "She didn't finish the old thing first, and she didn't start over. The
> instruction landed inside the loop that was already running — and the report
> says so, so I can audit it."

**This is the line the whole project exists for. Say it slowly.**

### 1:50 – 2:20 · Prove it's real

Click Maya's tile to open her workspace. Show **Terminal** (real commands, real
exit codes) and **Code** (a real diff on `huddle/maya`).

> "Her own git worktree, her own branch. Here's the command she ran and what it
> actually returned — including when it fails. Nothing in this app reports a
> result that didn't happen."

If Sam has a browser session open, show it: a real Chromium in Browserbase with
the running app in it.

### 2:20 – 2:40 · Close

Back to the gallery.

> "Three AI engineers on a real codebase, in a room you can talk over. Built
> solo at Hack the North."

---

## Editing

- **Cut the waiting.** Agents think for 10–20 seconds. Cut those out — keep the
  moment you speak and the moment the tile reacts, back to back.
- **Zoom on the redirect marker.** It is small text and it is the proof.
- **Do not speed up the audio.** Sped-up speech reads as padding.
- One take of the interrupt beat that lands cleanly is worth more than a
  polished take of everything else.

---

## If something breaks mid-recording

| What happens | What to do |
| --- | --- |
| A teammate goes idle before you interrupt | Give it a fresh task and wait again. Don't interrupt an idle agent "to save time" — the beat won't show. |
| Provider runs out of credit | The room says so plainly and names where to top up. Stop, top up, restart. |
| A red dev-server banner appears | It's honest output, not a crash. Either ignore it or cut it. |
| Voice transcription mangles a word | Type the instruction and narrate over it. The feature is the interrupt, not the transcription. |
| The app feels slow | Check `npm run demo:check` for disk space. A full system drive makes everything look broken. |

---

## What not to claim on camera

The project is strong enough without stretching, and a judge who catches one
overstatement discounts everything else:

- Teammates **cannot** interrupt each other yet — only you can.
- Agents **do not** persist across sessions.
- It is **not** a sandbox; the commands are real commands on your machine.

Saying these out loud, briefly, makes the rest more credible — not less.
