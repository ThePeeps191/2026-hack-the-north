# Huddle

Desktop voice room for collaborating with AI teammates. This repository currently ships the application shell and backend-owned room state. Model, voice, browser, coding, and tool runtimes are not connected yet.

## Setup

Requires Node.js 22+. From the repo root:

```bash
npm install
npm run dev
```

Other commands:

```bash
npm test
npm run typecheck
npm run build
```

Development reload is provided by electron-vite. The default window is 1280x800, with a 1000x700 minimum.

## What works now

- Create rooms, switch rooms, rename a room, and edit its description.
- First launch creates a **New project** room with **Maya** (frontend), configured but not connected.
- Add **Alex** (systems) or **Sam** (QA) from the participant strip. Maximum four agents per room.
- Team view and per-agent workspace tabs: Overview, Browser, Code, Terminal, Files.
- Human text messages persist in the selected room. Agent replies are not generated.
- Typed `window.huddle` IPC, an event stream, and a collapsible developer activity panel.
- Voice controls are visible and disabled. They do not touch the microphone.

## Storage

Application state is a versioned JSON snapshot:

- Development: `.data/huddle-state.json` in the project directory
- Packaged builds: `huddle-state.json` under Electron `userData`

Writes are serialized and replaced atomically. The last 200 runtime events are kept. Rooms, agents, messages, and the selected room survive reload and restart.

If the file is missing, Huddle treats that as a first launch. If the file is corrupt, the original bytes are copied to a `.corrupt-<timestamp>` sidecar and a recovery message is shown. Application storage is separate from any future user-selected coding workspace.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

Automated tests cover first-launch seeding, room switching, message scoping, rename/agent persistence, duplicate `clientRequestId` handling, rapid submits, event sequencing, subscription cleanup, and corrupt-file recovery.

Manual checks: create and switch rooms, send messages, rename, add an agent, change workspace tabs, reload, confirm unimplemented surfaces stay honest, and resize toward 1000x700.

## Remaining integrations

The next milestone is connecting one real text-based agent to the room so human messages can receive actual replies. Still out of scope: speech recognition, speech synthesis, coding tools, browser sessions, Pi, and sponsor integrations.
