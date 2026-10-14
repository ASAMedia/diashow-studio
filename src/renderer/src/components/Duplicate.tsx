// "Duplizieren" (a show's card on the home screen, the editor's "⋯" menu): an independent copy of the
// show, e.g. a parents' version with more pixelation next to the class version (src/main/duplicate.ts).
// The copy opens in the editor right away, since the next step is changing it; a notice says that
// this is the copy and the original stays as it was.
import { Copy, X } from 'lucide-react'
import { useEffect } from 'react'
import { create } from 'zustand'
import { saveOpenProject, useStore } from '../store'
import { notifyError } from '../errors'
import { t } from '../i18n'

/** The id of the copy made last, while it is the open show. */
const useCopied = create<{ copy: string | null }>(() => ({ copy: null }))

/** Duplicates show `id` (an open one is saved first: the copy is made from its file) and opens the copy. */
export async function duplicateShow(id: string): Promise<void> {
  try {
    await saveOpenProject(id)
    const copy = await window.api.duplicateProject(id, t('copyWord'))
    await useStore.getState().openProject(copy.id)
    useCopied.setState({ copy: copy.id })
  } catch (e) {
    notifyError(e, 'save')
  }
}

/** "This is the copy …", above the editor while the copy just made is open (with its name as it is now). */
export function DuplicateNotice() {
  const copy = useCopied((s) => s.copy)
  const open = useStore((s) => s.project?.id)
  const name = useStore((s) => s.project?.name ?? '')
  // another show opened, or back on the home screen: the notice is done
  useEffect(() => {
    if (copy && open !== copy) useCopied.setState({ copy: null })
  }, [copy, open])
  if (!copy || open !== copy) return null
  return (
    <div className="notice-stack upper">
      <div className="notice info" data-testid="duplicate-notice" role="status">
        <Copy size={16} className="notice-icon" aria-hidden />
        <div className="notice-body">
          <b>{t('duplicateDone').replace('{name}', name)}</b>
          <span>{t('duplicateHint')}</span>
        </div>
        <button className="btn ghost icon small" title={t('close')} aria-label={t('close')} onClick={() => useCopied.setState({ copy: null })}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
