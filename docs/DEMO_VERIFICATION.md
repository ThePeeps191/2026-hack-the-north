# Sketch Night live demo verification

This record covers a fresh room created through the running Electron UI on 2026-09-19. The room was bound through the real **Use demo** control to a new copy at `.data/projects/sketch-night-d9c9b905`; it did not reuse the existing room or project.

## Completed path

1. Sam reviewed the real README, feature notes, bug report, protocol, server, UI, and tests. The review correctly found that the shipped documents and code agreed on **public** voting. Sam asked one concrete question: whether voter identities should be hidden in both UI and network payloads while authors remain named.
2. The human decision was supplied through the real composer. Huddle recorded decision r1, **Anonymous voting with named sketch authors**, and marked Sam's earlier review stale. The decision explicitly keeps duplicate-vote prevention as a separate known issue.
3. Huddle created isolated worktrees for Alex, Maya, and Sam. Alex submitted `57dbc3f2` (protocol/server/tests); Maya submitted `4ed9a95d` (client/docs).
4. Alex integrated both submissions into the Team workspace. The exact Team revision is `9d464ea259c3636d0174bf33eafe819e646f8a1c` on `huddle/integration`.
5. The initial integration honestly failed typecheck because the new Team copy had not installed its declared dependencies. The application reported that failure and skipped build. After `npm ci` in the Team workspace, integration `18f04742` reran the exact revision and passed all checks:
   - `npm test`: 14/14 passing
   - `npm run typecheck`: exit 0
   - `npm run build`: exit 0

The integrated tests include aggregate vote-count serialization and assert that no voter identity/list is encoded while sketch author names remain available.

## Evidence

- Running-app state and raw CDP screenshots: `.data/polish/demo/`
- Active-work gallery captures: `active-gallery-1920x1080.png`, `active-gallery-1280x800.png`, `active-gallery-1000x700.png`
- The app's recorded integration, decision, task, job, and tool-run state is durable in `.data/huddle-state.json` and `.data/huddle-events.jsonl`.

## Browserbase status

The preview start exposed a real runtime defect: Vite printed `ready in 354 ms` before its URL, and the dev-server port parser incorrectly recorded `354` as a port. Preview then probed the wrong endpoint, so no Browserbase-accessible URL was available.

`src/main/exec/jobs.test.ts` now contains a regression case for this exact Vite output, and `src/main/exec/jobs.ts` no longer treats generic `ready` text as a port announcement. The focused job test suite passes 9/9. After a restart, Huddle detected the actual port `5273`, made a Team tunnel URL, opened a real Browserbase session (`e4cebc9c` in us-west-2), captured a 1440×900 remote PNG, and retained 20 real responses.

The remote session previously reached localtunnel's updated **"Tunnel website ahead!"** interstitial instead of Sketch Night. Huddle now treats that title (and "served via a tunnel") as a reminder page, sends `Bypass-Tunnel-Reminder` on the first request to loca.lt hosts, reloads once if needed, and clicks Continue when the header is not enough. The Sketch Night Vite config now sets `server.allowedHosts: true` so a tunneled Host header is not rejected.

After this change, a fresh Browserbase pass is still required before claiming Sketch Night's in-browser behavior or client-visible network payloads. The earlier session, tunnel, and remote screenshot remain valid evidence of Browserbase connectivity only.

## Live UI checks (this session)

`npm run ui-check` against the rebuilt app on CDP port 9222: **20/20 passed** at 1920x1080, 1280x800, and 1000x700, then Code, Terminal, Files, Browser, and return to the room gallery (4 tiles). Captures: `.data/build/ui/ui-1920x1080.png`, `ui-1280x800.png`, `ui-1000x700.png`, `ui-gallery.png`, `surface-code.png`, `surface-terminal.png`, `surface-files.png`, `surface-browser.png`.

Verified in those captures: one workspace header, one surface nav row, flattened sidebar, compact dock, visible Send at 1000px, no raw Markdown asterisks in chat, verification status as one line plus Details, real file trees with generated folders hidden, real job history in Terminal, participant gallery with You + Maya + Alex + Sam.

Preview now patches the bound project's Vite config with `allowedHosts: true` before starting the dev server, including already-copied Sketch Night folders and worktrees. A new Browserbase navigation is still required before claiming Sketch Night's in-browser behavior.

Not re-run live in this session: microphone capture or audible playback.

## Packaging and extra tracks

Live-from-source is the intended demo path. The voice helper needs a local Python venv, a downloaded Whisper model, and Silero VAD on disk. An installer that omitted those would look packaged while speech was broken; one that bundled them is out of scope for this session. `npm run build` plus `npx electron .` is the runnable artifact.

Huawei, Warp, and Rox tracks are not in this repository. They are not part of the pitch; nothing decorative was bolted on.
