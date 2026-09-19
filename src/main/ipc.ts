import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../shared/api.ts'
import type {
  AddAgentInput,
  CreateRoomInput,
  IpcResult,
  SendMessageInput,
  UpdateRoomInput
} from '../shared/types.ts'
import { toErrorShape } from './huddle-error.ts'
import type { RoomService } from './room-service.ts'

const ALLOWED_SENDER = /^(file:\/\/|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/i

export function registerIpcHandlers(
  service: RoomService,
  getWindow: () => BrowserWindow | null
): () => void {
  const invoke = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T>
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<T>> => {
      try {
        assertTrustedSender(event, getWindow())
        const value = await handler(event, ...args)
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: toErrorShape(error) }
      }
    })
  }

  invoke(IPC_CHANNELS.getSnapshot, async () => service.getSnapshot())

  invoke(IPC_CHANNELS.createRoom, async (_event, input) => {
    return service.createRoom(asCreateRoomInput(input))
  })

  invoke(IPC_CHANNELS.updateRoom, async (_event, input) => {
    return service.updateRoom(asUpdateRoomInput(input))
  })

  invoke(IPC_CHANNELS.selectRoom, async (_event, roomId) => {
    await service.selectRoom(asString(roomId, 'roomId'))
  })

  invoke(IPC_CHANNELS.addAgent, async (_event, input) => {
    return service.addAgent(asAddAgentInput(input))
  })

  invoke(IPC_CHANNELS.sendMessage, async (_event, input) => {
    return service.sendMessage(asSendMessageInput(input))
  })

  const stopEvents = service.subscribe((event) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) {
      return
    }
    window.webContents.send(IPC_CHANNELS.event, event)
  })

  return () => {
    stopEvents()
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.event) {
        ipcMain.removeHandler(channel)
      }
    }
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('Untrusted IPC sender.')
  }
  const url = event.senderFrame?.url ?? event.sender.getURL()
  if (!ALLOWED_SENDER.test(url)) {
    throw new Error('Untrusted IPC origin.')
  }
}

function asCreateRoomInput(value: unknown): CreateRoomInput {
  if (value === undefined || value === null) {
    return {}
  }
  const record = asRecord(value)
  return {
    name: optionalString(record.name),
    description: optionalString(record.description)
  }
}

function asUpdateRoomInput(value: unknown): UpdateRoomInput {
  const record = asRecord(value)
  return {
    id: asString(record.id, 'id'),
    name: optionalString(record.name),
    description: optionalString(record.description),
    workspace: record.workspace as UpdateRoomInput['workspace']
  }
}

function asAddAgentInput(value: unknown): AddAgentInput {
  const record = asRecord(value)
  return {
    roomId: asString(record.roomId, 'roomId'),
    presetId: asString(record.presetId, 'presetId') as AddAgentInput['presetId']
  }
}

function asSendMessageInput(value: unknown): SendMessageInput {
  const record = asRecord(value)
  return {
    roomId: asString(record.roomId, 'roomId'),
    body: asString(record.body, 'body'),
    clientRequestId: asString(record.clientRequestId, 'clientRequestId')
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object payload.')
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
