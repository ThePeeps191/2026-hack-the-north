/*
 * DEV PREVIEW ONLY — not part of the product.
 *
 * Nothing in the app imports this file. It exists so `CallScreen` can be opened
 * in isolation with a hand-written mock snapshot while the real backend runs on
 * another branch of the build. The mock data is clearly labelled in the preview
 * banner and the surface body is a placeholder, because the real surface body is
 * injected by the integration lead.
 *
 * Run it with the renderer's own Vite:
 *   npx vite --root src/renderer/src/call
 * and open the printed URL (`index.html` in this folder loads this file).
 */

import { useState, type JSX } from 'react'
import {
  DEFAULT_SETTINGS,
  STATE_VERSION,
  type Agent,
  type AppSettings,
  type AppSnapshot,
  type Artifact,
  type BrowserSessionRecord,
  type Capability,
  type CheckResult,
  type Decision,
  type IntegrationAttempt,
  type JobRecord,
  type Message,
  type ResumableItem,
  type Room,
  type RuntimeEvent,
  type StageState,
  type Task,
  type WorkspaceRecord
} from '../../../shared/types'
import { AGENT_PRESETS } from '../../../shared/presets'
import type { CallActions, CallScreenProps, NoticeItem } from '../state/view-model'
import { CallScreen } from './index'

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const ROOM_ID = 'room-sketch-night'
const OTHER_ROOM_ID = 'room-payments'

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  models: { contributor: 'gpt-6-astra', conversation: 'gpt-5.6-luna' }
}

function preset(index: number): (typeof AGENT_PRESETS)[number] {
  return AGENT_PRESETS[index] ?? AGENT_PRESETS[0]
}

function mockAgent(
  index: number,
  workState: Agent['workState'],
  activityLabel: string,
  extra: Partial<Agent> = {}
): Agent {
  const source = preset(index)
  return {
    id: `agent-${source.id}`,
    roomId: ROOM_ID,
    presetId: source.id,
    name: source.name,
    role: source.role,
    summary: source.summary,
    persona: source.persona,
    color: source.color,
    avatar: source.avatar,
    voice: source.voice,
    model: index === 0 ? 'gpt-5.6-luna' : 'gpt-6-astra',
    workState,
    speechState: 'silent',
    activityLabel,
    connected: workState !== 'offline',
    workspaceId: `ws-${source.id}`,
    browserSessionId: source.id === 'sam' ? 'br-1' : null,
    createdAt: at(180 + index),
    updatedAt: at(1 + index),
    ...extra
  }
}

export type PreviewScenario = 'meeting' | 'quiet' | 'spotlight' | 'empty'

export function buildMockProps(scenario: PreviewScenario = 'meeting'): CallScreenProps {
  const maya = mockAgent(0, scenario === 'empty' ? 'offline' : 'editing', 'Editing VotePanel.tsx', {
    speechState: scenario === 'meeting' ? 'speaking' : 'silent'
  })
  const alex = mockAgent(1, scenario === 'empty' ? 'offline' : 'integrating', 'Applying Maya’s branch to the team workspace')
  const sam = mockAgent(
    2,
    scenario === 'empty' ? 'offline' : 'browsing',
    'Reproducing the vote-count bug in Chrome',
    { speechState: scenario === 'meeting' ? 'queued' : 'silent' }
  )
  const agents = scenario === 'empty' ? [] : [maya, alex, sam]

  const room: Room = {
    id: ROOM_ID,
    name: 'Sketch Night launch',
    goal: 'Ship a shared sketch night vote screen that works offline and never leaks room data.',
    createdAt: at(240),
    updatedAt: at(1),
    stage: stageFor(scenario, agents),
    project: {
      rootPath: 'C:\\dev\\sketch-night',
      kind: 'demo',
      isGitRepo: true,
      hadDirtyWorkOnBind: false,
      demoTemplate: 'sketch-night',
      boundAt: at(230)
    },
    joined: scenario !== 'empty',
    decisionRevision: 4
  }

  const otherRoom: Room = {
    id: OTHER_ROOM_ID,
    name: 'Payments spike',
    goal: 'Decide whether the vote sync can ride the existing websocket.',
    createdAt: at(400),
    updatedAt: at(40),
    stage: { mode: { kind: 'gallery' }, follow: true, pendingHint: null },
    project: null,
    joined: false,
    decisionRevision: 1
  }

  const messages = scenario === 'empty' ? [] : mockMessages()
  const tasks = scenario === 'empty' ? [] : mockTasks()
  const decisions = scenario === 'empty' ? [] : mockDecisions()
  const workspaces = mockWorkspaces(agents)
  const integrations: IntegrationAttempt[] = scenario === 'empty' ? [] : mockIntegrations()
  const artifacts = scenario === 'empty' ? [] : mockArtifacts()
  const jobs = scenario === 'empty' ? [] : mockJobs()
  const browserSessions = scenario === 'empty' ? [] : mockBrowserSessions()
  const resumable: ResumableItem[] =
    scenario === 'quiet' || scenario === 'empty'
      ? []
      : [
          {
            id: 'res-1',
            roomId: ROOM_ID,
            kind: 'browser',
            title: 'Browser session closed by the provider',
            detail: 'The session ended while Huddle was not running. Retest the vote flow to reopen one.',
            state: 'interrupted'
          }
        ]
  const notices: NoticeItem[] = [
    {
      id: 'note-1',
      level: 'info',
      text: 'Tunnel for preview reopened on port 5180.',
      at: at(6),
      roomId: ROOM_ID
    }
  ]

  const call: AppSnapshot['call'] = {
    roomId: scenario === 'empty' ? null : ROOM_ID,
    connection: scenario === 'empty' ? 'disconnected' : 'connected',
    micMuted: scenario === 'quiet',
    deafened: false,
    micLevel: scenario === 'quiet' ? 0 : 0.34,
    listening: scenario !== 'empty',
    speakingAgentId: scenario === 'meeting' ? maya.id : null,
    queuedAgentIds: scenario === 'meeting' ? [sam.id] : [],
    error: null
  }

  const capabilities: Capability[] = [
    { id: 'openai', label: 'Models', state: 'ready', detail: 'gpt-5.6-luna reachable', fix: null, checkedAt: at(2) },
    { id: 'elevenlabs', label: 'Speech', state: 'ready', detail: 'Voice pool ready', fix: null, checkedAt: at(2) },
    {
      id: 'browserbase',
      label: 'Browser',
      state: scenario === 'quiet' ? 'unavailable' : 'ready',
      detail: scenario === 'quiet' ? 'No API key' : 'Session br-1 live',
      fix: scenario === 'quiet' ? 'Add a Browserbase API key in settings.' : null,
      checkedAt: at(2)
    },
    { id: 'localSpeech', label: 'Local transcription', state: 'ready', detail: 'base.en resident', fix: null, checkedAt: at(2) },
    { id: 'project', label: 'Project', state: 'ready', detail: 'C:\\dev\\sketch-night', fix: null, checkedAt: at(3) },
    { id: 'preview', label: 'Preview tunnel', state: 'starting', detail: 'Opening tunnel', fix: null, checkedAt: at(1) }
  ]

  const snapshot: AppSnapshot = {
    version: STATE_VERSION,
    rooms: [room, otherRoom],
    agents,
    messages,
    tasks,
    decisions,
    toolRuns: [],
    jobs,
    browserSessions,
    artifacts,
    workspaces,
    integrations,
    memories: [],
    settings,
    selectedRoomId: ROOM_ID,
    lastSeq: 42,
    events: messages.slice(0, 6).map(
      (message, index): RuntimeEvent => ({
        id: `ev-${message.id}`,
        seq: 30 + index,
        roomId: message.roomId,
        createdAt: message.createdAt,
        durable: true,
        type: 'message.created',
        message
      })
    ),
    capabilities,
    call,
    resumable
  }

  return {
    snapshot,
    room,
    rooms: [room, otherRoom],
    agents,
    messages,
    tasks,
    decisions,
    jobs,
    workspaces,
    browserSessions,
    artifacts,
    integrations,
    capabilities,
    resumable,
    settings,
    call,
    human: {
      name: 'You',
      muted: call.micMuted,
      deafened: false,
      level: call.micLevel,
      speaking: false
    },
    liveTranscript:
      scenario === 'meeting'
        ? {
            utteranceId: 'utt-1',
            roomId: ROOM_ID,
            text: 'keep the vote counts local',
            isFinal: false,
            updatedAt: at(0)
          }
        : null,
    speaking:
      scenario === 'meeting'
        ? {
            [maya.id]: {
              agentId: maya.id,
              generationId: 'gen-7',
              text:
                'The vote count only exists in local storage, so the panel has nothing to send. I am moving the totals out of the websocket payload now.',
              level: 0.72,
              messageId: 'm-maya-2'
            }
          }
        : {},
    notices,
    error: scenario === 'quiet' ? 'Speech is unavailable: no ElevenLabs key is stored.' : null,
    actions: mockActions(),
    onOpenRef: () => {},
    renderSurface: (args) => (
      <div className="hs-preview-surface">
        <p className="hs-preview-surface-title">
          {args.surface} surface · {args.owner.kind === 'team' ? 'team workspace' : args.owner.agentId}
        </p>
        <p className="hs-preview-surface-detail">
          In the real app this body is the integration lead’s {args.surface} surface, reading{' '}
          {args.workspace ? args.workspace.rootPath : 'no workspace'} and calling back with real
          references.
        </p>
        <button
          type="button"
          className="hs-btn hs-btn--quiet"
          onClick={() =>
            args.onAttachRef({
              kind: 'file',
              path: `${args.workspace?.rootPath ?? 'src'}\\src\\VotePanel.tsx`,
              startLine: 41,
              endLine: 58,
              agentId: args.agent?.id
            })
          }
        >
          Attach a mock code reference
        </button>
      </div>
    )
  }
}

function stageFor(scenario: PreviewScenario, agents: Agent[]): StageState {
  if (scenario === 'spotlight' && agents[0]) {
    return { mode: { kind: 'spotlight', agentId: agents[0].id, surface: 'code' }, follow: false, pendingHint: null }
  }
  if (scenario === 'quiet' && agents[1]) {
    return {
      mode: { kind: 'share', owner: { kind: 'team' }, surface: 'terminal' },
      follow: false,
      pendingHint: { agentId: agents[1].id, surface: 'code', at: at(1) }
    }
  }
  return { mode: { kind: 'gallery' }, follow: true, pendingHint: null }
}

function mockMessages(): Message[] {
  const base = {
    roomId: ROOM_ID,
    clientRequestId: 'mock',
    to: [] as string[]
  }
  return [
    {
      ...base,
      id: 'm-human-1',
      author: { type: 'human' },
      body: 'Vote counts must never leave the machine. Check the network payload, not just the screen.',
      createdAt: at(24),
      kind: 'chat'
    },
    {
      ...base,
      id: 'm-sam-1',
      author: { type: 'agent', agentId: 'agent-sam' },
      body: 'Before I test that: is the vote count supposed to sync to the room at all, or stay local to each person?',
      createdAt: at(22),
      kind: 'question',
      spoken: { generationId: 'gen-3', state: 'played', playedChars: 118 }
    },
    {
      ...base,
      id: 'm-human-2',
      author: { type: 'human' },
      body: 'Local only. Totals can sync, individual votes never do.',
      createdAt: at(21),
      kind: 'answer',
      replyToId: 'm-sam-1'
    },
    {
      ...base,
      id: 'm-alex-1',
      author: { type: 'agent', agentId: 'agent-alex' },
      body: 'Interface settled then: POST /votes takes {themeId, value} and the server returns only a total. Maya, that is the shape.',
      createdAt: at(19),
      kind: 'handoff',
      to: ['agent-maya'],
      spoken: { generationId: 'gen-4', state: 'interrupted', playedChars: 64 }
    },
    {
      ...base,
      id: 'm-decision-1',
      author: { type: 'agent', agentId: 'agent-alex' },
      body: 'Recorded: individual votes stay on the device; only totals cross the network.',
      createdAt: at(18),
      kind: 'decision',
      spoken: { generationId: 'gen-5', state: 'played', playedChars: 96 }
    },
    {
      ...base,
      id: 'm-maya-2',
      author: { type: 'agent', agentId: 'agent-maya' },
      body: 'The vote count only exists in local storage, so the panel has nothing to send. I am moving the totals out of the websocket payload now.',
      createdAt: at(4),
      kind: 'chat',
      refs: [
        { kind: 'file', path: 'C:\\dev\\sketch-night\\src\\VotePanel.tsx', startLine: 41, endLine: 58 },
        { kind: 'task', taskId: 'task-2' }
      ]
    },
    {
      ...base,
      id: 'm-sam-2',
      author: { type: 'agent', agentId: 'agent-sam' },
      body: 'Reproduced: 3 of 12 votes were posted to /sync in the current build. Screenshot attached, and the payload is in the browser surface.',
      createdAt: at(3),
      kind: 'result',
      refs: [{ kind: 'screenshot', artifactId: 'art-1', rect: { x: 320, y: 180, width: 640, height: 360 }, viewport: { width: 1280, height: 800 }, url: 'http://localhost:5180/vote' }],
      spoken: { generationId: 'gen-6', state: 'unheard', playedChars: 0 }
    },
    {
      ...base,
      id: 'm-private-1',
      author: { type: 'agent', agentId: 'agent-alex' },
      body: 'Between us: the sync endpoint still accepts a full vote list. Want me to close it off after Sam retests?',
      createdAt: at(2),
      kind: 'chat',
      private: { agentId: 'agent-alex' }
    },
    {
      ...base,
      id: 'm-system-1',
      author: { type: 'system' },
      body: 'Alex created the team workspace from Maya’s branch at 4f21c9d.',
      createdAt: at(2),
      kind: 'system'
    }
  ]
}

function mockTasks(): Task[] {
  const human = { type: 'human' as const }
  return [
    {
      id: 'task-1',
      roomId: ROOM_ID,
      title: 'Keep individual votes out of the sync payload',
      detail: 'Only the aggregate total may be posted to /sync.',
      ownerAgentId: 'agent-maya',
      createdBy: human,
      status: 'in_progress',
      dependsOn: [],
      acceptance: ['No per-vote id in the request body', 'Totals still update live'],
      decisionRevision: 4,
      staleSince: null,
      staleReason: null,
      blockedReason: null,
      evidence: [],
      createdAt: at(20),
      updatedAt: at(3)
    },
    {
      id: 'task-2',
      roomId: ROOM_ID,
      title: 'Retest the vote flow against revision 4f21c9d',
      detail: 'Check the network tab as well as the rendered count.',
      ownerAgentId: 'agent-sam',
      createdBy: { type: 'agent', agentId: 'agent-alex' },
      status: 'blocked',
      dependsOn: ['task-1'],
      acceptance: ['Zero vote ids in the payload', 'Screenshot of the network entry'],
      decisionRevision: 4,
      staleSince: null,
      staleReason: null,
      blockedReason: 'Waiting for Maya to land the payload change.',
      evidence: [{ kind: 'artifact', artifactId: 'art-1' }],
      createdAt: at(18),
      updatedAt: at(3)
    },
    {
      id: 'task-3',
      roomId: ROOM_ID,
      title: 'Integrate Maya and Alex branches into the team workspace',
      detail: 'Run the full check set and report the verified revision honestly.',
      ownerAgentId: 'agent-alex',
      createdBy: human,
      status: 'awaiting_review',
      dependsOn: ['task-1'],
      acceptance: ['build passes', 'tests pass'],
      decisionRevision: 4,
      staleSince: null,
      staleReason: null,
      blockedReason: null,
      evidence: [{ kind: 'job', jobId: 'job-1', fromLine: 12, toLine: 30 }],
      createdAt: at(16),
      updatedAt: at(1)
    },
    {
      id: 'task-4',
      roomId: ROOM_ID,
      title: 'Write the offline behaviour into the room notes',
      detail: 'Short entry covering what happens with no network.',
      ownerAgentId: 'agent-sam',
      createdBy: { type: 'agent', agentId: 'agent-maya' },
      status: 'done',
      dependsOn: [],
      acceptance: ['Entry references the decision revision'],
      decisionRevision: 3,
      staleSince: at(18),
      staleReason: 'Decision v4 changed what is syncable.',
      blockedReason: null,
      evidence: [{ kind: 'artifact', artifactId: 'art-2' }],
      createdAt: at(30),
      updatedAt: at(15)
    }
  ]
}

function mockDecisions(): Decision[] {
  return [
    {
      id: 'dec-2',
      roomId: ROOM_ID,
      revision: 4,
      title: 'Individual votes stay on the device',
      statement: 'Only aggregate totals are posted to /sync; a vote id never leaves the browser.',
      rationale: 'The room treats per-person voting data as private by default.',
      source: { type: 'human' },
      status: 'active',
      supersedesId: 'dec-1',
      supersededById: null,
      affectedTaskIds: ['task-1', 'task-2'],
      originMessageId: 'm-decision-1',
      createdAt: at(18)
    },
    {
      id: 'dec-1',
      roomId: ROOM_ID,
      revision: 3,
      title: 'Votes sync to the room over the websocket',
      statement: 'Every vote is broadcast so all clients count identically.',
      rationale: 'Simplest way to keep the totals in step.',
      source: { type: 'agent', agentId: 'agent-alex' },
      status: 'superseded',
      supersedesId: null,
      supersededById: 'dec-2',
      affectedTaskIds: ['task-4'],
      originMessageId: null,
      createdAt: at(30)
    }
  ]
}

function mockWorkspaces(agents: Agent[]): WorkspaceRecord[] {
  const base: WorkspaceRecord = {
    id: 'ws-team',
    roomId: ROOM_ID,
    agentId: null,
    kind: 'team',
    label: 'Team',
    rootPath: 'C:\\dev\\sketch-night',
    branch: 'main',
    baseBranch: 'main',
    isWorktree: false,
    devPort: 5180,
    devJobId: 'job-1',
    createdAt: at(230),
    lastVerifiedRevision: '4f21c9d8b1e4a7c25f0d3e6a9b8c7d6e5f4a3b2c'
  }
  const perAgent = agents.map<WorkspaceRecord>((agent, index) => ({
    id: `ws-${agent.presetId}`,
    roomId: ROOM_ID,
    agentId: agent.id,
    kind: 'agent',
    label: agent.name,
    rootPath: `C:\\dev\\.huddle\\worktrees\\${agent.presetId}`,
    branch: `huddle/${agent.presetId}/task-${index + 1}`,
    baseBranch: 'main',
    isWorktree: true,
    devPort: 5200 + index,
    devJobId: null,
    createdAt: at(200 - index),
    lastVerifiedRevision: index === 0 ? null : '9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b'
  }))
  return [base, ...perAgent]
}

function checks(): CheckResult[] {
  return [
    {
      name: 'typecheck',
      command: 'npm run typecheck',
      status: 'pass',
      exitCode: 0,
      output: 'tsc --noEmit\nno errors',
      durationMs: 18400
    },
    {
      name: 'unit tests',
      command: 'npm test',
      status: 'pass',
      exitCode: 0,
      output: '42 passing',
      durationMs: 9100
    },
    {
      name: 'build',
      command: 'npm run build',
      status: 'skipped',
      exitCode: null,
      output: '',
      durationMs: 0
    }
  ]
}

function mockIntegrations(): IntegrationAttempt[] {
  return [
    {
      id: 'int-2',
      roomId: ROOM_ID,
      agentId: 'agent-alex',
      sources: [
        { agentId: 'agent-maya', branch: 'huddle/maya/task-1', commit: '4f21c9d8b1e4a7c25f0d3e6a9b8c7d6e5f4a3b2c' },
        { agentId: 'agent-sam', branch: 'huddle/sam/task-4', commit: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b' }
      ],
      targetBranch: 'main',
      status: 'verified',
      revision: '4f21c9d8b1e4a7c25f0d3e6a9b8c7d6e5f4a3b2c',
      checks: checks(),
      conflicts: [],
      decisionRevision: 4,
      detail: 'Applied 2 branches cleanly. Typecheck and unit tests passed at 4f21c9d.',
      startedAt: at(9),
      endedAt: at(6)
    },
    {
      id: 'int-1',
      roomId: ROOM_ID,
      agentId: 'agent-alex',
      sources: [{ agentId: 'agent-maya', branch: 'huddle/maya/task-1', commit: '77aa11bb22cc33dd44ee55ff66aa77bb88cc99dd' }],
      targetBranch: 'main',
      status: 'checks_failed',
      revision: '77aa11bb22cc33dd44ee55ff66aa77bb88cc99dd',
      checks: [
        {
          name: 'unit tests',
          command: 'npm test',
          status: 'fail',
          exitCode: 1,
          output: 'FAIL src/vote.test.ts\n  expected 3 to be 2',
          durationMs: 8700
        }
      ],
      conflicts: ['src/VotePanel.tsx'],
      decisionRevision: 3,
      detail: 'Two new votes were posted per click. Handed back to Maya.',
      startedAt: at(34),
      endedAt: at(31)
    }
  ]
}

function mockArtifacts(): Artifact[] {
  return [
    {
      id: 'art-1',
      roomId: ROOM_ID,
      agentId: 'agent-sam',
      taskId: 'task-2',
      kind: 'screenshot',
      title: 'Sync request carrying three vote ids',
      path: 'C:\\dev\\.huddle\\artifacts\\art-1.png',
      mime: 'image/png',
      bytes: 184320,
      createdAt: at(3)
    },
    {
      id: 'art-2',
      roomId: ROOM_ID,
      agentId: 'agent-sam',
      taskId: 'task-4',
      kind: 'report',
      title: 'Offline behaviour notes',
      path: 'C:\\dev\\.huddle\\artifacts\\art-2.md',
      mime: 'text/markdown',
      bytes: 2048,
      createdAt: at(15)
    }
  ]
}

function mockJobs(): JobRecord[] {
  return [
    {
      id: 'job-1',
      roomId: ROOM_ID,
      agentId: 'agent-alex',
      workspaceId: 'ws-team',
      label: 'dev server',
      command: 'npm run dev -- --port 5180',
      cwd: 'C:\\dev\\sketch-night',
      status: 'running',
      exitCode: null,
      pid: 20488,
      startedAt: at(12),
      endedAt: null,
      lastObservedAt: at(0),
      truncated: false,
      port: 5180
    },
    {
      id: 'job-2',
      roomId: ROOM_ID,
      agentId: 'agent-sam',
      workspaceId: 'ws-sam',
      label: 'unit tests',
      command: 'npm test -- vote',
      cwd: 'C:\\dev\\.huddle\\worktrees\\sam',
      status: 'failed',
      exitCode: 1,
      pid: null,
      startedAt: at(20),
      endedAt: at(19),
      lastObservedAt: at(19),
      truncated: false,
      port: null
    }
  ]
}

function mockBrowserSessions(): BrowserSessionRecord[] {
  return [
    {
      id: 'br-1',
      roomId: ROOM_ID,
      agentId: 'agent-sam',
      provider: 'browserbase',
      remoteId: 'bb-session-9f2',
      liveViewUrl: 'https://browserbase.example/live/9f2',
      status: 'live',
      currentUrl: 'http://localhost:5180/vote',
      title: 'Sketch Night — Vote',
      startedAt: at(7),
      endedAt: null,
      error: null,
      detail: 'Driving the vote flow against the team preview.'
    }
  ]
}

function mockActions(): CallActions {
  return {
    createRoom: async () => {},
    selectRoom: async () => {},
    removeRoom: async () => {},
    renameRoom: async () => {},
    setGoal: async () => {},
    joinCall: async () => {},
    leaveCall: async () => {},
    toggleMic: async () => {},
    toggleDeafen: async () => {},
    stopSpeaking: async () => {},
    addAgent: async () => {},
    removeAgent: async () => {},
    setAgentVoice: async () => {},
    sendMessage: async () => {},
    setStage: async () => {},
    showGallery: async () => {},
    showShare: async () => {},
    openSpotlight: async () => {},
    setFollow: async () => {},
    chooseProject: async () => {},
    useDemoProject: async () => {},
    recordDecision: async () => {},
    pauseWork: async () => {},
    resumeWork: async () => {},
    cancelTask: async () => {},
    retryTask: async () => {},
    runIntegration: async () => {},
    cancelJob: async () => {},
    resumeItem: async () => {},
    dismissResumable: async () => {},
    updateSettings: async () => {},
    setSecret: async () => {},
    refreshCapabilities: async () => {},
    previewVoice: async () => {},
    revealPath: async () => {}
  }
}

const SCENARIOS: Array<{ id: PreviewScenario; label: string }> = [
  { id: 'meeting', label: 'Live meeting' },
  { id: 'quiet', label: 'Pinned + degraded' },
  { id: 'spotlight', label: 'One-on-one' },
  { id: 'empty', label: 'New room' }
]

/** The dev harness: scenario switch above the real CallScreen. */
export function PreviewApp(): JSX.Element {
  const [scenario, setScenario] = useState<PreviewScenario>('meeting')
  const props = buildMockProps(scenario)

  return (
    <div className="hs-preview">
      <div className="hs-preview-bar">
        <strong>Dev preview</strong>
        <span>mock snapshot, nothing here is wired to the backend</span>
        <span className="hs-preview-bar-actions">
          {SCENARIOS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`hs-btn hs-btn--${scenario === item.id ? 'primary' : 'ghost'}`}
              onClick={() => setScenario(item.id)}
            >
              {item.label}
            </button>
          ))}
        </span>
      </div>
      <div className="hs-preview-stage">
        <CallScreen {...props} />
      </div>
    </div>
  )
}
