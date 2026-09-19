import { HuddleError } from '../huddle-error.ts'

/**
 * A strict unified-diff parser and applier.
 *
 * Design constraints, in order of importance:
 *
 *  1. Never partially apply. Every hunk of every file is verified against the
 *     real bytes on disk *before* a single byte is written. A patch that does
 *     not match exactly is rejected whole, with a detail that names the hunk
 *     and the line where reality disagreed.
 *  2. Never invent content. The only text that reaches the disk is text that
 *     came out of the patch itself, plus untouched lines from the file.
 *  3. Accept the two shapes a model actually produces: a real unified diff with
 *     `@@` hunks, and a header-only envelope that replaces the whole file.
 */

export type PatchLineKind = 'context' | 'add' | 'remove'

export interface PatchLine {
  kind: PatchLineKind
  text: string
}

export interface PatchHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Text after the closing `@@`, usually a function name hint. */
  hint: string
  body: PatchLine[]
  /** True when the declared line counts did not match the supplied body. */
  malformed: boolean
  /** True when the patch marked the last line as having no trailing newline. */
  noTrailingNewline: boolean
}

export interface PatchFileSection {
  /** Path as written in the patch with `a/` + `b/` prefixes stripped. null for /dev/null. */
  oldPath: string | null
  newPath: string | null
  hunks: PatchHunk[]
  /** Whole-file replacement body when the section carries no `@@` hunks. */
  replacement: string | null
  /** `Binary files ... differ` and friends: nothing we can apply as text. */
  binary: boolean
}

export interface ParsedPatch {
  files: PatchFileSection[]
  errors: string[]
}

export interface PatchPlanEntry {
  path: string
  action: 'write' | 'delete'
  created: boolean
  additions: number
  deletions: number
  /** Set when a hunk matched at a different offset than the header claimed. */
  offsetNote: string | null
}

export interface PatchApplyResult {
  applied: boolean
  /** Paths actually changed on disk. */
  files: string[]
  rejected: string[]
  detail: string
}

/** Filesystem access the applier needs; the host supplies path-checked versions. */
export interface PatchTargets {
  /** Current text of a workspace-relative path, or null when it does not exist. */
  read(relativePath: string): Promise<string | null>
  /** Write and return the real byte count. */
  write(relativePath: string, contents: string): Promise<number>
  remove(relativePath: string): Promise<void>
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
const SECTION_META = /^(index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to)/
const NO_NEWLINE_MARKER = '\\ No newline at end of file'

function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

/** Normalise a patch header path: strip quotes, timestamps and a/b prefixes. */
export function cleanPatchPath(raw: string): string | null {
  let value = raw.trim()
  if (value.length === 0) return null
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  } else {
    const tab = value.indexOf('\t')
    if (tab >= 0) value = value.slice(0, tab)
  }
  value = value.trim()
  if (value === '/dev/null' || value === 'null' || value === 'nul') return null
  value = toForwardSlashes(value)
  value = value.replace(/^[ab]\//, '')
  return value.length === 0 ? null : value
}

function parseHunkHeader(line: string): Omit<PatchHunk, 'body' | 'malformed' | 'noTrailingNewline'> | null {
  const match = HUNK_HEADER.exec(line)
  if (!match) return null
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3], 10),
    newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
    hint: match[5]?.trim() ?? ''
  }
}

function parseDiffGitPaths(line: string): { oldPath: string | null; newPath: string | null } {
  const rest = line.slice('diff --git '.length).trim()
  // `a/x b/x` where x may be quoted when it contains spaces.
  const quoted = /^"(.*?)"\s+"(.*)"$/.exec(rest)
  if (quoted) {
    return { oldPath: cleanPatchPath(quoted[1]), newPath: cleanPatchPath(quoted[2]) }
  }
  const parts = rest.split(' ')
  if (parts.length >= 2) {
    return {
      oldPath: cleanPatchPath(parts[0]),
      newPath: cleanPatchPath(parts.slice(1).join(' '))
    }
  }
  return { oldPath: null, newPath: null }
}

export function parseUnifiedDiff(patch: string): ParsedPatch {
  const errors: string[] = []
  const files: PatchFileSection[] = []
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  // A patch that ends with a newline always leaves one empty element behind
  // from the split. It is an artefact of the terminator, not a line of the
  // patch: dropping it is what lets a real `git diff` parse.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let current: PatchFileSection | null = null
  let index = 0

  const startSection = (oldPath: string | null, newPath: string | null): PatchFileSection => {
    const section: PatchFileSection = {
      oldPath,
      newPath,
      hunks: [],
      replacement: null,
      binary: false
    }
    files.push(section)
    return section
  }

  while (index < lines.length) {
    const line = lines[index]

    if (line.startsWith('diff --git ')) {
      const paths = parseDiffGitPaths(line)
      current = startSection(paths.oldPath, paths.newPath)
      index += 1
      continue
    }

    if (line.startsWith('--- ')) {
      const next = lines[index + 1]
      if (next === undefined || !next.startsWith('+++ ')) {
        errors.push(`Header "${line}" is not followed by a "+++ " line.`)
        index += 1
        continue
      }
      const oldPath = cleanPatchPath(line.slice(4))
      const newPath = cleanPatchPath(next.slice(4))
      if (oldPath === null && newPath === null) {
        errors.push('A file section points at /dev/null on both sides, so it has no path.')
        index += 2
        continue
      }
      current = startSection(oldPath, newPath)
      index += 2
      continue
    }

    if (current === null) {
      if (line.trim().length === 0) {
        index += 1
        continue
      }
      errors.push(`Line ${index + 1} ("${line.slice(0, 80)}") is outside any file section.`)
      index += 1
      continue
    }

    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line)
      if (header === null) {
        errors.push(`Unparseable hunk header on line ${index + 1}: "${line}".`)
        index += 1
        continue
      }
      const body: PatchLine[] = []
      let oldSeen = 0
      let newSeen = 0
      let noTrailingNewline = false
      let cursor = index + 1
      while (cursor < lines.length && (oldSeen < header.oldCount || newSeen < header.newCount)) {
        const candidate = lines[cursor]
        const marker = candidate.charAt(0)
        if (marker === ' ') {
          body.push({ kind: 'context', text: candidate.slice(1) })
          oldSeen += 1
          newSeen += 1
        } else if (marker === '+') {
          body.push({ kind: 'add', text: candidate.slice(1) })
          newSeen += 1
        } else if (marker === '-') {
          body.push({ kind: 'remove', text: candidate.slice(1) })
          oldSeen += 1
        } else if (candidate.startsWith(NO_NEWLINE_MARKER)) {
          noTrailingNewline = true
        } else if (candidate.length === 0) {
          // A bare empty line can only be context in a hand-written patch.
          body.push({ kind: 'context', text: '' })
          oldSeen += 1
          newSeen += 1
        } else {
          break
        }
        cursor += 1
      }
      const malformed = oldSeen !== header.oldCount || newSeen !== header.newCount
      // git emits `\ No newline at end of file` after the last line of a hunk.
      if (cursor < lines.length && lines[cursor].startsWith(NO_NEWLINE_MARKER)) {
        noTrailingNewline = true
        cursor += 1
      }
      if (malformed) {
        errors.push(
          `Hunk ${header.oldStart},${header.oldCount} -> ${header.newStart},${header.newCount} declares ` +
            `${header.oldCount} old and ${header.newCount} new lines but the patch supplies ${oldSeen} and ${newSeen}.`
        )
      }
      current.hunks.push({ ...header, body, malformed, noTrailingNewline })
      index = cursor
      continue
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true
      index += 1
      continue
    }

    if (SECTION_META.test(line) || line.startsWith(NO_NEWLINE_MARKER)) {
      index += 1
      continue
    }

    if (current.hunks.length > 0) {
      errors.push(`Line ${index + 1} ("${line.slice(0, 80)}") follows a hunk but is not part of it.`)
      index += 1
      continue
    }

    if (current.replacement === null && line.length === 0) {
      // A single blank line between the "+++" header and the body is formatting.
      index += 1
      continue
    }

    if (current.replacement === null) {
      current.replacement = line
    } else if (line.startsWith(NO_NEWLINE_MARKER)) {
      current.replacement = current.replacement.slice(0, -1)
    } else {
      current.replacement = `${current.replacement}\n${line}`
    }
    index += 1
  }

  if (files.length === 0) {
    errors.push(
      'No file headers were found. Send a unified diff with "--- a/path" and "+++ b/path" lines, ' +
        'or a whole-file replacement using the same headers followed by the new file content.'
    )
  }

  // A section that produced neither hunks nor a replacement body is a mode or
  // rename-only record; drop it rather than treating it as an empty write.
  const usable = files.filter((file) => file.hunks.length > 0 || file.replacement !== null || file.binary)
  return { files: usable, errors }
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

interface FileText {
  lines: string[]
  eol: '\n' | '\r\n'
  trailingNewline: boolean
  existed: boolean
}

function splitFileText(text: string | null): FileText {
  if (text === null) {
    return { lines: [], eol: '\n', trailingNewline: true, existed: false }
  }
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n'
  const normalised = text.replace(/\r\n/g, '\n')
  const trailingNewline = normalised.endsWith('\n')
  const body = trailingNewline ? normalised.slice(0, -1) : normalised
  return {
    lines: body.length === 0 ? [] : body.split('\n'),
    eol,
    trailingNewline,
    existed: true
  }
}

function joinFileText(file: FileText, lines: string[], dropTrailingNewline: boolean): string {
  const trailing = dropTrailingNewline ? false : file.trailingNewline
  const body = lines.join(file.eol)
  if (body.length === 0) return ''
  return trailing ? `${body}${file.eol}` : body
}

function oldSideLines(body: PatchLine[]): string[] {
  return body.filter((line) => line.kind !== 'add').map((line) => line.text)
}

function newSideLines(body: PatchLine[]): string[] {
  return body.filter((line) => line.kind !== 'remove').map((line) => line.text)
}

function matchesAt(working: string[], needle: string[], at: number): boolean {
  if (at < 0 || at + needle.length > working.length) return false
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (working[at + offset] !== needle[offset]) return false
  }
  return true
}

/** Closest index of `needle` in `working`, preferring `expected`. */
function findNearest(working: string[], needle: string[], expected: number): number | null {
  if (needle.length === 0) {
    return Math.max(0, Math.min(working.length, expected))
  }
  if (matchesAt(working, needle, expected)) return expected
  for (let distance = 1; distance < Math.max(working.length, 1); distance += 1) {
    const before = expected - distance
    const after = expected + distance
    if (matchesAt(working, needle, before)) return before
    if (matchesAt(working, needle, after)) return after
  }
  return null
}

interface HunkMatch {
  index: number
  /** Body window actually used (fuzz drops boundary context lines). */
  from: number
  to: number
}

function locateHunk(working: string[], hunk: PatchHunk, expected: number): HunkMatch | null {
  const last = hunk.body.length - 1
  const windows: Array<{ from: number; to: number }> = [{ from: 0, to: last }]
  if (hunk.body.length > 1 && hunk.body[0]?.kind === 'context') windows.push({ from: 1, to: last })
  if (hunk.body.length > 1 && hunk.body[last]?.kind === 'context') windows.push({ from: 0, to: last - 1 })
  if (hunk.body.length > 2 && hunk.body[0]?.kind === 'context' && hunk.body[last]?.kind === 'context') {
    windows.push({ from: 1, to: last - 1 })
  }

  for (const window of windows) {
    const slice = hunk.body.slice(window.from, window.to + 1)
    const needle = oldSideLines(slice)
    const found = findNearest(working, needle, expected)
    if (found !== null) return { index: found, from: window.from, to: window.to }
  }
  return null
}

interface SectionPlan {
  path: string
  action: 'write' | 'delete'
  contents: string
  created: boolean
  additions: number
  deletions: number
  offsetNote: string | null
}

async function planSection(
  section: PatchFileSection,
  targets: PatchTargets
): Promise<{ plan: SectionPlan } | { error: string; path: string }> {
  const path = section.newPath ?? section.oldPath
  if (path === null) {
    return { error: 'The patch section has no usable path.', path: '<unknown>' }
  }
  if (section.binary) {
    return { error: `Cannot apply a binary patch to ${path}; Huddle only applies text patches.`, path }
  }
  if (section.hunks.some((hunk) => hunk.malformed)) {
    return { error: `The hunk for ${path} is malformed (declared line counts do not match the body).`, path }
  }

  const isAdd = section.oldPath === null
  const isDelete = section.newPath === null
  const currentText = isAdd ? null : await targets.read(path)
  if (!isAdd && currentText === null) {
    return { error: `${path} does not exist in this workspace, so the patch cannot be applied.`, path }
  }
  const file = splitFileText(isAdd ? null : currentText)

  if (section.hunks.length === 0) {
    const raw = section.replacement ?? ''
    const replacementLines =
      raw.length === 0 ? [] : (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n')
    const created = !file.existed
    return {
      plan: {
        path,
        action: 'write',
        contents: joinFileText(file, replacementLines, false),
        created,
        additions: replacementLines.length,
        deletions: created ? 0 : file.lines.length,
        offsetNote: created ? null : 'whole-file replacement'
      }
    }
  }

  let working = [...file.lines]
  let delta = 0
  let additions = 0
  let deletions = 0
  let offsetNote: string | null = null

  for (let hunkIndex = 0; hunkIndex < section.hunks.length; hunkIndex += 1) {
    const hunk = section.hunks[hunkIndex]
    // `@@ -l,0 +n,m @@` inserts *after* old line l, so a zero-count hunk anchors
    // one line later than a normal hunk.
    const anchor = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1
    const expected = Math.max(0, anchor + delta)
    const match = locateHunk(working, hunk, expected)
    if (match === null) {
      const wanted = oldSideLines(hunk.body)
      const actual = wanted.length === 0 ? [] : working.slice(expected, expected + Math.max(wanted.length, 1))
      const preview = actual.length === 0 ? '(end of file)' : actual.map((line) => `  | ${line}`).join('\n')
      return {
        error:
          `Hunk ${hunkIndex + 1} of ${section.hunks.length} in ${path} does not match the file content. ` +
          `Expected ${wanted.length} line(s) starting near line ${expected + 1}, found:\n${preview}`,
        path
      }
    }

    const matchedBody = hunk.body.slice(match.from, match.to + 1)
    const needle = oldSideLines(matchedBody)
    const inserted = newSideLines(matchedBody)
    additions += matchedBody.filter((line) => line.kind === 'add').length
    deletions += matchedBody.filter((line) => line.kind === 'remove').length
    if (match.index !== expected) {
      const shift = match.index - expected
      offsetNote = `hunk ${hunkIndex + 1} applied at offset ${shift > 0 ? '+' : ''}${shift}`
    }
    working = [...working.slice(0, match.index), ...inserted, ...working.slice(match.index + needle.length)]
    delta += inserted.length - needle.length
  }

  const dropTrailing = section.hunks[section.hunks.length - 1]?.noTrailingNewline ?? false
  const contents = joinFileText(file, working, dropTrailing)

  if (isDelete) {
    if (working.some((line) => line.trim().length > 0)) {
      return {
        error: `${path} was marked for deletion but ${working.length} line(s) would remain after the patch.`,
        path
      }
    }
    return {
      plan: {
        path,
        action: 'delete',
        contents: '',
        created: false,
        additions: 0,
        deletions: additions + deletions,
        offsetNote
      }
    }
  }

  return {
    plan: {
      path,
      action: 'write',
      contents,
      created: !file.existed,
      additions,
      deletions,
      offsetNote
    }
  }
}

/**
 * Parse and apply a unified diff. Nothing is written unless every hunk of every
 * file was verified first.
 */
export async function applyUnifiedPatch(patch: string, targets: PatchTargets): Promise<PatchApplyResult> {
  if (patch.trim().length === 0) {
    throw new HuddleError('empty_patch', 'The patch was empty.', 'Send a unified diff with real hunks.')
  }

  const parsed = parseUnifiedDiff(patch)
  if (parsed.errors.length > 0) {
    return {
      applied: false,
      files: [],
      rejected: parsed.files.map((file) => file.newPath ?? file.oldPath ?? '<unknown>'),
      detail: `The patch could not be parsed: ${parsed.errors.join(' ')}`
    }
  }

  const plans: SectionPlan[] = []
  const rejected: string[] = []
  const problems: string[] = []
  for (const section of parsed.files) {
    const outcome = await planSection(section, targets)
    if ('error' in outcome) {
      rejected.push(outcome.path)
      problems.push(outcome.error)
    } else {
      plans.push(outcome.plan)
    }
  }

  if (problems.length > 0) {
    return {
      applied: false,
      files: [],
      rejected,
      detail: `${problems.join('\n')}\nNothing was written: Huddle never applies half a patch.`
    }
  }

  const changed: string[] = []
  for (const plan of plans) {
    if (plan.action === 'delete') {
      await targets.remove(plan.path)
      changed.push(plan.path)
      continue
    }
    await targets.write(plan.path, plan.contents)
    changed.push(plan.path)
  }

  const totalAdditions = plans.reduce((sum, plan) => sum + plan.additions, 0)
  const totalDeletions = plans.reduce((sum, plan) => sum + plan.deletions, 0)
  const notes = plans
    .map((plan) => plan.offsetNote)
    .filter((note): note is string => note !== null)
  const detailParts = [
    `Applied ${plans.length} file(s): +${totalAdditions}/-${totalDeletions}.`,
    `Changed: ${changed.join(', ')}.`
  ]
  if (notes.length > 0) detailParts.push(`Notes: ${notes.join('; ')}.`)
  if (plans.some((plan) => plan.created)) {
    detailParts.push(`Created: ${plans.filter((plan) => plan.created).map((plan) => plan.path).join(', ')}.`)
  }

  return { applied: true, files: changed, rejected: [], detail: detailParts.join(' ') }
}

/** `git diff` style patch for a single file, used only for verification in tests. */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}
