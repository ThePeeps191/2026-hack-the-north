import type {
  AddAgentInput,
  Agent,
  AppSnapshot,
  CreateRoomInput,
  IpcResult,
  Message,
  Room,
  RuntimeEvent,
  SendMessageInput,
  UpdateRoomInput
} from './types'

export const IPC_CHANNELS = {
  getSnapshot: 'huddle:getSnapshot',
  createRoom: 'huddle:createRoom',
  updateRoom: 'huddle:updateRoom',
  selectRoom: 'huddle:selectRoom',
  addAgent: 'huddle:addAgent',
  sendMessage: 'huddle:sendMessage',
  event: 'huddle:event'
} as const

export interface HuddleApi {
  getSnapshot: () => Promise<AppSnapshot>
  createRoom: (input?: CreateRoomInput) => Promise<Room>
  updateRoom: (input: UpdateRoomInput) => Promise<Room>
  selectRoom: (roomId: string) => Promise<void>
  addAgent: (input: AddAgentInput) => Promise<Agent>
  sendMessage: (input: SendMessageInput) => Promise<Message>
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void
}

export type InvokeMap = {
  [IPC_CHANNELS.getSnapshot]: { args: []; result: IpcResult<AppSnapshot> }
  [IPC_CHANNELS.createRoom]: { args: [CreateRoomInput | undefined]; result: IpcResult<Room> }
  [IPC_CHANNELS.updateRoom]: { args: [UpdateRoomInput]; result: IpcResult<Room> }
  [IPC_CHANNELS.selectRoom]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.addAgent]: { args: [AddAgentInput]; result: IpcResult<Agent> }
  [IPC_CHANNELS.sendMessage]: { args: [SendMessageInput]; result: IpcResult<Message> }
}
