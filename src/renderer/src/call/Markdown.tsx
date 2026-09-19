import { Fragment, type JSX, type ReactNode } from 'react'
import { parseBlocks, parseInline, type Block, type Inline } from './markdown-parse.ts'

/**
 * Renders parsed Markdown as React elements.
 *
 * The parser in `markdown-parse.ts` produces tagged values; this file maps them onto
 * elements. There is no `dangerouslySetInnerHTML` here by design, so markup in
 * a teammate's message is shown as text and can never execute.
 */

function renderInline(nodes: readonly Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    if (node.kind === 'text') return <Fragment key={key}>{node.text}</Fragment>
    if (node.kind === 'code') {
      return (
        <code className="hs-md-code" key={key}>
          {node.text}
        </code>
      )
    }
    if (node.kind === 'link') {
      return (
        <a className="hs-md-link" href={node.href} target="_blank" rel="noreferrer noopener" key={key}>
          {renderInline(node.children, key)}
        </a>
      )
    }
    if (node.kind === 'strong') return <strong key={key}>{renderInline(node.children, key)}</strong>
    if (node.kind === 'em') return <em key={key}>{renderInline(node.children, key)}</em>
    return <s key={key}>{renderInline(node.children, key)}</s>
  })
}

function renderBlock(block: Block, key: string): JSX.Element {
  if (block.kind === 'heading') {
    const level = Math.min(block.level, 4)
    const Tag = `h${Math.min(level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6'
    return (
      <Tag className={`hs-md-h hs-md-h${level}`} key={key}>
        {renderInline(parseInline(block.text), key)}
      </Tag>
    )
  }
  if (block.kind === 'code') {
    return (
      <pre className="hs-md-pre" key={key} data-language={block.language ?? undefined}>
        <code>{block.lines.join('\n')}</code>
      </pre>
    )
  }
  if (block.kind === 'rule') return <hr className="hs-md-rule" key={key} />
  if (block.kind === 'quote') {
    return (
      <blockquote className="hs-md-quote" key={key}>
        {renderInline(parseInline(block.lines.join(' ')), key)}
      </blockquote>
    )
  }
  if (block.kind === 'list') {
    const items = block.items.map((item, itemIndex) => (
      <li key={`${key}-${itemIndex}`}>
        {renderInline(parseInline(item.join(' ')), `${key}-${itemIndex}`)}
      </li>
    ))
    return block.ordered ? (
      <ol className="hs-md-ol" key={key}>
        {items}
      </ol>
    ) : (
      <ul className="hs-md-ul" key={key}>
        {items}
      </ul>
    )
  }
  return (
    <p className="hs-md-p" key={key}>
      {renderInline(parseInline(block.lines.join(' ')), key)}
    </p>
  )
}

export interface MarkdownProps {
  source: string
  className?: string
}

export function Markdown({ source, className }: MarkdownProps): JSX.Element {
  const blocks = parseBlocks(source)
  return (
    <div className={className === undefined ? 'hs-md' : `hs-md ${className}`}>
      {blocks.map((block, index) => renderBlock(block, `b${index}`))}
    </div>
  )
}
