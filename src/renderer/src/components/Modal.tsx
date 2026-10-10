// Every dialog of the app goes through Modal: the dimmed overlay, role="dialog" with aria-modal and a
// title, Esc to close, focus kept inside while it is open and given back to the opener afterwards.
// The usual layout is a header (title + ✕), a scrolling body and a footer with the actions, so a
// dialog is never taller than the window; `bare` dialogs (handbook, assistant) lay out themselves.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { t } from '../i18n'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** Focusable elements inside `root` that are visible, in tab order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
}

const TitleId = createContext<string | undefined>(undefined)

/** Who opened each open dialog: a dialog opened from inside another one falls back to that one's opener. */
const openers = new WeakMap<HTMLElement, HTMLElement | null>()

/** The id a `bare` dialog gives its own heading (aria-labelledby). */
export const useDialogTitleId = (): string | undefined => useContext(TitleId)

export interface ModalProps {
  /** Heading of the dialog (also its accessible name). */
  title?: ReactNode
  /** Esc, the ✕ in the header and (with `backdropClose`) a click beside the dialog. Without it Esc does nothing. */
  onClose?: () => void
  /** Footer buttons, right-aligned. */
  actions?: ReactNode
  /** More classes on the .dialog element (e.g. 'wide'). */
  className?: string
  overlayClassName?: string
  testId?: string
  backdropClose?: boolean
  /** Without header, body and footer: the children lay out the whole dialog (use useDialogTitleId). */
  bare?: boolean
  /** Shown in the header between the title and the ✕. */
  headExtra?: ReactNode
  /** No ✕ in the header (the footer has the way out). */
  noCloseButton?: boolean
  /** Accessible name when there is no visible title. */
  label?: string
  children?: ReactNode
  /** Extra attributes for tests (data-*). */
  data?: Record<string, string | number | undefined>
}

export function Modal(props: ModalProps) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  /** Set while the dialog closes: giving the focus back must not be undone by keepInside. */
  const closing = useRef(false)
  // read while rendering: an autofocused field inside takes the focus before the effects run
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null))

  // focus moves into the dialog; it goes back to whatever opened it when the dialog closes
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const parent = opener?.closest<HTMLElement>('[role="dialog"]')
    const fallback = parent ? (openers.get(parent) ?? null) : null
    openers.set(el, opener && !parent ? opener : (fallback ?? opener))
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    return () => {
      closing.current = true
      const back = opener?.isConnected ? opener : fallback?.isConnected ? fallback : null
      // a dialog inside this one (or the next dialog) may have taken the focus already
      const now = document.activeElement
      if (back && (!now || now === document.body || el.contains(now) || !now.isConnected)) back.focus({ preventScroll: true })
    }
  }, [opener])

  // a dialog that opens over this one gets the keys; this one waits underneath
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const keepInside = (e: FocusEvent): void => {
      const target = e.target as Node | null
      if (closing.current || !target || el.contains(target)) return
      // focus left for something outside every dialog (not a nested or newer one): bring it back
      const other = (target as HTMLElement).closest?.('[role="dialog"], [role="alertdialog"], .notice-stack, .menu')
      if (!other && el === topmostDialog()) el.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', keepInside)
    return () => document.removeEventListener('focusin', keepInside)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // the innermost dialog handles Esc; the editor's shortcuts never see it
      e.stopPropagation()
      e.preventDefault()
      onClose.current?.()
      return
    }
    if (e.key !== 'Tab') return
    const el = ref.current
    if (!el) return
    const list = focusables(el)
    if (!list.length) {
      e.preventDefault()
      return
    }
    const first = list[0]
    const last = list[list.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const close = props.onClose && !props.noCloseButton ? (
    <button className="btn ghost icon" title={t('close')} aria-label={t('close')} onClick={props.onClose}>
      <X size={16} />
    </button>
  ) : null

  const dataAttrs = Object.fromEntries(Object.entries(props.data ?? {}).map(([k, v]) => [`data-${k}`, v]))
  return (
    <div
      className={`overlay ${props.overlayClassName ?? ''}`}
      onMouseDown={(e) => {
        if (props.backdropClose && e.target === e.currentTarget) props.onClose?.()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.title != null || props.bare ? titleId : undefined}
        aria-label={props.title == null && !props.bare ? props.label : undefined}
        tabIndex={-1}
        className={`dialog ${props.className ?? ''}`}
        data-testid={props.testId}
        onKeyDown={onKeyDown}
        {...dataAttrs}
      >
        <TitleId.Provider value={titleId}>
          {props.bare ? (
            props.children
          ) : (
            <>
              {(props.title != null || close) && (
                <div className="dialog-head">
                  {props.title != null && <h2 id={titleId}>{props.title}</h2>}
                  {props.headExtra}
                  {close}
                </div>
              )}
              <div className="dialog-body">{props.children}</div>
              {props.actions && <div className="actions">{props.actions}</div>}
            </>
          )}
        </TitleId.Provider>
      </div>
    </div>
  )
}

/** The dialog that was opened last (the one on top). */
function topmostDialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
  return all.length ? all[all.length - 1] : null
}
