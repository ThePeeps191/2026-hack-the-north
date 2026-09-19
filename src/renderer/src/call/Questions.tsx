import type { JSX } from 'react'
import type { Agent, Message, ShareSurface, ContextRef } from '../../../shared/types'
import { AvatarMark } from './avatars'
import { RefChip } from './Chat'
import { findAgent } from './derive'
import { authorName, formatClock, formatDateTime } from './format'
import { Badge, Button, Empty } from './ui'

/**
 * Questions the team is waiting on.
 *
 * A question disappears from this list only when a message actually answers it
 * (a real reply target), never because it was read.
 */

export interface QuestionsProps {
  questions: Message[]
  agents: Agent[]
  answeringId: string | null
  onAnswer: (question: Message) => void
  onOpenRef: (ref: ContextRef, surface: ShareSurface) => void
}

export function Questions({
  questions,
  agents,
  answeringId,
  onAnswer,
  onOpenRef
}: QuestionsProps): JSX.Element {
  if (questions.length === 0) {
    return (
      <Empty
        title="No open questions"
        detail="Nothing in this room is waiting on your answer right now."
      />
    )
  }

  return (
    <ul className="hs-questions">
      {questions.map((question) => {
        const agent =
          question.author.type === 'agent' ? findAgent(agents, question.author.agentId) : null
        const answering = answeringId === question.id
        return (
          <li key={question.id} className={`hs-question${answering ? ' is-answering' : ''}`}>
            <header className="hs-question-head">
              <AvatarMark
                avatar={agent?.avatar ?? 'huddle'}
                color={agent?.color ?? 'var(--accent)'}
                size={22}
              />
              <span className="hs-question-who">{authorName(question.author, agents)}</span>
              <Badge tone="accent">Question</Badge>
              <span className="hs-question-time" title={formatDateTime(question.createdAt)}>
                {formatClock(question.createdAt)}
              </span>
            </header>
            <p className="hs-question-body" title={question.body}>
              {question.body}
            </p>
            {question.refs && question.refs.length > 0 ? (
              <p className="hs-question-chips">
                {question.refs.map((ref, index) => (
                  <RefChip
                    key={`${question.id}-${index}`}
                    refItem={ref}
                    agents={agents}
                    tasks={[]}
                    decisions={[]}
                    artifacts={[]}
                    onOpenRef={onOpenRef}
                  />
                ))}
              </p>
            ) : null}
            <footer className="hs-question-foot">
              {answering ? (
                <span className="hs-question-hint" title="The composer is set to reply to this question">
                  <Badge tone="live">Replying in the composer</Badge>
                </span>
              ) : (
                <Button
                  variant="primary"
                  hint="Puts this question in the composer as the reply target"
                  onClick={() => onAnswer(question)}
                >
                  Answer
                </Button>
              )}
            </footer>
          </li>
        )
      })}
    </ul>
  )
}
