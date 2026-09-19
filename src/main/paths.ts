import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * All Huddle-owned locations. Huddle's own state lives here; a user's target
 * project never does. Importable from plain Node (tests, the voice helper) as
 * well as from Electron main.
 */

let cachedDataRoot: string | null = null

/** Set once at startup by the Electron main process. */
export function setDataRoot(root: string): void {
  cachedDataRoot = root
}

export function dataRoot(): string {
  if (cachedDataRoot) return cachedDataRoot
  const fromEnv = process.env.HUDDLE_DATA_ROOT
  if (fromEnv) return resolve(fromEnv)
  return join(process.cwd(), '.data')
}

export function resolveStatePath(): string {
  return join(dataRoot(), 'huddle-state.json')
}

/** Append-only durable record of task and decision history. */
export function eventLogPath(): string {
  return join(dataRoot(), 'huddle-events.jsonl')
}

export function secretsPath(): string {
  return join(dataRoot(), 'secrets.json')
}

export function roomDir(roomId: string): string {
  return join(dataRoot(), 'rooms', roomId)
}

export function artifactsDir(roomId: string): string {
  return join(roomDir(roomId), 'artifacts')
}

/** Where agent git worktrees are created for a room. */
export function worktreesDir(roomId: string): string {
  return join(roomDir(roomId), 'worktrees')
}

/** Default parent for freshly created demo projects. */
export function demoProjectsDir(): string {
  return join(dataRoot(), 'projects')
}

export function logsDir(): string {
  return join(dataRoot(), 'logs')
}

/** Repo root in development, resources dir in a packaged build. */
export function appRoot(): string {
  if (process.env.HUDDLE_APP_ROOT) return resolve(process.env.HUDDLE_APP_ROOT)
  return process.cwd()
}

/** The bundled Sketch Night starter project used for demos. */
export function demoTemplatePath(): string {
  const candidates = [
    join(appRoot(), 'demo', 'sketch-night'),
    join(appRoot(), 'resources', 'demo', 'sketch-night')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/** Bundled voice helper entry, run under a standalone Node process. */
export function voiceHelperPath(): string {
  const candidates = [
    join(appRoot(), 'out', 'main', 'voice-helper.js'),
    join(appRoot(), 'resources', 'voice-helper.js')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/** faster-whisper worker and its virtualenv, reused from the voice lab. */
export function speechAssets(): {
  pythonBin: string
  workerScript: string
  sileroModelPath: string
  labRoot: string
} {
  const labRoot = join(appRoot(), 'tools', 'voice-lab')
  const venvCandidates = [
    join(labRoot, '.venv', 'Scripts', 'python.exe'),
    join(labRoot, '.venv', 'bin', 'python')
  ]
  return {
    labRoot,
    pythonBin:
      process.env.HUDDLE_PYTHON ??
      venvCandidates.find((candidate) => existsSync(candidate)) ??
      'python',
    workerScript: join(labRoot, 'python', 'transcribe_worker.py'),
    sileroModelPath: join(labRoot, 'models', 'silero_vad.onnx')
  }
}
