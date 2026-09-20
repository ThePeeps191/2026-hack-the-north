import type { Agent, BrowserSessionRecord, JobRecord, Task, ToolRun } from '../../../shared/types'

/**
 * What a teammate's screen shows.
 *
 * A call tile that holds a name and a status word tells you nothing: the whole
 * claim of this product is that you can *see* what each teammate is doing. So
 * the tile renders the same thing a shoulder-surfer would see — the last few
 * real actions, the file or command they landed on, and the branch they are on.
 *
 * Everything here is read from records the backend already committed. Nothing
 * is inferred from model tokens, and a teammate that has done nothing shows an
 * empty screen rather than a plausible one.
 */

export type FeedTone = 'ok' | 'run' | 'bad'

export interface FeedLine {
  id: string
  /** Tool or command name, shown in the gutter. */
  action: string
  /** The thing it acted on: a path, a URL, a command, a task title. */
  target: string
  tone: FeedTone
  /** Short outcome, only when it adds something the target does not say. */
  note: string
}

export interface AgentScreen {
  /** The one line describing what is happening right now. */
  headline: string
  /** Where the work is: a file path, a URL, a command. Empty when unknown. */
  locus: string
  lines: FeedLine[]
  /** Real branch for this teammate's worktree, when it has one. */
  branch: string | null
  /** The task this teammate owns and is working on, when there is one. */
  task: string | null
  /** True when nothing real has happened yet. The tile then says so. */
  empty: boolean
}

const MAX_LINES = 6

/** Arguments are stored as a redacted JSON preview; pull the interesting value. */
function targetFromArgs(preview: string): string {
  if (!preview) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(preview)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const record = parsed as Record<string, unknown>
  for (const key of ['path', 'file', 'url', 'command', 'query', 'pattern', 'teammate', 'title', 'label']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function toneFor(status: ToolRun['status']): FeedTone {
  if (status === 'ok') return 'ok'
  if (status === 'error' || status === 'rejected') return 'bad'
  return 'run'
}

/** Trims a path to something readable in a narrow tile, keeping the filename. */
export function shortPath(path: string, max = 34): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (clean.length <= max) return clean
  const parts = clean.split('/')
  const file = parts[parts.length - 1] ?? clean
  if (file.length >= max) return `…${file.slice(-(max - 1))}`
  let out = file
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const next = `${parts[index]}/${out}`
    if (next.length > max - 1) return `…/${out}`
    out = next
  }
  return out
}

export function agentScreen(input: {
  agent: Agent
  toolRuns: ToolRun[]
  jobs: JobRecord[]
  browserSessions: BrowserSessionRecord[]
  tasks: Task[]
  branch: string | null
}): AgentScreen {
  const { agent } = input
  const mine = input.toolRuns.filter((run) => run.agentId === agent.id).slice(-MAX_LINES * 2)

  const lines: FeedLine[] = mine
    .slice(-MAX_LINES)
    .map((run) => {
      const target = targetFromArgs(run.argsPreview)
      return {
        id: run.id,
        action: run.name,
        target: target ? shortPath(target) : '',
        tone: toneFor(run.status),
        // The summary repeats the target more often than not; only keep it when
        // it carries something else, such as a failure or a count.
        note: run.status === 'ok' && target ? '' : run.error ?? run.summary
      }
    })
    .reverse()

  const runningJob = input.jobs
    .filter((job) => job.status === 'running' || job.status === 'starting')
    .slice(-1)[0]
  const session = input.browserSessions.find(
    (candidate) => candidate.id === agent.browserSessionId && candidate.status === 'live'
  )

  const task =
    input.tasks.find((candidate) => candidate.ownerAgentId === agent.id && candidate.status === 'in_progress') ??
    input.tasks.find(
      (candidate) =>
        candidate.ownerAgentId === agent.id &&
        candidate.status !== 'done' &&
        candidate.status !== 'cancelled' &&
        candidate.status !== 'failed'
    ) ??
    null

  // The locus is the most specific real place the work is happening. A live
  // browser or a running command outranks the last file that was touched.
  let locus = ''
  if (session?.currentUrl) locus = session.currentUrl
  else if (runningJob) locus = runningJob.command
  else {
    const lastTarget = [...mine].reverse().find((run) => targetFromArgs(run.argsPreview))
    if (lastTarget) locus = targetFromArgs(lastTarget.argsPreview)
  }

  return {
    headline: agent.activityLabel,
    locus: locus ? shortPath(locus, 44) : '',
    lines,
    branch: input.branch,
    task: task ? task.title : null,
    empty: lines.length === 0
  }
}
