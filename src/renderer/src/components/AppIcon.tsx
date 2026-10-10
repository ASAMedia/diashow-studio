// The app icon (build/icon.svg, build/icon-small.svg) inline: title bar and About dialog.
import { useId } from 'react'

export function AppIcon({ size = 18 }: { size?: number }) {
  const id = useId().replace(/:/g, '')
  if (size < 24) {
    return (
      <svg className="app-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
        <rect x="5" y="0.5" width="10.5" height="8" rx="1.5" fill="#9cc8fb" stroke="#2f7fe0" strokeWidth="1" />
        <rect x="0.5" y="5" width="12.5" height="10.5" rx="2" fill="#2f7fe0" />
        <path d="M5 7.6 L5 12.9 L9.6 10.25 Z" fill="#ffffff" />
      </svg>
    )
  }
  return (
    <svg className="app-icon" width={size} height={size} viewBox="0 0 256 256" aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4d9fff" />
          <stop offset="1" stopColor="#2f7fe0" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b7d8ff" />
          <stop offset="1" stopColor="#8dbdf6" />
        </linearGradient>
      </defs>
      <g transform="rotate(10 158 81)">
        <rect x="82" y="22" width="152" height="118" rx="20" fill={`url(#${id}b)`} stroke="#2f7fe0" strokeWidth="6" />
        <circle cx="200" cy="52" r="13" fill="#ffffff" />
        <path d="M96 98 L134 58 L160 84 L178 68 L222 108 L222 130 L96 130 Z" fill="#6aa8f2" />
      </g>
      <rect x="18" y="78" width="200" height="156" rx="24" fill={`url(#${id}f)`} stroke="#1f63bd" strokeWidth="4" />
      <path d="M98 122 L98 190 L156 156 Z" fill="#ffffff" stroke="#ffffff" strokeWidth="16" strokeLinejoin="round" />
    </svg>
  )
}
