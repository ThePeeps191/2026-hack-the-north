// Huddle renderer: the call actions wired to the preload bridge.
//
// Every callback here is the renderer's only way to change anything: it calls
// the typed bridge and reports the real error back to the UI. The screen never
// talks to IPC directly, and nothing is retried behind the user's back.

import type { AppSettings, CallState, StageState } from '../../../shared/types'
import type { CallActions } from './view-model'
import type { VoiceController } from '../voice/index'

type ErrorReporter = (message: string | null) => void

export interface ActionContext {
  roomId: string
  /** Reads the live call state, so toggles never act on a stale value. */
  getCall: () => CallState
  setError: ErrorReporter
  voice?: Pick<VoiceController, 'start' | 'stop' | 'setMicMuted' | 'setDeafened' | 'stopSpeaking'>
}

const SECRET_KEYS = new Set([
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID'
])

/**
 * Build the CallActions a `CallScreen` receives.
 *
 * `setError` surfaces the real failure text inline; nothing is swallowed.
 */
export function createActions({ roomId, getCall, setError, voice }: ActionContext): CallActions {
  const run = async (action: () => Promise<unknown>, propagate = false): Promise<void> => {
    try {
      await action()
      setError(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'That action failed.')
      // Forms must retain their draft until durability is confirmed. Other
      // click actions report errors here without creating unhandled promises.
      if (propagate) throw error
    }
  }

  const setStage = (stage: StageState): Promise<void> =>
    run(() => window.huddle.setStage({ roomId, stage }))

  return {
    createRoom: () => run(() => window.huddle.createRoom({})),

    selectRoom: (id: string) => run(() => window.huddle.selectRoom(id)),

    removeRoom: (id: string) => run(() => window.huddle.removeRoom(id)),

    renameRoom: (name: string) => run(() => window.huddle.updateRoom({ id: roomId, name })),

    setGoal: (goal: string) => run(() => window.huddle.updateRoom({ id: roomId, goal })),

    joinCall: () => run(() => voice ? voice.start(roomId) : window.huddle.joinCall(roomId)),

    leaveCall: () => run(() => voice ? voice.stop() : window.huddle.leaveCall(roomId)),

    toggleMic: () => {
      const { micMuted } = getCall()
      return run(() => (voice ?? window.huddle.voice).setMicMuted(!micMuted))
    },

    toggleDeafen: () => {
      const { deafened } = getCall()
      return run(() => (voice ?? window.huddle.voice).setDeafened(!deafened))
    },

    stopSpeaking: (scope: 'current' | 'all') =>
      run(() => voice ? voice.stopSpeaking(scope) : window.huddle.voice.stopSpeaking({ roomId, scope })),

    addAgent: (presetId, options) =>
      run(() => window.huddle.addAgent({ roomId, presetId, ...options })),

    removeAgent: (agentId: string) => run(() => window.huddle.removeAgent(agentId)),

    setAgentVoice: (agentId: string, voiceId: string) =>
      run(() => window.huddle.updateAgent({ agentId, voiceId })),

    sendMessage: (body, options) =>
      run(() =>
        window.huddle.sendMessage({
          roomId,
          body,
          clientRequestId: crypto.randomUUID(),
          ...(options?.to ? { to: options.to } : {}),
          ...(options?.refs ? { refs: options.refs } : {}),
          ...(options?.replyToId ? { replyToId: options.replyToId } : {}),
          ...(options?.privateTo ? { private: { agentId: options.privateTo } } : {})
        }), true
      ),

    setStage,

    showGallery: () =>
      setStage({ mode: { kind: 'gallery' }, follow: true, pendingHint: null }),

    showShare: (owner, surface) =>
      setStage({ mode: { kind: 'share', owner, surface }, follow: true, pendingHint: null }),

    openSpotlight: (agentId: string, surface = 'code') =>
      setStage({ mode: { kind: 'spotlight', agentId, surface }, follow: true, pendingHint: null }),

    setFollow: (follow: boolean) => setStage({ mode: { kind: 'gallery' }, follow, pendingHint: null }),

    chooseProject: () =>
      run(async () => {
        const path = await window.huddle.chooseProjectFolder()
        if (!path) return
        await window.huddle.bindProject({ roomId, rootPath: path, kind: 'existing' })
      }),

    useDemoProject: () => run(() => window.huddle.createDemoProject(roomId)),

    recordDecision: (input) =>
      run(() =>
        window.huddle.recordDecision({
          roomId,
          title: input.title,
          statement: input.statement,
          ...(input.rationale ? { rationale: input.rationale } : {}),
          ...(input.supersedesId ? { supersedesId: input.supersedesId } : {})
        }), true
      ),

    pauseWork: (agentId?: string) =>
      run(() => window.huddle.controlWork({ roomId, action: 'pause', ...(agentId ? { agentId } : {}) })),

    resumeWork: (agentId?: string) =>
      run(() =>
        window.huddle.controlWork({ roomId, action: 'resume', ...(agentId ? { agentId } : {}) })
      ),

    cancelTask: (taskId: string) =>
      run(() => window.huddle.controlWork({ roomId, action: 'cancelTask', taskId })),

    retryTask: (taskId: string) => run(() => window.huddle.retryTask(taskId)),

    runIntegration: () => run(() => window.huddle.exec.runIntegration({ roomId, agentIds: [] })),

    cancelJob: (jobId: string) => run(() => window.huddle.exec.cancelJob(jobId)),

    resumeItem: (itemId: string) => run(() => window.huddle.resumeItem({ roomId, itemId })),

    dismissResumable: (itemId: string) => run(() => window.huddle.dismissResumable({ roomId, itemId })),

    updateSettings: (patch: Partial<AppSettings>) =>
      run(() => window.huddle.settings.update(patch), true),

    setSecret: (key: string, value: string) =>
      run(() => {
        if (!SECRET_KEYS.has(key)) {
          throw new Error(`${key} is not a key Huddle stores.`)
        }
        return window.huddle.settings.setSecret({
          key: key as 'OPENAI_API_KEY' | 'ELEVENLABS_API_KEY' | 'BROWSERBASE_API_KEY' | 'BROWSERBASE_PROJECT_ID',
          value
        })
      }, true),

    refreshCapabilities: () => run(() => window.huddle.settings.refreshCapabilities()),

    previewVoice: (voiceId: string) => run(() => window.huddle.settings.previewVoice(voiceId)),

    revealPath: (path: string) => run(() => window.huddle.settings.revealPath(path))
  }
}
