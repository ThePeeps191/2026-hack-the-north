> Constructed fixture. Written by hand as demo input material, not by an AI teammate.
> Both bugs below are real: they reproduce against the code in this folder right now.
> `npm test` also pins both of them (`test/game.test.ts`), so a fix flips a test.

# Bug 1: Draw timer keeps running after every sketch is in

The draw phase is a fixed 60 second window. `submitSketch` stores the PNG and returns. It never
checks whether every connected player has already submitted, so the server does not move to
vote until the timer (or `/api/dev/advance`) says so.

## Steps

1. Start the app (`npm run dev`) and open `http://127.0.0.1:5273` in two browser tabs.
2. Join as two different names (for example `ada` and `bo`), then press **Start round**.
3. Wait for the phase label (`data-testid="phase-label"`) to read `Draw`.
4. Draw and press **Submit sketch** in both tabs, until the draw panel reads
   `2 of 2 sketches in` (`data-testid="submit-progress"`).
5. Watch `round-timer` and `phase-label` without touching anything.

## Expected

Once every connected player has submitted, the table should move on to voting (or the draw
timer should stop).

## Actual

The phase stays `Draw` and the timer keeps counting down for the rest of the 60 second window.
Only when it reaches `0:00` does the phase become `Vote`. `POST /api/dev/advance` also moves it
on, which is why the bug survives casual playtesting.

## Headless reproduction

`npm test` — the test `BUG 1 (current behaviour): the draw phase runs its full timer even when
everyone is in`: both sketches are submitted, the phase is still `draw` and `phaseEndsAt` is
unchanged; the phase only moves at the full `DRAW_MS`.

# Bug 2: Reloading during the vote phase lets a player vote twice

`vote` appends the voter's display name to `sketch.voters` and does not record that this player
already voted in this round. The client only disables the vote buttons in local React state
(`votedSketchId` in `src/useGame.ts`). A reload creates a fresh client, auto-rejoins with the
same player id from `sessionStorage`, and can vote again: the same name then appears twice in
`voter-list` and in the WebSocket `voters` array, and the sketch collects two points at results.

## Steps

1. Open two tabs, join as `ada` and `bo`, start the round, submit a sketch from each, and wait
   for the phase label to read `Vote`.
2. In `ada`'s tab, press **Vote** on `bo`'s sketch. The tile's voter line
   (`data-testid="voter-list"`) now reads `Votes: ada` and `ada`'s own buttons are disabled.
3. Reload `ada`'s tab (F5). The client rejoins automatically as the same player.
4. In `ada`'s tab, press **Vote** on `bo`'s sketch again.
5. Look at `bo`'s tile, then let the vote timer expire and check the scoreboard.

## Expected

Player `ada` should be blocked from voting a second time in the same round.

## Actual

The second vote is accepted. The tile's voter line reads `Votes: ada, ada`, the WebSocket
`voters` array holds the same name twice, and `bo` scores 2 for that sketch instead of 1.

## Headless reproduction

`npm test` — the test `BUG 2 (current behaviour): a voter can vote twice after a reload`: vote,
rejoin with the same player id (`room.leave` then `room.join(name, id)`, which is what the
client does after a reload), vote again, and the voter array becomes `['Bob', 'Bob']`.
