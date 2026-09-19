/**
 * The Markdown parser behind teammate messages.
 *
 * This half is deliberately free of React so it can be tested directly and so
 * that the rendering half has nothing to do but map plain data onto elements.
 * Nothing in this file produces HTML — it produces a tree of tagged values, and
 * `Markdown.tsx` turns those into React nodes. A message containing a script
 * tag therefore ends up as text content, never as markup.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Returns the href only when it is a protocol the shell will open. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    return SAFE_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }

interface Rule {
  pattern: RegExp
  build: (match: RegExpExecArray) => Inline
}

/**
 * Inline rules. Code is tried first so emphasis markers inside a code span stay
 * literal, which is how agents quote shell flags and glob patterns.
 */
const RULES: Rule[] = [
  { pattern: /`([^`\n]+)`/, build: (match) => ({ kind: 'code', text: match[1] }) },
  {
    pattern: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    build: (match) => {
      const href = safeHref(match[2])
      // An unsupported scheme is shown exactly as written, never as a link.
      if (href === null) return { kind: 'text', text: match[0] }
      return { kind: 'link', href, children: parseInline(match[1]) }
    }
  },
  {
    pattern: /<(https?:\/\/[^>\s]+)>/,
    build: (match) => {
      const href = safeHref(match[1])
      if (href === null) return { kind: 'text', text: match[0] }
      return { kind: 'link', href, children: [{ kind: 'text', text: match[1] }] }
    }
  },
  {
    pattern: /\*\*([^*\n]+)\*\*|__([^_\n]+)__/,
    build: (match) => ({ kind: 'strong', children: parseInline(match[1] ?? match[2] ?? '') })
  },
  {
    pattern: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/,
    build: (match) => ({ kind: 'em', children: parseInline(match[1]) })
  },
  {
    pattern: /~~([^~\n]+)~~/,
    build: (match) => ({ kind: 'strike', children: parseInline(match[1]) })
  }
]

/** Splits one run of source text into inline nodes. */
export function parseInline(source: string): Inline[] {
  if (source.length === 0) return []

  let earliest: { match: RegExpExecArray; rule: Rule } | null = null
  for (const rule of RULES) {
    const match = rule.pattern.exec(source)
    if (match === null) continue
    if (earliest === null || match.index < earliest.match.index) earliest = { match, rule }
  }

  if (earliest === null) return [{ kind: 'text', text: source }]

  const { match, rule } = earliest
  const before = source.slice(0, match.index)
  const after = source.slice(match.index + match[0].length)
  return [
    ...(before.length > 0 ? ([{ kind: 'text', text: before }] as Inline[]) : []),
    rule.build(match),
    ...parseInline(after)
  ]
}

export type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string | null; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[][] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' }

const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)\d{1,9}[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/

/** Turns the source into a flat block list. Unknown syntax stays a paragraph. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0
  let paragraph: string[] = []

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', lines: [...paragraph] })
      paragraph = []
    }
  }

  while (index < lines.length) {
    const line = lines[index]

    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const closer = new RegExp(`^\\s{0,3}${fence[1]}\\s*$`)
      const body: string[] = []
      index += 1
      while (index < lines.length && !closer.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      // An unterminated fence still renders as code: no text is ever dropped.
      index += 1
      blocks.push({ kind: 'code', language: fence[2].length > 0 ? fence[2] : null, lines: body })
      continue
    }

    if (line.trim().length === 0) {
      flush()
      index += 1
      continue
    }

    if (paragraph.length === 0 && RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      flush()
      const body: string[] = []
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index])
        if (next === null) break
        body.push(next[1])
        index += 1
      }
      blocks.push({ kind: 'quote', lines: body })
      continue
    }

    const ordered = ORDERED.exec(line)
    if (ordered !== null || BULLET.test(line)) {
      flush()
      const isOrdered = ordered !== null
      const items: string[][] = []
      while (index < lines.length) {
        const current = lines[index]
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current)
        if (match) {
          items.push([match[2]])
          index += 1
          continue
        }
        // A wrapped continuation line belongs to the item above it.
        if (items.length > 0 && current.trim().length > 0 && /^\s{2,}/.test(current)) {
          items[items.length - 1].push(current.trim())
          index += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    paragraph.push(line.trim())
    index += 1
  }

  flush()
  return blocks
}

/**
 * Roughly how tall a message will render, used to decide whether a long report
 * is collapsed behind a "Show more" control. Counted from the parsed blocks so
 * a fenced listing costs what it actually costs.
 */
export function blockWeight(blocks: readonly Block[]): number {
  let weight = 0
  for (const block of blocks) {
    if (block.kind === 'code') weight += block.lines.length + 1
    else if (block.kind === 'list') weight += block.items.length
    else if (block.kind === 'paragraph') weight += block.lines.length
    else if (block.kind === 'quote') weight += block.lines.length
    else weight += 1
  }
  return weight
}
