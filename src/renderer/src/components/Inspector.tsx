// The inspector: the rail of tabs and the panel of the open tab. The rail is a vertical tab list
// (arrow keys move between the tabs).
import { useId, type ReactNode } from 'react'
import { Clock, LayoutTemplate, Music, SlidersHorizontal } from 'lucide-react'
import { useStore, type InspectorTab } from '../store'
import { t } from '../i18n'
import { ThemesPanel } from './ThemesPanel'
import { MusicPanel } from './MusicPanel'
import { TimingPanel } from './TimingPanel'
import { SlidePanel } from './SlidePanel'

export function Inspector() {
  const tab = useStore((s) => s.tab)
  const set = useStore((s) => s.set)
  const id = useId()
  const tabs: { id: InspectorTab; icon: ReactNode; label: string }[] = [
    { id: 'themes', icon: <LayoutTemplate size={20} />, label: t('themes') },
    { id: 'music', icon: <Music size={20} />, label: t('music') },
    { id: 'timing', icon: <Clock size={20} />, label: t('timing') },
    { id: 'slide', icon: <SlidersHorizontal size={20} />, label: t('slide') }
  ]
  const current = tabs.find((x) => x.id === tab) ?? tabs[0]
  return (
    <>
      <div
        className="rail"
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('inspector')}
        onKeyDown={(e) => {
          const i = tabs.findIndex((x) => x.id === tab)
          const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
          if (next == null) return
          e.preventDefault()
          const to = tabs[(next + tabs.length) % tabs.length]
          set({ tab: to.id })
          document.getElementById(`${id}-${to.id}`)?.focus()
        }}
      >
        {tabs.map((x) => (
          <button
            key={x.id}
            id={`${id}-${x.id}`}
            role="tab"
            aria-selected={tab === x.id}
            aria-controls={`${id}-panel`}
            tabIndex={tab === x.id ? 0 : -1}
            className={tab === x.id ? 'on' : ''}
            title={x.label}
            aria-label={x.label}
            onClick={() => set({ tab: x.id })}
          >
            {x.icon}
          </button>
        ))}
      </div>
      <div className="inspector" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${current.id}`}>
        {tab === 'themes' && <ThemesPanel />}
        {tab === 'music' && <MusicPanel />}
        {tab === 'timing' && <TimingPanel />}
        {tab === 'slide' && <SlidePanel />}
      </div>
    </>
  )
}
