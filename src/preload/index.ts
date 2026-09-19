import { contextBridge } from 'electron'

const api = {}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('huddle', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(globalThis as unknown as { huddle: typeof api }).huddle = api
}
