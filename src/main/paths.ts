import { app } from 'electron'
import { join } from 'node:path'

export function resolveStatePath(): string {
  if (app.isPackaged) {
    return join(app.getPath('userData'), 'huddle-state.json')
  }
  return join(process.cwd(), '.data', 'huddle-state.json')
}
