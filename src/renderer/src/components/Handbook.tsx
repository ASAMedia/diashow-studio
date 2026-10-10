// The in-app handbook (F1, "Hilfe"): short chapters in German or English with screenshots, bundled
// with the app (handbook/de.md, handbook/en.md, images in public/handbook/<lang>/, made by
// e2e/handbook-shots.spec.ts). The table of contents filters as you type.
import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Info, Keyboard, Search, Wand2, X } from 'lucide-react'
import de from '../handbook/de.md?raw'
import en from '../handbook/en.md?raw'
import { Blocks, matches, parseHandbook, searchWords, type Chapter, type InlineContext } from '../handbook/markdown'
import { useStore } from '../store'
import { localeTag, t } from '../i18n'
import { openWizard } from './Wizard'
import { Modal, useDialogTitleId } from './Modal'
import './help.css'

let cache: { lang: 'de' | 'en'; chapters: Chapter[] } | null = null

export function handbookChapters(): { lang: 'de' | 'en'; chapters: Chapter[] } {
  const lang = localeTag().startsWith('de') ? 'de' : 'en'
  if (cache?.lang !== lang) cache = { lang, chapters: parseHandbook(lang === 'de' ? de : en).chapters }
  return cache
}

/** Starts the assistant from the handbook: an open show is saved and closed first. */
function startWizard(): void {
  const s = useStore.getState()
  s.set({ dialog: null })
  if (s.project) s.closeProject()
  openWizard()
}

export function HandbookDialog() {
  const set = useStore((s) => s.set)
  const { lang, chapters } = handbookChapters()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(chapters[0]?.id ?? '')
  const body = useRef<HTMLDivElement>(null)
  const words = useMemo(() => searchWords(query), [query])
  const shown = useMemo(() => (words.length ? chapters.filter((c) => matches(c, words)) : chapters), [chapters, words])

  const scrollTo = (id: string): void => {
    setActive(id)
    const el = body.current?.querySelector<HTMLElement>(`[data-chapter="${CSS.escape(id)}"]`)
    if (el && body.current) body.current.scrollTop = el.offsetTop - 12
  }

  const ctx: InlineContext = {
    words,
    onJump: (id) => {
      // a link to a chapter the search hides shows everything again
      if (!shown.some((c) => c.id === id)) setQuery('')
      requestAnimationFrame(() => scrollTo(id))
    },
    onAction: (action) => {
      if (action === 'shortcuts') set({ dialog: 'help' })
      else if (action === 'about') set({ dialog: 'about' })
      else if (action === 'settings') set({ dialog: 'settings' })
      else if (action === 'wizard') startWizard()
    }
  }

  // the chapter in view is marked in the table of contents
  useEffect(() => {
    const el = body.current
    if (!el) return
    const onScroll = (): void => {
      const secs = [...el.querySelectorAll<HTMLElement>('[data-chapter]')]
      let cur = secs[0]?.dataset.chapter ?? ''
      for (const s of secs) if (s.offsetTop - 40 <= el.scrollTop) cur = s.dataset.chapter ?? cur
      setActive(cur)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
    if (shown[0]) setActive(shown[0].id)
  }, [query])

  const close = (): void => set({ dialog: null })
  return (
    <Modal bare onClose={close} backdropClose className="hb" testId="handbook">
      <aside className="hb-side">
        <HandbookHead />
        <div className="hb-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            autoFocus
            aria-label={t('handbookSearch')}
            placeholder={t('handbookSearch')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                e.preventDefault()
                if (query) setQuery('')
                else close()
              } else if (e.key === 'F1') {
                e.preventDefault()
                e.stopPropagation()
                close()
              } else if (e.key === 'Enter' && shown[0]) scrollTo(shown[0].id)
            }}
          />
        </div>
        <nav className="hb-toc" aria-label={t('handbookToc')}>
          {shown.map((c) => (
            <button key={c.id} className={c.id === active ? 'on' : ''} aria-current={c.id === active ? 'true' : undefined} onClick={() => scrollTo(c.id)}>
              <span className="n">{chapters.indexOf(c) + 1}</span>
              <span>{c.title}</span>
            </button>
          ))}
          {!shown.length && <div className="empty">{t('handbookNoHits')}</div>}
        </nav>
        <div className="hb-foot">
          <button className="btn ghost small" onClick={startWizard}>
            <Wand2 size={15} /> {t('wizardOpen')}
          </button>
          <button className="btn ghost small" onClick={() => set({ dialog: 'help' })}>
            <Keyboard size={15} /> {t('shortcuts')}
          </button>
          <button className="btn ghost small" onClick={() => set({ dialog: 'about' })}>
            <Info size={15} /> {t('about')}
          </button>
        </div>
      </aside>
      <div className="hb-main">
        <button className="btn ghost icon hb-close" title={t('close')} aria-label={t('close')} onClick={close}>
          <X size={16} />
        </button>
        <div className="hb-body" ref={body} tabIndex={0} aria-label={t('handbook')}>
          {shown.map((c) => (
            <section key={c.id} data-chapter={c.id} id={`hb-${c.id}`}>
              <h2>{c.title}</h2>
              <Blocks blocks={c.blocks} ctx={ctx} imageBase={`./handbook/${lang}/`} />
            </section>
          ))}
          {!shown.length && <p className="hint">{t('handbookNoHits')}</p>}
        </div>
      </div>
    </Modal>
  )
}

/** The handbook's title in its sidebar; it names the dialog. */
function HandbookHead() {
  const id = useDialogTitleId()
  return (
    <div className="hb-head">
      <BookOpen size={18} aria-hidden /> <span id={id}>{t('handbook')}</span>
    </div>
  )
}
