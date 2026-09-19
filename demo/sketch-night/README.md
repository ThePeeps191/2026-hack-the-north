> **Demo fixture.** This folder is a constructed starting scaffold, written by hand as input
> material for the Huddle demo (three AI teammates — Maya, Alex, Sam — working in a real bound
> project directory). It is not a production app: one room, state in memory, no accounts, no
> database, no persistence. It also contains two known bugs that are left in place on purpose.
> Nothing in this folder was written by an AI teammate during the demo.

# Sketch Night

A small room-based drawing and voting party game. Players join a shared lobby, get a prompt,
sketch on a canvas, then vote on the submitted drawings. Scores live in memory on the game
server and are thrown away when it restarts.

## Run locally

Requires Node 22.6+ (the tests use Node's native TypeScript type stripping). Install and start
from this folder only:

```bash
cd demo/sketch-night
npm install
npm run dev
```

That starts both processes:

- Client (Vite): `http://127.0.0.1:5273`
- Game server (Express + WebSocket): `http://127.0.0.1:5274`

Vite proxies `/api` and `/ws` to the game server, so the browser should use the client origin
only. Open the client URL in two tabs to play against yourself.

Scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | game server (`tsx watch`) + Vite client, both in watch mode |
| `npm run dev:server` | game server only |
| `npm run dev:client` | Vite only |
| `npm test` | headless round-logic tests (`node --test`), no browser, no network |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck, then a Vite production build into `dist/` |

## What this scaffold is for

The Huddle demo room binds to this directory and the teammates work on the code in `server/`,
`shared/` and `src/`. The starting material is meant to be read in this order:

1. `README.md` (this file) — how to run it, and what the product does today.
2. `FEATURE_NOTES.md` — the product decisions the team has already made, and why.
3. `BUG_REPORT.md` — two real bugs with reproduction steps.
4. The code: `shared/protocol.ts` (the wire contract), `server/game.ts` (round logic),
   `server/index.ts` (HTTP + WebSocket transport), `src/` (the React client).

A full round plays end to end. Both documented bugs reproduce against the code as it stands,
and the product notes describe behaviour that the code actually implements — so anything the
human asks for later has to be reconciled against what is already written down here.

## Round loop

1. **Lobby** — enter a display name and join room `default`. Anyone in the room can start.
2. **Prompt** — the server picks a prompt from a built-in list (4 seconds).
3. **Draw** — a 60 second canvas (mouse, pen and touch). Submit exports
   `toDataURL('image/png')` and locks the board.
4. **Vote** — gallery of the sketches submitted this round. Each player may vote for one
   sketch that is not their own.
5. **Results** — scores, then the next round starts from a fresh prompt.

Reconnect uses exponential backoff. Room state is broadcast in full on every change, so the
client is a pure renderer of the latest snapshot.

## Voting is public today

Voting visibility is deliberately public, and it is wired through the whole stack:

- `shared/protocol.ts` — `Sketch` carries `voters: string[]` of display names.
- `server/game.ts` — `vote()` pushes `player.name` onto the target sketch.
- `src/components/VoteGallery.tsx` — each tile lists the names that voted for it, and the
  lede says so.
- `FEATURE_NOTES.md` — records the decision (2026-09-12) and the reason: visible voters drive
  the banter, and names belong to sketches so the table can talk about the drawing.

Sketches are always attributed: `playerName` is on every tile.

## Dev helpers

Non-production routes for automated testing. They are enabled unless `SKETCH_NIGHT_DEV=0`.

- `GET /api/health` — `{ ok: true, phase, players, round }`
- `POST /api/dev/reset` — reset the room to an empty lobby and tell every connected client
  to drop its session
- `POST /api/dev/advance` — force the current phase to end immediately

## Known issues

- **Bug 1 — the draw timer keeps running after every sketch is in** (`BUG_REPORT.md`).
  Submitting does not check whether the whole table has submitted. The draw panel shows
  `n of m sketches in` while the timer keeps ticking down.
- **Bug 2 — reloading during the vote phase lets a player vote twice** (`BUG_REPORT.md`).
  Votes are stored as names and nothing records that a player already voted for this round.

`npm test` pins both of these as current behaviour, so a fix makes the corresponding test fail
until the assertion is updated on purpose.
