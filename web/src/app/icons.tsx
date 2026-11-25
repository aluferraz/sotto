import type { JSX } from 'preact'

const icon = (path: JSX.Element, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{path}</svg>
)

export const Mic = ({ size = 18 }: { size?: number }) => icon(<>
  <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" />
</>, size)
export const Stop = ({ size = 18 }: { size?: number }) => icon(<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />, size)
export const Check = () => icon(<path d="M5 12.5l4.5 4.5L19 7.5" />, 16)
export const Copy = () => icon(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>, 16)
export const Trash = () => icon(<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>, 16)
export const Plus = () => icon(<path d="M12 5v14M5 12h14" />, 16)
export const Close = () => icon(<path d="M6 6l12 12M18 6L6 18" />, 14)

/** The Sotto mark: a small waveform. */
export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="#6d4aff" />
    <g fill="#fff">
      <rect x="6.5" y="13" width="3" height="6" rx="1.5" /><rect x="11.5" y="9" width="3" height="14" rx="1.5" />
      <rect x="16.5" y="11.5" width="3" height="9" rx="1.5" /><rect x="21.5" y="7" width="3" height="18" rx="1.5" />
    </g>
  </svg>
)
