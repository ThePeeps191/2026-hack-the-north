This is a constructed starting scaffold created for a demo. It is not production software and was not written by the AI teammates during the demo.

# Sketch Night

A small room-based drawing and voting party game. Players join a shared lobby, get a prompt, sketch on a canvas, then vote on the submitted drawings. Scores live in memory on the game server. There is no database.

## Run locally

Requires Node 20+. Install and start from this folder only:

```bash
cd demo/sketch-night
npm install
npm run dev
```

That starts both processes:

- Client (Vite): `http://127.0.0.1:5273`
- Game server (Express + WebSocket): `http://127.0.0.1:5274`

Vite proxies `/api` and `/ws` to the game server, so the browser should use the client origin only.

Other scripts:

- `npm run dev:server` - game server only
- `npm run dev:client` - Vite only
- `npm run typecheck` - `tsc --noEmit`
- `npm run build` - typecheck, then Vite production build

## Round loop

1. Lobby: enter a display name and join room `default`.
2. Prompt: the server picks a prompt from a built-in list.
3. Draw: 60 second canvas (mouse and touch). Submit exports `toDataURL('image/png')`.
4. Vote: gallery of sketches. Each player votes for one sketch that is not their own. Votes are public: each tile lists the display names that voted for it, and the WebSocket state payload includes `voters: string[]` per sketch.
5. Results: scores, then next round.

Reconnect uses exponential backoff. Room state is broadcast in full on every change.

## Dev helpers

Non-production routes for automated testing. They are enabled unless `SKETCH_NIGHT_DEV=0`.

- `GET /api/health` - `{ ok: true, phase, players, round }`
- `POST /api/dev/reset` - reset room state
- `POST /api/dev/advance` - force the current phase to end immediately
