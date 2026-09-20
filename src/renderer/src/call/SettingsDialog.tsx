import { useState, type JSX } from 'react'
import type {
  Agent,
  AppSettings,
  Capability,
  CapabilityState,
  ProjectBinding
} from '../../../shared/types'
import { AGENT_PRESETS } from '../../../shared/presets'
import { basename } from './derive'
import { formatDateTime, formatRelative, roleLabel, truncate } from './format'
import { RefreshIcon, VolumeIcon } from './icons'
import { Badge, Button, Modal, SectionLabel, Toggle } from './ui'
import type { Tone } from './format'

/**
 * Settings.
 *
 * Everything here is a real setting the backend reads: models, voice and
 * capture behaviour, preview mode, concurrency limits, teammate voices and the
 * API keys. Keys are write-only — Huddle never shows a stored value back.
 */

const SECRET_FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key', hint: 'Used for the conversation and contributor models.' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', hint: 'Used for teammate speech.' },
  { key: 'BROWSERBASE_API_KEY', label: 'Browserbase API key', hint: 'Used for real browser sessions.' },
  {
    key: 'BROWSERBASE_PROJECT_ID',
    label: 'Browserbase project id',
    hint: 'The project that browser sessions are created in.'
  },
]

const STATE_TONES: Record<CapabilityState, Tone | 'accent' | 'muted'> = {
  ready: 'done',
  starting: 'wait',
  unavailable: 'quiet',
  error: 'stop',
  disabled: 'quiet'
}

export interface SettingsDialogProps {
  settings: AppSettings
  capabilities: Capability[]
  agents: Agent[]
  project: ProjectBinding | null
  now: number
  onClose: () => void
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>
  onSetSecret: (key: string, value: string) => Promise<void>
  onRefreshCapabilities: () => void
  onPreviewVoice: (voiceId: string) => void
  onSetAgentVoice: (agentId: string, voiceId: string) => void
  onRevealPath: (path: string) => void
  onChooseProject: () => void
  onUseDemoProject: () => void
}

export function SettingsDialog({
  settings,
  capabilities,
  agents,
  project,
  now,
  onClose,
  onUpdate,
  onSetSecret,
  onRefreshCapabilities,
  onPreviewVoice,
  onSetAgentVoice,
  onRevealPath,
  onChooseProject,
  onUseDemoProject
}: SettingsDialogProps): JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({})
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const patchVoice = (patch: Partial<AppSettings['voice']>): void =>
    setDraft((current) => ({ ...current, voice: { ...current.voice, ...patch } }))
  const patchModels = (patch: Partial<AppSettings['models']>): void =>
    setDraft((current) => ({ ...current, models: { ...current.models, ...patch } }))
  const patchPreview = (patch: Partial<AppSettings['preview']>): void =>
    setDraft((current) => ({ ...current, preview: { ...current.preview, ...patch } }))
  const patchLimits = (patch: Partial<AppSettings['limits']>): void =>
    setDraft((current) => ({ ...current, limits: { ...current.limits, ...patch } }))

  const numberFrom = (value: string, fallback: number): number => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <Modal
      title="Settings"
      detail="Voice, models, limits, teammates and keys. Huddle stores these locally."
      onClose={onClose}
      width={620}
      footer={
        <>
          <span className="hs-settings-foot">
            {saveError ? (
              <Badge tone="stop">{saveError}</Badge>
            ) : savedAt ? (
              <Badge tone="done">saved {formatRelative(new Date(savedAt).toISOString(), now)}</Badge>
            ) : dirty ? (
              <Badge tone="wait">unsaved changes</Badge>
            ) : (
              <span className="hs-settings-hint">No unsaved changes</span>
            )}
          </span>
          <span className="hs-settings-foot-actions">
            <Button
              variant="ghost"
              disabled={!dirty || saving}
              hint={dirty ? 'Discards your edits' : 'Nothing has been changed yet'}
              onClick={() => setDraft(settings)}
            >
              Reset
            </Button>
            <Button
              variant="primary"
              disabled={!dirty}
              hint={dirty ? 'Writes these settings to the room' : 'Nothing has been changed yet'}
              onClick={() => {
                setSaving(true)
                void onUpdate(draft)
                  .then(() => {
                    setSaveError(null)
                    setSavedAt(Date.now())
                  })
                  .catch((error: unknown) => {
                    setSaveError(error instanceof Error ? error.message : 'Could not save settings')
                  })
                  .finally(() => setSaving(false))
              }}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </span>
        </>
      }
    >
      <section className="hs-settings-section" aria-label="Capabilities">
        <SectionLabel
          aside={
            <Button variant="ghost" onClick={onRefreshCapabilities} hint="Re-checks every provider and the local project">
              <span className="hs-btn-inner">
                <RefreshIcon size={14} /> Refresh
              </span>
            </Button>
          }
        >
          Capabilities
        </SectionLabel>
        <ul className="hs-caps">
          {capabilities.map((capability) => (
            <li key={capability.id} className="hs-cap">
              <Badge tone={STATE_TONES[capability.state]}>{capability.state}</Badge>
              <span className="hs-cap-label">{capability.label}</span>
              <span className="hs-cap-detail" title={`${capability.detail} · checked ${formatDateTime(capability.checkedAt)}`}>
                {truncate(capability.detail, 90)}
              </span>
              {capability.fix ? <span className="hs-cap-fix">{truncate(capability.fix, 90)}</span> : null}
            </li>
          ))}
          {capabilities.length === 0 ? (
            <li className="hs-work-empty">No capability checks have run yet.</li>
          ) : null}
        </ul>
      </section>

      <section className="hs-settings-section" aria-label="Project">
        <SectionLabel>Project</SectionLabel>
        {project ? (
          <p className="hs-settings-line">
            <span className="hs-mono" title={project.rootPath}>
              {basename(project.rootPath)}
            </span>
            <Badge tone={project.kind === 'demo' ? 'accent' : 'plain'}>
              {project.kind === 'demo' ? 'demo copy' : 'folder'}
            </Badge>
            <Badge tone={project.isGitRepo ? 'plain' : 'wait'}>
              {project.isGitRepo ? 'git repository' : 'no git'}
            </Badge>
            <Button variant="ghost" onClick={() => onRevealPath(project.rootPath)} hint="Opens the project folder">
              Reveal
            </Button>
            <Button variant="ghost" onClick={onChooseProject} hint="Binds a different folder to this room">
              Change folder
            </Button>
          </p>
        ) : (
          <p className="hs-settings-line">
            <span>No project is bound to this room.</span>
            <Button variant="primary" onClick={onChooseProject} hint="Binds an existing folder">
              Choose folder
            </Button>
            {/* Sketch Night demo bind is parked. Bind a real folder instead. */}
          </p>
        )}
      </section>

      <section className="hs-settings-section" aria-label="Models">
        <SectionLabel>Models</SectionLabel>
        <div className="hs-settings-grid">
          <label className="hs-field">
            <span className="hs-field-label">Contributor model</span>
            <input
              className="hs-input"
              value={draft.models.contributor}
              onChange={(event) => patchModels({ contributor: event.target.value })}
            />
            <span className="hs-field-hint">Planning, coding and tool loops on real tasks.</span>
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Conversation model</span>
            <input
              className="hs-input"
              value={draft.models.conversation}
              onChange={(event) => patchModels({ conversation: event.target.value })}
            />
            <span className="hs-field-hint">Fast replies and routing during the call.</span>
          </label>
        </div>
      </section>

      <section className="hs-settings-section" aria-label="Voice">
        <SectionLabel>Voice</SectionLabel>
        <Toggle
          checked={draft.voice.enabled}
          onChange={(next) => patchVoice({ enabled: next })}
          label="Speech in calls"
          detail="Teammates speak their short turns out loud, and you can interrupt them."
        />
        <div className="hs-settings-grid">
          <label className="hs-field">
            <span className="hs-field-label">Input device id</span>
            <input
              className="hs-input"
              value={draft.voice.inputDeviceId ?? ''}
              placeholder="system default"
              onChange={(event) => patchVoice({ inputDeviceId: event.target.value || null })}
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Output device id</span>
            <input
              className="hs-input"
              value={draft.voice.outputDeviceId ?? ''}
              placeholder="system default"
              onChange={(event) => patchVoice({ outputDeviceId: event.target.value || null })}
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Speech model</span>
            <input
              className="hs-input"
              value={draft.voice.whisperModel}
              onChange={(event) => patchVoice({ whisperModel: event.target.value })}
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">End of speech silence (ms)</span>
            <input
              className="hs-input"
              type="number"
              min={200}
              max={4000}
              step={50}
              value={draft.voice.endpointSilenceMs}
              onChange={(event) =>
                patchVoice({ endpointSilenceMs: numberFrom(event.target.value, draft.voice.endpointSilenceMs) })
              }
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Barge-in threshold</span>
            <input
              className="hs-input"
              type="number"
              min={0.1}
              max={0.99}
              step={0.05}
              value={draft.voice.bargeInThreshold}
              onChange={(event) =>
                patchVoice({ bargeInThreshold: numberFrom(event.target.value, draft.voice.bargeInThreshold) })
              }
            />
          </label>
        </div>
        <Toggle
          checked={draft.voice.saveRawAudio}
          onChange={(next) => patchVoice({ saveRawAudio: next })}
          label="Keep raw microphone audio"
          detail="Off by default. When off, only transcribed text is stored."
        />
      </section>

      <section className="hs-settings-section" aria-label="Preview and browser">
        <SectionLabel>Preview and browser</SectionLabel>
        <div className="hs-settings-grid">
          <label className="hs-field">
            <span className="hs-field-label">Preview mode</span>
            <select
              className="hs-select"
              value={draft.preview.mode}
              onChange={(event) =>
                patchPreview({ mode: event.target.value as AppSettings['preview']['mode'] })
              }
            >
              <option value="tunnel">tunnel</option>
              <option value="lan">LAN</option>
              <option value="off">off</option>
            </select>
            <span className="hs-field-hint">How the remote browser reaches your dev server.</span>
          </label>
          <label className="hs-field">
            <span className="hs-field-label">LAN host</span>
            <input
              className="hs-input"
              value={draft.preview.lanHost ?? ''}
              placeholder="192.168.x.x"
              onChange={(event) => patchPreview({ lanHost: event.target.value || null })}
            />
          </label>
        </div>
        <Toggle
          checked={draft.browserbaseEnabled}
          onChange={(next) => setDraft((current) => ({ ...current, browserbaseEnabled: next }))}
          label="Browser automation"
          detail="Lets Sam drive a real browser session and file screenshot evidence."
        />
      </section>

      <section className="hs-settings-section" aria-label="Limits">
        <SectionLabel>Limits</SectionLabel>
        <div className="hs-settings-grid">
          <label className="hs-field">
            <span className="hs-field-label">Concurrent builds</span>
            <input
              className="hs-input"
              type="number"
              min={1}
              max={4}
              value={draft.limits.maxConcurrentBuilds}
              onChange={(event) =>
                patchLimits({ maxConcurrentBuilds: numberFrom(event.target.value, draft.limits.maxConcurrentBuilds) })
              }
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Concurrent tool calls</span>
            <input
              className="hs-input"
              type="number"
              min={1}
              max={16}
              value={draft.limits.maxConcurrentToolCalls}
              onChange={(event) =>
                patchLimits({
                  maxConcurrentToolCalls: numberFrom(event.target.value, draft.limits.maxConcurrentToolCalls)
                })
              }
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Model turns per task</span>
            <input
              className="hs-input"
              type="number"
              min={1}
              max={200}
              value={draft.limits.maxModelTurnsPerTask}
              onChange={(event) =>
                patchLimits({
                  maxModelTurnsPerTask: numberFrom(event.target.value, draft.limits.maxModelTurnsPerTask)
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="hs-settings-section" aria-label="Teammate voices">
        <SectionLabel>Teammate voices</SectionLabel>
        {agents.length === 0 ? (
          <p className="hs-work-empty">No teammates in this room yet.</p>
        ) : (
          <ul className="hs-voices">
            {agents.map((agent) => (
              <li key={agent.id} className="hs-voice">
                <span className="hs-voice-ident">
                  {agent.name}
                  <span className="hs-voice-role">{roleLabel(agent.role)}</span>
                </span>
                <select
                  className="hs-select"
                  value={agent.voice.voiceId}
                  aria-label={`Voice for ${agent.name}`}
                  onChange={(event) => onSetAgentVoice(agent.id, event.target.value)}
                >
                  {AGENT_PRESETS.map((preset) => (
                    <option key={preset.voice.voiceId} value={preset.voice.voiceId}>
                      {preset.voice.voiceName} · {preset.name}
                    </option>
                  ))}
                  {AGENT_PRESETS.every((preset) => preset.voice.voiceId !== agent.voice.voiceId) ? (
                    <option value={agent.voice.voiceId}>{agent.voice.voiceName} · current</option>
                  ) : null}
                </select>
                <Button
                  variant="ghost"
                  hint={`Plays a short sample of ${agent.voice.voiceName}`}
                  onClick={() => onPreviewVoice(agent.voice.voiceId)}
                >
                  <span className="hs-btn-inner">
                    <VolumeIcon size={14} /> Preview
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="hs-settings-section" aria-label="API keys">
        <SectionLabel>API keys</SectionLabel>
        <p className="hs-settings-hint">
          Keys are stored by the desktop app and are never shown again. A blank field leaves the
          existing value unchanged.
        </p>
        <ul className="hs-secrets">
          {SECRET_FIELDS.map((field) => (
            <li key={field.key} className="hs-secret">
              <label className="hs-field">
                <span className="hs-field-label">{field.label}</span>
                <input
                  className="hs-input"
                  type="password"
                  autoComplete="off"
                  placeholder="not set"
                  value={secretDraft[field.key] ?? ''}
                  onChange={(event) =>
                    setSecretDraft((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  aria-describedby={`hs-secret-${field.key}`}
                />
                <span className="hs-field-hint" id={`hs-secret-${field.key}`}>
                  {field.hint}
                </span>
              </label>
              <Button
                variant="quiet"
                disabled={(secretDraft[field.key] ?? '').length === 0}
                hint={
                  (secretDraft[field.key] ?? '').length === 0
                    ? 'Type a value first, or leave it empty to keep the stored key'
                    : 'Stores the key in the encrypted store'
                }
                onClick={() => {
                  const value = secretDraft[field.key] ?? ''
                  if (!value) return
                  void onSetSecret(field.key, value)
                    .then(() => {
                      setSaveError(null)
                      setSecretDraft((current) => ({ ...current, [field.key]: '' }))
                    })
                    .catch((error: unknown) => {
                      setSaveError(error instanceof Error ? error.message : 'Could not save key')
                    })
                }}
              >
                Save
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </Modal>
  )
}
