import { type JSX } from 'react'
import type {
  Agent,
  Artifact,
  CallState,
  ContextRef,
  Decision,
  IntegrationAttempt,
  JobRecord,
  LiveTranscript,
  Message,
  ResumableItem,
  Room,
  ShareSurface,
  Task
} from '../../../shared/types'
import type { HumanPresence, NoticeItem, SpeakingState } from '../state/view-model'
import { Captions } from './Captions'
import { Chat } from './Chat'
import { Composer, type ComposerModel } from './Composer'
import { Decisions } from './Decisions'
import { pendingQuestions } from './derive'
import { Questions } from './Questions'
import { WorkPanel } from './WorkPanel'
import { Button, IconButton } from './ui'
import { AlertIcon, CloseIcon } from './icons'

/**
 * The right rail.
 *
 * Chat is secondary to the call, so the rail is narrow, quiet and scrolls on its
 * own: captions on top, then chat / questions / decisions / work evidence, then
 * the composer. In a one-on-one the rail becomes that teammate's private channel.
 */

export type RailTab = 'chat' | 'ask' | 'decisions' | 'work'

/**
 * Four sections, named and nothing else. Icons alongside the labels pushed this
 * row past the rail width and produced a horizontal scrollbar inside the
 * navigation, so the row is now a fitted segmented control that always fits.
 */
const TABS: Array<{ id: RailTab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'ask', label: 'Questions' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'work', label: 'Work' }
]

export interface RailProps {
  room: Room
  agents: Agent[]
  messages: Message[]
  tasks: Task[]
  decisions: Decision[]
  artifacts: Artifact[]
  jobs: JobRecord[]
  integrations: IntegrationAttempt[]
  resumable: ResumableItem[]
  notices: NoticeItem[]
  error: string | null
  speaking: Record<string, SpeakingState>
  call: CallState
  human: HumanPresence
  liveTranscript: LiveTranscript | null
  now: number
  composer: ComposerModel
  spotlightAgent: Agent | null
  tab: RailTab
  onTab: (tab: RailTab) => void
  onClose: () => void
  onReplyTo: (message: Message) => void
  onAnswer: (question: Message) => void
  onOpenRef: (ref: ContextRef, surface: ShareSurface) => void
  onOpenAgent: (agentId: string) => void
  onRecordDecision: (input: {
    title: string
    statement: string
    rationale?: string
    supersedesId?: string | null
  }) => Promise<void> | void
  onStopSpeaking: (scope: 'current' | 'all') => void
  onRevealPath: (path: string) => void
  onCancelJob: (jobId: string) => void
  onResumeItem: (itemId: string) => void
  onDismissResumable: (itemId: string) => void
  onRunIntegration: () => void
  onAttachRef: (ref: ContextRef) => void
}

export function Rail(props: RailProps): JSX.Element {
  const {
    room,
    agents,
    messages,
    tasks,
    decisions,
    artifacts,
    jobs,
    integrations,
    resumable,
    notices,
    error,
    speaking,
    call,
    human,
    liveTranscript,
    now,
    composer,
    spotlightAgent,
    tab,
    onTab,
    onClose,
    onReplyTo,
    onAnswer,
    onOpenRef,
    onOpenAgent,
    onRecordDecision,
    onStopSpeaking,
    onRevealPath,
    onCancelJob,
    onResumeItem,
    onDismissResumable,
    onRunIntegration,
    onAttachRef
  } = props

  const questions = pendingQuestions(messages)
  const activeDecisions = decisions.filter((decision) => decision.status === 'active')
  const counts: Record<RailTab, number> = {
    chat: 0,
    ask: questions.length,
    decisions: activeDecisions.length,
    work: artifacts.length + resumable.length
  }
  const newestNotice = notices.length > 0 ? notices[notices.length - 1] : null

  const tabClass = (id: RailTab): string =>
    `hs-rail-tab${tab === id ? ' is-selected' : ''}${counts[id] > 0 ? ' has-count' : ''}`

  return (
    <aside className="hs-rail" aria-label={spotlightAgent ? `One-on-one with ${spotlightAgent.name}` : 'Room panel'}>
      <header className="hs-rail-head">
        <div>
          <h2 className="hs-rail-title">
            {spotlightAgent ? `One-on-one · ${spotlightAgent.name}` : room.name}
          </h2>
          <p className="hs-rail-sub" title={spotlightAgent ? undefined : room.goal}>
            {spotlightAgent
              ? `Only you and ${spotlightAgent.name}`
              : `${agents.length} teammate${agents.length === 1 ? '' : 's'} in the room`}
          </p>
        </div>
        <IconButton
          label="Hide room panel"
          hint="Gives the stage the full width. Reopen it from the dock."
          onClick={onClose}
        >
          <CloseIcon size={15} />
        </IconButton>
      </header>

      <Captions
        agents={agents}
        messages={messages}
        speaking={speaking}
        call={call}
        human={human}
        liveTranscript={liveTranscript}
        onStopSpeaking={onStopSpeaking}
      />

      {error || newestNotice || resumable.length > 0 ? (
        <div className="hs-alerts" aria-live="polite">
          {error ? (
            <p className="hs-alert is-error" role="alert">
              <AlertIcon size={14} />
              <span>{error}</span>
            </p>
          ) : null}
          {newestNotice ? (
            <p className={`hs-alert is-${newestNotice.level}`}>
              <AlertIcon size={14} />
              <span>
                {newestNotice.text}
                {newestNotice.fix ? <em className="hs-alert-fix"> {newestNotice.fix}</em> : null}
              </span>
            </p>
          ) : null}
          {resumable.length > 0 ? (
            <p className="hs-alert is-warn">
              <AlertIcon size={14} />
              <span>
                {resumable.length} operation{resumable.length === 1 ? '' : 's'} stopped before
                finishing.
              </span>
              <Button variant="ghost" onClick={() => onTab('work')} hint="Shows them with resume and dismiss actions">
                Review
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}

      <nav
        className="hs-rail-tabs"
        role="tablist"
        aria-label="Room panel sections"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
          const index = TABS.findIndex((item) => item.id === tab)
          const next =
            event.key === 'ArrowRight'
              ? TABS[(index + 1) % TABS.length]
              : TABS[(index - 1 + TABS.length) % TABS.length]
          if (next) onTab(next.id)
        }}
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            className={tabClass(item.id)}
            onClick={() => onTab(item.id)}
            title={`${item.label}${counts[item.id] > 0 ? ` · ${counts[item.id]}` : ''}`}
          >
            <span className="hs-rail-tab-label">{item.label}</span>
            {counts[item.id] > 0 ? (
              <span
                className={`hs-rail-count${item.id === 'ask' && counts.ask > 0 ? ' is-accent' : ''}`}
              >
                {counts[item.id]}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="hs-rail-body">
        {tab === 'chat' ? (
          spotlightAgent ? (
            <Chat
              messages={messages}
              agents={agents}
              tasks={tasks}
              decisions={decisions}
              artifacts={artifacts}
              speaking={speaking}
              privateAgentId={spotlightAgent.id}
              emptyDetail={`Ask ${spotlightAgent.name} anything. The other teammates never receive these messages.`}
              onReplyTo={onReplyTo}
              onOpenRef={onOpenRef}
              onOpenAgent={onOpenAgent}
            />
          ) : (
            <Chat
              messages={messages}
              agents={agents}
              tasks={tasks}
              decisions={decisions}
              artifacts={artifacts}
              speaking={speaking}
              privateAgentId={null}
              emptyDetail="Say something to get the team moving, or ask one teammate for a status."
              onReplyTo={onReplyTo}
              onOpenRef={onOpenRef}
              onOpenAgent={onOpenAgent}
            />
          )
        ) : null}

        {tab === 'ask' ? (
          <Questions
            questions={questions}
            agents={agents}
            answeringId={composer.replyTo?.id ?? null}
            onAnswer={onAnswer}
            onOpenRef={onOpenRef}
          />
        ) : null}

        {tab === 'decisions' ? (
          <Decisions
            decisions={decisions}
            tasks={tasks}
            agents={agents}
            decisionRevision={room.decisionRevision}
            now={now}
            onRecord={onRecordDecision}
          />
        ) : null}

        {tab === 'work' ? (
          <WorkPanel
            agents={agents}
            artifacts={artifacts}
            jobs={jobs}
            integrations={integrations}
            resumable={resumable}
            notices={notices}
            now={now}
            onRevealPath={onRevealPath}
            onCancelJob={onCancelJob}
            onResumeItem={onResumeItem}
            onDismissResumable={onDismissResumable}
            onRunIntegration={onRunIntegration}
            onAttachRef={onAttachRef}
          />
        ) : null}
      </div>

      <Composer model={composer} agents={agents} />
    </aside>
  )
}
