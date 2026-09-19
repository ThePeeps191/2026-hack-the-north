import { useId, type JSX } from 'react'

/**
 * The avatar set. Every mark is drawn here as an original geometric SVG: one
 * disc, one distinguishable silhouette, tinted with the participant's colour.
 * They stay legible at 40px and never rely on gradients or imagery.
 */

export const AVATAR_KEYS = ['prism', 'orbit', 'wave', 'leaf', 'spark', 'human', 'huddle'] as const
export type AvatarKey = (typeof AVATAR_KEYS)[number]

export interface AvatarProps {
  /** Avatar key from the agent record, preset, or `human` / `huddle`. */
  avatar: string
  /** Hex colour. The disc and mark are tinted from it. */
  color: string
  size?: number
  className?: string
  /** Reduces contrast for an idle or offline participant. */
  dim?: boolean
}

export function AvatarMark({ avatar, color, size = 40, className, dim }: AvatarProps): JSX.Element {
  const raw = useId()
  const clipId = `hs-av-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const opacity = dim ? 0.9 : 1

  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      role="img"
      aria-hidden="true"
      focusable="false"
      style={{
        width: size,
        height: size,
        flex: '0 0 auto',
        fill: 'none',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        opacity
      }}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="24" cy="24" r="22.4" />
        </clipPath>
      </defs>
      <circle cx="24" cy="24" r="22.4" fill={color} fillOpacity="0.24" />
      <circle
        cx="24"
        cy="24"
        r="22.4"
        fill="none"
        stroke={color}
        strokeOpacity="0.15"
        strokeWidth="1.5"
      />
      <g clipPath={`url(#${clipId})`}>{mark(avatar, color)}</g>
    </svg>
  )
}

function mark(key: string, color: string): JSX.Element {
  switch (key) {
    case 'prism':
      return (
        <>
          <path
            d="M24 12.6L34.4 31.2H13.6z"
            fill={color}
            fillOpacity="0.9"
            stroke={color}
            strokeOpacity="0.85"
            strokeWidth="1.7"
          />
          <path d="M24 27.6L19.2 19.4h9.6z" fill={color} fillOpacity="0.85" />
        </>
      )
    case 'orbit':
      return (
        <>
          <ellipse
            cx="24"
            cy="24"
            rx="13"
            ry="6.4"
            transform="rotate(-28 24 24)"
            fill="none"
            stroke={color}
            strokeOpacity="0.6"
            strokeWidth="1.5"
          />
          <circle cx="24" cy="24" r="6" fill={color} fillOpacity="0.85" />
          <circle cx="35.4" cy="17.9" r="2.5" fill={color} fillOpacity="0.95" />
        </>
      )
    case 'wave':
      return (
        <>
          <rect x="13.4" y="19.6" width="3.6" height="8.8" rx="1.8" fill={color} fillOpacity="0.5" />
          <rect x="19.2" y="13.6" width="3.6" height="20.8" rx="1.8" fill={color} fillOpacity="0.9" />
          <rect x="25" y="16.6" width="3.6" height="14.8" rx="1.8" fill={color} fillOpacity="0.72" />
          <rect x="30.8" y="21.4" width="3.6" height="5.2" rx="1.8" fill={color} fillOpacity="0.42" />
        </>
      )
    case 'leaf':
      return (
        <>
          <path
            d="M24 12.4c6.6 4.4 6.6 19 0 23.2-6.6-4.2-6.6-18.8 0-23.2z"
            fill={color}
            fillOpacity="0.18"
            stroke={color}
            strokeOpacity="0.8"
            strokeWidth="1.6"
          />
          <path d="M24 15.6v17" stroke={color} strokeOpacity="0.55" strokeWidth="1.2" />
          <path
            d="M24 12.4c1.9-1.3 3.5-1.8 4.9-1.6"
            stroke={color}
            strokeOpacity="0.7"
            strokeWidth="1.3"
            fill="none"
          />
        </>
      )
    case 'spark':
      return (
        <>
          <path
            d="M24 10.8c1.3 7.5 5.2 11.4 12.7 12.7-7.5 1.3-11.4 5.2-12.7 12.7-1.3-7.5-5.2-11.4-12.7-12.7 7.5-1.3 11.4-5.2 12.7-12.7z"
            fill={color}
            fillOpacity="0.8"
          />
          <circle cx="24" cy="23.5" r="2.1" fill={color} fillOpacity="0.35" />
        </>
      )
    case 'human':
      return (
        <>
          <circle cx="24" cy="19.4" r="6.3" fill={color} fillOpacity="0.8" />
          <path d="M12.4 37.4c0-5.9 5.2-9.7 11.6-9.7s11.6 3.8 11.6 9.7z" fill={color} fillOpacity="0.72" />
        </>
      )
    default:
      return (
        <>
          <circle cx="19.4" cy="20.8" r="6.8" fill={color} fillOpacity="0.55" />
          <circle cx="29.6" cy="20.8" r="6.8" fill={color} fillOpacity="0.33" />
          <path
            d="M13.4 35.4c1.7-3.6 4.9-5.4 10.6-5.4s8.9 1.8 10.6 5.4"
            fill="none"
            stroke={color}
            strokeOpacity="0.7"
            strokeWidth="1.6"
          />
        </>
      )
  }
}
