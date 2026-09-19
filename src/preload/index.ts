import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, type HuddleApi } from '../shared/api.ts'
import type { IpcResult, RuntimeEvent } from '../shared/types.ts'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result || typeof result !== 'object') {
    throw new Error('Malformed IPC response.')
  }
  if (!result.ok) {
    const error = new Error(result.error.message)
    error.name = result.error.code
    throw error
  }
  return result.value
}

const api: HuddleApi = {
  getSnapshot: () => invoke(IPC_CHANNELS.getSnapshot),
  createRoom: (input) => invoke(IPC_CHANNELS.createRoom, input),
  updateRoom: (input) => invoke(IPC_CHANNELS.updateRoom, input),
  selectRoom: (roomId) => invoke(IPC_CHANNELS.selectRoom, roomId),
  addAgent: (input) => invoke(IPC_CHANNELS.addAgent, input),
  sendMessage: (input) => invoke(IPC_CHANNELS.sendMessage, input),
  subscribe: (listener) => {
    const wrapped = (_event: IpcRendererEvent, event: RuntimeEvent): void => {
      listener(event)
    }
    ipcRenderer.on(IPC_CHANNELS.event, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.event, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('huddle', api)
