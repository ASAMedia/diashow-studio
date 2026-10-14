// Short tips that introduce the main steps on first use (home screen, editor).
import { useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { t } from '../i18n'

/** One-time hint card; `id` remembers that it was dismissed. */
export function Tip({ id, children }: { id: string; children: React.ReactNode }) {
  const key = `tip:${id}`
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem(key)
    } catch {
      return true
    }
  })
  if (!open) return null
  return (
    <div className="tip" role="note">
      <Lightbulb size={16} aria-hidden />
      <span>{children}</span>
      <button
        className="btn small"
        onClick={() => {
          setOpen(false)
          try {
            localStorage.setItem(key, '1')
          } catch {
            // ignore
          }
        }}
      >
        {t('gotIt')}
      </button>
    </div>
  )
}
