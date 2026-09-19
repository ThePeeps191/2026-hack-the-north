import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc.ts'
import { JsonSnapshotStore } from './json-store.ts'
import { resolveStatePath } from './paths.ts'
import { RoomService } from './room-service.ts'

const ALLOWED_EXTERNAL = new Set(['https:', 'mailto:'])

let mainWindow: BrowserWindow | null = null
let stopIpc: (() => void) | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#121418',
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
    if (current && url !== current && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
      event.preventDefault()
    }
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

if (!app.isPackaged) {
  app.setPath('userData', join(process.cwd(), '.data', 'electron-profile'))
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.huddle.app')

  const service = await RoomService.open(new JsonSnapshotStore(resolveStatePath()))
  stopIpc = registerIpcHandlers(service, () => mainWindow)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  stopIpc?.()
  stopIpc = null
})
