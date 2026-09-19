/**
 * Who responds to a message.
 *
 * Deterministic on purpose: routing decides *whether* a turn happens and *which
 * single* teammate owns it, and it must stay explainable and cheap. It never
 * calls the model.
 *
 * Anti-spam rules encoded here:
 *  - a room-wide instruction goes to exactly one owner, never all three;
 *  - an agent's own message never routes back to that agent;
 *  - pure acknowledgements produce no turn at all;
 *  - agent messages without an explicit recipient produce nothing, so two
 *    teammates cannot ping-pong.
 */

import type { AgentRole, MessageAuthor, MessageKind, TaskStatus } from '../../shared/types.ts'

export interface RouterAgent {
  id: string
  name: string
  role: AgentRole
}

export interface RouterMessage {
  id: string
  body: string
  author: MessageAuthor
  to: string[]
  kind: MessageKind
  replyToId?: string
  private?: { agentId: string }
}

export interface RouterTask {
  id: string
  title: string
  status: TaskStatus
  ownerAgentId: string | null
}

export type RouteKind = 'conversation' | 'work' | 'handoff' | 'ignore'

export interface RouterDecision {
  kind: RouteKind
  /** Agent ids that should react. At most one for a room-wide instruction. */
  targets: string[]
  reason: string
  /** Set when the message is clearly about a task already in the graph. */
  taskId: string | null
}

export interface RouterInput {
  message: RouterMessage
  agents: RouterAgent[]
  tasks: RouterTask[]
  /** Recent messages, oldest first. Used for reply and target resolution. */
  recent: RouterMessage[]
  /** Agents currently running a work loop. */
  busyAgentIds?: string[]
}

const WORK_VERBS = new Set([
  'add',
  'build',
  'change',
  'check',
  'confirm',
  'connect',
  'create',
  'delete',
  'deploy',
  'document',
  'drop',
  'expose',
  'fix',
  'hook',
  'implement',
  'improve',
  'integrate',
  'make',
  'migrate',
  'patch',
  'port',
  'refactor',
  'remove',
  'rename',
  'replace',
  'review',
  'rewrite',
  'run',
  'scaffold',
  'ship',
  'split',
  'support',
  'test',
  'update',
  'verify',
  'wire',
  'write',
  // Investigation verbs: these need tools, so they start a real run rather than
  // a spoken aside. "What are you checking?" stays conversation because only
  // exact words are matched, not stems.
  'analyze',
  'analyse',
  'audit',
  'compare',
  'find',
  'inspect',
  'investigate',
  'list',
  'look',
  'measure',
  'open',
  'profile',
  'read',
  'search',
  'summarize',
  'trace'
])

const ROLE_KEYWORDS: Record<AgentRole, string[]> = {
  frontend: [
    'ui',
    'ux',
    'component',
    'components',
    'screen',
    'screens',
    'layout',
    'style',
    'styles',
    'styling',
    'css',
    'button',
    'buttons',
    'form',
    'modal',
    'animation',
    'react',
    'renderer',
    'page',
    'frontend',
    'polish',
    'responsive'
  ],
  systems: [
    'api',
    'server',
    'backend',
    'endpoint',
    'endpoints',
    'database',
    'db',
    'schema',
    'migration',
    'integration',
    'build',
    'deploy',
    'node',
    'config',
    'pipeline',
    'workspace',
    'git',
    'contract',
    'payload',
    'persistence'
  ],
  qa: [
    'test',
    'tests',
    'testing',
    'bug',
    'bugs',
    'broken',
    'regression',
    'verify',
    'verification',
    'reproduce',
    'repro',
    'check',
    'coverage',
    'failing',
    'failure',
    'skip',
    'privacy',
    'requirement',
    'requirements',
    'acceptance',
    'edge',
    'browser'
  ],
  research: [
    'document',
    'documentation',
    'docs',
    'research',
    'explain',
    'explanation',
    'summarise',
    'summarize',
    'summary',
    'notes',
    'readme',
    'guide',
    'sources',
    'compare',
    'reference'
  ],
  design: ['design', 'brand', 'colour', 'color', 'typography', 'logo', 'visual', 'icon', 'spacing'],
  general: ['help', 'general', 'anything', 'whatever', 'misc']
}

const ACK_PATTERN =
  /^(ok|okay|k|kk|thanks|thank you|got it|sounds good|cool|nice|sure|yes|yep|yeah|no|nope|hmm|alright|great|perfect|good|lgtm|agreed)\b[\s.!]*$/i

const QUESTION_STARTERS = new Set([
  'who',
  'what',
  'when',
  'where',
  'why',
  'how',
  'which',
  'are',
  'is',
  'do',
  'does',
  'did',
  'can',
  'could',
  'would',
  'should',
  'will',
  'any'
])

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 0)
}

export function isAcknowledgement(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed.length > 28) return false
  return ACK_PATTERN.test(trimmed)
}

export function isQuestion(body: string): boolean {
  const trimmed = body.trim()
  if (!trimmed) return false
  if (trimmed.endsWith('?')) return true
  const first = words(trimmed)[0]
  return first !== undefined && QUESTION_STARTERS.has(first)
}

export function hasWorkVerb(body: string): boolean {
  return words(body).some((word) => WORK_VERBS.has(word))
}

/** Stable key so an agent acknowledges a given assignment at most once. */
export function acknowledgementKey(messageId: string): string {
  return `ack:${messageId}`
}

function roleScore(agent: RouterAgent, tokens: string[]): number {
  const keywords = ROLE_KEYWORDS[agent.role] ?? []
  let score = 0
  for (const token of tokens) {
    if (keywords.includes(token)) score += 2
  }
  return score
}

function nameMentions(agents: RouterAgent[], tokens: string[], body: string): RouterAgent[] {
  const found: RouterAgent[] = []
  for (const agent of agents) {
    const name = agent.name.toLowerCase()
    if (tokens.includes(name)) {
      found.push(agent)
      continue
    }
    // "Maya," at the start of a message is a direct address.
    if (new RegExp(`^\\s*${name}\\b[\\s,:]`, 'i').test(body)) found.push(agent)
  }
  return found
}

interface OwnerPickInput {
  agents: RouterAgent[]
  tasks: RouterTask[]
  recent: RouterMessage[]
  body: string
  busyAgentIds: string[]
}

/** Picks the single most relevant owner for a room-wide message. */
export function pickOwner(input: OwnerPickInput): { agent: RouterAgent | null; reason: string } {
  const { agents, body } = input
  if (agents.length === 0) return { agent: null, reason: 'the room has no teammates yet' }

  const tokens = words(body)
  const named = nameMentions(agents, tokens, body)
  if (named.length === 1) {
    return { agent: named[0], reason: `${named[0].name} was addressed by name` }
  }

  const openTasks = input.tasks.filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'failed'
  )

  let best: RouterAgent | null = null
  // Start below any real score so a single busy teammate is still a candidate:
  // someone already working can always be *asked* something, even if they are
  // the wrong person to hand more work to.
  let bestScore = Number.NEGATIVE_INFINITY
  let bestWhy = 'the first available teammate'
  for (const agent of agents) {
    let score = roleScore(agent, tokens)
    let why = 'matched the area of the request'
    if (score === 0) why = 'no specific area matched'

    for (const task of openTasks) {
      if (task.ownerAgentId !== agent.id) continue
      const taskTokens = words(task.title)
      const overlap = taskTokens.filter((token) => tokens.includes(token)).length
      if (overlap > 0) {
        score += 3 + overlap
        why = `already owns "${task.title}"`
      }
    }
    const isBusy = input.busyAgentIds.includes(agent.id)
    score += isBusy ? -1 : 1

    if (score > bestScore) {
      best = agent
      bestScore = score
      bestWhy = why
    }
  }

  if (!best) return { agent: null, reason: 'no teammate was available' }
  const chosenIsBusy = input.busyAgentIds.includes(best.id)
  if (bestScore <= 0) {
    return {
      agent: best,
      reason: chosenIsBusy
        ? `only ${best.name} is here and already working`
        : `no area matched, so ${best.name} (first available) took it`
    }
  }
  return {
    agent: best,
    reason: chosenIsBusy ? `${bestWhy} — ${best.name} is already working` : bestWhy
  }
}

export function routeMessage(input: RouterInput): RouterDecision {
  const { message, agents } = input
  const body = message.body.trim()
  if (!body) return { kind: 'ignore', targets: [], reason: 'empty message', taskId: null }

  const known = (ids: string[]): string[] =>
    ids.filter((id) => agents.some((agent) => agent.id === id))

  if (message.author.type === 'system') {
    return { kind: 'ignore', targets: [], reason: 'system messages never start a turn', taskId: null }
  }

  if (message.author.type === 'agent') {
    const speaker = message.author.agentId
    const recipients = known(message.to).filter((id) => id !== speaker)
    if (recipients.length === 0) {
      return {
        kind: 'ignore',
        targets: [],
        reason: 'an agent message with no explicit recipient would be a loop',
        taskId: null
      }
    }
    return {
      kind: 'handoff',
      targets: recipients,
      reason: 'explicitly addressed to a teammate',
      taskId: null
    }
  }

  const busy = input.busyAgentIds ?? []
  const work = hasWorkVerb(body)

  if (message.private) {
    const target = message.private.agentId
    if (!known([target]).length) {
      return { kind: 'ignore', targets: [], reason: 'the private channel target left the room', taskId: null }
    }
    return {
      kind: work ? 'work' : 'conversation',
      targets: [target],
      reason: 'private one-on-one message',
      taskId: matchTask(input, [target])
    }
  }

  const explicit = known(message.to)
  if (explicit.length > 0) {
    let targets = explicit
    if (explicit.length > 1 && work) {
      // A room-wide instruction never fans out to every teammate.
      const pick = pickOwner({
        agents,
        tasks: input.tasks,
        recent: input.recent,
        body,
        busyAgentIds: busy
      })
      targets = pick.agent ? [pick.agent.id] : [explicit[0]]
    }
    return {
      kind: work ? 'work' : 'conversation',
      targets,
      reason: work ? 'addressed to an owner with something to do' : 'addressed directly',
      taskId: matchTask(input, targets)
    }
  }

  if (message.replyToId) {
    const parent = input.recent.find((item) => item.id === message.replyToId)
    if (parent && parent.author.type === 'agent') {
      const speaker = parent.author.agentId
      if (agents.some((agent) => agent.id === speaker)) {
        return {
          kind: work ? 'work' : 'conversation',
          targets: [speaker],
          reason: 'reply to that teammate',
          taskId: matchTask(input, [speaker])
        }
      }
    }
  }

  if (!work && isAcknowledgement(body)) {
    return {
      kind: 'ignore',
      targets: [],
      reason: 'a bare acknowledgement needs no turn',
      taskId: null
    }
  }

  const pick = pickOwner({
    agents,
    tasks: input.tasks,
    recent: input.recent,
    body,
    busyAgentIds: busy
  })
  if (!pick.agent) {
    return { kind: 'ignore', targets: [], reason: pick.reason, taskId: null }
  }
  return {
    kind: work ? 'work' : 'conversation',
    targets: [pick.agent.id],
    reason: pick.reason,
    taskId: matchTask(input, [pick.agent.id])
  }
}

/** Best open task of these owners that the message seems to be about. */
function matchTask(input: RouterInput, targets: string[]): string | null {
  const tokens = words(input.message.body)
  let best: string | null = null
  let bestScore = 0
  for (const task of input.tasks) {
    if (task.ownerAgentId && !targets.includes(task.ownerAgentId)) continue
    if (task.status === 'done' || task.status === 'cancelled') continue
    const overlap = words(task.title).filter((token) => tokens.includes(token)).length
    if (overlap > bestScore) {
      bestScore = overlap
      best = task.id
    }
  }
  return bestScore >= 2 ? best : null
}
