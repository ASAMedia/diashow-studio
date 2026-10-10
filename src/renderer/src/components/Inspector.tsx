// The inspector: the rail of tabs and the panel of the open tab.
import type { ReactNode } from 'react'
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
  const tabs: { id: InspectorTab; icon: ReactNode; label: string }[] = [
    { id: 'themes', icon: <LayoutTemplate size={19} />, label: t('themes') },
    { id: 'music', icon: <Music size={19} />, label: t('music') },
    { id: 'timing', icon: <Clock size={19} />, label: t('timing') },
    { id: 'slide', icon: <SlidersHorizontal size={19} />, label: t('slide') }
  ]
  return (
    <>
      <div className="inspector">
        {tab === 'themes' && <ThemesPanel />}
        {tab === 'music' && <MusicPanel />}
        {tab === 'timing' && <TimingPanel />}
        {tab === 'slide' && <SlidePanel />}
      </div>
      <div className="rail">
        {tabs.map((x) => (
          <button key={x.id} className={tab === x.id ? 'on' : ''} title={x.label} aria-label={x.label} onClick={() => set({ tab: x.id })}>
            {x.icon}
          </button>
        ))}
      </div>
    </>
  )
}
