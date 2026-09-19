import type { JSX } from 'react'

type IconProps = { className?: string }

export function PlusIcon({ className }: IconProps): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

export function MicOffIcon({ className }: IconProps): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="6" y="2.5" width="4" height="7" rx="2" />
      <path d="M4.5 8.5a3.5 3.5 0 0 0 7 0M8 12v1.5M5.5 13.5h5M3 3l10 10" />
    </svg>
  )
}

export function ChevronIcon({ className }: IconProps): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}
