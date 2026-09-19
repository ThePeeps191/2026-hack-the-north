import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile as writeFileToDisk } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type {
  CreateExecutionHost,
  ExecutionHost,
  ExecutionHostDeps,
  IntegrateInput,
  PatchResult,
  SearchHit,
  StartJobInput,
  SubmitInput,
  SubmitResult,
  WriteResult
} from '../contracts.ts'
import type { DirEntry, FileContents, JobOutput, PreviewInfo, WorkspaceDiff } from '../../shared/api.ts'
import type {
  Artifact,
  Capability,
  IntegrationAttempt,
  JobRecord,
  ProjectBinding,
  WorkspaceRecord
} from '../../shared/types.ts'
import { HuddleError } from '../huddle-error.ts'
import { artifactsDir } from '../paths.ts'
import { computeWorkspaceDiff } from './diff.ts'
import {
  DEFAULT_MAX_READ_BYTES,
  MAX_READ_BYTES,
  detectLanguage,
  listWorkspaceDir,
  readWorkspaceFile,
  searchWorkspace,
  writeWorkspaceFile
} from './files.ts'
import { IntegrationRunner } from './integrate.ts'
import { JobManager } from './jobs.ts'
import { applyUnifiedPatch, type PatchTargets } from './patch.ts'
import { resolveInsideWorkspace, safeFilename } from './path-safety.ts'
import { PreviewManager } from './preview.ts'
import { bindProjectDirectory, demoTemplate, suggestDemoPath } from './projects.ts'
import { commitWorkspace } from './submit.ts'
import { WorkspaceManager } from './workspaces.ts'

/**
 * The composition root of the execution host.
 *
 * Every capability here is a real filesystem, git or process operation on the
 * room's bound project. When something is not possible — no git, no dev script,
 * no network — the host says so with a `HuddleError`, a notice, or a field in
 * the returned record. It never fabricates a result to look busy.
 */

class ExecutionHostImpl implements ExecutionHost {
  private readonly deps: ExecutionHostDeps
  private readonly projects = new Map<string, ProjectBinding>()
  private readonly workspaces: WorkspaceManager
  private readonly jobs: JobManager
  private readonly integrations: IntegrationRunner
  private readonly preview: PreviewManager

  constructor(deps: ExecutionHostDeps) {
    this.deps = deps
    this.workspaces = new WorkspaceManager({
      bus: deps.bus,
      project: (roomId) => this.resolveProject(roomId)
    })
    this.jobs = new JobManager({
      bus: deps.bus,
      workspace: (workspaceId) => this.workspaces.get(workspaceId),
      onPortDetected: (record, port) => {
        const workspace = this.workspaces.get(record.workspaceId)
        if (workspace === null) return
        this.workspaces.update({ ...workspace, devPort: port, devJobId: record.id })
      },
      onJobFinished: (record) => {
        const workspace = this.workspaces.get(record.workspaceId)
        if (workspace !== null && workspace.devJobId === record.id) {
          this.workspaces.update({ ...workspace, devJobId: null, devPort: null })
        }
        this.preview.onJobFinished(record)
      }
    })
    this.integrations = new IntegrationRunner({
      bus: deps.bus,
      jobs: this.jobs,
      workspaces: this.workspaces,
      project: (roomId) => this.resolveProject(roomId),
      writeArtifact: (input) => this.writeArtifact(input)
    })
    this.preview = new PreviewManager({
      bus: deps.bus,
      jobs: this.jobs,
      workspace: (workspaceId) => this.workspaces.get(workspaceId),
      settings: () => this.deps.settings(),
      updateWorkspace: (record) => this.workspaces.update(record)
    })
  }

  /* ---------------------------------------------------------------- *
   * Project binding
   * ---------------------------------------------------------------- */

  private async resolveProject(roomId: string): Promise<ProjectBinding> {
    const room = this.deps.bus.getRoom(roomId)
    const roomProject = room?.project ?? null
    const cached = this.projects.get(roomId)

    // A room-level re-bind always wins over what this host cached earlier.
    if (roomProject !== null && cached !== undefined && cached.rootPath !== roomProject.rootPath) {
      this.projects.set(roomId, roomProject)
      if (existsSync(roomProject.rootPath)) return roomProject
    }
    if (cached !== undefined && existsSync(cached.rootPath)) return cached

    const project = roomProject
    if (project === null) {
      throw new HuddleError(
        'no_project',
        'No project folder is bound to this room yet.',
        'Bind an existing folder or create the demo project from the room header.'
      )
    }
    if (!existsSync(project.rootPath)) {
      throw new HuddleError(
        'project_missing',
        `The bound project folder ${project.rootPath} is no longer there.`,
        'Bind the project folder again.'
      )
    }
    this.projects.set(roomId, project)
    return project
  }

  async bindProject(
    roomId: string,
    rootPath: string,
    kind: 'existing' | 'demo'
  ): Promise<ProjectBinding> {
    const binding = await bindProjectDirectory(rootPath, {
      kind,
      notify: (level, text, fix) => this.deps.bus.notice(roomId, level, text, fix)
    })
    this.projects.set(roomId, binding)
    return binding
  }

  demoTemplatePath(): string {
    return demoTemplate()
  }

  suggestDemoPath(roomId: string): string {
    return suggestDemoPath(roomId)
  }

  /* ---------------------------------------------------------------- *
   * Workspaces
   * ---------------------------------------------------------------- */

  async ensureTeamWorkspace(roomId: string): Promise<WorkspaceRecord> {
    return this.workspaces.ensureTeamWorkspace(roomId)
  }

  async ensureAgentWorkspace(roomId: string, agentId: string): Promise<WorkspaceRecord> {
    return this.workspaces.ensureAgentWorkspace(roomId, agentId)
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | null {
    return this.workspaces.get(workspaceId)
  }

  private requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.workspaces.get(workspaceId)
    if (workspace === null) {
      throw new HuddleError(
        'workspace_unknown',
        `No workspace ${workspaceId} is registered in this session.`,
        'Bind the project again from the room header.'
      )
    }
    return workspace
  }

  /* ---------------------------------------------------------------- *
   * Files
   * ---------------------------------------------------------------- */

  async readFile(workspaceId: string, path: string, maxBytes?: number): Promise<FileContents> {
    const workspace = this.requireWorkspace(workspaceId)
    const result = await readWorkspaceFile(workspace.rootPath, path, maxBytes ?? DEFAULT_MAX_READ_BYTES)
    const resolved = await resolveInsideWorkspace(workspace.rootPath, path)
    return {
      path: resolved.absolute,
      relativePath: resolved.relative,
      text: result.text,
      language: detectLanguage(resolved.relative),
      bytes: result.bytes,
      truncated: result.truncated,
      modifiedAt: result.modifiedAt
    }
  }

  async listDir(workspaceId: string, path?: string): Promise<DirEntry[]> {
    const workspace = this.requireWorkspace(workspaceId)
    return listWorkspaceDir(workspace.rootPath, path)
  }

  async search(
    workspaceId: string,
    query: string,
    opts?: { glob?: string; max?: number }
  ): Promise<SearchHit[]> {
    const workspace = this.requireWorkspace(workspaceId)
    const result = await searchWorkspace(workspace.rootPath, query, opts)
    if (result.truncated) {
      this.deps.bus.notice(
        workspace.roomId,
        'info',
        `Search for "${query}" stopped early: ${result.detail}`,
        'Narrow the query or add a glob to see fewer results.'
      )
    }
    return result.hits
  }

  async writeFile(workspaceId: string, path: string, contents: string): Promise<WriteResult> {
    const workspace = this.requireWorkspace(workspaceId)
    return writeWorkspaceFile(workspace.rootPath, path, contents)
  }

  private patchTargets(workspace: WorkspaceRecord): PatchTargets {
    const root = workspace.rootPath
    return {
      read: async (relativePath) => {
        try {
          const file = await readWorkspaceFile(root, relativePath, MAX_READ_BYTES)
          return file.text
        } catch (error) {
          if (error instanceof HuddleError && error.code === 'file_not_found') return null
          throw error
        }
      },
      write: async (relativePath, contents) => {
        const written = await writeWorkspaceFile(root, relativePath, contents)
        return written.bytes
      },
      remove: async (relativePath) => {
        const resolved = await resolveInsideWorkspace(root, relativePath)
        await rm(resolved.absolute, { force: true })
      }
    }
  }

  async applyPatch(workspaceId: string, patch: string): Promise<PatchResult> {
    const workspace = this.requireWorkspace(workspaceId)
    return applyUnifiedPatch(patch, this.patchTargets(workspace))
  }

  async diff(workspaceId: string): Promise<WorkspaceDiff> {
    const workspace = this.requireWorkspace(workspaceId)
    return computeWorkspaceDiff(workspace)
  }

  /* ---------------------------------------------------------------- *
   * Jobs
   * ---------------------------------------------------------------- */

  async startJob(input: StartJobInput): Promise<JobRecord> {
    const record = await this.jobs.startJob(input)
    if (input.devServer === true) {
      const workspace = this.workspaces.get(input.workspaceId)
      if (workspace !== null) this.workspaces.update({ ...workspace, devJobId: record.id })
    }
    return record
  }

  async cancelJob(jobId: string): Promise<JobRecord> {
    return this.jobs.cancelJob(jobId)
  }

  getJobOutput(jobId: string, maxChars?: number): JobOutput {
    return this.jobs.getJobOutput(jobId, maxChars)
  }

  async waitForJob(jobId: string, timeoutMs: number): Promise<JobRecord> {
    return this.jobs.waitForJob(jobId, timeoutMs)
  }

  /* ---------------------------------------------------------------- *
   * Submit and integrate
   * ---------------------------------------------------------------- */

  async submitWork(input: SubmitInput): Promise<SubmitResult> {
    const workspace = this.requireWorkspace(input.workspaceId)
    const agent = this.deps.bus.getAgent(input.agentId)
    const result = await commitWorkspace(workspace.rootPath, !workspace.isWorktree, {
      summary: input.summary,
      agentName: agent?.name ?? input.agentId.slice(0, 6),
      agentId: input.agentId,
      taskId: input.taskId
    })
    if (result.commit.length === 0) {
      this.deps.bus.notice(input.roomId, 'info', result.detail)
    } else {
      this.deps.bus.notice(
        input.roomId,
        'info',
        `${agent?.name ?? 'Agent'} committed ${result.filesChanged} file(s) on ${result.branch} (${result.commit.slice(0, 8)}).`
      )
    }
    return result
  }

  async integrate(input: IntegrateInput): Promise<IntegrationAttempt> {
    return this.integrations.run(input)
  }

  /* ---------------------------------------------------------------- *
   * Preview
   * ---------------------------------------------------------------- */

  async startPreview(roomId: string, workspaceId: string): Promise<PreviewInfo> {
    const info = await this.preview.startPreview(roomId, workspaceId)
    if (info.state === 'off') return info
    // Degrade honestly: if the capability provider says previews are not ready,
    // say so next to the real result instead of hiding it.
    const capability = this.tryCapability('preview')
    if (capability === null || capability.state === 'ready') return info
    return {
      ...info,
      detail: `${info.detail} (The preview capability reports ${capability.state}: ${capability.detail})`
    }
  }

  private tryCapability(id: Capability['id']): Capability | null {
    try {
      return this.deps.capability(id)
    } catch {
      return null
    }
  }

  getPreview(roomId: string, workspaceId: string): PreviewInfo | null {
    return this.preview.getPreview(roomId, workspaceId)
  }

  async stopPreview(roomId: string): Promise<void> {
    await this.preview.stopPreview(roomId)
  }

  /* ---------------------------------------------------------------- *
   * Artifacts
   * ---------------------------------------------------------------- */

  artifactDir(roomId: string): string {
    const directory = artifactsDir(roomId)
    return directory
  }

  async writeArtifact(input: {
    roomId: string
    agentId: string | null
    taskId: string | null
    kind: Artifact['kind']
    title: string
    filename: string
    data: Buffer | string
    mime: string
  }): Promise<Artifact> {
    const directory = this.artifactDir(input.roomId)
    await mkdir(directory, { recursive: true })
    const id = this.deps.bus.newId()
    const buffer = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : input.data
    const target = join(directory, uniqueFilename(directory, safeFilename(input.filename, `${input.kind}-${id.slice(0, 8)}`)))
    await writeFileToDisk(target, buffer)
    const artifact: Artifact = {
      id,
      roomId: input.roomId,
      agentId: input.agentId,
      taskId: input.taskId,
      kind: input.kind,
      title: input.title,
      path: target,
      mime: input.mime,
      bytes: buffer.byteLength,
      createdAt: this.deps.bus.now()
    }
    this.deps.bus.addArtifact(artifact)
    return artifact
  }

  /* ---------------------------------------------------------------- *
   * Reconciliation and teardown
   * ---------------------------------------------------------------- */

  async reconcile(jobs: JobRecord[], workspaces: WorkspaceRecord[]): Promise<void> {
    for (const workspace of workspaces) this.workspaces.remember(workspace)
    await this.jobs.reconcile(jobs, workspaces)
  }

  async disposeRoom(roomId: string): Promise<void> {
    await this.preview.stopPreview(roomId)
    this.preview.disposeRoom(roomId)
    await this.jobs.disposeRoom(roomId)
    this.projects.delete(roomId)
  }

  async dispose(): Promise<void> {
    this.preview.dispose()
    await this.jobs.dispose()
    this.projects.clear()
  }
}

function uniqueFilename(directory: string, filename: string): string {
  if (!existsSync(join(directory, filename))) return filename
  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  for (let counter = 1; counter < 100; counter += 1) {
    const candidate = `${stem}-${counter}${extension}`
    if (!existsSync(join(directory, candidate))) return candidate
  }
  return `${stem}-${Date.now()}${extension}`
}

export const createExecutionHost: CreateExecutionHost = (deps: ExecutionHostDeps): ExecutionHost =>
  new ExecutionHostImpl(deps)
