> Constructed fixture. Written by hand as demo input material, not by an AI teammate.

# Bug 1: Draw timer keeps running after every sketch is in

The draw phase is a fixed 60 second window. `submitSketch` stores the PNG and returns. It never checks whether every connected player has already submitted, so the server does not move to vote until the timer (or `/api/dev/advance`) says so.

## Steps

1. Start the app, open two browsers, and join as two different names.
2. Start the round and wait until the phase label is `Draw`.
3. Submit a sketch from both players.
4. Watch `round-timer` and `phase-label`.

## Expected

Once every connected player has submitted, the table should move to vote (or the timer should stop).

## Actual

The timer keeps counting down for the rest of the 60 seconds and the phase stays `Draw` until it hits zero.

# Bug 2: Reloading during the vote phase lets a player vote twice

`vote` appends the voter's display name to `sketch.voters` and does not record that this player already voted. The client only disables vote buttons in local React state. A reload creates a fresh client, auto-rejoins with the same player id from `sessionStorage`, and can vote again. The same name then appears twice in `voter-list` and in the WebSocket `voters` array.

## Steps

1. Join two players, start a round, submit a sketch from each, and wait for `Vote`.
2. From player A, vote for player B's sketch. Confirm A's name is listed under that tile.
3. Reload player A's tab.
4. Vote for the same sketch again.

## Expected

Player A should be blocked from voting a second time in the same round.

## Actual

The second vote is accepted. The tile's voter list shows the same display name twice.
