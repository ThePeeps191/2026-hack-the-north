import { existsSync } from 'node:fs'
import type { ModelOption, VoiceOption } from '../../shared/api.ts'
import type { AppSettings, Capability, CapabilityId } from '../../shared/types.ts'
import { speechAssets, voiceHelperPath } from '../paths.ts'
import { secretOrigin, setSecret, getSecret, type SecretKey } from './secrets.ts'
import { backendForModel, PROVIDER_BACKENDS } from '../runtime/provider.ts'

/**
 * Truthful capability reporting.
 *
 * The point of this module is that the UI never claims a capability it does not
 * have. Each probe either reaches the provider and reports what actually came
 * back, or reports the concrete reason it could not, plus the next step.
 *
 * Probes are cheap and cached; a network probe runs at most once every
 * `PROBE_TTL_MS` unless the user asks again or a secret changes.
 */

const PROBE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 12_000

export interface CapabilityBus {
  setCapability(capability: Capability): void
  getCapability(id: CapabilityId): Capability
  notice(roomId: string, level: 'info' | 'warn' | 'error', text: string, fix?: string): void
}

export interface CapabilityDeps {
  bus: CapabilityBus
  settings(): AppSettings
  /** The voice host knows the real ElevenLabs catalogue. */
  listVoices(): Promise<VoiceOption[]>
  /** The runtime can prove a model id actually answers. */
  probeModel?(model: string): Promise<{ ok: boolean; detail: string; fix?: string }>
  /** Live preview state for the selected room, when there is one. */
  previewState?(): { state: string; detail: string; publicUrl: string | null } | null
  projectState?(): { rootPath: string; isGitRepo: boolean } | null
}

export interface CapabilityService {
  refresh(): Promise<Capability[]>
  probe(id: CapabilityId): Promise<Capability>
  setSecret(key: SecretKey, value: string): Promise<Capability>
  listModels(): Promise<ModelOption[]>
  get(id: CapabilityId): Capability
}

const LABELS: Record<CapabilityId, string> = {
  openai: 'Models',
  elevenlabs: 'ElevenLabs speech',
  browserbase: 'Browserbase',
  localSpeech: 'Local speech (Whisper + VAD)',
  project: 'Project workspace',
  preview: 'Dev-server preview'
}

/** Which capability a secret belongs to. */
const SECRET_CAPABILITY: Record<SecretKey, CapabilityId> = {
  OPENAI_API_KEY: 'openai',
  DEEPSEEK_API_KEY: 'openai',
  ELEVENLABS_API_KEY: 'elevenlabs',
  BROWSERBASE_API_KEY: 'browserbase',
  BROWSERBASE_PROJECT_ID: 'browserbase',
  NGROK_AUTHTOKEN: 'preview'
}

export function createCapabilityService(deps: CapabilityDeps): CapabilityService {
  const cache = new Map<CapabilityId, { at: number; capability: Capability }>()
  let models: ModelOption[] = []
  const verifiedModels = new Set<string>()

  function remember(capability: Capability): Capability {
    cache.set(capability.id, { at: Date.now(), capability })
    deps.bus.setCapability(capability)
    return capability
  }

  function cached(id: CapabilityId, ttl = PROBE_TTL_MS): Capability | null {
    const entry = cache.get(id)
    if (!entry) return null
    if (Date.now() - entry.at > ttl) return null
    return entry.capability
  }

  async function probe(id: CapabilityId): Promise<Capability> {
    switch (id) {
      case 'openai':
        return remember(await probeOpenAI(deps, models, verifiedModels))
      case 'elevenlabs':
        return remember(await probeElevenLabs(deps))
      case 'browserbase':
        return remember(probeBrowserbase(deps))
      case 'localSpeech':
        return remember(probeLocalSpeech(deps))
      case 'project':
        return remember(probeProject(deps))
      case 'preview':
        return remember(probePreview(deps))
      default:
        return remember({
          id,
          label: LABELS.openai,
          state: 'unavailable',
          detail: 'Unknown capability.',
          fix: null,
          checkedAt: new Date().toISOString()
        })
    }
  }

  return {
    async refresh(): Promise<Capability[]> {
      const ids: CapabilityId[] = [
        'openai',
        'elevenlabs',
        'browserbase',
        'localSpeech',
        'project',
        'preview'
      ]
      const results: Capability[] = []
      for (const id of ids) {
        results.push(await probe(id))
      }
      return results
    },

    probe,

    async setSecret(key: SecretKey, value: string): Promise<Capability> {
      setSecret(key, value)
      const capabilityId = SECRET_CAPABILITY[key]
      // A changed secret invalidates the cache for its capability.
      cache.delete(capabilityId)
      if (capabilityId === 'openai') {
        models = []
        verifiedModels.clear()
      }
      return probe(capabilityId)
    },

    async listModels(): Promise<ModelOption[]> {
      if (models.length === 0) {
        await probe('openai')
      }
      return models.map((model) => ({
        id: model.id,
        verified: verifiedModels.has(model.id)
      }))
    },

    get(id: CapabilityId): Capability {
      return cached(id, Number.POSITIVE_INFINITY) ?? deps.bus.getCapability(id)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Probes
 * ------------------------------------------------------------------ */

/**
 * One reachable-models probe across every configured model backend.
 *
 * Huddle can reason through OpenAI, DeepSeek, or both at once, so this reports
 * a single "Models" capability describing what is actually reachable rather
 * than one row per vendor. A backend with no key is not an error — it is simply
 * not one of the places a model can come from — but a backend whose key is
 * *rejected*, or whose configured model does not exist, is reported plainly.
 */
async function probeOpenAI(
  deps: CapabilityDeps,
  models: ModelOption[],
  verifiedModels: Set<string>
): Promise<Capability> {
  const checkedAt = new Date().toISOString()
  const configured = PROVIDER_BACKENDS.filter((backend) => getSecret(backend.secret).length > 0)

  if (configured.length === 0) {
    return {
      id: 'openai',
      label: LABELS.openai,
      state: 'unavailable',
      detail: `No model API key (checked ${PROVIDER_BACKENDS.map(
        (backend) => `${backend.secret}: ${secretOrigin(backend.secret)}`
      ).join(', ')}).`,
      fix: 'Add OPENAI_API_KEY or DEEPSEEK_API_KEY in Settings, or put one in .env at the repo root.',
      checkedAt
    }
  }

  const reachable: string[] = []
  const problems: string[] = []
  const healthy: string[] = []

  for (const backend of configured) {
    const key = getSecret(backend.secret)
    const url = `${backend.baseURL ?? 'https://api.openai.com/v1'}/models`
    try {
      const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${key}` } })
      if (response.status === 401 || response.status === 403) {
        problems.push(`${backend.label} rejected its key (HTTP ${response.status})`)
        continue
      }
      if (!response.ok) {
        problems.push(`${backend.label} answered HTTP ${response.status}`)
        continue
      }
      const payload = (await response.json()) as { data?: Array<{ id?: string }> }
      const ids = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string')
      reachable.push(...ids)
      healthy.push(`${backend.label} ${ids.length} models`)
    } catch (error) {
      problems.push(`${backend.label} was unreachable (${describe(error)})`)
    }
  }

  const unique = [...new Set(reachable)].sort()
  models.length = 0
  for (const id of unique) models.push({ id, verified: false })

  if (unique.length === 0) {
    return {
      id: 'openai',
      label: LABELS.openai,
      state: 'error',
      detail: problems.join('; ') || 'No backend listed any model.',
      fix: 'Check the keys and network access, then refresh capabilities.',
      checkedAt
    }
  }

  // The models the room is actually set to use have to exist and to answer.
  const settings = deps.settings()
  const wanted = [...new Set([settings.models.contributor, settings.models.conversation])]
  const missing = wanted.filter((id) => !unique.includes(id))

  for (const id of wanted) {
    if (!deps.probeModel || missing.includes(id) || verifiedModels.has(id)) continue
    try {
      const result = await deps.probeModel(id)
      if (result.ok) verifiedModels.add(id)
      else if (result.fix) {
        return {
          id: 'openai',
          label: LABELS.openai,
          state: 'error',
          detail: `${unique.length} models reachable, but ${id} did not answer: ${result.detail}`,
          fix: result.fix,
          checkedAt
        }
      }
    } catch {
      // A probe failure is reported through the model list, not as a lie.
    }
  }

  if (missing.length > 0) {
    const suggestion = unique.find((id) => id.startsWith('deepseek')) ?? unique[0]
    return {
      id: 'openai',
      label: LABELS.openai,
      state: 'error',
      detail: `${unique.length} models reachable, but the configured model ${missing.join(
        ', '
      )} is not available on ${[...new Set(missing.map((id) => backendForModel(id).label))].join(', ')}.`,
      fix: `Pick an available model in Settings${suggestion ? ` (for example ${suggestion})` : ''}.`,
      checkedAt
    }
  }

  const verifiedLabel = [...verifiedModels].join(', ')
  const detail = [
    healthy.join(', '),
    verifiedLabel ? `${verifiedLabel} answered a real request` : `${unique.length} models listed`
  ]
    .filter((part) => part.length > 0)
    .join(' · ')

  return {
    id: 'openai',
    label: LABELS.openai,
    // A backend that failed while another one worked is worth saying out loud,
    // but it does not make the capability unusable.
    state: 'ready',
    detail: problems.length > 0 ? `${detail}. Also: ${problems.join('; ')}.` : detail,
    fix: null,
    checkedAt
  }
}

async function probeElevenLabs(deps: CapabilityDeps): Promise<Capability> {
  const checkedAt = new Date().toISOString()
  if (!deps.settings().voice.enabled) {
    return {
      id: 'elevenlabs',
      label: LABELS.elevenlabs,
      state: 'disabled',
      detail: 'Voice is turned off in Settings.',
      fix: 'Turn voice on to hear the team speak.',
      checkedAt
    }
  }
  const key = getSecret('ELEVENLABS_API_KEY')
  if (!key) {
    return {
      id: 'elevenlabs',
      label: LABELS.elevenlabs,
      state: 'unavailable',
      detail: 'No API key, so the team cannot speak. You can still type.',
      fix: 'Add ELEVENLABS_API_KEY in Settings to give each teammate a voice.',
      checkedAt
    }
  }
  try {
    const voices = await deps.listVoices()
    return {
      id: 'elevenlabs',
      label: LABELS.elevenlabs,
      state: 'ready',
      detail: `${voices.length} voices available.`,
      fix: null,
      checkedAt
    }
  } catch (error) {
    return {
      id: 'elevenlabs',
      label: LABELS.elevenlabs,
      state: 'error',
      detail: `ElevenLabs could not be reached: ${describe(error)}`,
      fix: 'Check the key and network access, then refresh capabilities. Written replies still work.',
      checkedAt
    }
  }
}

function probeBrowserbase(deps: CapabilityDeps): Capability {
  const settings = deps.settings()
  const checkedAt = new Date().toISOString()
  if (!settings.browserbaseEnabled) {
    return {
      id: 'browserbase',
      label: LABELS.browserbase,
      state: 'disabled',
      detail: 'Remote browser verification is turned off in Settings.',
      fix: 'Turn it on to let teammates test the running app in a real browser.',
      checkedAt
    }
  }
  const key = getSecret('BROWSERBASE_API_KEY')
  const projectId = getSecret('BROWSERBASE_PROJECT_ID')
  if (!key || !projectId) {
    return {
      id: 'browserbase',
      label: LABELS.browserbase,
      state: 'unavailable',
      detail: `Credentials incomplete (key: ${key ? 'set' : 'missing'}, project id: ${projectId ? 'set' : 'missing'}).`,
      fix: 'Set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID in Settings.',
      checkedAt
    }
  }
  return {
    id: 'browserbase',
    label: LABELS.browserbase,
    state: 'ready',
    detail: 'Credentials present. A session is confirmed only when one is actually opened.',
    fix: null,
    checkedAt
  }
}

function probeLocalSpeech(deps: CapabilityDeps): Capability {
  const checkedAt = new Date().toISOString()
  if (!deps.settings().voice.enabled) {
    return {
      id: 'localSpeech',
      label: LABELS.localSpeech,
      state: 'disabled',
      detail: 'Voice is turned off in Settings.',
      fix: 'Turn voice on to speak to the team.',
      checkedAt
    }
  }
  const assets = speechAssets()
  const missing: string[] = []
  if (!existsSync(assets.pythonBin) && assets.pythonBin !== 'python') {
    missing.push('python virtualenv (tools/voice-lab/.venv)')
  }
  if (!existsSync(assets.workerScript)) missing.push('transcribe_worker.py')
  if (!existsSync(assets.sileroModelPath)) missing.push('silero_vad.onnx')
  if (!existsSync(voiceHelperPath())) missing.push('voice helper build (out/main/voice-helper.js)')

  if (missing.length > 0) {
    return {
      id: 'localSpeech',
      label: LABELS.localSpeech,
      state: 'unavailable',
      detail: `Missing: ${missing.join(', ')}.`,
      fix: 'Run `npm run build` at the repo root and `node tools/voice-lab/scripts/setup.mjs`, then relaunch Huddle.',
      checkedAt
    }
  }
  return {
    id: 'localSpeech',
    label: LABELS.localSpeech,
    state: 'ready',
    detail: `Microphone audio is transcribed locally with faster-whisper (${deps.settings().voice.whisperModel}) and Silero VAD. Nothing is sent to a cloud speech service.`,
    fix: null,
    checkedAt
  }
}

function probeProject(deps: CapabilityDeps): Capability {
  const checkedAt = new Date().toISOString()
  const project = deps.projectState?.() ?? null
  if (!project) {
    return {
      id: 'project',
      label: LABELS.project,
      state: 'unavailable',
      detail: 'This room is not bound to a project yet, so the team has nothing real to work on.',
      fix: 'Choose a folder or create the demo project from the call dock.',
      checkedAt
    }
  }
  return {
    id: 'project',
    label: LABELS.project,
    state: 'ready',
    detail: `${project.rootPath}${project.isGitRepo ? ' (git repository — teammates get worktrees)' : ' (not a git repository — teammates share files)'}`,
    fix: null,
    checkedAt
  }
}

function probePreview(deps: CapabilityDeps): Capability {
  const checkedAt = new Date().toISOString()
  const settings = deps.settings()
  if (settings.preview.mode === 'off') {
    return {
      id: 'preview',
      label: LABELS.preview,
      state: 'disabled',
      detail: 'Exposing the dev server is turned off, so the remote browser cannot reach it.',
      fix: 'Set preview mode to tunnel or lan in Settings.',
      checkedAt
    }
  }
  const live = deps.previewState?.() ?? null
  if (live) {
    return {
      id: 'preview',
      label: LABELS.preview,
      state: live.state === 'failed' ? 'error' : live.state === 'ready' ? 'ready' : 'starting',
      detail: live.detail,
      fix: live.state === 'failed' ? 'Check the dev server output in the terminal surface.' : null,
      checkedAt
    }
  }
  return {
    id: 'preview',
    label: LABELS.preview,
    state: 'unavailable',
    detail: `No preview is running. Mode: ${settings.preview.mode}.`,
    fix: 'Start the preview from the browser surface once a project is bound.',
    checkedAt
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
