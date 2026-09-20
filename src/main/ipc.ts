import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC_CHANNELS,
  type IntegrationInput,
  type ListDirInput,
  type ModelOption,
  type NavigateInput,
  type NetworkEntry,
  type OpenBrowserInput,
  type ReadFileInput,
  type RecordDecisionInput,
  type ResumeInput,
  type SearchInput,
  type SetSecretInput,
  type VoiceOption
} from '../shared/api.ts'
import type {
  AddAgentInput,
  AgentRole,
  AppSettings,
  Capability,
  CreateRoomInput,
  IpcResult,
  Message,
  SendMessageInput,
  ShareSurface,
  SpeechControlInput,
  StageState,
  UpdateAgentInput,
  UpdateRoomInput,
  WorkControlInput
} from '../shared/types.ts'
import type { PlaybackClientEvent } from '../shared/voice.ts'
import type { AgentRuntime, BrowserHost, ExecutionHost, VoiceHost } from './contracts.ts'
import { HuddleError, toErrorShape } from './huddle-error.ts'
import { dataRoot } from './paths.ts'
import type { RoomService } from './room-service.ts'

/**
 * The whole typed IPC surface.
 *
 * Rules this file exists to keep:
 *  - Only the preload bridge can call these channels, and only from a trusted
 *    origin in this window (`assertTrustedSender`).
 *  - Every payload is narrowed before it reaches a host. A renderer cannot
 *    smuggle an arbitrary object into a tool, a path or a command.
 *  - Failures come back as `{ ok: false, error }` with a stable code, so the UI
 *    can explain what happened instead of showing a stack trace.
 *  - Long operations (integration, preview start, browser sessions, agent work)
 *    never block the UI: they are kicked off and their real progress arrives as
 *    runtime events.
 */

/** Settings, secrets and provider probing live in the composition root. */
export interface CapabilityService {
  refresh(): Promise<Capability[]>
  setSecret(key: SetSecretInput['key'], value: string): Promise<Capability>
  listModels(): Promise<ModelOption[]>
}

export interface IpcHost {
  service: RoomService
  runtime: AgentRuntime
  exec: ExecutionHost
  browser: BrowserHost
  voice: VoiceHost
  capabilities: CapabilityService
}

const ALLOWED_SENDER = /^(file:\/\/|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/i

const ROLES: readonly AgentRole[] = ['frontend', 'systems', 'qa', 'research', 'design', 'general']
const SURFACES: readonly ShareSurface[] = ['browser', 'code', 'terminal', 'files']

export function registerIpcHandlers(host: IpcHost, getWindow: () => BrowserWindow | null): () => void {
  const { service } = host

  const invoke = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T
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

  /* ---------------- snapshot + events ---------------- */

  invoke(IPC_CHANNELS.getSnapshot, () => service.snapshot())

  const stopEvents = service.subscribe((event) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IPC_CHANNELS.event, event)
  })

  /* ---------------- rooms ---------------- */

  invoke(IPC_CHANNELS.createRoom, async (_event, input) => {
    const value = input === undefined || input === null ? {} : asRecord(input)
    const clean: CreateRoomInput = {}
    const name = optionalString(value.name)
    const goal = optionalString(value.goal)
    if (name) clean.name = name
    if (goal) clean.goal = goal
    if (typeof value.agentCount === 'number' && Number.isFinite(value.agentCount)) {
      clean.agentCount = value.agentCount
    }
    const room = await service.createRoom(clean)
    await attachRuntime(host, room.id)
    return room
  })

  invoke(IPC_CHANNELS.updateRoom, async (_event, input) => {
    const value = asRecord(input)
    const clean: UpdateRoomInput = { id: asString(value.id, 'id') }
    const name = optionalString(value.name)
    const goal = optionalString(value.goal)
    if (name !== undefined) clean.name = name
    if (goal !== undefined) clean.goal = goal
    if (value.stage !== undefined) clean.stage = asStageState(value.stage)
    return service.updateRoom(clean)
  })

  invoke(IPC_CHANNELS.selectRoom, async (_event, roomId) => {
    const id = asString(roomId, 'roomId')
    await service.selectRoom(id)
    await attachRuntime(host, id)
  })

  invoke(IPC_CHANNELS.removeRoom, async (_event, roomId) => {
    const id = asString(roomId, 'roomId')
    if (service.getCall().roomId === id) await leaveCall(host, id)
    await host.runtime.detachRoom(id)
    await host.exec.disposeRoom(id)
    await host.browser.disposeRoom(id)
    await service.removeRoom(id)
  })

  invoke(IPC_CHANNELS.joinCall, async (_event, roomId) => {
    await joinCall(host, asString(roomId, 'roomId'))
  })

  invoke(IPC_CHANNELS.leaveCall, async (_event, roomId) => {
    await leaveCall(host, asString(roomId, 'roomId'))
  })

  /* ---------------- agents ---------------- */

  invoke(IPC_CHANNELS.addAgent, async (_event, input) => {
    const value = asRecord(input)
    const clean: AddAgentInput = {
      roomId: asString(value.roomId, 'roomId'),
      presetId: asString(value.presetId, 'presetId') as AddAgentInput['presetId']
    }
    const name = optionalString(value.name)
    const assignment = optionalString(value.assignment)
    const voiceId = optionalString(value.voiceId)
    const role = optionalString(value.role)
    if (name) clean.name = name
    if (assignment) clean.assignment = assignment
    if (voiceId) clean.voiceId = voiceId
    if (role && ROLES.includes(role as AgentRole)) clean.role = role as AgentRole
    const agent = await service.addAgent(clean)
    await host.runtime.onboardAgent(agent.roomId, agent.id, clean.assignment)
    return agent
  })

  invoke(IPC_CHANNELS.updateAgent, async (_event, input) => {
    const value = asRecord(input)
    const clean: UpdateAgentInput = { agentId: asString(value.agentId, 'agentId') }
    const name = optionalString(value.name)
    const title = optionalString(value.title)
    const persona = optionalString(value.persona)
    const model = optionalString(value.model)
    const voiceId = optionalString(value.voiceId)
    const role = optionalString(value.role)
    if (name !== undefined) clean.name = name
    if (title !== undefined) clean.title = title
    if (persona !== undefined) clean.persona = persona
    if (model !== undefined) clean.model = model
    if (voiceId !== undefined) clean.voiceId = voiceId
    if (role && ROLES.includes(role as AgentRole)) clean.role = role as AgentRole
    return service.updateAgentSettings(clean)
  })

  invoke(IPC_CHANNELS.removeAgent, async (_event, agentId) => {
    const id = asString(agentId, 'agentId')
    const agent = service.getAgent(id)
    await service.removeAgent(id)
    if (agent && service.getCall().speakingAgentId === id) {
      host.voice.stopSpeaking(agent.roomId, 'all', 'stopSpeaking')
    }
  })

  /* ---------------- conversation ---------------- */

  invoke(IPC_CHANNELS.sendMessage, async (_event, input) => {
    const value = asRecord(input)
    const clean: SendMessageInput = {
      roomId: asString(value.roomId, 'roomId'),
      body: asString(value.body, 'body'),
      clientRequestId: asString(value.clientRequestId, 'clientRequestId')
    }
    const to = asStringArray(value.to)
    if (to) clean.to = to
    const replyToId = optionalString(value.replyToId)
    if (replyToId) clean.replyToId = replyToId
    const utteranceId = optionalString(value.utteranceId)
    if (utteranceId) clean.utteranceId = utteranceId
    if (Array.isArray(value.refs)) {
      clean.refs = value.refs.filter(isPlainObject) as SendMessageInput['refs']
    }
    const priv = value.private
    if (isPlainObject(priv)) {
      const agentId = optionalString(priv.agentId)
      if (agentId) clean.private = { agentId }
    }

    const message = await service.sendHumanMessage(clean)
    // The reply arrives as runtime events; sending never blocks on the model.
    void dispatchHumanMessage(host, message)
    return message
  })

  /* ---------------- decisions and work control ---------------- */

  invoke(IPC_CHANNELS.recordDecision, async (_event, input) => {
    const value = asRecord(input)
    const clean: RecordDecisionInput = {
      roomId: asString(value.roomId, 'roomId'),
      title: asString(value.title, 'title'),
      statement: asString(value.statement, 'statement')
    }
    const rationale = optionalString(value.rationale)
    if (rationale) clean.rationale = rationale
    const supersedesId = optionalString(value.supersedesId)
    if (supersedesId) clean.supersedesId = supersedesId
    const originMessageId = optionalString(value.originMessageId)
    if (originMessageId) clean.originMessageId = originMessageId

    const decision = await service.recordDecision(clean, { type: 'human' })
    const affected = service
      .getTasks(clean.roomId)
      .filter((task) => decision.affectedTaskIds.includes(task.id))

    // Speech and queued work generated against an older revision is obsolete.
    host.voice.invalidateSpeechBefore(clean.roomId, decision.revision)
    try {
      await host.runtime.applyDecision(clean.roomId, decision, affected)
    } catch (error) {
      service.notice(
        clean.roomId,
        'warn',
        'The decision was recorded, but the team could not be told about it yet.',
        toErrorShape(error).message
      )
    }
    return decision
  })

  invoke(IPC_CHANNELS.controlWork, async (_event, input) => {
    const value = asRecord(input)
    const roomId = asString(value.roomId, 'roomId')
    const action = asString(value.action, 'action')
    const agentId = optionalString(value.agentId)
    const taskId = optionalString(value.taskId)
    if (action === 'pause') {
      await host.runtime.pauseWork(roomId, agentId)
    } else if (action === 'resume') {
      await host.runtime.resumeWork(roomId, agentId)
    } else if (action === 'cancelTask') {
      if (!taskId) throw new HuddleError('missing_task', 'Choose a task to cancel.')
      await host.runtime.cancelTask(roomId, taskId)
    } else {
      throw new HuddleError('unknown_action', `"${action}" is not a work control.`)
    }
  })

  invoke(IPC_CHANNELS.retryTask, async (_event, taskId) => {
    return host.runtime.retryTask(asString(taskId, 'taskId'))
  })

  invoke(IPC_CHANNELS.resumeItem, async (_event, input) => {
    const { roomId, itemId } = asResumeInput(input)
    await resumeResumable(host, roomId, itemId)
  })

  invoke(IPC_CHANNELS.dismissResumable, async (_event, input) => {
    const { itemId } = asResumeInput(input)
    service.dismissResumable(itemId)
  })

  /* ---------------- project + stage ---------------- */

  invoke(IPC_CHANNELS.chooseProjectFolder, async () => {
    const window = getWindow()
    const options = {
      title: 'Choose the project Huddle should work on',
      properties: ['openDirectory', 'createDirectory'] as const
    }
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  invoke(IPC_CHANNELS.bindProject, async (_event, input) => {
    const value = asRecord(input)
    const roomId = asString(value.roomId, 'roomId')
    const rootPath = asString(value.rootPath, 'rootPath')
    const kind = value.kind === 'demo' ? 'demo' : 'existing'
    const binding = await host.exec.bindProject(roomId, rootPath, kind)
    const room = await service.bindProject(roomId, binding)
    await prepareTeamWorkspace(host, roomId)
    await attachRuntime(host, roomId)
    service.notice(
      roomId,
      'info',
      `This room now works on ${binding.rootPath}.`,
      binding.isGitRepo
        ? 'Teammates get their own worktree and branch; the Team view stays the integration workspace.'
        : 'This folder is not a git repository, so teammates write to the same files. This is not a sandbox.'
    )
    return room
  })

  invoke(IPC_CHANNELS.createDemoProject, async (_event, roomId) => {
    const id = asString(roomId, 'roomId')
    const target = host.exec.suggestDemoPath(id)
    const binding = await host.exec.bindProject(id, target, 'demo')
    const room = await service.bindProject(id, binding)
    await prepareTeamWorkspace(host, id)
    await attachRuntime(host, id)
    service.notice(
      id,
      'info',
      `Sketch Night was copied to ${binding.rootPath}.`,
      'It is a constructed starting scaffold with real bugs and contradictory notes. Read it before changing it.'
    )
    return room
  })

  invoke(IPC_CHANNELS.setStage, async (_event, input) => {
    const value = asRecord(input)
    const roomId = asString(value.roomId, 'roomId')
    return service.setStage(roomId, asStageState(value.stage))
  })

  /* ---------------- voice ---------------- */

  invoke(IPC_CHANNELS.voiceStart, async (_event, roomId) => {
    await startVoice(host, asString(roomId, 'roomId'))
  })

  invoke(IPC_CHANNELS.voiceStop, async () => {
    await host.voice.stop()
    service.patchCall({ connection: 'disconnected', listening: false })
  })

  invoke(IPC_CHANNELS.voiceSetMicMuted, async (_event, muted) => {
    const value = asBoolean(muted, 'muted')
    host.voice.setMicMuted(value)
    service.patchCall({ micMuted: value, micLevel: value ? 0 : service.getCall().micLevel })
  })

  invoke(IPC_CHANNELS.voiceSetDeafened, async (_event, deafened) => {
    const value = asBoolean(deafened, 'deafened')
    host.voice.setDeafened(value)
    service.patchCall({ deafened: value })
  })

  invoke(IPC_CHANNELS.voiceStopSpeaking, async (_event, input) => {
    const value = asRecord(input)
    const roomId = asString(value.roomId, 'roomId')
    const scope: SpeechControlInput['scope'] = value.scope === 'all' ? 'all' : 'current'
    // Stopping audio never stops the work behind it.
    host.voice.stopSpeaking(roomId, scope, 'stopSpeaking')
  })

  invoke(IPC_CHANNELS.voiceListDevices, async () => {
    // Device enumeration needs a renderer context with microphone permission,
    // so the settings panel reads navigator.mediaDevices directly.
    return []
  })

  invoke(IPC_CHANNELS.voiceTimings, async () => service.getTimings())

  /* ---------------- execution surfaces ---------------- */

  invoke(IPC_CHANNELS.readWorkspaceFile, async (_event, input) => {
    const value = asRecord(input)
    const clean: ReadFileInput = {
      workspaceId: asString(value.workspaceId, 'workspaceId'),
      path: asString(value.path, 'path')
    }
    const maxBytes = optionalNumber(value.maxBytes)
    if (maxBytes !== undefined) clean.maxBytes = maxBytes
    return host.exec.readFile(clean.workspaceId, clean.path, clean.maxBytes)
  })

  invoke(IPC_CHANNELS.listWorkspaceDir, async (_event, input) => {
    const value = asRecord(input)
    const clean: ListDirInput = { workspaceId: asString(value.workspaceId, 'workspaceId') }
    const path = optionalString(value.path)
    if (path) clean.path = path
    return host.exec.listDir(clean.workspaceId, clean.path)
  })

  invoke(IPC_CHANNELS.searchWorkspace, async (_event, input) => {
    const value = asRecord(input)
    const clean: SearchInput = {
      workspaceId: asString(value.workspaceId, 'workspaceId'),
      query: asString(value.query, 'query')
    }
    const glob = optionalString(value.glob)
    const max = optionalNumber(value.max)
    if (glob) clean.glob = glob
    if (max !== undefined) clean.max = max
    return host.exec.search(clean.workspaceId, clean.query, {
      ...(clean.glob ? { glob: clean.glob } : {}),
      ...(clean.max !== undefined ? { max: clean.max } : {})
    })
  })

  invoke(IPC_CHANNELS.getWorkspaceDiff, async (_event, workspaceId) => {
    return host.exec.diff(asString(workspaceId, 'workspaceId'))
  })

  invoke(IPC_CHANNELS.cancelJob, async (_event, jobId) => {
    await host.exec.cancelJob(asString(jobId, 'jobId'))
  })

  invoke(IPC_CHANNELS.getJobOutput, async (_event, jobId) => {
    return host.exec.getJobOutput(asString(jobId, 'jobId'))
  })

  invoke(IPC_CHANNELS.runIntegration, async (_event, input) => {
    const value = asRecord(input)
    const roomId = asString(value.roomId, 'roomId')
    const agentIds = asStringArray(value.agentIds) ?? []
    const room = service.getRoom(roomId)
    if (!room) throw new HuddleError('unknown_room', 'That room no longer exists.')
    const integrator = pickIntegrator(host, roomId)
    if (!integrator) {
      throw new HuddleError(
        'no_agent',
        'No teammate is in this room to run the integration.',
        'Add Maya, Alex or Sam first.'
      )
    }
    // Integration runs the real checks against a real revision and can take
    // minutes; the attempt streams through `integration.upserted` events.
    void host.exec
      .integrate({
        roomId,
        agentId: integrator.id,
        sourceAgentIds: agentIds,
        decisionRevision: room.decisionRevision
      })
      .catch((error: unknown) => {
        const shape = toErrorShape(error)
        service.notice(roomId, 'error', 'Integration could not start.', shape.fix ?? shape.message)
      })
  })

  invoke(IPC_CHANNELS.startPreview, async (_event, roomIdArg, workspaceIdArg) => {
    const roomId = asString(roomIdArg, 'roomId')
    const workspaceId = asString(workspaceIdArg, 'workspaceId')
    const pending = host.exec.startPreview(roomId, workspaceId)
    pending.catch((error: unknown) => {
      const shape = toErrorShape(error)
      service.notice(roomId, 'error', 'The preview could not be started.', shape.fix ?? shape.message)
    })
    // Readiness can take a while (a dev server has to answer). Return quickly
    // with the live record; the UI keeps polling by calling this again.
    const settled = await Promise.race([
      pending.then((info) => info).catch(() => null),
      delay(2500).then(() => null)
    ])
    return (
      settled ??
      host.exec.getPreview(roomId, workspaceId) ?? {
        roomId,
        workspaceId,
        publicUrl: null,
        localUrl: '',
        mode: service.getSettings().preview.mode,
        state: 'starting' as const,
        detail: 'Starting the development server and waiting for it to answer real requests.'
      }
    )
  })

  /* ---------------- browser ---------------- */

  invoke(IPC_CHANNELS.openBrowserSession, async (_event, input) => {
    const value = asRecord(input)
    const clean: OpenBrowserInput = {
      roomId: asString(value.roomId, 'roomId'),
      agentId: asString(value.agentId, 'agentId')
    }
    const url = optionalString(value.url)
    if (url) clean.url = url
    return host.browser.openSession(clean)
  })

  invoke(IPC_CHANNELS.closeBrowserSession, async (_event, sessionId) => {
    await host.browser.closeSession(asString(sessionId, 'sessionId'))
  })

  invoke(IPC_CHANNELS.browserNavigate, async (_event, input) => {
    const value = asRecord(input)
    const clean: NavigateInput = {
      sessionId: asString(value.sessionId, 'sessionId'),
      url: asString(value.url, 'url')
    }
    const result = await host.browser.act({
      sessionId: clean.sessionId,
      action: { kind: 'navigate', url: clean.url }
    })
    if (!result.ok) throw new HuddleError('browser_navigate_failed', result.detail)
    const session = host.browser.getSession(clean.sessionId)
    if (!session) throw new HuddleError('unknown_session', 'That browser session is closed.')
    return session
  })

  invoke(IPC_CHANNELS.browserScreenshot, async (_event, sessionId) => {
    return host.browser.screenshot(asString(sessionId, 'sessionId'))
  })

  invoke(IPC_CHANNELS.browserNetwork, async (_event, sessionIdArg, filterArg) => {
    const sessionId = asString(sessionIdArg, 'sessionId')
    const filter = optionalString(filterArg)
    const captures = await host.browser.network(sessionId, filter)
    return captures.map<NetworkEntry>((capture) => ({
      url: capture.url,
      method: capture.method,
      status: capture.status,
      body: capture.body
    }))
  })

  /* ---------------- settings + capabilities ---------------- */

  invoke(IPC_CHANNELS.updateSettings, async (_event, patch) => {
    const value = asRecord(patch)
    if (Object.keys(value).length === 0) return service.getSettings()
    const before = service.getSettings()
    const next = await service.updateSettings(asSettingsPatch(value, before))
    // Agents still on the previous default follow the new one; a model chosen
    // for one teammate by name is left alone.
    if (next.models.contributor !== before.models.contributor) {
      for (const room of service.snapshot().rooms) {
        for (const agent of service.getAgents(room.id)) {
          if (agent.model === before.models.contributor) {
            await service.updateAgentSettings({ agentId: agent.id, model: next.models.contributor })
          }
        }
      }
    }
    void host.capabilities.refresh().catch(() => undefined)
    return next
  })

  invoke(IPC_CHANNELS.setSecret, async (_event, input) => {
    const value = asRecord(input)
    const key = asString(value.key, 'key') as SetSecretInput['key']
    const secret = asString(value.value, 'value')
    const capability = await host.capabilities.setSecret(key, secret)
    const roomId = service.getCall().roomId ?? service.snapshot().selectedRoomId ?? ''
    if (roomId) {
      service.notice(roomId, 'info', `${capability.label}: ${capability.detail}`, capability.fix ?? undefined)
    }
    return capability
  })

  invoke(IPC_CHANNELS.refreshCapabilities, async () => host.capabilities.refresh())

  invoke(IPC_CHANNELS.listModels, async () => host.capabilities.listModels())

  invoke(IPC_CHANNELS.listVoices, async (): Promise<VoiceOption[]> => {
    return host.voice.listVoices()
  })

  invoke(IPC_CHANNELS.previewVoice, async (_event, voiceId) => {
    await host.voice.previewVoice(asString(voiceId, 'voiceId'))
  })

  invoke(IPC_CHANNELS.revealPath, async (_event, pathArg) => {
    const target = resolve(asString(pathArg, 'path'))
    const roots = [
      dataRoot(),
      ...service
        .snapshot()
        .rooms.map((room) => room.project?.rootPath)
        .filter((root): root is string => Boolean(root))
    ]
    if (!roots.some((root) => isInside(root, target))) {
      throw new HuddleError(
        'path_refused',
        'Huddle only opens its own data folder and folders bound to a room.',
        'Bind that project to a room first if you want to open it from here.'
      )
    }
    if (!existsSync(target)) {
      throw new HuddleError('path_missing', `${target} is no longer on disk.`)
    }
    shell.showItemInFolder(target)
  })

  /* ---------------- fire-and-forget renderer messages ---------------- */

  const onMicFrame = (event: IpcMainInvokeEvent, ...args: unknown[]): void => {
    try {
      assertTrustedSender(event, getWindow())
    } catch {
      return
    }
    const pcm = args[0]
    const capturedAt = typeof args[1] === 'number' ? args[1] : Date.now()
    if (pcm instanceof ArrayBuffer) host.voice.pushMicFrame(pcm, capturedAt)
  }

  const onClientEvent = (event: IpcMainInvokeEvent, ...args: unknown[]): void => {
    try {
      assertTrustedSender(event, getWindow())
    } catch {
      return
    }
    const payload = args[0]
    if (!isPlainObject(payload) || typeof payload.type !== 'string') return
    host.voice.reportClientEvent(payload as unknown as PlaybackClientEvent)
  }

  ipcMain.on(IPC_CHANNELS.voiceMicFrame, onMicFrame)
  ipcMain.on(IPC_CHANNELS.voiceClientEvent, onClientEvent)

  return () => {
    stopEvents()
    ipcMain.removeListener(IPC_CHANNELS.voiceMicFrame, onMicFrame)
    ipcMain.removeListener(IPC_CHANNELS.voiceClientEvent, onClientEvent)
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.event) ipcMain.removeHandler(channel)
    }
  }
}

/* ================================================================== *
 * Room-level operations shared by more than one handler
 * ================================================================== */

function pickIntegrator(host: IpcHost, roomId: string): { id: string } | null {
  const agents = host.service.getAgents(roomId)
  const chosen =
    agents.find((agent) => agent.role === 'systems') ??
    agents.find((agent) => agent.role === 'qa') ??
    agents[0]
  return chosen ? { id: chosen.id } : null
}

async function attachRuntime(host: IpcHost, roomId: string): Promise<void> {
  try {
    await host.runtime.attachRoom(roomId)
  } catch (error) {
    host.service.notice(
      roomId,
      'warn',
      'The team could not attach to this room.',
      toErrorShape(error).message
    )
  }
}

/**
 * Creates the Team workspace the moment a project is bound.
 *
 * It used to be created lazily, the first time an agent happened to call a tool
 * that needed one — which meant that after binding a folder the Code, Terminal,
 * Files and Browser tabs all read "No project bound" until somebody got a
 * teammate to do something. The workspace is what those surfaces read, so it
 * has to exist as soon as there is a project for it to point at.
 *
 * A failure here never fails the bind: the project is still bound, and the
 * reason the workspace could not be prepared is reported as itself.
 */
async function prepareTeamWorkspace(host: IpcHost, roomId: string): Promise<void> {
  try {
    await host.exec.ensureTeamWorkspace(roomId)
  } catch (error) {
    host.service.notice(
      roomId,
      'warn',
      'The project is bound, but the Team workspace could not be prepared, so the workspace tabs are empty.',
      toErrorShape(error).message
    )
  }
}

async function startVoice(host: IpcHost, roomId: string): Promise<void> {
  const room = host.service.getRoom(roomId)
  if (!room) throw new HuddleError('unknown_room', 'That room no longer exists.')
  host.service.patchCall({ roomId, connection: 'connecting', error: null })
  await host.voice.start(roomId)
  host.service.patchCall({ connection: 'connected', listening: true, error: null })
}

async function joinCall(host: IpcHost, roomId: string): Promise<void> {
  const room = host.service.getRoom(roomId)
  if (!room) throw new HuddleError('unknown_room', 'That room no longer exists.')
  const { service } = host
  await service.setJoined(roomId, true)
  await attachRuntime(host, roomId)

  try {
    await startVoice(host, roomId)
  } catch (error) {
    // Local speech being unavailable must never make the room unusable.
    const shape = toErrorShape(error)
    service.patchCall({ connection: 'error', listening: false, error: shape.message })
    service.notice(
      roomId,
      'warn',
      'Huddle could not start the microphone or local speech, so this call is text-only.',
      shape.fix ?? shape.message
    )
  }
}

async function leaveCall(host: IpcHost, roomId: string): Promise<void> {
  const { service } = host
  // Speech stops; explicitly running jobs do not.
  host.voice.stopSpeaking(roomId, 'all', 'leave')
  await host.voice.stop()
  await service.setJoined(roomId, false)
  service.patchCall({
    connection: 'disconnected',
    listening: false,
    speakingAgentId: null,
    queuedAgentIds: [],
    micLevel: 0,
    roomId: null
  })
  service.notice(
    roomId,
    'info',
    'You left the call. Room history is kept, and any job that was explicitly started keeps running until you cancel it.'
  )
}

/** A human message is stored first, then handed to the team. */
async function dispatchHumanMessage(host: IpcHost, message: Message): Promise<void> {
  const addressed = message.private ? [message.private.agentId] : message.to
  try {
    await host.runtime.handleHumanMessage({
      roomId: message.roomId,
      message,
      addressed: addressed.filter((id) => Boolean(host.service.getAgent(id)))
    })
  } catch (error) {
    const shape = toErrorShape(error)
    host.service.notice(
      message.roomId,
      'error',
      'The team could not take that message.',
      shape.fix ?? shape.message
    )
  }
}

/**
 * Resuming is an explicit, user-approved restart of something we can really
 * re-run. Anything else is reported as unrecoverable instead of pretending it
 * continued.
 */
async function resumeResumable(host: IpcHost, roomId: string, itemId: string): Promise<void> {
  const { service } = host
  const item = service.getResumable().find((entry) => entry.id === itemId)
  if (!item) throw new HuddleError('unknown_item', 'That interrupted operation is no longer listed.')

  if (item.kind === 'job') {
    const job = service.getJobs(roomId).find((entry) => entry.id === itemId)
    if (!job) throw new HuddleError('unknown_job', 'That job is no longer recorded.')
    const workspace = host.exec.getWorkspace(job.workspaceId)
    const cwd = workspace ? relative(workspace.rootPath, job.cwd) : ''
    await host.exec.startJob({
      roomId,
      agentId: job.agentId,
      workspaceId: job.workspaceId,
      label: `${job.label} (restarted)`,
      command: job.command,
      ...(cwd && !cwd.startsWith('..') ? { cwd } : {}),
      ...(job.port !== null ? { devServer: true } : {})
    })
  } else if (item.kind === 'task') {
    await host.runtime.retryTask(itemId)
  } else if (item.kind === 'integration') {
    const integrator = pickIntegrator(host, roomId)
    if (integrator) {
      void host.exec
        .integrate({
          roomId,
          agentId: integrator.id,
          sourceAgentIds: [],
          decisionRevision: service.getRoom(roomId)?.decisionRevision ?? 0
        })
        .catch(() => undefined)
    }
  } else if (item.kind === 'browser') {
    const session = service.getBrowserSessions(roomId).find((entry) => entry.id === itemId)
    if (session) {
      await host.browser.openSession({
        roomId,
        agentId: session.agentId,
        ...(session.currentUrl ? { url: session.currentUrl } : {})
      })
    }
  }

  service.dismissResumable(itemId)
}

/* ================================================================== *
 * Payload narrowing
 * ================================================================== */

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new HuddleError('untrusted_sender', 'That request did not come from the Huddle window.')
  }
  const url = event.senderFrame?.url ?? event.sender.getURL()
  if (!ALLOWED_SENDER.test(url)) {
    throw new HuddleError('untrusted_origin', 'That request came from an untrusted origin.')
  }
}

function asResumeInput(value: unknown): ResumeInput {
  const record = asRecord(value)
  return {
    roomId: asString(record.roomId, 'roomId'),
    itemId: asString(record.itemId, 'itemId')
  }
}

function asStageState(value: unknown): StageState {
  const record = asRecord(value)
  const follow = record.follow !== false
  const pendingHint = isPlainObject(record.pendingHint)
    ? {
        agentId: asString(record.pendingHint.agentId, 'pendingHint.agentId'),
        surface: asSurface(record.pendingHint.surface),
        at: asString(record.pendingHint.at, 'pendingHint.at')
      }
    : null

  const mode = asRecord(record.mode, 'mode')
  if (mode.kind === 'gallery') return { mode: { kind: 'gallery' }, follow, pendingHint }
  if (mode.kind === 'share') {
    const owner = asRecord(mode.owner, 'owner')
    const surface = asSurface(mode.surface)
    if (owner.kind === 'team') {
      return { mode: { kind: 'share', owner: { kind: 'team' }, surface }, follow, pendingHint }
    }
    return {
      mode: {
        kind: 'share',
        owner: { kind: 'agent', agentId: asString(owner.agentId, 'owner.agentId') },
        surface
      },
      follow,
      pendingHint
    }
  }
  if (mode.kind === 'spotlight') {
    return {
      mode: {
        kind: 'spotlight',
        agentId: asString(mode.agentId, 'mode.agentId'),
        surface: asSurface(mode.surface)
      },
      follow,
      pendingHint
    }
  }
  throw new HuddleError('bad_stage', 'The stage state could not be read.')
}

function asSurface(value: unknown): ShareSurface {
  const surface = asString(value, 'surface') as ShareSurface
  if (!SURFACES.includes(surface)) {
    throw new HuddleError('bad_surface', `"${surface}" is not a share surface.`)
  }
  return surface
}

/** Only the settings fields a renderer may change, and only with valid types. */
function asSettingsPatch(
  value: Record<string, unknown>,
  current: AppSettings
): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {}

  if (isPlainObject(value.models)) {
    const contributor = optionalString(value.models.contributor)?.trim()
    const conversation = optionalString(value.models.conversation)?.trim()
    if (contributor || conversation) {
      patch.models = {
        contributor: contributor || current.models.contributor,
        conversation: conversation || current.models.conversation
      }
    }
  }

  if (isPlainObject(value.voice)) {
    const voice = value.voice
    const next: Partial<AppSettings['voice']> = {}
    if (typeof voice.enabled === 'boolean') next.enabled = voice.enabled
    if (voice.inputDeviceId === null || typeof voice.inputDeviceId === 'string') {
      next.inputDeviceId = voice.inputDeviceId
    }
    if (voice.outputDeviceId === null || typeof voice.outputDeviceId === 'string') {
      next.outputDeviceId = voice.outputDeviceId
    }
    if (typeof voice.whisperModel === 'string' && voice.whisperModel.trim()) {
      next.whisperModel = voice.whisperModel.trim()
    }
    if (typeof voice.endpointSilenceMs === 'number') next.endpointSilenceMs = voice.endpointSilenceMs
    if (typeof voice.bargeInThreshold === 'number') next.bargeInThreshold = voice.bargeInThreshold
    if (typeof voice.saveRawAudio === 'boolean') next.saveRawAudio = voice.saveRawAudio
    patch.voice = { ...current.voice, ...next }
  }

  if (isPlainObject(value.preview)) {
    const mode = value.preview.mode
    if (mode === 'tunnel' || mode === 'lan' || mode === 'off') {
      patch.preview = {
        mode,
        lanHost: typeof value.preview.lanHost === 'string' ? value.preview.lanHost : null
      }
    }
  }

  if (typeof value.browserbaseEnabled === 'boolean') {
    patch.browserbaseEnabled = value.browserbaseEnabled
  }

  if (isPlainObject(value.limits)) {
    const limits = value.limits
    const next: Partial<AppSettings['limits']> = {}
    if (typeof limits.maxConcurrentBuilds === 'number') {
      next.maxConcurrentBuilds = limits.maxConcurrentBuilds
    }
    if (typeof limits.maxConcurrentToolCalls === 'number') {
      next.maxConcurrentToolCalls = limits.maxConcurrentToolCalls
    }
    if (typeof limits.maxModelTurnsPerTask === 'number') {
      next.maxModelTurnsPerTask = limits.maxModelTurnsPerTask
    }
    patch.limits = { ...current.limits, ...next }
  }

  return patch
}

function asRecord(value: unknown, what = 'payload'): Record<string, unknown> {
  if (!isPlainObject(value)) throw new HuddleError('bad_payload', `Expected an object ${what}.`)
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new HuddleError('bad_payload', `${field} must be a string.`)
  return value
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HuddleError('bad_payload', `${field} must be a boolean.`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isAbsolute(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\)/.test(path) || path.startsWith('/')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
