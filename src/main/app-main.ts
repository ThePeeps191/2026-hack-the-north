import { join } from 'node:path'
import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/api.ts'
import type { AudioChunkMessage, PlaybackServerEvent } from '../shared/voice.ts'
import type { VoiceSink } from './contracts.ts'
import { createBrowserHost } from './browser/index.ts'
import { createCapabilityService } from './config/capabilities.ts'
import { attachSafeStorage } from './config/secrets.ts'
import { createExecutionHost } from './exec/index.ts'
import { EventLog } from './event-log.ts'
import { registerIpcHandlers } from './ipc.ts'
import { JsonSnapshotStore } from './json-store.ts'
import { eventLogPath, resolveStatePath, setDataRoot } from './paths.ts'
import { RoomService } from './room-service.ts'
import { createAgentRuntime } from './runtime/index.ts'
import { createVoiceHost } from './voice/host.ts'

/**
 * Composition root.
 *
 * One Node/Electron runtime supervises room state, the agent sessions, job and
 * browser processes and the voice helper. Nothing here does product work
 * itself: it wires the hosts together and forwards truth between them.
 *
 *   renderer ──IPC──▶ RoomService (state) ◀── HuddleBus ── runtime / exec / browser / voice
 *
 * `index.ts` is the Electron entry point and does nothing but start this.
 */

const ALLOWED_EXTERNAL = new Set(['https:', 'mailto:'])

let mainWindow: BrowserWindow | null = null
let stopIpc: (() => void) | null = null
let shutdown: (() => Promise<void>) | null = null

function sendToRenderer(channel: string, payload: unknown): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#121418',
    title: 'Huddle',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (ALLOWED_EXTERNAL.has(url.protocol)) {
        void shell.openExternal(details.url)
      }
    } catch {
      // Ignore malformed URLs.
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (
      current &&
      url !== current &&
      !url.startsWith('http://localhost') &&
      !url.startsWith('http://127.0.0.1')
    ) {
      event.preventDefault()
    }
  })

  // The microphone is only ever opened after the human asks to join a call.
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media')
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Boot the whole application. Called once from the Electron entry point.
 */
export function startHuddle(): void {
  if (!app.isPackaged) {
    app.setPath('userData', join(process.cwd(), '.data', 'electron-profile'))
  }
  setDataRoot(app.isPackaged ? app.getPath('userData') : join(process.cwd(), '.data'))

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('com.huddle.app')
      attachSafeStorage(safeStorage)

      const store = new JsonSnapshotStore(resolveStatePath())
      const log = new EventLog(eventLogPath())
      const service = await RoomService.open(store, { log })
      const settings = (): ReturnType<RoomService['getSettings']> => service.getSettings()

      /* ---------------- hosts ---------------- */

      let sink: VoiceSink | null = null

      const voice = createVoiceHost({
        bus: service,
        settings,
        sink: () => sink,
        sendServerEvent: (event: PlaybackServerEvent) =>
          sendToRenderer(IPC_CHANNELS.voiceServerEvent, event),
        sendAudioChunk: (chunk: AudioChunkMessage) =>
          sendToRenderer(IPC_CHANNELS.voiceAudioChunk, chunk)
      })

      const exec = createExecutionHost({
        bus: service,
        capability: (id) => service.getCapability(id),
        settings
      })

      const browser = createBrowserHost({ bus: service, exec, settings })

      const runtime = createAgentRuntime({
        bus: service,
        exec,
        browser,
        voice,
        capability: (id) => service.getCapability(id),
        settings
      })

      /**
       * A finalized utterance becomes exactly one room message, which is then
       * handed to the team. Partials are captions only: they never become
       * messages and never trigger work.
       */
      sink = {
        onFinalUtterance: ({ roomId, utteranceId, text }) => {
          service.emit(roomId, {
            type: 'voice.transcript',
            transcript: {
              utteranceId,
              roomId,
              text,
              isFinal: true,
              updatedAt: new Date().toISOString()
            }
          })
          void service
            .sendHumanMessage({
              roomId,
              body: text,
              clientRequestId: `voice:${utteranceId}`,
              utteranceId
            })
            .then((message) =>
              runtime.handleHumanMessage({
                roomId,
                message,
                addressed: message.private ? [message.private.agentId] : message.to
              })
            )
            .catch((error: unknown) => {
              service.notice(
                roomId,
                'error',
                'That spoken message could not be stored, so the team did not receive it.',
                error instanceof Error ? error.message : undefined
              )
            })
        },
        onPartialUtterance: ({ roomId, utteranceId, text }) => {
          service.emit(roomId, {
            type: 'voice.transcript',
            transcript: {
              utteranceId,
              roomId,
              text,
              isFinal: false,
              updatedAt: new Date().toISOString()
            }
          })
        },
        onHumanSpeechStart: (roomId) => {
          service.emit(roomId, { type: 'voice.vad', speaking: true, probability: 1 })
        },
        onHumanSpeechEnd: (roomId) => {
          service.emit(roomId, { type: 'voice.vad', speaking: false, probability: 0 })
        }
      }

      const capabilities = createCapabilityService({
        bus: service,
        settings,
        listVoices: () => voice.listVoices(),
        probeModel: (model) => {
          const probe = runtime.probeModel
          if (!probe) return Promise.resolve({ ok: false, detail: 'No model probe available.' })
          return probe.call(runtime, model)
        },
        projectState: () => {
          const selected = service.snapshot().selectedRoomId
          const room = selected ? service.getRoom(selected) : null
          if (!room?.project) return null
          return { rootPath: room.project.rootPath, isGitRepo: room.project.isGitRepo }
        },
        previewState: () => {
          const selected = service.snapshot().selectedRoomId
          const room = selected ? service.getRoom(selected) : null
          if (!room) return null
          const workspaces = service.getWorkspaces(room.id)
          const workspace =
            workspaces.find((item) => item.kind === 'team') ?? workspaces[0] ?? null
          if (!workspace) return null
          const preview = exec.getPreview(room.id, workspace.id)
          return preview
            ? { state: preview.state, detail: preview.detail, publicUrl: preview.publicUrl }
            : null
        }
      })

      /* ---------------- restart reconciliation ---------------- */

      const persisted = service.snapshot()
      await exec.reconcile(persisted.jobs, persisted.workspaces).catch((error: unknown) => {
        service.notice(
          persisted.selectedRoomId ?? '',
          'warn',
          'Huddle could not check the state of previously running processes.',
          error instanceof Error ? error.message : undefined
        )
      })
      await browser.reconcile(persisted.browserSessions).catch(() => undefined)

      stopIpc = registerIpcHandlers(
        { service, runtime, exec, browser, voice, capabilities },
        () => mainWindow
      )

      shutdown = async (): Promise<void> => {
        stopIpc?.()
        stopIpc = null
        await voice.dispose().catch(() => undefined)
        await browser.dispose().catch(() => undefined)
        await exec.dispose().catch(() => undefined)
        await runtime.dispose().catch(() => undefined)
        await service.dispose().catch(() => undefined)
      }

      createWindow()

      // Probe providers first so the team is not told it cannot reason simply
      // because the probe has not finished yet, then attach the room.
      await capabilities.refresh().catch(() => undefined)

      const selectedRoomId = service.snapshot().selectedRoomId
      if (selectedRoomId) {
        await runtime.attachRoom(selectedRoomId).catch((error: unknown) => {
          service.notice(
            selectedRoomId,
            'warn',
            'The team could not attach to this room.',
            error instanceof Error ? error.message : undefined
          )
        })
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow()
        }
      })
    })
    .catch((error: unknown) => {
      // A failure before the window exists must still be visible.
      console.error('Huddle failed to start:', error)
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    const run = shutdown
    shutdown = null
    if (run) void run()
  })
}
