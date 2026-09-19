import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import type { Tone } from './format'

/**
 * Small, shared UI primitives for the call screen.
 *
 * Two rules live here: every control is a real button with an accessible name,
 * and every disabled control explains itself through `title` plus
 * `aria-describedby` rather than going quietly grey.
 */

/* ------------------------------------------------------------------ *
 * Timing helpers
 * ------------------------------------------------------------------ */

/** A ticking clock so relative timestamps and elapsed labels stay honest. */
export function useNow(intervalMs = 20000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

/** Keeps a scroll container pinned to the bottom while the reader is there. */
export function useStickToBottom<T extends HTMLElement>(
  ref: { current: T | null },
  dependency: number
): void {
  const stick = useRef(true)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const onScroll = (): void => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      stick.current = distance < 48
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [ref])
  useEffect(() => {
    const node = ref.current
    if (!node || !stick.current) return
    node.scrollTop = node.scrollHeight
  }, [ref, dependency])
}

/* ------------------------------------------------------------------ *
 * Buttons
 * ------------------------------------------------------------------ */

function titleFor(label: string, hint?: string, shortcut?: string, disabled?: boolean): string {
  if (disabled && hint) return `${label} — ${hint}`
  if (shortcut) return `${label} (${shortcut})`
  return label
}

export interface IconButtonProps {
  label: string
  /** Why a control is unavailable, or extra context when it is available. */
  hint?: string
  shortcut?: string
  disabled?: boolean
  pressed?: boolean
  tone?: 'default' | 'accent' | 'danger'
  size?: 'sm' | 'md'
  onClick: () => void
  children: ReactNode
}

export function IconButton({
  label,
  hint,
  shortcut,
  disabled,
  pressed,
  tone = 'default',
  size = 'md',
  onClick,
  children
}: IconButtonProps): JSX.Element {
  const raw = useId()
  const hintId = `hs-hint-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const button = (
    <button
      type="button"
      className={`hs-iconbtn hs-iconbtn--${tone} hs-iconbtn--${size}`}
      aria-label={label}
      title={titleFor(label, hint, shortcut, disabled)}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-describedby={hint ? hintId : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )

  return (
    <>
      {disabled && hint ? (
        <span className="hs-tipwrap" title={`${label} — ${hint}`}>
          {button}
        </span>
      ) : (
        button
      )}
      {hint ? (
        <span id={hintId} className="hs-sr-only">
          {hint}
        </span>
      ) : null}
    </>
  )
}

export interface ButtonProps {
  children: ReactNode
  onClick: () => void
  variant?: 'primary' | 'quiet' | 'ghost' | 'danger'
  hint?: string
  shortcut?: string
  disabled?: boolean
  pressed?: boolean
  type?: 'button' | 'submit'
  className?: string
}

export function Button({
  children,
  onClick,
  variant = 'quiet',
  hint,
  shortcut,
  disabled,
  pressed,
  type = 'button',
  className
}: ButtonProps): JSX.Element {
  const raw = useId()
  const hintId = `hs-hint-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const label = typeof children === 'string' ? children : undefined
  return (
    <>
      <button
        type={type}
        className={`hs-btn hs-btn--${variant}${className ? ` ${className}` : ''}`}
        title={label ? titleFor(label, hint, shortcut, disabled) : hint}
        aria-pressed={pressed === undefined ? undefined : pressed}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
      {hint ? (
        <span id={hintId} className="hs-sr-only">
          {hint}
        </span>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Small display pieces
 * ------------------------------------------------------------------ */

export interface BadgeProps {
  children: ReactNode
  tone?: Tone | 'accent' | 'muted' | 'plain'
  title?: string
  className?: string
}

export function Badge({ children, tone = 'plain', title, className }: BadgeProps): JSX.Element {
  return (
    <span className={`hs-badge hs-badge--${tone}${className ? ` ${className}` : ''}`} title={title}>
      {children}
    </span>
  )
}

export function SectionLabel({
  children,
  aside
}: {
  children: ReactNode
  aside?: ReactNode
}): JSX.Element {
  return (
    <div className="hs-sectionlabel">
      <span>{children}</span>
      {aside}
    </div>
  )
}

export function Empty({
  title,
  detail,
  children
}: {
  title: string
  detail?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="hs-empty">
      <p className="hs-empty-title">{title}</p>
      {detail ? <p className="hs-empty-detail">{detail}</p> : null}
      {children}
    </div>
  )
}

export interface LevelBarProps {
  level: number
  muted?: boolean
  label: string
}

export function LevelBar({ level, muted, label }: LevelBarProps): JSX.Element {
  const percent = Math.round(Math.min(1, Math.max(0, level)) * 100)
  return (
    <div
      className={`hs-level${muted ? ' is-muted' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={muted ? 0 : percent}
    >
      <span className="hs-level-fill" style={{ width: `${muted ? 0 : percent}%` }} />
    </div>
  )
}

export interface TextAreaProps {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  rows?: number
  placeholder?: string
  id?: string
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  rows = 3,
  placeholder,
  id
}: TextAreaProps): JSX.Element {
  const generated = useId()
  const inputId = id ?? `hs-ta-${generated.replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <div className="hs-field">
      <label className="hs-field-label" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        id={inputId}
        className="hs-textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className="hs-field-hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

export interface ModalProps {
  title: string
  detail?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}

export function Modal({ title, detail, onClose, children, footer, width }: ModalProps): JSX.Element {
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    panel.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="hs-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="hs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        style={width ? { width: `${width}px` } : undefined}
      >
        <header className="hs-modal-head">
          <div>
            <h2 className="hs-modal-title">{title}</h2>
            {detail ? <p className="hs-modal-detail">{detail}</p> : null}
          </div>
          <Button variant="ghost" onClick={onClose} hint="Closes this dialog">
            Close
          </Button>
        </header>
        <div className="hs-modal-body">{children}</div>
        {footer ? <footer className="hs-modal-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Inline confirmation for destructive actions
 * ------------------------------------------------------------------ */

export interface ConfirmProps {
  question: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

export function Confirm({ question, confirmLabel, onConfirm, onCancel }: ConfirmProps): JSX.Element {
  return (
    <div className="hs-confirm" role="group" aria-label={question}>
      <span>{question}</span>
      <Button variant="danger" onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  detail
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  detail?: string
}): JSX.Element {
  const raw = useId()
  const id = `hs-tog-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <div className="hs-toggle">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <div>
        <label htmlFor={id}>{label}</label>
        {detail ? <p>{detail}</p> : null}
      </div>
    </div>
  )
}
