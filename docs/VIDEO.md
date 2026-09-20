# The Devpost video

Target **2:30–3:00**. Judges decide in the first fifteen seconds whether to
watch the rest, so the hook comes before any explanation.

## Time budget — 50 minutes, realistically

| Phase | Time | Notes |
| --- | --- | --- |
| Setup (preflight, warm the room, screen recorder, mic check) | 10 min | Do the mic check by recording 10 seconds and playing it back |
| Take 1 — expect it to be rough | 8 min | Treat it as a rehearsal you happen to be recording |
| Take 2 — the real one | 8 min | Usually the keeper |
| Take 3 — insurance on the interrupt beat only | 5 min | Just that 45-second segment |
| Editing (trim waiting, cut takes together, zoom on the marker) | 15 min | The waiting is what you cut |
| Export + upload | 5 min | |

**Do not plan for one perfect take.** The interrupt beat depends on a teammate
still working when you speak, and that timing varies. Record the beat three
times and keep the best.

**Budget ~$0.50 of provider credit** — each full take costs about $0.12.

---

## The two rules

### Only interrupt a teammate that is actually working

If the chip reads `IDLE`, your instruction is an ordinary message. It works, but
nothing visible happens and the `[Redirected 1 time mid-run]` marker never
appears — and that marker is the proof the whole video exists to show.

**Speak while the chip reads `THINKING`, `READING`, `EDITING` or `RUNNING`.**

### Speak in short command sentences

Local Whisper `base.en` is accurate on short command-shaped speech and
unreliable on long sentences. Measured on this build:

| Said | Heard |
| --- | --- |
| "Maya here, the build has passed and I pushed the branch for review." | "Maya here, the build **a past** and I push the branch for review." |

The name transcribed perfectly; the long tail did not. So: **start with the
name, keep it to one clause.** If it mis-hears during a take, that take is a
throwaway — just go again.

---

## Before you press record

| Step | Why |
| --- | --- |
| `npm run demo:check` | Catches an empty API account or a full disk — both look exactly like app bugs on camera |
| Top up the provider | A take costs ~$0.12; three takes plus rehearsal needs real headroom |
| Delete `.data/` | Removes stale rooms and the "operations stopped before finishing" recovery banner |
| `npm run build && npx electron .` | Record the built app, not the dev server |
| `node scripts/demo-warm.mjs` | Gets you to three teammates working in ~20 seconds |
| Headphones **on** | On speakers the team hears itself and barge-in cuts it off mid-sentence |
| Window 1512×945 or larger | Below that the gallery drops to two columns |
| Notifications off | |

**Record your voice.** The whole premise is that this is a voice room. A silent
screen capture with typed text throws the pitch away.

---

## Shot list

### 0:00–0:15 · Hook

Open on the room already moving — three tiles, real tool lines scrolling.

> "This is a voice call with three AI engineers. They're working on a real repo
> right now, each in their own git branch. Watch what happens when I talk over
> them."

No architecture yet. Show motion first.

### 0:15–0:40 · What you're looking at

Move the cursor across the tiles as you talk.

> "Every tile is that teammate's actual screen — the file they're reading, the
> command they just ran. Maya owns the frontend, Alex owns the server contract,
> Sam is quality and verifies in a real browser. Every line is a tool call that
> really happened."

### 0:40–1:05 · Say it to the room

Speak it:

> "Everyone, keep API spend under five dollars while you test."

All three answer in their own words.

> "That reached all three — not a router picking one. And it's recorded as a
> standing rule, so a teammate I add an hour from now is bound by it too."

### 1:05–1:50 · The moment

This is the whole video. Do not rush it.

1. Say: *"Maya, implement the anonymous vote UI and update the tests."*
2. **Wait** until her chip reads `THINKING` or `EDITING` and lines are
   scrolling. 10–20 seconds. Let the silence sit — you'll cut it in editing, and
   it makes the next beat land.
3. Talk over her:

> "Maya — actually stop, and research the payload shape before you write any
> more code."

Point at each thing:

- tile **pulses**, chip flips to **"Heard you"**
- she answers **out loud in one sentence**, tools still running
- next actions switch from **writes to reads**
- report ends with **`[Redirected 1 time mid-run]`**

> "She didn't finish the old thing first, and she didn't start over. The
> instruction landed inside the loop that was already running — and the report
> says so, so I can audit it."

**Say that slowly.**

### 1:50–2:20 · Prove it's real

Click Maya's tile → **Terminal**, then **Code**.

> "Her own worktree and branch. Real command, real exit code — including when it
> fails. Nothing here reports a result that didn't happen."

If Sam has a browser session open, show it.

### 2:20–2:40 · Close

Back to the gallery.

> "Three AI engineers on a real codebase, in a room you can talk over. Built
> solo at Hack the North."

---

## Editing

- **Cut the waiting.** Agents think for 10–20 seconds. Remove those — keep the
  moment you speak and the moment the tile reacts back to back.
- **Zoom on the redirect marker.** Small text, and it's the proof.
- **Don't speed up audio.** Sped-up speech reads as padding.
- One clean take of the interrupt beat beats a polished take of everything else.

---

## If something breaks mid-take

| What happens | What to do |
| --- | --- |
| Teammate goes idle before you interrupt | Give a fresh task and wait again. Never interrupt an idle agent to save time. |
| Provider out of credit | The room says so and names where to top up. Stop, top up, restart. |
| Whisper mis-hears | Throw the take away and go again. Keep it short next time. |
| Red dev-server banner | Honest output, not a crash. Ignore or cut. |
| App feels slow | Check `npm run demo:check` for disk space. |

---

## Don't claim on camera

- Teammates **cannot** interrupt each other yet — only you can.
- Agents **do not** persist across sessions.
- It is **not** a sandbox.

Saying one of these briefly makes the rest more credible.
