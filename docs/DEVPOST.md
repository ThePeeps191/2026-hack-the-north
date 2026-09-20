# Devpost copy

Paste-ready text for the sections that are still `qqqq`, plus corrections to the
parts of the story that describe behaviour the code no longer has.

Everything here is something that actually happened while building this. Nothing
is padded, and nothing claims a capability the repo cannot demonstrate.

---

## Challenges we ran into

**The agents were confidently the wrong people.** Every teammate introduced
itself with somebody else's name — the agent on Sam's tile opened with "I'm
Maya, the frontend engineer." The personas were stored as hard-coded strings
with names baked in, while the *names* came from a separate list in a different
order, so agent #0 got Sam's name and Maya's identity. It also broke
agent-to-agent messaging: Sam, holding Maya's persona, tried to message Maya and
was told it could not message itself. Identity is now generated from the name
the room actually gave a teammate, and old state repairs itself on load.

**"Everyone" reached exactly one person.** The router was a keyword matcher that
deliberately collapsed every room-wide instruction to a single owner. Say
"everyone, if you can hear me, say your name" and one agent answered while two
sat silent — indistinguishable from being broken. Room-wide addressing now fans
out to the whole roster, and a standing constraint ("keep test spend under five
dollars") is recorded on the room so it binds teammates added an hour later.

**Interrupting a working agent did nothing.** This was the feature the whole
idea rests on, and it did not exist. An instruction to a busy teammate went into
a mailbox that was only drained when the current run finished; worse, it was
turned into a *new task* whose title was the raw sentence — the board filled up
with entries like "Maya, actually stop and do some research first before you
write any more code." The work loop now drains a live interjection queue before
every model turn and between tool calls, so a redirect lands inside the run that
is already going. If it arrives mid-batch, the remaining planned tool calls are
dropped rather than executed against instructions that no longer hold.

**Models cannot count, and we were grading them on arithmetic.** Roughly a fifth
of every agent's edits were rejected by our own patch parser — not because the
edit was wrong, but because the `@@ -241,24 +241,23 @@` line miscounted by one.
The counts in a diff header are derived data; the body is the truth. We stopped
trusting the arithmetic, started reading the hunk until it actually ends, and
added the other dialects models reach for (a bare `@@`, the `*** Begin Patch`
envelope). Safety did not move: every context line is still matched against the
real bytes before anything is written, and a patch that disagrees with the file
is still refused whole.

**A model that thinks in-band will spend your whole budget thinking.** Long runs
kept ending with "stopped without a report." Two separate causes, both invisible
from the outside. DeepSeek returns its reasoning in a field beside the answer
and bills it against the same ceiling, so a 500-token budget could be entirely
consumed before it said a word. And our context trimmer, keeping "the newest
forty items," could cut between a tool call and its result — producing a message
sequence every provider rejects with a 400, most reliably on the closing summary
turn, which carries the longest context.

**The workspace tabs were dead.** Bind a project and Code, Terminal, Files and
Browser all read "No project bound," because the workspace record was only
created lazily the first time an agent happened to need one. And when it did
appear, the editor pane collapsed to five pixels: it lived in a grid row sized
to its content, so Monaco resolved `height: 100%` against nothing and rendered a
single line.

**A full disk looks exactly like a broken app.** Seven tests failed at once with
errors that pointed at git and temp files. The code was fine; the system drive
had zero bytes free. It is now the first thing the preflight check reports.

---

## Accomplishments that we're proud of

**You can talk over a working agent and the work changes.** Not a queue, not a
restart — the instruction reaches the model turn the agent was about to take. It
answers out loud in one sentence while its tools keep running, its next actions
change, and the report it eventually writes carries `[Redirected 1 time mid-run]`
generated from a counter in the run rather than from the model's memory.

**Every tile is a real screen.** A call tile that shows a name and a status word
tells you nothing. Each teammate's tile renders its last real actions — the file
it read, the command it ran, the request it inspected — in the order they
happened, each one a committed tool run with a real status. A teammate that has
done nothing shows an empty screen and says so.

**The team argues with itself, usefully.** In a recorded run, the frontend and
systems engineers negotiated a shared interface across two git worktrees: one
noticed the other's protocol change had not landed on main, quoted the exact
TypeScript error its own typecheck produced, and got back a decision recorded as
revision r1. The quality engineer stopped and asked whether the server was
allowed to keep a private voter record at all — a real ambiguity in the
requirement, spotted by reading the code rather than the notes.

**It refuses to lie.** A job interrupted by a restart is `unknown`, never "still
running." Speech that was cut off is marked interrupted, not played. A failing
check is reported as failing at the revision that produced it. A model whose
backend has no key is refused rather than quietly answered by a different
vendor. When the provider ran out of credit mid-run, the room said exactly that,
named the vendor, and linked where to top it up.

**Microphone audio never leaves the machine.** Silero VAD and faster-whisper run
locally in a helper process. There is no cloud speech-to-text path in the code
at all. ElevenLabs is synthesis only.

---

## What we learned

**A refused instruction teaches a model nothing.** Our strictest failures were
the least useful ones. "Hunk declares 24 old lines but the patch supplies 23"
is true, precise, and completely unactionable — the model already believed it
supplied 24. Strictness about *format* bought us nothing and cost a turn every
time; strictness about *content* is what actually protects the file. We kept the
second and dropped the first, and the edit success rate moved immediately.

**"Honest" is not the same as "helpful."** Telling a QA agent that
`http://localhost:5173` is unreachable because the browser runs in another
data centre is accurate and left it stuck three runs in a row. The same fact,
phrased as "call `start_preview` first and use the URL it returns," unblocked
it. Where a correct answer exists, saying so is better than describing the
problem again.

**Agents guess their environment, and guess badly.** Half the commands our team
wrote were POSIX pipelines on a machine where `run_command` uses `cmd.exe`, all
failing with exit 255 that reads like a broken project. They were not being
careless; nobody had told them. One line of shared state — which shell, which
platform, whether dependencies are installed — removed an entire class of
failure for all three at once.

**Routing is a product decision, not a dispatch problem.** The most damaging
code in this project was a single deliberate rule: "a room-wide instruction goes
to exactly one owner, never all three." It was written to prevent spam, it was
efficient, and it quietly broke the central promise of the product. Efficient
routing and a room that feels like a room are not the same objective.

**Build the thing that tells you the truth before you need it.** Two separate
sessions were spent debugging "the app is broken" when the real answers were an
empty API balance and a full disk. `npm run demo:check` now proves a provider
will serve a request rather than checking that a key exists, and it checks free
space on both drives. It would have saved more time than any feature we wrote.

---

## What's next for Huddle

**Teammates that interrupt each other.** A human can redirect a running agent;
an agent still cannot. The interjection channel already exists and is the same
mechanism — the reason it is not turned on between teammates is that we have not
yet worked out how to stop three agents derailing each other in a loop.

**Persistent teammates across sessions.** A room remembers its decisions, tasks
and standing rules, but a teammate starts each run from the shared state rather
than from anything it personally learned. Per-teammate memory — what this
engineer already knows about this codebase — is the obvious next layer.

**More than one human in the room.** Everything about the design assumes one
voice and one floor. Two people in the same room, with the agents tracking who
asked for what, is where this stops being a demo and starts being how a team
works.

**Let the team run while you are not there.** The work loop, the task graph and
the decision revisions do not need a human present. A room you brief and come
back to — with a recording of what was decided and what changed — is a different
product with the same architecture underneath.

---

## Corrections to the existing story

Three things in the current draft describe how the build works, and should be
adjusted:

1. **"Underlying LLMs: OpenAI"** — it is now two backends behind one adapter.
   Say **"OpenAI and DeepSeek behind a single adapter, chosen per model id"**,
   and list `deepseek` in Built With. It is also the more interesting claim.

2. **"State / history: SQLite plus an event stream"** — the repo persists to an
   atomic JSON store plus `huddle-events.jsonl`, not SQLite. Say **"an atomic
   JSON store plus an append-only event log"**. It is true, and the durability
   rules are worth a sentence: anything you asked for is written to disk before
   the event announcing it is broadcast.

3. **"Playwright" in Built With** — correct, but worth saying what for: it
   drives the remote Browserbase session over CDP. It is not running a local
   browser.

One line worth adding to *What it does*, because it is the thing nothing else
does:

> You can talk over a teammate that is already working, and the work changes
> course instead of starting over — the instruction reaches the model turn it
> was about to take, not a queue behind it.
