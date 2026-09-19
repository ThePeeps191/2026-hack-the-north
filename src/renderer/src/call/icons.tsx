import type { JSX } from 'react'

/**
 * The call UI's icon set: small, geometric, 1.4px strokes on a 16px grid.
 * Icons are decorative; every interactive element carries its own aria label.
 */

export interface IconProps {
  className?: string
  size?: number
}

function Svg({
  className,
  size = 16,
  children
}: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      style={{
        width: size,
        height: size,
        flex: '0 0 auto',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round'
      }}
    >
      {children}
    </svg>
  )
}

export function PlusIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </Svg>
  )
}

export function CloseIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </Svg>
  )
}

export function CheckIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.4 8.4l3 3 6.2-6.8" />
    </Svg>
  )
}

export function ChevronDownIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.8 6.2L8 10.4l4.2-4.2" />
    </Svg>
  )
}

export function ChevronLeftIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.8 3.6L5.4 8l4.4 4.4" />
    </Svg>
  )
}

export function ChevronRightIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.2 3.6L10.6 8l-4.4 4.4" />
    </Svg>
  )
}

export function ArrowLeftIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12.6 8H3.6M7.4 4.2L3.6 8l3.8 3.8" />
    </Svg>
  )
}

export function ArrowRightIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.4 8h9M8.6 4.2L12.4 8l-3.8 3.8" />
    </Svg>
  )
}

export function MicIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="6" y="2.2" width="4" height="7" rx="2" />
      <path d="M4.6 8.2a3.4 3.4 0 0 0 6.8 0M8 11.6v2M5.8 13.6h4.4" />
    </Svg>
  )
}

export function MicOffIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 3.9a2 2 0 0 1 4 0v3.4" />
      <path d="M4.6 8.2a3.4 3.4 0 0 0 5 3M8 11.6v2M5.8 13.6h4.4" />
      <path d="M2.6 2.6l10.8 10.8" />
    </Svg>
  )
}

export function HeadphonesIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 10.6V8a5 5 0 0 1 10 0v2.6" />
      <rect x="2.1" y="9.6" width="2.6" height="4.2" rx="1.3" />
      <rect x="11.3" y="9.6" width="2.6" height="4.2" rx="1.3" />
    </Svg>
  )
}

export function HeadphonesOffIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 10.6V8a5 5 0 0 1 8.4-3.6" />
      <path d="M2.1 9.6h2.6v4.2H3.4A1.3 1.3 0 0 1 2.1 12.5zM11.3 9.6h2.6v2.9" />
      <path d="M2.6 2.6l10.8 10.8" />
    </Svg>
  )
}

export function EnterCallIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.6 3.4h3.2v9.2H9.6" />
      <path d="M3.4 8h6M7.2 5.6L9.6 8l-2.4 2.4" />
    </Svg>
  )
}

export function LeaveCallIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.4 3.4H3.2v9.2h3.2" />
      <path d="M6.4 8h6.2M10.2 5.6L12.6 8l-2.4 2.4" />
    </Svg>
  )
}

export function PauseIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.2 3.6v8.8M9.8 3.6v8.8" />
    </Svg>
  )
}

export function PlayIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5.6 3.6l7 4.4-7 4.4z" />
    </Svg>
  )
}

export function StopIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.4" />
    </Svg>
  )
}

export function SlidersIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.6 5.4h10.8M2.6 10.6h10.8" />
      <circle cx="6" cy="5.4" r="1.5" />
      <circle cx="10.4" cy="10.6" r="1.5" />
    </Svg>
  )
}

export function ChatIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.4 3.4h9.2a1.4 1.4 0 0 1 1.4 1.4v4.6a1.4 1.4 0 0 1-1.4 1.4H7.8L4.6 13.2v-2.4H3.4A1.4 1.4 0 0 1 2 9.4V4.8a1.4 1.4 0 0 1 1.4-1.4z" />
    </Svg>
  )
}

export function HelpIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M6.4 6.4a1.7 1.7 0 1 1 2.3 1.6c-.6.25-.9.6-.9 1.2v.3" />
      <path d="M8 11.6v.01" />
    </Svg>
  )
}

export function BookmarkIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.4 2.6h7.2v11.2L8 10.8l-3.6 3z" />
    </Svg>
  )
}

export function HistoryIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 8a5 5 0 1 0 1.5-3.6" />
      <path d="M3 3.4v3.2h3.2" />
      <path d="M8 5.8V8l1.8 1.3" />
    </Svg>
  )
}

export function GridIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2.4" y="2.4" width="4.8" height="4.8" rx="1.3" />
      <rect x="8.8" y="2.4" width="4.8" height="4.8" rx="1.3" />
      <rect x="2.4" y="8.8" width="4.8" height="4.8" rx="1.3" />
      <rect x="8.8" y="8.8" width="4.8" height="4.8" rx="1.3" />
    </Svg>
  )
}

export function MonitorIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2" y="3.2" width="12" height="8" rx="1.6" />
      <path d="M5.8 13.4h4.4" />
    </Svg>
  )
}

export function PinIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.2 2.6h3.6l-.5 2.8 1.9 2.1H4.8l1.9-2.1z" />
      <path d="M8 7.5v5.9" />
    </Svg>
  )
}

export function ReplyIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.4 4.2L2.8 7.4l3.6 3.2" />
      <path d="M2.8 7.4h6.4a3.6 3.6 0 0 1 3.6 3.6v1.2" />
    </Svg>
  )
}

export function UsersIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="6" cy="5.8" r="2.3" />
      <path d="M2.4 12.9c.5-2.1 1.9-3.2 3.6-3.2s3.1 1.1 3.6 3.2" />
      <path d="M10.8 4.2a2.1 2.1 0 0 1 0 3.7M11.6 12.9c-.2-1.5-.8-2.5-1.6-3.1" />
    </Svg>
  )
}

export function GlobeIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M2.6 8h10.8" />
      <path d="M8 2.6c1.7 1.7 2.5 3.5 2.5 5.4S9.7 11.7 8 13.4c-1.7-1.7-2.5-3.5-2.5-5.4S6.3 4.3 8 2.6z" />
    </Svg>
  )
}

export function CodeIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.2 4.4L3 8l3.2 3.6M9.8 4.4L13 8l-3.2 3.6" />
    </Svg>
  )
}

export function TerminalIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.6 4.6L6.4 8l-2.8 3.4M8.6 11.4h4" />
    </Svg>
  )
}

export function FolderIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.4 4.9A1.3 1.3 0 0 1 3.7 3.6h2.5l1.4 1.9h4.7a1.3 1.3 0 0 1 1.3 1.3v4.9a1.3 1.3 0 0 1-1.3 1.3H3.7a1.3 1.3 0 0 1-1.3-1.3z" />
    </Svg>
  )
}

export function FileIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 2.6h5l3 3v7.8H4z" />
      <path d="M9 2.6v3.4h3" />
    </Svg>
  )
}

export function BranchIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="4.8" cy="3.9" r="1.6" />
      <circle cx="4.8" cy="12.1" r="1.6" />
      <circle cx="11.2" cy="6.4" r="1.6" />
      <path d="M4.8 5.5v5" />
      <path d="M6.4 3.9h3.2a1.6 1.6 0 0 1 1.6 1.6v0" />
    </Svg>
  )
}

export function AlertIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 2.6l5.6 9.8H2.4z" />
      <path d="M8 6.4v3.1M8 11.5v.01" />
    </Svg>
  )
}

export function InfoIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 7.4v3.8M8 5.2v.01" />
    </Svg>
  )
}

export function RefreshIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 3.2v3.4H9.8" />
    </Svg>
  )
}

export function TrashIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.4 4.6h9.2" />
      <path d="M6.4 4.6V3.4h3.2v1.2" />
      <path d="M4.9 4.6l.5 8.2h5.2l.5-8.2" />
    </Svg>
  )
}

export function EyeIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M1.9 8S4.4 4.5 8 4.5 14.1 8 14.1 8 11.6 11.5 8 11.5 1.9 8 1.9 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </Svg>
  )
}

export function VolumeIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.2 6.2h2.2L8.6 3.9v8.2L5.4 9.8H3.2z" />
      <path d="M10.6 6.2a2.6 2.6 0 0 1 0 3.6" />
    </Svg>
  )
}

export function SpeechIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.6 8.6h1.6M6 4.6v7M8 3.2v9.6M10 5.8v4.4M12.6 7.4v1.2" />
    </Svg>
  )
}

export function LockIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4.2" y="7.2" width="7.6" height="6.2" rx="1.3" />
      <path d="M5.9 7.2V5.7a2.1 2.1 0 0 1 4.2 0v1.5" />
    </Svg>
  )
}

export function ExternalIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.4 3.4h3.2v3.2" />
      <path d="M12.6 3.4L7.6 8.4" />
      <path d="M11.2 9.2v3.4H3.4V4.8h3.4" />
    </Svg>
  )
}

export function KeyboardIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="1.8" y="4.4" width="12.4" height="7.2" rx="1.5" />
      <path d="M4.6 9.8h6.8" />
      <path d="M4.6 6.6h.01M7.3 6.6h.01M10 6.6h.01M12.7 6.6h.01" />
    </Svg>
  )
}
