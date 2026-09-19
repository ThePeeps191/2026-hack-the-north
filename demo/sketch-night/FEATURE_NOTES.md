> Constructed fixture. Written by hand as demo input material, not by an AI teammate.

# Sketch Night product notes

Small table game, one room (`default`), state in memory. The client is a renderer: it joins,
sends actions, and paints whatever the latest room snapshot says.

The round is supposed to feel like a short party beat, not a campaign. Prompt, draw, vote,
results, immediately again. Display names stay attached to sketches so the table can talk about
the drawing, not an anonymous tile.

## Decided 2026-09-12 — voting is public

Voting is public. Players can see who voted for which sketch. That is the point of the vote
screen: it drives the banter, it lets the table argue about taste, and it keeps the vote
legible without extra screens or reveals.

What "public" means in this codebase, and where it lives:

- `shared/protocol.ts` — a `Sketch` carries `voters: string[]`, the display names of the
  players who voted for it.
- `server/game.ts` — `vote(playerId, sketchId)` pushes the voter's `player.name` onto the
  target sketch. Names, not counts: the tally and the identity are the same field.
- `src/components/VoteGallery.tsx` — every tile renders its voter line, and the lede tells the
  player that votes are public.
- `README.md` — documents the same behaviour under "Round loop" and "Voting is public today".

Public votes are part of the WebSocket payload and part of the gallery UI. That is current
product behaviour, not a leftover. Changing how much a voter is exposed is a product decision
that lands in all three places above at once (protocol, server, UI), plus the tests in
`test/game.test.ts` that pin the payload shape.

## Still open

- The draw phase is a fixed 60 second window; nobody has decided what should happen if the
  whole table finishes early. (See `BUG_REPORT.md`, Bug 1.)
- Votes are only remembered as names on a sketch, so nothing today can tell whether a given
  player already voted in this round. (See `BUG_REPORT.md`, Bug 2.)
- Scores are in memory only and reset with the server.
