import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ContextRef, Message, ShareSurface } from '../../../shared/types'
import { HUMAN_AVATAR, HUMAN_COLOR } from '../../../shared/presets'
import type { CallScreenProps } from '../state/view-model'
import type { ComposerModel } from './Composer'
import { Dock } from './Dock'
import {
  activeAgents,
  connectionStatus,
  findAgent,
  retainedTeamMessages,
  teamWorkspace
} from './derive'
import { surfaceLabel } from './format'
import { Rail, type RailTab } from './Rail'
import { SettingsDialog } from './SettingsDialog'
import { Sidebar } from './Sidebar'
import { Stage } from './Stage'
import { useNow } from './ui'

/**
 * The call screen shell.
 *
 * It owns only view concerns: which stage is showing, whether the room panel is
 * open, the draft in the composer and which dialog is up. All truth comes from
 * props, and every mutation goes through `props.actions`.
 */

export function CallShell(props: CallScreenProps): JSX.Element {
  const {
    room,
    rooms,
    agents: roomAgents,
    messages,
    tasks,
    decisions,
    jobs,
    workspaces,
    artifacts,
    integrations,
    capabilities,
    resumable,
    notices,
    settings,
    call,
    human,
    liveTranscript,
    speaking,
    error,
    actions,
    snapshot
  } = props

  const now = useNow(15000)
  const [railOpen, setRailOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTab] = useState<RailTab>('chat')

  // Composer draft. Owned here so questions, refs and replies can prefill it.
  const [body, setBody] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [refs, setRefs] = useState<ContextRef[]>([])
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [privateTo, setPrivateTo] = useState<string | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const [sending, setSending] = useState(false)

  const agents = useMemo(() => activeAgents(roomAgents), [roomAgents])
  const connection = connectionStatus(call, room)
  const mode = room.stage.mode
  const spotlightAgent = mode.kind === 'spotlight' ? findAgent(agents, mode.agentId) : null
  const team = teamWorkspace(workspaces)
  const retainedMessages = useMemo(() => retainedTeamMessages(snapshot), [snapshot])

  const replyTo = replyToId ? messages.find((item) => item.id === replyToId) ?? null : null

  const stageLabel =
    mode.kind === 'gallery'
      ? 'Gallery'
      : mode.kind === 'share'
        ? `${mode.owner.kind === 'team' ? 'Team workspace' : `${findAgent(agents, mode.owner.agentId)?.name ?? 'Teammate'}'s workspace`} · ${surfaceLabel(mode.surface)}`
        : `One-on-one · ${spotlightAgent?.name ?? 'teammate'}`

  /** Private scope follows the spotlight, so a 1:1 stays 1:1. */
  useEffect(() => {
    setPrivateTo(spotlightAgent ? spotlightAgent.id : null)
  }, [spotlightAgent])

  /** A room switch drops anything bound to the previous room. */
  const lastRoomId = useRef(room.id)
  useEffect(() => {
    if (lastRoomId.current === room.id) return
    lastRoomId.current = room.id
    setRefs([])
    setReplyToId(null)
    setTargets([])
  }, [room.id])

  const attachRef = (ref: ContextRef): void => {
    setRefs((current) => {
      const key = JSON.stringify(ref)
      return current.some((item) => JSON.stringify(item) === key) ? current : [...current, ref]
    })
    setRailOpen(true)
    if (tab !== 'chat' && tab !== 'ask') setTab('chat')
    setFocusToken((token) => token + 1)
  }

  const send = (): void => {
    const text = body.trim()
    if (!text || sending) return
    setSending(true)
    const options: { to?: string[]; refs?: ContextRef[]; replyToId?: string; privateTo?: string } = {}
    if (targets.length > 0) options.to = targets
    if (refs.length > 0) options.refs = refs
    if (replyToId) options.replyToId = replyToId
    if (privateTo) options.privateTo = privateTo
    void actions
      .sendMessage(text, options)
      .then(() => {
        setBody('')
        setRefs([])
        setReplyToId(null)
      })
      .catch(() => {
        // The action publishes the failure; retain the entire draft for retry.
      })
      .finally(() => setSending(false))
  }

  const composer: ComposerModel = {
    body,
    setBody,
    targets,
    setTargets,
    refs,
    removeRef: (index) => setRefs((current) => current.filter((_, at) => at !== index)),
    replyTo,
    clearReply: () => setReplyToId(null),
    privateTo,
    setPrivateTo,
    spotlightAgentId: spotlightAgent?.id ?? null,
    focusToken,
    send,
    sending
  }

  const replyToMessage = (message: Message): void => {
    setReplyToId(message.id)
    setFocusToken((token) => token + 1)
    setRailOpen(true)
    setTab('chat')
  }

  const openRef = (ref: ContextRef, surface: ShareSurface): void => {
    if (ref.kind === 'task' || ref.kind === 'decision') {
      setRailOpen(true)
      setTab(ref.kind === 'task' ? 'work' : 'decisions')
      return
    }
    props.onOpenRef(ref, surface)
  }

  const openSpotlight = (agentId: string): void => {
    void actions.openSpotlight(agentId, mode.kind === 'share' ? mode.surface : 'code')
  }

  /** Keyboard equivalents for the dock controls, guarded by the same rules. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if (event.key === 'Escape' && !typing && !settingsOpen) {
        if (room.stage.mode.kind !== 'gallery') {
          event.preventDefault()
          void actions.showGallery()
        }
        return
      }

      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()

      if (key === ',' && !event.shiftKey) {
        event.preventDefault()
        setSettingsOpen(true)
        return
      }
      if (!event.shiftKey) return

      if (key === 'm') {
        if (!connection.live) return
        event.preventDefault()
        void actions.toggleMic()
        return
      }
      if (key === 'd') {
        if (!connection.live) return
        event.preventDefault()
        void actions.toggleDeafen()
        return
      }
      if (key === 'g') {
        event.preventDefault()
        void actions.showGallery()
        return
      }
      if (key === 'e') {
        event.preventDefault()
        setRailOpen((open) => !open)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    actions,
    connection.live,
    room.stage.mode.kind,
    settingsOpen
  ])

  const joinDisabledReason =
    call.connection === 'connecting' ? 'Huddle is already connecting this room.' : null

  return (
    <div className={`hs-app${railOpen ? '' : ' is-rail-closed'}`}>
      <Sidebar
        room={room}
        rooms={rooms}
        agents={agents}
        human={human}
        call={call}
        connection={connection}
        speaking={speaking}
        queuedAgentIds={call.queuedAgentIds}
        retainedTeamMessages={retainedMessages}
        project={room.project}
        creating={false}
        now={now}
        onSelectRoom={(roomId) => void actions.selectRoom(roomId)}
        onCreateRoom={() => void actions.createRoom()}
        onRemoveRoom={(roomId) => void actions.removeRoom(roomId)}
        onOpenSpotlight={openSpotlight}
        onOpenSettings={() => setSettingsOpen(true)}
        onChooseProject={() => void actions.chooseProject()}
        onUseDemoProject={() => void actions.useDemoProject()}
        onRevealPath={(path) => void actions.revealPath(path)}
      />

      <main className="hs-main">
        <Stage
          room={room}
          agents={agents}
          workspaces={workspaces}
          tasks={tasks}
          decisions={decisions}
          integrations={integrations}
          speaking={speaking}
          queuedAgentIds={call.queuedAgentIds}
          human={human}
          call={call}
          connection={connection}
          now={now}
          label={stageLabel}
          humanAvatar={HUMAN_AVATAR}
          humanColor={HUMAN_COLOR}
          onJoin={() => void actions.joinCall()}
          onLeave={() => void actions.leaveCall()}
          joinDisabledReason={joinDisabledReason}
          onOpenSpotlight={openSpotlight}
          onShowShare={(owner, surface) => void actions.showShare(owner, surface)}
          onShowGallery={() => void actions.showGallery()}
          onSetStage={(stage) => void actions.setStage(stage)}
          onRenameRoom={(name) => void actions.renameRoom(name)}
          onSetGoal={(goal) => void actions.setGoal(goal)}
          onPauseWork={(agentId) => void actions.pauseWork(agentId)}
          onResumeWork={(agentId) => void actions.resumeWork(agentId)}
          onRemoveAgent={(agentId) => void actions.removeAgent(agentId)}
          onPreviewVoice={(voiceId) => void actions.previewVoice(voiceId)}
          onReveal={(path) => void actions.revealPath(path)}
          onRunIntegration={() => void actions.runIntegration()}
          onChooseProject={() => void actions.chooseProject()}
          onUseDemoProject={() => void actions.useDemoProject()}
          onCancelTask={(taskId) => void actions.cancelTask(taskId)}
          onRetryTask={(taskId) => void actions.retryTask(taskId)}
          renderSurface={props.renderSurface}
          onAttachRef={attachRef}
        />

        <Dock
          room={room}
          agents={agents}
          call={call}
          human={human}
          connection={connection}
          liveTranscript={liveTranscript}
          stage={room.stage}
          railOpen={railOpen}
          teamWorkspaceLabel={team ? team.label : null}
          onJoin={() => void actions.joinCall()}
          onLeave={() => void actions.leaveCall()}
          onToggleMic={() => void actions.toggleMic()}
          onToggleDeafen={() => void actions.toggleDeafen()}
          onStopSpeaking={(scope) => void actions.stopSpeaking(scope)}
          onAddAgent={(presetId, options) => actions.addAgent(presetId, options)}
          onShowGallery={() => void actions.showGallery()}
          onShowTeamShare={() => void actions.showShare({ kind: 'team' }, mode.kind === 'share' ? mode.surface : 'code')}
          onSetFollow={(follow) => void actions.setFollow(follow)}
          onToggleRail={() => setRailOpen((open) => !open)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </main>

      {railOpen ? (
        <Rail
          room={room}
          agents={agents}
          messages={messages}
          tasks={tasks}
          decisions={decisions}
          artifacts={artifacts}
          jobs={jobs}
          integrations={integrations}
          resumable={resumable}
          notices={notices}
          error={error}
          speaking={speaking}
          call={call}
          human={human}
          liveTranscript={liveTranscript}
          now={now}
          composer={composer}
          spotlightAgent={spotlightAgent}
          tab={tab}
          onTab={setTab}
          onClose={() => setRailOpen(false)}
          onReplyTo={replyToMessage}
          onAnswer={(question) => {
            replyToMessage(question)
            setTab('ask')
          }}
          onOpenRef={openRef}
          onOpenAgent={openSpotlight}
          onRecordDecision={(input) => actions.recordDecision(input)}
          onStopSpeaking={(scope) => void actions.stopSpeaking(scope)}
          onRevealPath={(path) => void actions.revealPath(path)}
          onCancelJob={(jobId) => void actions.cancelJob(jobId)}
          onResumeItem={(itemId) => void actions.resumeItem(itemId)}
          onDismissResumable={(itemId) => void actions.dismissResumable(itemId)}
          onRunIntegration={() => void actions.runIntegration()}
          onAttachRef={attachRef}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          capabilities={capabilities}
          agents={agents}
          project={room.project}
          now={now}
          onClose={() => setSettingsOpen(false)}
          onUpdate={(patch) => actions.updateSettings(patch)}
          onSetSecret={(key, value) => actions.setSecret(key, value)}
          onRefreshCapabilities={() => void actions.refreshCapabilities()}
          onPreviewVoice={(voiceId) => void actions.previewVoice(voiceId)}
          onSetAgentVoice={(agentId, voiceId) => void actions.setAgentVoice(agentId, voiceId)}
          onRevealPath={(path) => void actions.revealPath(path)}
          onChooseProject={() => void actions.chooseProject()}
          onUseDemoProject={() => void actions.useDemoProject()}
        />
      ) : null}
    </div>
  )
}
