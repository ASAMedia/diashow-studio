// Pop-up menus (the "⋯" menu in the title bar, the filmstrip's context menu): role="menu", arrow keys,
// Home/End, Esc and Tab close it, and the focus goes back to what opened it. Stays inside the window.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

const CloseMenu = createContext<(refocus: boolean) => void>(() => {})

export function Menu(props: { label: string; onClose: () => void; style?: CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  // read while rendering, before the first item takes the focus
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null))
  const [shift, setShift] = useState({ x: 0, y: 0 })
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  const items = (): HTMLButtonElement[] => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
  const close = (refocus: boolean): void => {
    if (refocus && opener?.isConnected) opener.focus({ preventScroll: true })
    onClose.current()
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = Math.min(0, window.innerWidth - 8 - r.right) || Math.max(0, 8 - r.left)
    const y = Math.min(0, window.innerHeight - 8 - r.bottom) || Math.max(0, 8 - r.top)
    if (x || y) setShift({ x, y })
    items()[0]?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const outside = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose.current()
    }
    const blur = (): void => onClose.current()
    window.addEventListener('pointerdown', outside)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const go = (k: number): void => list[(k + list.length) % list.length]?.focus()
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(-1)
    else if (e.key === 'Escape') close(true)
    else if (e.key === 'Tab') {
      close(true)
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={props.label}
      className="menu"
      style={{ ...props.style, ...(shift.x || shift.y ? { transform: `translate(${shift.x}px, ${shift.y}px)` } : null) }}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <CloseMenu.Provider value={close}>{props.children}</CloseMenu.Provider>
    </div>
  )
}

/** A menu entry: closes the menu (focus back to its opener), then runs `onSelect`. */
export function MenuItem(props: { icon?: ReactNode; onSelect: () => void; disabled?: boolean; children: ReactNode }) {
  const close = useContext(CloseMenu)
  return (
    <button
      role="menuitem"
      tabIndex={-1}
      disabled={props.disabled}
      onClick={() => {
        close(true)
        props.onSelect()
      }}
    >
      {props.icon}
      <span>{props.children}</span>
    </button>
  )
}

export function MenuSeparator() {
  return <hr role="separator" />
}
