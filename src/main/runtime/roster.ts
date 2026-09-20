import { AGENT_PRESETS, type AgentPreset } from '../../shared/presets.ts'
import type { AgentPresetId } from '../../shared/types.ts'

/**
 * Who should be in the room, given what the room is for.
 *
 * Rooms used to be staffed by position: teammate one is always the frontend
 * engineer, teammate two always systems, teammate three always quality — no
 * matter what the goal said. A room created to research a market therefore got
 * a frontend engineer with nothing to build and a QA engineer with nothing to
 * test, while the research and generalist presets were never reachable at all.
 *
 * Roles stay fixed once chosen, because routing, ownership and persona all hang
 * off them (see `router.ts`). Only the *choice* is made from the goal, once, at
 * creation.
 *
 * Three layers, in order: a model call for the general case, a keyword
 * heuristic when the model is unavailable or answers unusably, and the original
 * fixed order as the last resort. Room creation must never fail or hang because
 * a provider is slow — a room with a slightly odd roster is fine, a room that
 * never opens is not.
 */

/** How long the roster call may take before the heuristic answers instead. */
export const ROSTER_TIMEOUT_MS = 8000

/** The catalogue, as the model sees it. Ids are the only valid answers. */
export function rosterCatalogue(): string {
  return AGENT_PRESETS.map((preset) => `- ${preset.id} — ${preset.role}: ${preset.summary}`).join('\n')
}

export function rosterInstructions(count: number): string {
  return [
    `You are staffing a small engineering room. Pick exactly ${count} teammate${count === 1 ? '' : 's'} for the goal below.`,
    '',
    'Available teammates:',
    rosterCatalogue(),
    '',
    'Rules:',
    '- Answer with ids from the list above and nothing else.',
    '- Pick the teammates the goal actually needs. A research goal does not need a frontend engineer.',
    '- You may repeat an id when the work genuinely needs two of that kind.',
    '- Order matters: put the teammate who should take the first slice of work first.',
    '',
    'Reply with exactly one line, in this format and nothing else:',
    'ROSTER: id, id, id'
  ].join('\n')
}

/**
 * Reads the model's answer.
 *
 * Tolerant about shape — a `ROSTER:` prefix, bullet points, quotes and extra
 * prose are all accepted — and strict about content: only ids that exist are
 * kept, so the model cannot staff a room with a role that has no persona
 * behind it. Returns null when nothing usable came back, which is the signal
 * to fall through to the heuristic.
 */
export function parseRoster(text: string, count: number): AgentPresetId[] | null {
  if (!text.trim()) return null
  const valid = new Set(AGENT_PRESETS.map((preset) => preset.id))
  // Prefer the line that names itself, then fall back to the whole reply.
  const line = /ROSTER\s*:\s*(.+)/i.exec(text)?.[1] ?? text
  const picked: AgentPresetId[] = []
  for (const token of line.toLowerCase().split(/[^a-z]+/)) {
    if (!valid.has(token as AgentPresetId)) continue
    picked.push(token as AgentPresetId)
    if (picked.length === count) break
  }
  return picked.length > 0 ? picked : null
}

/** Words that point at a preset when no model is available to judge. */
const SIGNALS: Record<AgentPresetId, readonly string[]> = {
  maya: ['ui', 'interface', 'screen', 'page', 'component', 'frontend', 'design', 'css', 'layout', 'app', 'button', 'form', 'dashboard', 'style', 'render', 'client'],
  alex: ['server', 'api', 'backend', 'database', 'schema', 'endpoint', 'auth', 'deploy', 'pipeline', 'data', 'contract', 'protocol', 'sync', 'storage', 'migration'],
  sam: ['bug', 'test', 'verify', 'broken', 'fix', 'regression', 'qa', 'quality', 'security', 'privacy', 'leak', 'audit', 'reliable', 'crash', 'anonymous'],
  rio: ['research', 'compare', 'competitors', 'market', 'docs', 'documentation', 'write', 'summarise', 'summarize', 'report', 'guide', 'investigate', 'survey', 'landscape', 'readme'],
  nova: []
}

/**
 * The roster a goal implies, judged on words alone.
 *
 * Used when no model can be reached, and as the shape the model's answer is
 * checked against. Always returns exactly `count` ids.
 */
export function heuristicRoster(goal: string, count: number): AgentPresetId[] {
  const words = new Set(goal.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const scored = AGENT_PRESETS.map((preset) => ({
    id: preset.id,
    score: (SIGNALS[preset.id] ?? []).reduce((total, signal) => total + (words.has(signal) ? 1 : 0), 0)
  }))

  const ranked = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score)

  // Nothing matched: a goal we cannot read is most likely software, which is
  // what the fixed order always assumed. Saying so here keeps that assumption
  // in one place instead of spread through the app.
  if (ranked.length === 0) return defaultRoster(count)

  const picked: AgentPresetId[] = ranked.map((entry) => entry.id)

  /*
   * A room that builds something needs somebody to check it, and a room with
   * more than one builder needs somebody to hold the contract between them.
   * These are the two gaps that make a roster useless in practice, so they are
   * filled before the list is padded with generalists.
   */
  const builds = picked.includes('maya') || picked.includes('alex')
  if (builds && !picked.includes('sam')) picked.push('sam')
  if (picked.includes('maya') && !picked.includes('alex')) picked.push('alex')

  /*
   * Any remaining seats go to the generalist, never to the next preset in the
   * catalogue. Padding in catalogue order quietly put a frontend engineer in
   * every research room, because the catalogue happens to start with one — the
   * exact failure this function exists to fix. "We do not know what else this
   * needs" is a real answer, and it is what the generalist is for.
   */
  while (picked.length < count) picked.push('nova')
  return picked.slice(0, count)
}

/** The original fixed order, kept as the floor under everything else. */
export function defaultRoster(count: number): AgentPresetId[] {
  const out: AgentPresetId[] = []
  for (let index = 0; index < count; index += 1) {
    out.push((AGENT_PRESETS[index % AGENT_PRESETS.length] as AgentPreset).id)
  }
  return out
}

/** A short line naming the roster, for the notice the room opens with. */
export function describeRoster(ids: readonly AgentPresetId[]): string {
  const roles = ids.map((id) => AGENT_PRESETS.find((preset) => preset.id === id)?.role ?? id)
  if (roles.length === 1) return roles[0] as string
  return `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`
}
