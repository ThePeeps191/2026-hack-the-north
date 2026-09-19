/**
 * The tool registry.
 *
 * Every capability a teammate has is a tool here: read the workspace, write to
 * it, run a command, drive the remote browser, or talk to the rest of the team.
 * Three rules hold for all of them:
 *
 *  1. Filesystem work goes through `deps.exec`, which owns path scoping. The
 *     registry never touches the disk itself.
 *  2. Every call is recorded through `bus.recordToolRun` with a truthful status
 *     (`running` -> `ok | error | cancelled | rejected`) and a one-line summary
 *     that says what actually happened.
 *  3. Malformed arguments are `rejected`, with the validation message handed back
 *     to the model. Nothing is invented, ever — a tool that cannot do its job
 *     says so and stops.
 *
 * Concurrency is bounded per room by `settings.limits.maxConcurrentToolCalls`.
 */

import type { RecordDecisionInput } from '../../shared/api.ts'
import type {
  AgentWorkState,
  AppSettings,
  Capability,
  ContextRef,
  JobRecord,
  MemoryKind,
  ShareSurface,
  Task,
  TaskStatus,
  ToolRun,
  WorkspaceRecord
} from '../../shared/types.ts'
import { MAX_TOOL_OUTPUT_CHARS } from '../../shared/types.ts'
import type { BrowserActionInput, RuntimeDeps } from '../contracts.ts'
import { HuddleError, toErrorShape } from '../huddle-error.ts'
import { redact } from '../config/secrets.ts'
import type { ProviderToolDefinition } from './provider.ts'
import { plannedBefore, type TaskPatch } from './tasks.ts'
import type { BridgeTaskInput, ToolContext, ToolExecution, ToolOutcome } from './types.ts'
import { ArgReader, isRecord, type Validation } from './validate.ts'

/* ------------------------------------------------------------------ *
 * Schema helpers
 * ------------------------------------------------------------------ */

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

function str(description: string): Record<string, unknown> {
  return { type: 'string', description }
}

function num(description: string): Record<string, unknown> {
  return { type: 'number', description }
}

function bool(description: string): Record<string, unknown> {
  return { type: 'boolean', description }
}

function strList(description: string): Record<string, unknown> {
  return { type: 'array', items: { type: 'string' }, description }
}

/* ------------------------------------------------------------------ *
 * Tool definition shapes
 * ------------------------------------------------------------------ */

export interface ToolDefinition<A> {
  name: string
  description: string
  parameters: Record<string, unknown>
  validate(raw: unknown): Validation<A>
  run(args: A, ctx: ToolContext): Promise<ToolOutcome>
}

/** A tool with its argument type erased, which is what the registry stores. */
export interface ErasedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  validate(raw: unknown): Validation<unknown>
  run(args: unknown, ctx: ToolContext): Promise<ToolOutcome>
}

export function defineTool<A>(tool: ToolDefinition<A>): ErasedTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    validate: (raw: unknown) => tool.validate(raw),
    run: (args: unknown, ctx: ToolContext) => tool.run(args as A, ctx)
  }
}

/* ------------------------------------------------------------------ *
 * Concurrency guard
 * ------------------------------------------------------------------ */

/**
 * A counting semaphore with a replaceable limit, so a settings change takes
 * effect on the next call instead of requiring a restart.
 */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit)
    this.drain()
  }

  get inFlight(): number {
    return this.active
  }

  get queued(): number {
    return this.waiters.length
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    // Whoever woke us reserved the slot on our behalf, so we must not claim a
    // second one: doing that is how a "guard" silently doubles its own limit.
    return () => this.release()
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.active < this.limit) {
      const next = this.waiters.shift()
      if (!next) break
      // Reserve the slot now, before the waiter resumes, or every waiter woken
      // in this loop would see the same free slot and all of them would run.
      this.active += 1
      next()
    }
  }
}

/* ------------------------------------------------------------------ *
 * Activity + stage, derived from real tool calls
 * ------------------------------------------------------------------ */

export interface ToolCallDescription {
  state: AgentWorkState
  surface: ShareSurface | null
  label: string
}

function shortPath(args: Record<string, unknown>): string {
  const value = args['path'] ?? args['file'] ?? args['query'] ?? args['url'] ?? args['command']
  if (typeof value !== 'string' || !value.trim()) return ''
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > 48 ? `…${text.slice(-47)}` : text
}

/**
 * The activity label the tile shows while this call runs. Only real tool names
 * can produce a state here: nothing infers "testing" from model tokens.
 */
export function describeToolCall(name: string, args: unknown): ToolCallDescription {
  const record: Record<string, unknown> = isRecord(args) ? args : {}
  const detail = shortPath(record)
  const withDetail = (base: string): string => (detail ? `${base} ${detail}` : base)

  switch (name) {
    case 'list_files':
      return { state: 'reading', surface: 'files', label: withDetail('Listing') }
    case 'read_file':
      return { state: 'reading', surface: 'code', label: withDetail('Reading') }
    case 'search_text':
      return { state: 'reading', surface: 'code', label: withDetail('Searching for') }
    case 'inspect_diff':
      return { state: 'reading', surface: 'code', label: 'Inspecting the workspace diff' }
    case 'get_job_output':
    case 'wait_for_job':
      return { state: 'running', surface: 'terminal', label: 'Reading command output' }
    case 'list_tasks':
      return { state: 'thinking', surface: null, label: 'Reviewing the task board' }
    case 'list_decisions':
      return { state: 'thinking', surface: null, label: 'Reviewing decisions' }
    case 'read_browser_observation':
      return { state: 'browsing', surface: 'browser', label: 'Reading the page' }
    case 'write_file':
      return { state: 'editing', surface: 'code', label: withDetail('Writing') }
    case 'apply_patch':
      return { state: 'editing', surface: 'code', label: 'Applying a patch' }
    case 'run_command':
      return { state: 'running', surface: 'terminal', label: withDetail('Running') }
    case 'cancel_job':
      return { state: 'running', surface: 'terminal', label: 'Cancelling a job' }
    case 'start_preview':
      return { state: 'running', surface: 'browser', label: 'Starting the preview' }
    case 'browser_open':
      return { state: 'browsing', surface: 'browser', label: withDetail('Opening') }
    case 'browser_navigate':
      return { state: 'browsing', surface: 'browser', label: withDetail('Navigating to') }
    case 'browser_act':
      return { state: 'browsing', surface: 'browser', label: 'Interacting with the page' }
    case 'browser_screenshot':
      return { state: 'browsing', surface: 'browser', label: 'Capturing the page' }
    case 'browser_network':
      return { state: 'browsing', surface: 'browser', label: 'Checking network responses' }
    case 'message_teammate':
      return { state: 'waiting', surface: null, label: 'Messaging a teammate' }
    case 'ask_human':
      return { state: 'waiting', surface: null, label: 'Asking the human' }
    case 'create_task':
    case 'assign_task':
    case 'update_task':
      return { state: 'thinking', surface: null, label: 'Updating the task board' }
    case 'record_decision':
      return { state: 'thinking', surface: null, label: 'Recording a decision' }
    case 'record_memory':
      return { state: 'thinking', surface: null, label: 'Writing room memory' }
    case 'submit_work':
      return { state: 'running', surface: 'terminal', label: 'Submitting work' }
    case 'run_integration':
      return { state: 'integrating', surface: 'terminal', label: 'Integrating and checking' }
    case 'present_workspace':
      return { state: 'integrating', surface: 'files', label: 'Presenting the workspace' }
    default:
      return { state: 'thinking', surface: null, label: `Using ${name}` }
  }
}

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

function clip(text: string, max: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated: ${text.length - max} more characters]`
}

function previewArgs(raw: unknown): string {
  let encoded: string
  try {
    encoded = JSON.stringify(raw ?? {})
  } catch {
    encoded = '{}'
  }
  return redact(encoded).slice(0, 400)
}

function agentName(deps: RuntimeDeps, roomId: string, agentId: string | null): string {
  if (!agentId) return 'nobody'
  return deps.bus.getAgent(agentId)?.name ?? deps.bus.getAgents(roomId).find((a) => a.id === agentId)?.name ?? 'a teammate'
}

/** Resolve "Alex", "alex", an id, or an id prefix to an agent in this room. */
function resolveAgent(deps: RuntimeDeps, roomId: string, needle: string): { id: string; name: string } | null {
  const agents = deps.bus.getAgents(roomId)
  const wanted = needle.trim().toLowerCase()
  if (!wanted) return null
  const exact = agents.find(
    (agent) => agent.id === needle || agent.name.toLowerCase() === wanted || agent.presetId === wanted
  )
  if (exact) return { id: exact.id, name: exact.name }
  const partial = agents.find((agent) => agent.id.startsWith(needle) || agent.name.toLowerCase().startsWith(wanted))
  if (partial) return { id: partial.id, name: partial.name }
  return null
}

function resolveJob(deps: RuntimeDeps, roomId: string, jobId: string): JobRecord | null {
  const jobs = deps.bus.getJobs(roomId)
  return jobs.find((job) => job.id === jobId) ?? jobs.find((job) => job.id.startsWith(jobId)) ?? null
}

function currentSessionId(deps: RuntimeDeps, ctx: ToolContext, explicit: string): string {
  if (explicit) return explicit
  const agent = deps.bus.getAgent(ctx.agentId)
  return agent?.browserSessionId ?? ''
}

async function workspaceOf(ctx: ToolContext, preferTeam: boolean): Promise<WorkspaceRecord> {
  if (preferTeam) return ctx.bridge.teamWorkspace(ctx.roomId)
  const agent = ctx.deps.bus.getAgent(ctx.agentId)
  if (agent?.workspaceId) {
    const existing = ctx.deps.exec.getWorkspace(agent.workspaceId)
    if (existing) return existing
  }
  return ctx.bridge.ensureWorkspace(ctx.roomId, ctx.agentId)
}

function requireProject(ctx: ToolContext): string | null {
  const room = ctx.deps.bus.getRoom(ctx.roomId)
  if (!room?.project) {
    return 'No project folder is bound to this room yet, so there is nothing to work in. Use ask_human to ask the human to bind a project folder (or pick the demo template) and continue once it is bound.'
  }
  return null
}

/**
 * Honest degradation: when a provider capability is not ready, the tool says so
 * with the concrete fix instead of failing somewhere deeper.
 */
function capabilityGap(ctx: ToolContext, id: Capability['id']): string | null {
  const capability = ctx.deps.capability(id)
  if (capability.state === 'ready' || capability.state === 'starting') return null
  const fix = capability.fix ? ` ${capability.fix}` : ''
  return `${capability.label} is not available right now (${capability.detail}).${fix}`
}

/* ------------------------------------------------------------------ *
 * Tool: list_files
 * ------------------------------------------------------------------ */

const listFiles = defineTool<{ path: string; team: boolean }>({
  name: 'list_files',
  description:
    'List files and folders in the project workspace. Use it before reading, never to guess at structure.',
  parameters: schema(
    { path: str('Folder relative to the workspace root. Empty means the root.'), team: bool('List the shared team workspace instead of your own.') },
    []
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const path = a.str('path', { max: 400 })
    const team = a.bool('team')
    return a.finish(() => ({ path, team }))
  },
  async run(args, ctx) {
    const missing = requireProject(ctx)
    if (missing) return { summary: 'No project bound', content: missing, error: missing }
    const workspace = await workspaceOf(ctx, args.team)
    const entries = await ctx.deps.exec.listDir(workspace.id, args.path || undefined)
    const lines = entries
      .map((entry) => `${entry.kind === 'dir' ? 'dir ' : 'file'} ${entry.path}${entry.bytes === null ? '' : ` (${entry.bytes}b)`}`)
      .join('\n')
    return {
      summary: `Listed ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${args.path || '.'}`,
      content: clip(lines || 'That folder is empty.'),
      refs: entries.slice(0, 40).map((entry) => ({ kind: 'file', path: entry.path, agentId: ctx.agentId }))
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: read_file
 * ------------------------------------------------------------------ */

const readFile = defineTool<{ path: string; startLine: number; endLine: number; maxBytes: number; team: boolean }>({
  name: 'read_file',
  description:
    'Read a real file from the project workspace, with line numbers. Quote only what you have actually read.',
  parameters: schema(
    {
      path: str('File path relative to the workspace root.'),
      start_line: num('First line to return (1-based).'),
      end_line: num('Last line to return (1-based, inclusive).'),
      max_bytes: num('Byte ceiling for the read.'),
      team: bool('Read from the shared team workspace instead of your own.')
    },
    ['path']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const path = a.str('path', { required: true, max: 400 })
    const startLine = a.num('start_line', { integer: true, min: 1, max: 500000 })
    const endLine = a.num('end_line', { integer: true, min: 1, max: 500000 })
    const maxBytes = a.num('max_bytes', { integer: true, min: 512, max: 512 * 1024 })
    const team = a.bool('team')
    a.check(!(startLine > 0 && endLine > 0 && endLine < startLine), '"end_line" must not be smaller than "start_line"')
    return a.finish(() => ({ path, startLine, endLine, maxBytes, team }))
  },
  async run(args, ctx) {
    const missing = requireProject(ctx)
    if (missing) return { summary: 'No project bound', content: missing, error: missing }
    const workspace = await workspaceOf(ctx, args.team)
    const file = await ctx.deps.exec.readFile(workspace.id, args.path, args.maxBytes || undefined)
    const allLines = file.text.split('\n')
    const from = args.startLine > 0 ? args.startLine : 1
    const to = args.endLine > 0 ? Math.min(args.endLine, allLines.length) : allLines.length
    const slice = allLines.slice(from - 1, to)
    const numbered = slice.map((line, index) => `${from + index}\t${line}`).join('\n')
    const header = `${file.relativePath} (${file.bytes} bytes${file.truncated ? ', truncated at the read ceiling' : ''}) lines ${from}-${to} of ${allLines.length}`
    return {
      summary: `Read ${file.relativePath} lines ${from}-${to}`,
      content: clip(`${header}\n${numbered}`),
      refs: [{ kind: 'file', path: file.relativePath, startLine: from, endLine: to, agentId: ctx.agentId }]
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: search_text
 * ------------------------------------------------------------------ */

const searchText = defineTool<{ query: string; glob: string; maxResults: number; team: boolean }>({
  name: 'search_text',
  description: 'Search the project for a literal string or pattern. Returns file, line and text for each hit.',
  parameters: schema(
    {
      query: str('Text or pattern to search for.'),
      glob: str('Optional glob filter such as "src/**/*.tsx".'),
      max_results: num('Maximum hits to return (default 40).'),
      team: bool('Search the shared team workspace instead of your own.')
    },
    ['query']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const query = a.str('query', { required: true, max: 200 })
    const glob = a.str('glob', { max: 200 })
    const maxResults = a.num('max_results', { integer: true, min: 1, max: 200 })
    const team = a.bool('team')
    return a.finish(() => ({ query, glob, maxResults: maxResults || 40, team }))
  },
  async run(args, ctx) {
    const missing = requireProject(ctx)
    if (missing) return { summary: 'No project bound', content: missing, error: missing }
    const workspace = await workspaceOf(ctx, args.team)
    const hits = await ctx.deps.exec.search(workspace.id, args.query, {
      glob: args.glob || undefined,
      max: args.maxResults
    })
    const content = hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text.trim().slice(0, 220)}`).join('\n')
    return {
      summary: `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${args.query}"`,
      content: clip(content || `No matches for "${args.query}".`),
      refs: hits.slice(0, 20).map((hit) => ({ kind: 'file', path: hit.path, startLine: hit.line, endLine: hit.line, agentId: ctx.agentId }))
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: inspect_diff
 * ------------------------------------------------------------------ */

const inspectDiff = defineTool<{ team: boolean }>({
  name: 'inspect_diff',
  description: 'Show the real workspace diff (git) for your workspace or the shared team workspace.',
  parameters: schema({ team: bool('Inspect the team workspace instead of your own.') }, []),
  validate(raw) {
    const a = new ArgReader(raw)
    const team = a.bool('team')
    return a.finish(() => ({ team }))
  },
  async run(args, ctx) {
    const missing = requireProject(ctx)
    if (missing) return { summary: 'No project bound', content: missing, error: missing }
    const workspace = await workspaceOf(ctx, args.team)
    const diff = await ctx.deps.exec.diff(workspace.id)
    if (diff.files.length === 0) {
      return {
        summary: `No changes in ${workspace.label}`,
        content: `${workspace.branch ?? 'workspace'} at ${diff.revision ?? 'unknown revision'}: no file changes.${diff.note ? ` ${diff.note}` : ''}`
      }
    }
    const body = diff.files
      .map((file) => `## ${file.status} ${file.path} (+${file.additions}/-${file.deletions})\n${clip(file.patch, 2500)}`)
      .join('\n')
    return {
      summary: `${diff.files.length} changed file(s) in ${workspace.label}`,
      content: clip(`Revision ${diff.revision ?? 'unknown'}\n${body}${diff.note ? `\n${diff.note}` : ''}`),
      refs: diff.files.slice(0, 20).map((file) => ({ kind: 'file', path: file.path, agentId: ctx.agentId }))
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: get_job_output
 * ------------------------------------------------------------------ */

const getJobOutput = defineTool<{ jobId: string; maxChars: number }>({
  name: 'get_job_output',
  description:
    'Read the real captured output of a command you started. Poll this after run_command; never assume the result.',
  parameters: schema({ job_id: str('Job id returned by run_command.'), max_chars: num('Output ceiling (default 8000).') }, ['job_id']),
  validate(raw) {
    const a = new ArgReader(raw)
    const jobId = a.str('job_id', { required: true, max: 120 })
    const maxChars = a.num('max_chars', { integer: true, min: 200, max: MAX_TOOL_OUTPUT_CHARS })
    return a.finish(() => ({ jobId, maxChars: maxChars || 8000 }))
  },
  async run(args, ctx) {
    const job = resolveJob(ctx.deps, ctx.roomId, args.jobId)
    if (!job) {
      const message = `No job matches "${args.jobId}" in this room. Use run_command to start one.`
      return { summary: 'Unknown job', content: message, error: message }
    }
    const output = ctx.deps.exec.getJobOutput(job.id, args.maxChars)
    const header = `job ${job.id.slice(0, 8)} "${job.label}" status=${output.status}${output.exitCode === null ? '' : ` exit=${output.exitCode}`}${output.truncated ? ' (output trimmed)' : ''}`
    return {
      summary: `${job.label}: ${output.status}${output.exitCode === null ? '' : ` (exit ${output.exitCode})`}`,
      content: clip(`${header}\n${output.text || '(no output yet)'}`),
      refs: [{ kind: 'job', jobId: job.id }]
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: wait_for_job
 * ------------------------------------------------------------------ */

const waitForJob = defineTool<{ jobId: string; timeoutMs: number }>({
  name: 'wait_for_job',
  description: 'Wait until a started command finishes, or until the timeout. Returns the job record and output.',
  parameters: schema(
    { job_id: str('Job id returned by run_command.'), timeout_ms: num('How long to wait (default 60000, max 300000).') },
    ['job_id']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const jobId = a.str('job_id', { required: true, max: 120 })
    const timeoutMs = a.num('timeout_ms', { integer: true, min: 500, max: 300000 })
    return a.finish(() => ({ jobId, timeoutMs: timeoutMs || 60000 }))
  },
  async run(args, ctx) {
    const known = resolveJob(ctx.deps, ctx.roomId, args.jobId)
    if (!known) {
      const message = `No job matches "${args.jobId}" in this room.`
      return { summary: 'Unknown job', content: message, error: message }
    }
    const job = await ctx.deps.exec.waitForJob(known.id, args.timeoutMs)
    const output = ctx.deps.exec.getJobOutput(job.id, 8000)
    const settled = job.status !== 'running' && job.status !== 'starting'
    return {
      summary: settled
        ? `${job.label} finished: ${job.status}${job.exitCode === null ? '' : ` (exit ${job.exitCode})`}`
        : `${job.label} still running after ${Math.round(args.timeoutMs / 1000)}s`,
      content: clip(
        `job ${job.id.slice(0, 8)} status=${job.status}${job.exitCode === null ? '' : ` exit=${job.exitCode}`}\n${output.text || '(no output yet)'}`
      ),
      refs: [{ kind: 'job', jobId: job.id }],
      error: settled && (job.status === 'failed' || job.exitCode !== null && job.exitCode !== 0)
        ? `${job.label} exited with a non-zero status.`
        : undefined
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: list_tasks
 * ------------------------------------------------------------------ */

const listTasks = defineTool<{ mineOnly: boolean }>({
  name: 'list_tasks',
  description: 'Read the real task board for this room, including owners, dependencies and stale flags.',
  parameters: schema({ mine_only: bool('Only your own tasks.') }, []),
  validate(raw) {
    const a = new ArgReader(raw)
    const mineOnly = a.bool('mine_only')
    return a.finish(() => ({ mineOnly }))
  },
  async run(args, ctx) {
    const tasks = ctx.deps.bus
      .getTasks(ctx.roomId)
      .filter((task) => !args.mineOnly || task.ownerAgentId === ctx.agentId)
    if (tasks.length === 0) {
      return { summary: 'No tasks on the board', content: 'The task board is empty.' }
    }
    const lines = tasks.map((task) => {
      const owner = agentName(ctx.deps, ctx.roomId, task.ownerAgentId)
      const bits = [`${task.id.slice(0, 8)} [${task.status}] ${task.title}`, `owner=${owner}`]
      if (task.dependsOn.length > 0) bits.push(`depends_on=${task.dependsOn.map((id) => id.slice(0, 8)).join(',')}`)
      if (task.staleSince) bits.push(`STALE: ${task.staleReason ?? 'a newer decision landed'}`)
      if (task.blockedReason) bits.push(`blocked: ${task.blockedReason}`)
      if (task.acceptance.length > 0) bits.push(`acceptance=${task.acceptance.join(' | ')}`)
      return `- ${bits.join(' ')}`
    })
    return {
      summary: `Read ${tasks.length} task(s)`,
      content: clip(lines.join('\n')),
      refs: tasks.slice(0, 12).map((task) => ({ kind: 'task', taskId: task.id }))
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: list_decisions
 * ------------------------------------------------------------------ */

const listDecisions = defineTool<Record<string, never>>({
  name: 'list_decisions',
  description: 'Read the active decisions for this room with their revision numbers. Decisions outrank assumptions.',
  parameters: schema({}, []),
  validate(raw) {
    const a = new ArgReader(raw)
    return a.finish(() => ({}) as Record<string, never>)
  },
  async run(_args, ctx) {
    const decisions = ctx.deps.bus.getActiveDecisions(ctx.roomId)
    const room = ctx.deps.bus.getRoom(ctx.roomId)
    if (decisions.length === 0) {
      return {
        summary: 'No active decisions',
        content: `No decisions recorded yet (room decision revision ${room?.decisionRevision ?? 0}).`
      }
    }
    const lines = decisions.map(
      (decision) => `- r${decision.revision} [${decision.id.slice(0, 8)}] ${decision.title}: ${decision.statement}`
    )
    return {
      summary: `Read ${decisions.length} decision(s)`,
      content: clip(`Room decision revision: ${room?.decisionRevision ?? 0}\n${lines.join('\n')}`),
      refs: decisions.slice(0, 8).map((decision) => ({ kind: 'decision', decisionId: decision.id }))
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: read_browser_observation
 * ------------------------------------------------------------------ */

const readBrowser = defineTool<{ sessionId: string }>({
  name: 'read_browser_observation',
  description: 'Read the current page: URL, title, visible text and the interactive elements you can act on.',
  parameters: schema({ session_id: str('Browser session id. Defaults to your own session.') }, []),
  validate(raw) {
    const a = new ArgReader(raw)
    const sessionId = a.str('session_id', { max: 120 })
    return a.finish(() => ({ sessionId }))
  },
  async run(args, ctx) {
    const sessionId = currentSessionId(ctx.deps, ctx, args.sessionId)
    if (!sessionId) {
      const message = 'You have no browser session yet. Call browser_open first.'
      return { summary: 'No browser session', content: message, error: message }
    }
    const observation = await ctx.deps.browser.observe(sessionId)
    const elements = observation.elements
      .slice(0, 40)
      .map((element) => `- [${element.ref}] ${element.role} "${element.name}" selector=${element.selector}`)
      .join('\n')
    return {
      summary: `Observed ${observation.title || observation.url}`,
      content: clip(
        `URL: ${observation.url}\nTitle: ${observation.title}\n\nText:\n${observation.text}\n\nInteractive elements:\n${elements || '(none found)'}`
      ),
      refs: []
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: write_file
 * ------------------------------------------------------------------ */

const writeFile = defineTool<{ path: string; contents: string; reason: string }>({
  name: 'write_file',
  description:
    'Create or overwrite a file in your own workspace with the full contents you supply. This is a real write; the diff becomes visible immediately.',
  parameters: schema(
    {
      path: str('File path relative to the workspace root.'),
      contents: str('The complete new contents of the file.'),
      reason: str('One short line explaining why this change is needed.')
    },
    ['path', 'contents']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const path = a.str('path', { required: true, max: 400 })
    // Contents are written exactly as given, including trailing newlines.
    const contents = a.str('contents', { required: true, max: 400000, raw: true })
    const reason = a.str('reason', { max: 200 })
    return a.finish(() => ({ path, contents, reason }))
  },
  async run(args, ctx) {
    const missing = requireProject(ctx)
    if (missing) return { summary: 'No project bound', content: missing, error: missing }
    const workspace = await workspaceOf(ctx, false)
    const result = await ctx.deps.exec.writeFile(workspace.id, args.path, args.contents)
    return {
      summary: `${result.created ? 'Created' : 'Updated'} ${result.relativePath} (${result.bytes} bytes)`,
      content: `${result.created ? 'Created' : 'Overwrote'} ${result.relativePath} in ${workspace.label} (${result.bytes} bytes). The change is real and visible in the diff.`,
      refs: [{ kind: 'file', path: result.relativePath, agentId: ctx.agentId }]
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: apply_patch
 * ------------------------------------------------------------------ */

const applyPatch = defineTool<{ patch: string; reason: string }>({
  name: 'apply_patch',
  description:
    'Apply a unified diff to your workspace. If any hunk does not apply cleanly nothing is written and the reason is returned.',
  parameters: schema({ patch: str('Unified diff text.'), reason: str('One short line explaining the change.') }, ['patch']),
  validate(raw) {
    const a = new ArgReader(raw)
    const patch = a.str('patch', { required: true, max: 200000, raw: true })
    const reason = a.str('reason', { max: 200 })
    a.check(patch.includes('@@') || patch.startsWith('---'), 'the patch must be unified diff text (it needs @@ hunks or --- headers)')
    return a.finish(() => ({ patch, reason }))
  },
  async run(args, ctx) {
    const missing = requireProject(ctx)
    if (missing) return { summary: 'No project bound', content: missing, error: missing }
    const workspace = await workspaceOf(ctx, false)
    const result = await ctx.deps.exec.applyPatch(workspace.id, args.patch)
    if (!result.applied) {
      return {
        summary: result.rejected.length > 0 ? `Patch rejected for ${result.rejected.join(', ')}` : 'Patch not applied',
        content: `The patch was not applied. ${result.detail}${result.rejected.length > 0 ? `\nFiles that did not match:\n${result.rejected.join('\n')}` : ''}\nRead the current file and produce a patch against it.`,
        error: result.detail || 'patch did not apply',
        rejected: true
      }
    }
    return {
      summary: `Applied a patch to ${result.files.length} file(s)`,
      content: `Patch applied. Files changed: ${result.files.join(', ')}. ${result.detail}`,
      refs: result.files.slice(0, 20).map((path) => ({ kind: 'file', path, agentId: ctx.agentId }))
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: run_command
 * ------------------------------------------------------------------ */

const runCommand = defineTool<{ command: string; label: string; cwd: string; devServer: boolean }>({
  name: 'run_command',
  description:
    'Start a real command in your workspace (install, build, test, dev server). Returns a job id; read the result with get_job_output or wait_for_job before claiming anything about it.',
  parameters: schema(
    {
      command: str('Command line to run, for example "npm test".'),
      label: str('Short label for the activity view, for example "unit tests".'),
      cwd: str('Folder relative to the workspace root.'),
      dev_server: bool('True when this command serves the app and should keep running.')
    },
    ['command']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const command = a.str('command', { required: true, min: 2, max: 600 })
    const label = a.str('label', { max: 80 })
    const cwd = a.str('cwd', { max: 400 })
    const devServer = a.bool('dev_server')
    return a.finish(() => ({ command, label, cwd, devServer }))
  },
  async run(args, ctx) {
    const missing = requireProject(ctx)
    if (missing) return { summary: 'No project bound', content: missing, error: missing }
    const workspace = await workspaceOf(ctx, false)
    const job = await ctx.deps.exec.startJob({
      roomId: ctx.roomId,
      agentId: ctx.agentId,
      workspaceId: workspace.id,
      label: args.label || args.command.slice(0, 48),
      command: args.command,
      cwd: args.cwd || undefined,
      devServer: args.devServer
    })
    return {
      summary: `Started "${job.label}" (${job.status})`,
      content: `Started job ${job.id} in ${workspace.label}: ${args.command}\nStatus is ${job.status}. Poll with get_job_output or wait_for_job; do not assume it passed.`,
      refs: [{ kind: 'job', jobId: job.id }]
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: cancel_job
 * ------------------------------------------------------------------ */

const cancelJob = defineTool<{ jobId: string; reason: string }>({
  name: 'cancel_job',
  description: 'Stop a command you started. Output already produced is kept.',
  parameters: schema({ job_id: str('Job id to stop.'), reason: str('Why it is being stopped.') }, ['job_id']),
  validate(raw) {
    const a = new ArgReader(raw)
    const jobId = a.str('job_id', { required: true, max: 120 })
    const reason = a.str('reason', { max: 200 })
    return a.finish(() => ({ jobId, reason }))
  },
  async run(args, ctx) {
    const known = resolveJob(ctx.deps, ctx.roomId, args.jobId)
    if (!known) {
      const message = `No job matches "${args.jobId}" in this room.`
      return { summary: 'Unknown job', content: message, error: message }
    }
    const job = await ctx.deps.exec.cancelJob(known.id)
    return {
      summary: `Cancelled ${job.label} (${job.status})`,
      content: `Job ${job.id} is now ${job.status}. Anything it had already written to disk is still there; nothing was rolled back.`,
      refs: [{ kind: 'job', jobId: job.id }]
    }
  }
})

/* ------------------------------------------------------------------ *
 * Tool: start_preview
 * ------------------------------------------------------------------ */

const startPreview = defineTool<Record<string, never>>({
  name: 'start_preview',
  description: 'Start (or reuse) the project dev server and expose it so the remote browser can open the running app.',
  parameters: schema({}, []),
  validate(raw) {
    const a = new ArgReader(raw)
    return a.finish(() => ({}) as Record<string, never>)
  },
  async run(_args, ctx) {
    const missing = requireProject(ctx)
    if (missing) return { summary: 'No project bound', content: missing, error: missing }
    const gap = capabilityGap(ctx, 'preview')
    if (gap) return { summary: 'Preview unavailable', content: gap, error: gap }
    const workspace = await workspaceOf(ctx, false)
    const preview = await ctx.deps.exec.startPreview(ctx.roomId, workspace.id)
    const reachable = preview.publicUrl ?? preview.localUrl
    return {
      summary: `Preview ${preview.state} at ${reachable}`,
      content: `Preview state: ${preview.state}. Local URL: ${preview.localUrl}. Remote-reachable: ${preview.publicUrl ?? '(none yet)'}. ${preview.detail}`,
      error: preview.state === 'failed' ? preview.detail : undefined
    }
  }
})

/* ------------------------------------------------------------------ *
 * Browser tools
 * ------------------------------------------------------------------ */

const browserOpen = defineTool<{ url: string; label: string }>({
  name: 'browser_open',
  description: 'Open a real remote browser session (Browserbase) and optionally navigate it to a URL.',
  parameters: schema({ url: str('URL to open first.'), label: str('Label for a second session, for example "second user".') }, []),
  validate(raw) {
    const a = new ArgReader(raw)
    const url = a.str('url', { max: 2000 })
    const label = a.str('label', { max: 60 })
    if (url) a.check(/^https?:\/\//i.test(url), '"url" must start with http:// or https://')
    return a.finish(() => ({ url, label }))
  },
  async run(args, ctx) {
    const gap = capabilityGap(ctx, 'browserbase')
    if (gap) return { summary: 'Browserbase unavailable', content: gap, error: gap }
    const session = await ctx.deps.browser.openSession({
      roomId: ctx.roomId,
      agentId: ctx.agentId,
      url: args.url || undefined,
      label: args.label || undefined
    })
    ctx.deps.bus.updateAgent(ctx.agentId, { browserSessionId: session.id })
    if (session.status !== 'live') {
      const message = `Browser session ${session.id} is ${session.status}: ${session.detail}`
      return { summary: `Browser session ${session.status}`, content: message, error: message }
    }
    return {
      summary: `Opened browser session at ${session.currentUrl ?? args.url ?? 'about:blank'}`,
      content: `Session ${session.id} is live at ${session.currentUrl ?? 'about:blank'}. Live view: ${session.liveViewUrl ?? '(none)'}.`
    }
  }
})

const browserNavigate = defineTool<{ sessionId: string; url: string }>({
  name: 'browser_navigate',
  description: 'Navigate an existing browser session to a URL and return what is on the page afterwards.',
  parameters: schema({ session_id: str('Session id. Defaults to your own.'), url: str('Absolute URL.') }, ['url']),
  validate(raw) {
    const a = new ArgReader(raw)
    const sessionId = a.str('session_id', { max: 120 })
    const url = a.str('url', { required: true, max: 2000 })
    a.check(/^https?:\/\//i.test(url), '"url" must start with http:// or https://')
    return a.finish(() => ({ sessionId, url }))
  },
  async run(args, ctx) {
    const sessionId = currentSessionId(ctx.deps, ctx, args.sessionId)
    if (!sessionId) {
      const message = 'You have no browser session yet. Call browser_open first.'
      return { summary: 'No browser session', content: message, error: message }
    }
    const result = await ctx.deps.browser.act({ sessionId, action: { kind: 'navigate', url: args.url } })
    return {
      summary: result.ok ? `Navigated to ${args.url}` : `Navigation failed: ${result.detail}`,
      content: `${result.detail}${result.observation ? `\n\nURL: ${result.observation.url}\nTitle: ${result.observation.title}\n${clip(result.observation.text, 3000)}` : ''}`,
      error: result.ok ? undefined : result.detail
    }
  }
})

/** A task reference, or nothing when there is no task to point at. */
function taskRef(taskId: string | null | undefined): ContextRef[] {
  return taskId ? [{ kind: 'task', taskId }] : []
}

const BROWSER_ACTIONS = ['navigate', 'click', 'type', 'press', 'select', 'waitFor', 'evaluate', 'draw'] as const
type BrowserActionName = (typeof BROWSER_ACTIONS)[number]

interface BrowserActArgs {
  sessionId: string
  action: BrowserActionName
  selector: string
  text: string
  key: string
  value: string
  ms: number
  expression: string
  strokes: number
  submit: boolean
}

const browserAct = defineTool<BrowserActArgs>({
  name: 'browser_act',
  description:
    'Act on the live page: click, type, press a key, select, wait, evaluate an expression, or draw strokes. Check the returned observation before claiming anything worked.',
  parameters: schema(
    {
      session_id: str('Session id. Defaults to your own.'),
      action: { type: 'string', enum: [...BROWSER_ACTIONS], description: 'What to do.' },
      selector: str('CSS selector for click, type, select, draw or waitFor.'),
      text: str('Text for the "type" action.'),
      key: str('Key name for the "press" action, for example "Enter".'),
      value: str('Option value for the "select" action.'),
      ms: num('Milliseconds for the "waitFor" action.'),
      expression: str('JavaScript expression for the "evaluate" action.'),
      strokes: num('Number of strokes for the "draw" action.'),
      submit: bool('Submit the form after typing.')
    },
    ['action']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const sessionId = a.str('session_id', { max: 120 })
    const actionRaw = a.str('action', { required: true, enum: BROWSER_ACTIONS })
    const action = (actionRaw || 'click') as BrowserActionName
    const selector = a.str('selector', { max: 600 })
    const text = a.str('text', { max: 8000 })
    const key = a.str('key', { max: 40 })
    const value = a.str('value', { max: 600 })
    const ms = a.num('ms', { integer: true, min: 1, max: 60000 })
    const expression = a.str('expression', { max: 4000 })
    const strokes = a.num('strokes', { integer: true, min: 1, max: 200 })
    const submit = a.bool('submit')

    if (actionRaw) {
      if ((action === 'click' || action === 'draw') && !selector) a.reject(`"${action}" needs a "selector"`)
      if (action === 'type' && (!selector || !text)) a.reject('"type" needs a "selector" and "text"')
      if (action === 'select' && (!selector || !value)) a.reject('"select" needs a "selector" and "value"')
      if (action === 'press' && !key) a.reject('"press" needs a "key"')
      if (action === 'evaluate' && !expression) a.reject('"evaluate" needs an "expression"')
      if (action === 'navigate') a.reject('use browser_navigate for navigation')
      if (action === 'waitFor' && !selector && ms === 0) a.reject('"waitFor" needs a "selector" or "ms"')
    }
    return a.finish(() => ({ sessionId, action, selector, text, key, value, ms, expression, strokes, submit }))
  },
  async run(args, ctx) {
    const sessionId = currentSessionId(ctx.deps, ctx, args.sessionId)
    if (!sessionId) {
      const message = 'You have no browser session yet. Call browser_open first.'
      return { summary: 'No browser session', content: message, error: message }
    }
    const action = buildBrowserAction(args)
    const result = await ctx.deps.browser.act({ sessionId, action })
    return {
      summary: result.ok ? `${args.action} succeeded` : `${args.action} failed: ${result.detail.slice(0, 120)}`,
      content: `${result.detail}${result.observation ? `\n\nURL: ${result.observation.url}\nTitle: ${result.observation.title}\n${clip(result.observation.text, 2500)}` : ''}`,
      error: result.ok ? undefined : result.detail
    }
  }
})

function buildBrowserAction(args: BrowserActArgs): BrowserActionInput['action'] {
  switch (args.action) {
    case 'click':
      return { kind: 'click', selector: args.selector }
    case 'type':
      return { kind: 'type', selector: args.selector, text: args.text, submit: args.submit }
    case 'press':
      return { kind: 'press', key: args.key }
    case 'select':
      return { kind: 'select', selector: args.selector, value: args.value }
    case 'waitFor':
      return args.selector ? { kind: 'waitFor', selector: args.selector, ms: args.ms || undefined } : { kind: 'waitFor', ms: args.ms }
    case 'evaluate':
      return { kind: 'evaluate', expression: args.expression }
    case 'draw':
      return { kind: 'draw', selector: args.selector, strokes: args.strokes || 1 }
    case 'navigate':
    default:
      return { kind: 'waitFor', ms: 250 }
  }
}

const browserScreenshot = defineTool<{ sessionId: string; fullPage: boolean; note: string }>({
  name: 'browser_screenshot',
  description: 'Capture the live page. The screenshot is stored as an artifact and can be cited as evidence.',
  parameters: schema(
    {
      session_id: str('Session id. Defaults to your own.'),
      full_page: bool('Capture the whole page rather than the viewport.'),
      note: str('What this capture is meant to show.')
    },
    []
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const sessionId = a.str('session_id', { max: 120 })
    const fullPage = a.bool('full_page')
    const note = a.str('note', { max: 200 })
    return a.finish(() => ({ sessionId, fullPage, note }))
  },
  async run(args, ctx) {
    const sessionId = currentSessionId(ctx.deps, ctx, args.sessionId)
    if (!sessionId) {
      const message = 'You have no browser session yet. Call browser_open first.'
      return { summary: 'No browser session', content: message, error: message }
    }
    const shot = await ctx.deps.browser.screenshot(sessionId, { fullPage: args.fullPage })
    const ref: ContextRef = {
      kind: 'screenshot',
      artifactId: shot.artifact.id,
      rect: { x: 0, y: 0, width: shot.viewport.width, height: shot.viewport.height },
      viewport: { width: shot.viewport.width, height: shot.viewport.height },
      url: shot.url
    }
    return {
      summary: `Captured ${shot.url} (${shot.viewport.width}x${shot.viewport.height})`,
      content: `Screenshot saved as artifact ${shot.artifact.id} for ${shot.url} at ${shot.viewport.width}x${shot.viewport.height}.${args.note ? ` Note: ${args.note}` : ''}`,
      refs: [ref]
    }
  }
})

const browserNetwork = defineTool<{ sessionId: string; filter: string }>({
  name: 'browser_network',
  description: 'Inspect recent network responses from the live page, including payload bodies. Use it to check what really went over the wire.',
  parameters: schema({ session_id: str('Session id. Defaults to your own.'), filter: str('Only responses whose URL contains this text.') }, []),
  validate(raw) {
    const a = new ArgReader(raw)
    const sessionId = a.str('session_id', { max: 120 })
    const filter = a.str('filter', { max: 200 })
    return a.finish(() => ({ sessionId, filter }))
  },
  async run(args, ctx) {
    const sessionId = currentSessionId(ctx.deps, ctx, args.sessionId)
    if (!sessionId) {
      const message = 'You have no browser session yet. Call browser_open first.'
      return { summary: 'No browser session', content: message, error: message }
    }
    const captures = await ctx.deps.browser.network(sessionId, args.filter || undefined)
    if (captures.length === 0) {
      return { summary: 'No network responses captured', content: 'No network responses captured yet for that filter.' }
    }
    const body = captures
      .map((capture) => `${capture.method} ${capture.status} ${capture.url}\n${clip(capture.body, 1200)}`)
      .join('\n---\n')
    return {
      summary: `Read ${captures.length} network response(s)`,
      content: clip(body)
    }
  }
})

/* ------------------------------------------------------------------ *
 * Team tools
 * ------------------------------------------------------------------ */

const messageTeammate = defineTool<{ teammate: string; message: string; review: boolean }>({
  name: 'message_teammate',
  description:
    'Send one teammate a short, specific message (a handoff, a question, or a review request). They read it when they are free.',
  parameters: schema(
    {
      teammate: str('Teammate name or id.'),
      message: str('What you need from them, in one or two sentences.'),
      review: bool('True when you are asking them to review something specific.')
    },
    ['teammate', 'message']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const teammate = a.str('teammate', { required: true, max: 80 })
    const message = a.str('message', { required: true, min: 2, max: 1200 })
    const review = a.bool('review')
    return a.finish(() => ({ teammate, message, review }))
  },
  async run(args, ctx) {
    const target = resolveAgent(ctx.deps, ctx.roomId, args.teammate)
    if (!target) {
      const message = `No teammate called "${args.teammate}" in this room.`
      return { summary: 'Unknown teammate', content: message, error: message, rejected: true }
    }
    if (target.id === ctx.agentId) {
      const message = 'You cannot message yourself.'
      return { summary: 'Self-message refused', content: message, error: message, rejected: true }
    }
    const from = agentName(ctx.deps, ctx.roomId, ctx.agentId)
    const message = ctx.bridge.message({
      roomId: ctx.roomId,
      agentId: ctx.agentId,
      body: `@${target.name} ${args.message}`,
      kind: args.review ? 'question' : 'handoff',
      to: [target.id],
      speak: true,
      speechReason: args.review ? 'clarify' : 'peer'
    })
    ctx.bridge.notify(target.id, {
      kind: args.review ? 'review_request' : 'handoff',
      summary: `${from}: ${args.message.slice(0, 160)}`,
      note: args.message,
      messageId: message.id,
      taskId: ctx.taskId ?? undefined
    })
    return {
      summary: `Messaged ${target.name}`,
      content: `Delivered to ${target.name}; they will pick it up from their inbox.`,
      refs: taskRef(ctx.taskId)
    }
  }
})

const askHuman = defineTool<{ question: string; context: string }>({
  name: 'ask_human',
  description:
    'Ask the human one specific question when you are genuinely blocked. This pauses your task as blocked until they answer.',
  parameters: schema({ question: str('The single question you need answered.'), context: str('What you tried and what blocks you.') }, ['question']),
  validate(raw) {
    const a = new ArgReader(raw)
    const question = a.str('question', { required: true, min: 4, max: 600 })
    const context = a.str('context', { max: 800 })
    a.check(question.includes('?'), 'the question must be a question')
    return a.finish(() => ({ question, context }))
  },
  async run(args, ctx) {
    const message = ctx.bridge.message({
      roomId: ctx.roomId,
      agentId: ctx.agentId,
      body: args.context ? `${args.question}\n\n(Context: ${args.context})` : args.question,
      kind: 'question',
      to: [],
      speak: true,
      speechReason: 'clarify',
      spokenOverride: args.question
    })
    if (ctx.taskId) {
      ctx.bridge.updateTask(ctx.taskId, {
        status: 'blocked',
        blockedReason: `Waiting on the human: ${args.question.slice(0, 200)}`
      })
    }
    return {
      summary: `Asked the human: ${args.question.slice(0, 100)}`,
      content: 'Question delivered out loud and in the transcript. Your task is now blocked; stop and wait for the answer instead of guessing.',
      refs: ctx.taskId ? [{ kind: 'task', taskId: ctx.taskId }] : []
    }
  }
})

const createTask = defineTool<{ title: string; detail: string; owner: string; dependsOn: string[]; acceptance: string[] }>({
  name: 'create_task',
  description: 'Create one task on the room board with a clear owner and explicit acceptance criteria. Creating a task does not do the work.',
  parameters: schema(
    {
      title: str('Short imperative title.'),
      detail: str('What the work is, and any constraint that matters.'),
      owner: str('Teammate name or id. Empty leaves it unowned for now.'),
      depends_on: strList('Task ids that must finish first.'),
      acceptance: strList('Concrete checks that prove the task is done.')
    },
    ['title']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const title = a.str('title', { required: true, min: 3, max: 160 })
    const detail = a.str('detail', { max: 2000 })
    const owner = a.str('owner', { max: 80 })
    const dependsOn = a.list('depends_on', { maxItems: 12 })
    const acceptance = a.list('acceptance', { maxItems: 8, maxLength: 300 })
    return a.finish(() => ({ title, detail, owner, dependsOn, acceptance }))
  },
  async run(args, ctx) {
    const owner = args.owner ? resolveAgent(ctx.deps, ctx.roomId, args.owner) : null
    const input: BridgeTaskInput = {
      title: args.title,
      detail: args.detail,
      ownerAgentId: owner?.id ?? null,
      dependsOn: resolveTaskIds(ctx, args.dependsOn),
      acceptance: args.acceptance
    }
    const result = ctx.bridge.createTask(ctx.roomId, input, { type: 'agent', agentId: ctx.agentId })
    return {
      summary: `Created task "${result.task.title}"${owner ? ` for ${owner.name}` : ''}`,
      content: `Task ${result.task.id} created with status ${result.task.status}.${owner ? ` ${owner.name} was notified.` : ''}`,
      refs: [{ kind: 'task', taskId: result.task.id }]
    }
  }
})

function resolveTaskIds(ctx: ToolContext, values: string[]): string[] {
  const tasks = ctx.deps.bus.getTasks(ctx.roomId)
  const ids: string[] = []
  for (const value of values) {
    const exact = tasks.find((task) => task.id === value) ?? tasks.find((task) => task.id.startsWith(value))
    if (exact) ids.push(exact.id)
  }
  return ids
}

const assignTask = defineTool<{ taskId: string; owner: string; note: string }>({
  name: 'assign_task',
  description: 'Give an existing task to one teammate and tell them what you need.',
  parameters: schema(
    { task_id: str('Task id (or its first characters).'), owner: str('Teammate name or id.'), note: str('What you want from them.') },
    ['task_id', 'owner']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const taskId = a.str('task_id', { required: true, max: 120 })
    const owner = a.str('owner', { required: true, max: 80 })
    const note = a.str('note', { max: 800 })
    return a.finish(() => ({ taskId, owner, note }))
  },
  async run(args, ctx) {
    const task = findTask(ctx, args.taskId)
    if (!task) {
      const message = `No task matches "${args.taskId}".`
      return { summary: 'Unknown task', content: message, error: message, rejected: true }
    }
    const owner = resolveAgent(ctx.deps, ctx.roomId, args.owner)
    if (!owner) {
      const message = `No teammate called "${args.owner}" in this room.`
      return { summary: 'Unknown teammate', content: message, error: message, rejected: true }
    }
    const updated = ctx.bridge.updateTask(task.id, { ownerAgentId: owner.id })
    ctx.bridge.notify(owner.id, {
      kind: 'handoff',
      summary: `Assigned: ${task.title}`,
      note: args.note || `Task ${task.id}: ${task.detail}`,
      taskId: task.id
    })
    return {
      summary: `Assigned "${task.title}" to ${owner.name}`,
      content: `Task ${task.id} is now owned by ${owner.name} (status ${updated?.status ?? task.status}).`,
      refs: [{ kind: 'task', taskId: task.id }]
    }
  }
})

function findTask(ctx: ToolContext, needle: string): Task | null {
  const tasks = ctx.deps.bus.getTasks(ctx.roomId)
  return tasks.find((task) => task.id === needle) ?? tasks.find((task) => task.id.startsWith(needle)) ?? null
}

const updateTask = defineTool<{
  taskId: string
  status: string
  detail: string
  blockedReason: string
  acceptance: string[]
}>({
  name: 'update_task',
  description:
    'Update a task you own: status, detail, acceptance criteria or a blocked reason. Setting "done" is a claim and must be backed by evidence refs in your message.',
  parameters: schema(
    {
      task_id: str('Task id.'),
      status: { type: 'string', enum: ['proposed', 'assigned', 'in_progress', 'blocked', 'awaiting_review', 'submitted', 'done', 'cancelled', 'failed'] },
      detail: str('New detail text.'),
      blocked_reason: str('Why the task is blocked.'),
      acceptance: strList('Replacement acceptance criteria.')
    },
    ['task_id']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const taskId = a.str('task_id', { required: true, max: 120 })
    const status = a.str('status', {
      enum: ['proposed', 'assigned', 'in_progress', 'blocked', 'awaiting_review', 'submitted', 'done', 'cancelled', 'failed']
    })
    const detail = a.str('detail', { max: 2000 })
    const blockedReason = a.str('blocked_reason', { max: 600 })
    const acceptance = a.list('acceptance', { maxItems: 8, maxLength: 300 })
    return a.finish(() => ({ taskId, status, detail, blockedReason, acceptance }))
  },
  async run(args, ctx) {
    const task = findTask(ctx, args.taskId)
    if (!task) {
      const message = `No task matches "${args.taskId}".`
      return { summary: 'Unknown task', content: message, error: message, rejected: true }
    }
    const patch: TaskPatch = {}
    if (args.status) patch.status = args.status as TaskStatus
    if (args.detail) patch.detail = args.detail
    if (args.blockedReason) patch.blockedReason = args.blockedReason
    if (args.acceptance.length > 0) patch.acceptance = args.acceptance
    const updated = ctx.bridge.updateTask(task.id, patch)
    if (!updated) {
      const message = `Task ${task.id} no longer exists.`
      return { summary: 'Task vanished', content: message, error: message }
    }
    return {
      summary: `Task "${updated.title}" -> ${updated.status}`,
      content: `Task ${updated.id} is now ${updated.status}${updated.blockedReason ? ` (blocked: ${updated.blockedReason})` : ''}.`,
      refs: [{ kind: 'task', taskId: updated.id }]
    }
  }
})

const recordDecision = defineTool<{ title: string; statement: string; rationale: string; supersedes: string }>({
  name: 'record_decision',
  description:
    'Record a decision the human actually settled that changes what the team builds. This bumps the room decision revision and marks older work stale.',
  parameters: schema(
    {
      title: str('Short decision title.'),
      statement: str('The decision, stated so someone else can follow it.'),
      rationale: str('Why this was chosen.'),
      supersedes: str('Id of the decision this replaces, when there is one.')
    },
    ['title', 'statement']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const title = a.str('title', { required: true, min: 3, max: 120 })
    const statement = a.str('statement', { required: true, min: 4, max: 2000 })
    const rationale = a.str('rationale', { max: 1000 })
    const supersedes = a.str('supersedes', { max: 120 })
    return a.finish(() => ({ title, statement, rationale, supersedes }))
  },
  async run(args, ctx) {
    const input: RecordDecisionInput = { roomId: ctx.roomId, title: args.title, statement: args.statement }
    if (args.rationale) input.rationale = args.rationale
    if (args.supersedes) {
      const decisions = ctx.deps.bus.getDecisions(ctx.roomId)
      const previous =
        decisions.find((decision) => decision.id === args.supersedes) ??
        decisions.find((decision) => decision.id.startsWith(args.supersedes))
      if (previous) input.supersedesId = previous.id
    }
    const decision = await ctx.bridge.recordDecision(ctx.roomId, ctx.agentId, input)
    return {
      summary: `Recorded decision r${decision.revision}: ${decision.title}`,
      content: `Decision r${decision.revision} recorded (${decision.id}). Tasks planned against earlier revisions are marked stale and will be re-planned.`,
      refs: [{ kind: 'decision', decisionId: decision.id }]
    }
  }
})

const recordMemory = defineTool<{ kind: string; title: string; body: string }>({
  name: 'record_memory',
  description: 'Write one durable room note: an interface, a convention, a finding, or a goal detail the next teammate needs.',
  parameters: schema(
    {
      kind: { type: 'string', enum: ['goal', 'decision', 'interface', 'convention', 'finding', 'artifact'] },
      title: str('Short label.'),
      body: str('The note itself.')
    },
    ['title', 'body']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const kind = a.str('kind', { required: true, enum: ['goal', 'decision', 'interface', 'convention', 'finding', 'artifact'] })
    const title = a.str('title', { required: true, min: 2, max: 120 })
    const body = a.str('body', { required: true, min: 2, max: 2000 })
    return a.finish(() => ({ kind, title, body }))
  },
  async run(args, ctx) {
    const room = ctx.deps.bus.getRoom(ctx.roomId)
    ctx.deps.bus.addMemory({
      id: ctx.deps.bus.newId(),
      roomId: ctx.roomId,
      kind: args.kind as MemoryKind,
      title: args.title,
      body: args.body,
      decisionRevision: room?.decisionRevision ?? 0,
      source: { type: 'agent', agentId: ctx.agentId },
      createdAt: ctx.deps.bus.now(),
      supersededById: null
    })
    return {
      summary: `Recorded ${args.kind}: ${args.title}`,
      content: `Room memory updated with ${args.kind} "${args.title}".`
    }
  }
})

const submitWork = defineTool<{ summary: string; taskId: string; files: string[] }>({
  name: 'submit_work',
  description:
    'Commit your workspace changes to your branch as a submission. Refuses when your task was planned against an older decision revision.',
  parameters: schema(
    {
      summary: str('What this submission contains and how it was checked.'),
      task_id: str('Task this submission completes.'),
      files: strList('Files you changed (for the record).')
    },
    ['summary']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const summary = a.str('summary', { required: true, min: 4, max: 2000 })
    const taskId = a.str('task_id', { max: 120 })
    const files = a.list('files', { maxItems: 60, maxLength: 400 })
    return a.finish(() => ({ summary, taskId, files }))
  },
  async run(args, ctx) {
    const task = args.taskId ? findTask(ctx, args.taskId) : ctx.taskId ? ctx.deps.bus.getTask(ctx.taskId) : null
    const room = ctx.deps.bus.getRoom(ctx.roomId)
    const revision = room?.decisionRevision ?? 0
    if (task && plannedBefore(task, revision)) {
      const message = `Refused: this task was planned against decision revision ${task.decisionRevision} but the room is at revision ${revision}. Re-plan against the current decisions (list_decisions) before submitting.`
      return { summary: 'Submission refused: stale decision revision', content: message, error: message, rejected: true }
    }
    const workspace = await workspaceOf(ctx, false)
    const result = await ctx.deps.exec.submitWork({
      roomId: ctx.roomId,
      agentId: ctx.agentId,
      workspaceId: workspace.id,
      summary: args.summary,
      taskId: task?.id ?? null
    })
    if (task) {
      ctx.bridge.updateTask(task.id, { status: 'submitted' })
    }
    return {
      summary: `Submitted ${result.commit.slice(0, 8)} on ${result.branch} (${result.filesChanged} file(s))`,
      content: `Committed ${result.commit} on branch ${result.branch}: ${result.filesChanged} file(s). ${result.detail}`,
      refs: taskRef(task?.id ?? ctx.taskId)
    }
  }
})

const runIntegration = defineTool<{ sources: string[]; checks: string[]; taskId: string }>({
  name: 'run_integration',
  description:
    'Fold teammates\' branches into the team workspace and run the real checks. This is the only way to claim a verified integrated revision.',
  parameters: schema(
    {
      sources: strList('Teammate names or ids whose branches to fold in.'),
      checks: strList('Commands to run on the integrated revision, for example "npm test".'),
      task_id: str('Task this integration serves.')
    },
    []
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const sources = a.list('sources', { maxItems: 8, maxLength: 80 })
    const checks = a.list('checks', { maxItems: 6, maxLength: 300 })
    const taskId = a.str('task_id', { max: 120 })
    return a.finish(() => ({ sources, checks, taskId }))
  },
  async run(args, ctx) {
    const agents = ctx.deps.bus.getAgents(ctx.roomId)
    const sourceIds = args.sources
      .map((value) => agents.find((agent) => agent.id === value || agent.name.toLowerCase() === value.toLowerCase())?.id)
      .filter((id): id is string => typeof id === 'string')
    const unknown = args.sources.filter(
      (value) => !agents.some((agent) => agent.id === value || agent.name.toLowerCase() === value.toLowerCase())
    )
    if (unknown.length > 0) {
      const message = `Unknown teammate(s): ${unknown.join(', ')}.`
      return { summary: 'Unknown integration source', content: message, error: message, rejected: true }
    }
    const room = ctx.deps.bus.getRoom(ctx.roomId)
    const attempt = await ctx.deps.exec.integrate({
      roomId: ctx.roomId,
      agentId: ctx.agentId,
      sourceAgentIds: sourceIds.length > 0 ? sourceIds : agents.filter((agent) => agent.id !== ctx.agentId).map((agent) => agent.id),
      decisionRevision: room?.decisionRevision ?? 0,
      checks: args.checks.map((command) => ({ name: command.slice(0, 40), command }))
    })
    const checkLines = attempt.checks
      .map((check) => `- ${check.name}: ${check.status}${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}`)
      .join('\n')
    const verified = attempt.status === 'verified'
    return {
      summary: verified
        ? `Integration verified at ${attempt.revision?.slice(0, 8) ?? 'unknown revision'}`
        : `Integration ${attempt.status}: ${attempt.detail.slice(0, 120)}`,
      content: clip(
        `Integration ${attempt.id} status=${attempt.status} revision=${attempt.revision ?? 'none'}\n${attempt.detail}\n${checkLines}${attempt.conflicts.length > 0 ? `\nConflicts:\n${attempt.conflicts.join('\n')}` : ''}`
      ),
      error: verified ? undefined : attempt.detail,
      refs: attempt.revision ? taskRef(ctx.taskId) : []
    }
  }
})

const presentWorkspace = defineTool<{ title: string; summary: string; taskId: string }>({
  name: 'present_workspace',
  description: 'Write a short report about the current workspace and show it on the files surface as an artifact.',
  parameters: schema(
    { title: str('Report title.'), summary: str('What the workspace currently contains, truthfully.'), task_id: str('Related task id.') },
    ['summary']
  ),
  validate(raw) {
    const a = new ArgReader(raw)
    const title = a.str('title', { max: 120 })
    const summary = a.str('summary', { required: true, min: 4, max: 6000 })
    const taskId = a.str('task_id', { max: 120 })
    return a.finish(() => ({ title, summary, taskId }))
  },
  async run(args, ctx) {
    const room = ctx.deps.bus.getRoom(ctx.roomId)
    const tasks = ctx.deps.bus.getTasks(ctx.roomId)
    const jobs = ctx.deps.bus.getJobs(ctx.roomId)
    const integrations = ctx.deps.bus.getIntegrations(ctx.roomId)
    const body = [
      `# ${args.title || `Workspace report — ${room?.name ?? 'room'}`}`,
      '',
      args.summary,
      '',
      '## Task board',
      ...tasks.map((task) => `- [${task.status}] ${task.title} (${agentName(ctx.deps, ctx.roomId, task.ownerAgentId)})`),
      '',
      '## Commands run',
      ...(jobs.length > 0
        ? jobs.map((job) => `- ${job.label}: ${job.status}${job.exitCode === null ? '' : ` exit ${job.exitCode}`}`)
        : ['- none']),
      '',
      '## Integrations',
      ...(integrations.length > 0
        ? integrations.map((attempt) => `- ${attempt.status} at ${attempt.revision ?? 'unknown revision'}`)
        : ['- none yet'])
    ].join('\n')

    const artifact = await ctx.deps.exec.writeArtifact({
      roomId: ctx.roomId,
      agentId: ctx.agentId,
      taskId: args.taskId ? findTask(ctx, args.taskId)?.id ?? null : ctx.taskId,
      kind: 'report',
      title: args.title || 'Workspace report',
      filename: `workspace-report-${Date.now()}.md`,
      data: body,
      mime: 'text/markdown'
    })
    ctx.deps.bus.proposeStage(ctx.roomId, ctx.agentId, 'files')
    return {
      summary: `Wrote report artifact ${artifact.id}`,
      content: `Report saved as artifact ${artifact.id} (${artifact.path ?? 'inline'}).`,
      refs: [{ kind: 'artifact', artifactId: artifact.id }]
    }
  }
})

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

export const TOOL_DEFINITIONS: readonly ErasedTool[] = [
  // READ
  listFiles,
  readFile,
  searchText,
  inspectDiff,
  getJobOutput,
  waitForJob,
  listTasks,
  listDecisions,
  readBrowser,
  // WRITE / RUN
  writeFile,
  applyPatch,
  runCommand,
  cancelJob,
  startPreview,
  // BROWSER
  browserOpen,
  browserNavigate,
  browserAct,
  browserScreenshot,
  browserNetwork,
  // TEAM
  messageTeammate,
  askHuman,
  createTask,
  assignTask,
  updateTask,
  recordDecision,
  recordMemory,
  submitWork,
  runIntegration,
  presentWorkspace
]

export class ToolRegistry {
  private readonly byName = new Map<string, ErasedTool>()
  private readonly gates = new Map<string, Semaphore>()

  constructor(
    tools: readonly ErasedTool[] = TOOL_DEFINITIONS,
    private readonly settings: () => AppSettings
  ) {
    for (const tool of tools) this.byName.set(tool.name, tool)
  }

  names(): string[] {
    return [...this.byName.keys()]
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  definitions(filter?: readonly string[]): ProviderToolDefinition[] {
    const wanted = filter ? new Set(filter) : null
    const out: ProviderToolDefinition[] = []
    for (const tool of this.byName.values()) {
      if (wanted && !wanted.has(tool.name)) continue
      out.push({ name: tool.name, description: tool.description, parameters: tool.parameters })
    }
    return out
  }

  /** Per-room gate bound to `settings.limits.maxConcurrentToolCalls`. */
  private gate(roomId: string): Semaphore {
    const limit = Math.max(1, this.settings().limits.maxConcurrentToolCalls)
    const existing = this.gates.get(roomId)
    if (existing) {
      existing.setLimit(limit)
      return existing
    }
    const created = new Semaphore(limit)
    this.gates.set(roomId, created)
    return created
  }

  releaseRoom(roomId: string): void {
    this.gates.delete(roomId)
  }

  /**
   * Run one tool call, recording a truthful ToolRun either side of it. The
   * returned content is what the model reads next.
   */
  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolExecution> {
    const bus = ctx.deps.bus
    const startedAt = bus.now()
    const startedMs = Date.now()
    const runId = bus.newId()
    const run: ToolRun = {
      id: runId,
      roomId: ctx.roomId,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      name,
      argsPreview: previewArgs(rawArgs),
      status: 'running',
      summary: 'Running…',
      error: null,
      startedAt,
      endedAt: null,
      durationMs: null
    }
    bus.recordToolRun(run)

    const finish = (
      status: ToolExecution['status'],
      summary: string,
      content: string,
      error: string | null,
      refs: ContextRef[] | undefined
    ): ToolExecution => {
      const finished: ToolRun = {
        ...run,
        status,
        summary: summary.slice(0, 300),
        error,
        endedAt: bus.now(),
        durationMs: Date.now() - startedMs,
        ...(refs && refs.length > 0 ? { refs } : {})
      }
      bus.recordToolRun(finished)
      return { name, status, summary, content, ...(refs && refs.length > 0 ? { refs } : {}) }
    }

    const tool = this.byName.get(name)
    if (!tool) {
      const message = `There is no tool called "${name}". Available tools: ${this.names().join(', ')}.`
      return finish('rejected', 'Unknown tool', message, message, undefined)
    }

    if (ctx.signal.aborted) {
      const message = `"${name}" was not run: the work was cancelled.`
      return finish('cancelled', 'Cancelled before it ran', message, message, undefined)
    }

    const validation = tool.validate(rawArgs)
    if (!validation.ok) {
      const message = `Invalid arguments for ${name}: ${validation.message}. Fix the arguments and call it again.`
      return finish('rejected', `Rejected: ${validation.message.slice(0, 160)}`, message, message, undefined)
    }

    const release = await this.gate(ctx.roomId).acquire()
    try {
      if (ctx.signal.aborted) {
        const message = `"${name}" was not run: the work was cancelled.`
        return finish('cancelled', 'Cancelled before it ran', message, message, undefined)
      }
      const outcome = await tool.run(validation.value, ctx)
      const status: ToolExecution['status'] = outcome.rejected ? 'rejected' : outcome.error ? 'error' : 'ok'
      const error = outcome.error ?? null
      const content = outcome.error ? `${outcome.content}\n\n[${name}: ${outcome.error}]` : outcome.content
      return finish(status, outcome.summary, clip(content), error, outcome.refs)
    } catch (error) {
      if (ctx.signal.aborted) {
        const message = `"${name}" was interrupted because the work was cancelled.`
        return finish('cancelled', 'Cancelled mid-call', message, message, undefined)
      }
      const shape = toErrorShape(error)
      const fix = shape.fix ? ` ${shape.fix}` : ''
      const message = `${name} failed: ${shape.message}.${fix}`
      const label =
        error instanceof HuddleError
          ? `${error.code}: ${shape.message.slice(0, 160)}`
          : `Failed: ${shape.message.slice(0, 160)}`
      return finish('error', label, message, shape.message, undefined)
    } finally {
      release()
    }
  }
}
