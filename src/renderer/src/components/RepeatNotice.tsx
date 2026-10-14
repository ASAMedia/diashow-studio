// The notice after an import that skipped photos or videos the show has already (repeats.ts): what was
// skipped, "Add anyway" (one undo step) and "Show" (selects the slides they repeat). It sits in the
// notice stack at the bottom right (dialogs leave it reachable with Tab), stays until it is closed or the
// next one replaces it, and its text is read out by screen readers through a polite live region.
import { useEffect, useState } from 'react'
import { CopyCheck, X } from 'lucide-react'
import { playerRef, useStore } from '../store'
import { timelineOf } from '../timeline'
import { stripReveal } from '../insert'
import { notifyError } from '../errors'
import { dismissRepeats, noticeText, useRepeatNotice, type RepeatNotice as Notice } from '../repeats'
import { t } from '../i18n'

/** Back to the filmstrip once the notice is gone (its selected card is the strip's Tab stop). */
function focusStrip(): void {
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return
    document.querySelector<HTMLElement>('.cards .card[tabindex="0"]')?.focus({ preventScroll: true })
  })
}

/** Selects the slides of the photos and videos the skipped ones repeat; left-out ones are in the review grid. */
function showTargets(notice: Notice): void {
  const s = useStore.getState()
  const p = s.project
  if (!p) return
  const want = new Set(notice.targets)
  const entries = p.entries.filter((e) => e.type !== 'text' && want.has(e.mediaId))
  const shown = entries.filter((e) => !e.excluded)
  if (!shown.length) {
    if (entries.length) s.set({ view: 'cull' })
    return
  }
  if (s.view !== 'editor') s.set({ view: 'editor' })
  s.select(shown.map((e) => e.id))
  s.set({ tab: 'slide' })
  stripReveal.current?.(shown[0].id)
  const slide = timelineOf(p).slides.find((x) => x.entries.some((e) => e.id === shown[0].id))
  if (slide) playerRef.current?.seek(slide.start + Math.min(slide.transIn + 0.05, slide.duration / 2))
}

export function RepeatNotice() {
  const notice = useRepeatNotice((s) => s.notice)
  const announce = useRepeatNotice((s) => s.announce)
  const project = useStore((s) => s.project)
  const [busy, setBusy] = useState(false)
  const shown = notice && project && notice.projectId === project.id ? notice : null
  // another show (or none) is open: the notice belongs to the one before and goes
  const projectId = project?.id
  useEffect(() => {
    const n = useRepeatNotice.getState().notice
    if (n && n.projectId !== projectId) dismissRepeats()
  }, [projectId])

  const addAnyway = async (n: Notice): Promise<void> => {
    setBusy(true)
    try {
      const ids = await n.addAnyway()
      if (useRepeatNotice.getState().notice?.id === n.id) dismissRepeats()
      if (ids.length) {
        useStore.getState().select(ids)
        stripReveal.current?.(ids[0])
      }
      focusStrip()
    } catch (e) {
      notifyError(e, 'import')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" data-testid="repeat-announce">
        {shown ? announce : ''}
      </div>
      {shown && project && (
        <div
          className="notice info"
          data-testid="repeat-notice"
          role="group"
          aria-labelledby={`repeat-text-${shown.id}`}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            dismissRepeats()
            focusStrip()
          }}
        >
          <CopyCheck size={16} className="notice-icon" aria-hidden />
          <div className="notice-body">
            <span className="repeat-text" id={`repeat-text-${shown.id}`}>{noticeText(project, shown)}</span>
            <div className="row">
              <button className="btn small" disabled={busy} onClick={() => void addAnyway(shown)}>
                {t('repeatAddAnyway')}
              </button>
              <button className="btn small" title={t('repeatShowHint')} onClick={() => showTargets(shown)}>
                {t('repeatShow')}
              </button>
            </div>
          </div>
          <button
            className="btn ghost icon small"
            title={t('close')}
            aria-label={t('close')}
            onClick={() => {
              dismissRepeats()
              focusStrip()
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  )
}
