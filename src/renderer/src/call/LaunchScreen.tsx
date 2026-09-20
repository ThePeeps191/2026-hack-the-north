import { useState, type JSX } from 'react'
import { MAX_AGENTS_PER_ROOM, type Capability, type Room } from '../../../shared/types'
import { formatRelative } from './format'
import { Button } from './ui'
import { useNow } from './ui'

/**
 * The first screen.
 *
 * Nothing is running yet, so this screen has one job: say what Huddle is and
 * get a room started with the two things that actually change what the team
 * does — how many teammates, and what they are for.
 *
 * The goal field is here rather than behind an edit dialog because a room
 * without a goal is a room where nobody starts: teammates read the goal, pick a
 * first slice of work and introduce themselves against it. Making the human
 * create a room and *then* discover they have to edit it was the difference
 * between a team that gets to work and three idle tiles.
 */

export interface LaunchScreenProps {
  rooms: Room[]
  capabilities: Capability[]
  onCreate: (name: string, goal: string, agentCount: number) => Promise<void> | void
  onOpen: (roomId: string) => void
}

/** Short examples, to show the shape of a goal rather than explain it. */
const GOAL_EXAMPLES = [
  'Make voting anonymous in Sketch Night',
  'Add a dark mode that respects the system setting',
  'Find and fix the duplicate-submit bug in checkout'
]

export function LaunchScreen({ rooms, capabilities, onCreate, onOpen }: LaunchScreenProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [count, setCount] = useState(3)
  const now = useNow(30_000)

  const models = capabilities.find((capability) => capability.id === 'openai')
  const speech = capabilities.find((capability) => capability.id === 'elevenlabs')
  const browser = capabilities.find((capability) => capability.id === 'browserbase')
  const local = capabilities.find((capability) => capability.id === 'localSpeech')

  const submit = (): void => {
    if (busy) return
    setBusy(true)
    void Promise.resolve(onCreate(name.trim(), goal.trim(), count)).finally(() => setBusy(false))
  }

  return (
    <div className="hs-launch">
      <div className="hs-launch-grid">
        <section className="hs-launch-pitch">
          <p className="hs-launch-kicker">Huddle</p>
          <h1>
            A voice room where
            <br />
            your AI team is <em>already working</em>.
          </h1>
          <p className="hs-launch-lead">
            Three engineers on a real repo. Talk over them and the work changes course — no turn to
            wait for, nothing already verified thrown away.
          </p>

          <ul className="hs-launch-points">
            <li>
              <span className="hs-launch-point-key">Say it to the room</span>
              Every teammate hears it. A standing rule is recorded and binds the ones you add later.
            </li>
            <li>
              <span className="hs-launch-point-key">Interrupt mid-task</span>
              The instruction lands inside the loop that is already running, not in a queue behind it.
            </li>
            <li>
              <span className="hs-launch-point-key">Watch every screen</span>
              Real files, real commands, a real browser — each teammate in its own git worktree.
            </li>
          </ul>

          <div className="hs-launch-caps" aria-label="What is configured on this machine">
            <CapabilityChip label="Models" capability={models} />
            <CapabilityChip label="Voices" capability={speech} />
            <CapabilityChip label="Browser" capability={browser} />
            <CapabilityChip label="Local speech" capability={local} />
          </div>
        </section>

        <section className="hs-launch-panel">
          <form
            className="hs-create-room"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <h2>Start a room</h2>

            <label className="hs-field">
              <span className="hs-field-label">What should the team work on?</span>
              <textarea
                className="hs-textarea"
                rows={3}
                value={goal}
                maxLength={600}
                autoFocus
                placeholder={GOAL_EXAMPLES[0]}
                onChange={(event) => setGoal(event.target.value)}
                onKeyDown={(event) => {
                  // A goal is one sentence, not a document: Enter submits.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submit()
                  }
                }}
              />
            </label>

            <div className="hs-launch-examples">
              {GOAL_EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="hs-launch-example"
                  onClick={() => setGoal(example)}
                >
                  {example}
                </button>
              ))}
            </div>

            <div className="hs-launch-row">
              <label className="hs-field">
                <span className="hs-field-label">Room name</span>
                <input
                  className="hs-input"
                  value={name}
                  maxLength={60}
                  placeholder="Optional"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>

              <fieldset className="hs-create-room-count">
                <legend className="hs-field-label">Teammates</legend>
                <div className="hs-create-room-picks" role="group">
                  {Array.from({ length: MAX_AGENTS_PER_ROOM }, (_, index) => index + 1).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={value === count ? 'is-selected' : undefined}
                      aria-pressed={value === count}
                      title={`${value} teammate${value === 1 ? '' : 's'}`}
                      onClick={() => setCount(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="hs-create-room-actions">
              <p className="hs-launch-note">
                {goal.trim()
                  ? 'They read the goal, take a first slice each and introduce themselves.'
                  : 'Without a goal they will wait to be asked for something.'}
              </p>
              <Button variant="primary" disabled={busy} type="submit" onClick={() => undefined}>
                {busy ? 'Starting…' : 'Start the room'}
              </Button>
            </div>
          </form>

          {rooms.length > 0 ? (
            <section className="hs-launch-saved" aria-label="Saved rooms">
              <h2>Rooms you have already started</h2>
              <ul>
                {rooms.slice(0, 5).map((room) => (
                  <li key={room.id}>
                    <button type="button" onClick={() => onOpen(room.id)}>
                      <span className="hs-launch-saved-name">{room.name}</span>
                      <span className="hs-launch-saved-goal">{room.goal || 'No goal set'}</span>
                      <span className="hs-launch-saved-when">{formatRelative(room.updatedAt, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </section>
      </div>
    </div>
  )
}

/**
 * One capability, exactly as the backend last probed it. A capability that has
 * not been checked yet says so rather than showing a hopeful green dot.
 */
function CapabilityChip({
  label,
  capability
}: {
  label: string
  capability: Capability | undefined
}): JSX.Element {
  const state = capability?.state ?? 'unknown'
  const tone =
    state === 'ready' ? 'ok' : state === 'error' ? 'bad' : state === 'unavailable' ? 'off' : 'wait'
  return (
    <span
      className={`hs-cap hs-cap--${tone}`}
      title={capability ? `${capability.detail}${capability.fix ? ` — ${capability.fix}` : ''}` : 'Not checked yet'}
    >
      <span className="hs-cap-dot" aria-hidden="true" />
      {label}
    </span>
  )
}
