# Testing Huddle by hand

A checklist you can work through in about 25 minutes. Every item says **what to
do**, **what you should see**, and **what it means if you see something else**.

When something is wrong, the fastest useful thing you can tell me is:

> **which section**, **what you did**, **what you saw**, and the exact text of
> any red or warning line.

A screenshot of the window beats a description. If a teammate said something
odd, copy the whole message — the wording is usually the clue.

---

## 0 · Before anything (2 min)

```bash
npm run demo:check
```

This is the one command that catches the failures that look like app bugs but
are not. Every line is either `READY`, `WARN` or `BLOCKED`.

| Line | What it means |
| --- | --- |
| `BLOCKED No model provider can serve a request` | **Stop here.** Both accounts are empty. Nothing below will work. Top up DeepSeek at platform.deepseek.com/top_up. |
| `WARN DeepSeek credit ($0.14)` | Under $0.20 — a full run costs more than that. Top up. |
| `WARN ElevenLabs characters (3,200 left)` | The team will go silent partway through. |
| `WARN Disk space … (0.4 GB free)` | **Fix this.** A full drive makes git worktrees, commands and Whisper fail in ways that look like Huddle is broken. This has already bitten us once. |
| `BLOCKED Local Whisper` | Voice input will not work. Run `node tools/voice-lab/scripts/setup.mjs`. |

Then:

```bash
npm run build
npx electron . 
```

> **Tip for a clean run:** delete `.data/` first. It resets rooms, demo copies
> and worktrees. It never touches your own project folders.

---

## 1 · The first screen (1 min)

**Do:** look at the window before clicking anything.

**Expect:**
- Headline in a **sans-serif** font — "A voice room where your AI team is *already working*."
- Four capability chips at the bottom left: Models, Voices, Browser, Local speech.
- A "Start a room" card on the right with a **goal box focused and ready to type in**.

**If you see:** a serif font, or a tiny card floating in the middle of a black
page → the stylesheet did not load. Tell me, with a screenshot.

**Also check:** the chips are honest. Hover one — the tooltip should say what
was actually checked. If Models is green while `demo:check` said BLOCKED, that
is a bug worth reporting.

---

## 2 · Starting a room (2 min)

**Do:** click the example chip *"Make voting anonymous in Sketch Night"*, leave
teammates at 3, click **Start the room**.

**Expect:**
- The call screen appears with **four tiles**: You, Maya (Frontend), Alex
  (Systems), Sam (Quality).
- Left sidebar lists the same three names with the same three roles.

**Critical check — identity.** Each teammate must introduce itself with **its
own name and its own role**:
- Maya says she is Maya and owns the frontend
- Alex says he is Alex and owns systems
- Sam says they are Sam and own quality

**If a teammate says "I'm Maya" on Alex's tile, that is the single worst bug in
the app and I need to know immediately.** It was broken exactly this way before
and is fixed; a regression here is serious.

**If you see:** all three saying "I need this room bound to a repo" → the
project-binding grace period regressed. Tell me.

---

## 3 · Binding the project (2 min)

**Do:** in the left sidebar, click **Choose folder** → **Use the demo project**
(or the equivalent button in the dock).

**Expect:**
- A notice: "Sketch Night was copied to …"
- The sidebar shows `sketch-night-<id>` under Project.
- Each tile's footer shows a branch chip like `huddle/maya` once that teammate
  starts working.

**Then click the grid/share icon in the dock and check all four tabs.** This is
the part that was completely broken until recently:

| Tab | What you should see |
| --- | --- |
| **Code** | A file tree on the left (server, shared, src, test, README.md …) and, after clicking a file, a **syntax-highlighted editor filling the pane** |
| **Diff** (inside Code) | "No tracked changes right now" at first; real diffs once a teammate edits something |
| **Terminal** | "No process has run in this workspace yet" — honest, not an error |
| **Files** | The same tree with sizes and a filter box |
| **Browser** | "No remote browser is attached" plus buttons to open a session |

**If Code says "No project bound" while the sidebar shows a project** → the
Team workspace was not created on bind. That was a real bug; tell me if it is
back.

**If the editor shows only one or two lines in a thin strip** → the editor pane
collapsed. Also a fixed bug; tell me if it returns.

---

## 4 · Talking to the whole room (3 min)

**Do:** type into the composer (bottom right):

> `Everyone, if you can hear me, say your name and one thing you will own.`

**Expect:** **all three** teammates answer, each in one short sentence, each
about their own area. Not one. Not two.

**If only one answers** → broadcast routing regressed. This is a headline
feature; tell me.

**Then:**

> `Everyone, keep API spend under five dollars while you test.`

**Expect:**
- A notice: *"Standing rule recorded for the room: …"*
- Each teammate acknowledges in its own words.

**Why it matters:** that rule is now stored on the room, not just in the
transcript. It goes into every later prompt, including teammates you add an
hour from now.

---

## 5 · The headline feature — interrupting mid-task (5 min)

This is the demo. Take your time here.

**Do:**
1. Type: `Maya, start implementing anonymous voting.`
2. **Watch Maya's tile.** Wait until its state chip reads `EDITING` or
   `READING` and real lines appear on her screen (`read_file shared/protocol.ts`
   and so on).
3. **While she is still working**, type:
   `Maya, actually stop and research the payload shape before you write any more code.`

**Expect, in this order:**
- Maya's tile **pulses** and the chip changes to **"Heard you"**.
- Within a few seconds she answers out loud in **one sentence**, something like
  *"Holding all edits — I'm only reading the vote path, no writes."*
- Her **next actions on screen are reads and searches**, not writes.
- When she finally reports, the message ends with
  `[Redirected 1 time mid-run; this report is against the latest instruction.]`

**What each failure means:**

| What you see | What it means |
| --- | --- |
| Nothing happens until she finishes her whole task | The interjection never reached the running loop. Core feature broken — tell me. |
| A **new task** appears named after your sentence | The instruction was queued as fresh work instead of steering the current run. |
| She says "on it" but keeps writing files | She acknowledged but the loop did not absorb it. |
| She restarts from the beginning | The "keep what you verified" instruction is not landing. |

---

## 6 · Watching them work (3 min)

**Do:** just watch the gallery for a minute while all three are busy.

**Expect on each tile:**
- A **live feed** of that teammate's last actions in monospace, newest at top,
  older ones fading.
- Green tool names for success, red for failure, amber for still running.
- A `locus` line showing the file, command or URL they are on.
- The task they own in the header.

**Do:** click any teammate's tile.

**Expect:** a one-on-one view with Browser / Code / Terminal / Files tabs for
**that teammate's own worktree**, plus a private message box. Messages you send
there go only to them.

**Check the Terminal tab** for whoever ran a command. You should see the real
job, the real command line, and the real output — including failures.

---

## 7 · Voice (5 min, headphones required)

> **Headphones are not optional.** On speakers, the team hears itself and
> barge-in cuts them off mid-sentence.

**Do:** click **Join call** in the dock. Allow microphone access. Say out loud:

> "Everyone, if you can hear me, say your name."

**Expect:**
- Your words appear as **captions as you speak** (transcribed locally).
- Teammates answer **out loud in distinct voices** — Maya bright, Alex even,
  Sam crisp and British.
- The speaking teammate's tile gets an amber ring and shows a caption.

**Then, while a teammate is speaking, start talking over them.**

**Expect:** their audio **cuts immediately**. Their work does *not* stop — the
tile keeps showing actions.

**If you see:**

| Symptom | Likely cause |
| --- | --- |
| No captions while you speak | Whisper is not set up. Run `npm run verify:voice`. |
| Captions work, nobody speaks | ElevenLabs out of characters, or voice disabled in Settings. |
| Everyone talks at once | Floor control regressed — tell me. |
| Audio keeps playing when you talk over it | Barge-in regressed — tell me. |

---

## 8 · The browser (3 min)

**Do:** ask Sam: `Sam, open the running app in a real browser and check whether voter names appear in the network payload.`

**Expect:**
- Sam starts the dev server (visible in Terminal).
- Sam calls `start_preview`, which exposes a public URL.
- A Browserbase session opens; the Browser tab shows a live view.
- Sam reports what the **network payload** contained, not just what the page
  showed.

**If Sam says it cannot reach `localhost`** → it tried to open a local address
without a preview. Huddle should now either rewrite it to the preview URL or
tell Sam to call `start_preview` first. If you see the old blunt refusal with no
instruction, tell me.

---

## 9 · Honesty checks (2 min)

Huddle's main claim is that it never says something happened when it did not.
Try to catch it lying:

**Do:** ask `Maya, did the tests pass?` before anyone has run tests.

**Expect:** she says she has not run them, or that no test run is recorded —
**not** a confident "yes".

**Do:** while a teammate is running a command, quit the app and reopen it.

**Expect:** the job is listed as interrupted or `unknown`. **Never** "still
running" — nothing survived the restart.

**Do:** find a failing command in the Terminal tab.

**Expect:** the failure is reported as a failure, with the real exit code. A
teammate that reports a failing check as passing is the worst class of bug here.

---

## 10 · Things that are *not* bugs

So you do not spend time reporting these:

- **`wait_for_job` showing red** — that is a command that exited non-zero, being
  reported honestly. Correct behaviour.
- **"stopped at the turn limit"** — a teammate used its whole budget. It should
  still leave a report saying where the work stands.
- **A teammate refusing to claim something it did not verify** — the point.
- **Tiles with empty screens before anyone has done anything** — honest.
- **The demo project's tests failing** — `demo/sketch-night` ships with real,
  deliberate bugs. Finding them is the job.

---

## Quick reference

```bash
npm run demo:check      # everything that has to be true before a demo
npm test                # 350 tests, no network
npm run typecheck       # main + renderer + scripts
npm run verify:voice    # ElevenLabs + local VAD + local Whisper, for real
npm run verify:browser  # a real Browserbase session, opened and closed
npm run verify:openai   # which models this machine can actually reach
npm run build           # then: npx electron .
```

**Reset everything:** delete `.data/`. Rooms, demo copies, worktrees, logs and
artifacts all live there. Your own project folders are never touched.
