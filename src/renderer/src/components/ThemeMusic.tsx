// Theme music in the editor (Music tab) and the assistant: switch it on or off, pick a theme's song
// and listen to it. Which songs play is decided in one place (src/shared/themeMusic.ts).
import { useEffect, useRef, useState } from 'react'
import { Music, Play, Square } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import { THEMES } from '@shared/themes'
import { chosenTheme, freeLicence, type ThemeTrack } from '@shared/themeMusic'
import type { ThemeId } from '@shared/types'
import { useStore } from '../store'
import { pick, t } from '../i18n'
import { Check, Section } from './ui'

/** Plays one song at a time from its start (the Listen button); stops when another song is chosen or the panel closes. */
function useListen(chosen: string | undefined): { playing: string | null; toggle: (track: ThemeTrack) => void } {
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const stop = (): void => {
    audio.current?.pause()
    audio.current = null
    setPlaying(null)
  }
  useEffect(() => stop, [chosen])
  const toggle = (track: ThemeTrack): void => {
    const again = playing === track.id
    stop()
    if (again || !track.playback) return
    const a = new Audio(mediaUrl(track.playback))
    audio.current = a
    a.onended = stop
    void a.play().then(() => setPlaying(track.id)).catch(() => setPlaying(null))
  }
  return { playing, toggle }
}

/** "Title – Artist · free to use (CC0 / public domain)". */
export function songCredit(song: ThemeTrack): string {
  const licence = freeLicence(song.licence) ? t('themeLicenceFree') : song.licence
  return [`${song.title}${song.artist ? ` – ${song.artist}` : ''}`, licence].filter(Boolean).join(' · ')
}

function ListenButton({ song, listen }: { song: ThemeTrack; listen: ReturnType<typeof useListen> }) {
  const on = listen.playing === song.id
  return (
    <button className="btn small" data-testid="theme-listen" aria-label={`${on ? t('stop') : t('listen')}: ${song.title}`} onClick={() => listen.toggle(song)}>
      {on ? <Square size={12} /> : <Play size={13} />} {on ? t('stop') : t('listen')}
    </button>
  )
}

/** Music tab: theme music on or off, which song, and that the show's own songs replace it. */
export function ThemeMusicSection() {
  const project = useStore((s) => s.project)!
  const themeTracks = useStore((s) => s.themeTracks)
  const setSettings = useStore((s) => s.setSettings)
  const st = project.settings
  const song = themeTracks.find((x) => x.theme === chosenTheme(st))
  const listen = useListen(song?.id)
  if (!themeTracks.length) return null
  const on = st.themeMusic === true
  const own = project.music.length > 0
  const songOf = (id: ThemeId): ThemeTrack | undefined => themeTracks.find((x) => x.theme === id)
  const auto = songOf(st.theme)
  return (
    <Section title={t('themeMusic')} className="theme-music">
      <Check checked={on} testId="theme-music-on" onChange={(v) => setSettings(v ? { themeMusic: true, themeSong: st.themeSong ?? 'auto' } : { themeMusic: false })}>
        {t('themeMusicOn')}
      </Check>
      <select
        className="theme-song"
        aria-label={t('themeSong')}
        data-testid="theme-song"
        value={st.themeSong ?? 'auto'}
        onChange={(e) => setSettings({ themeSong: e.target.value as ThemeId | 'auto' })}
      >
        {/* the theme's name, not only the song's: "Classic" is a song of Magazine, not the Classic theme */}
        <option value="auto">
          {t('themeSongAuto')}
          {auto ? ` (${pick(THEMES.find((th) => th.id === st.theme)!.name)}): ${auto.title}` : ''}
        </option>
        {THEMES.filter((th) => songOf(th.id)).map((th) => (
          <option key={th.id} value={th.id}>
            {pick(th.name)}: {songOf(th.id)!.title}
          </option>
        ))}
      </select>
      {song && (
        <div className="trim-row">
          <span className="hint theme-credit" data-testid="theme-credit">
            {songCredit(song)}
          </span>
          <ListenButton song={song} listen={listen} />
        </div>
      )}
      {own ? (
        <p className="hint" data-testid="theme-music-own">
          {t('themeMusicOwn')}
        </p>
      ) : (
        !on && <p className="hint">{t('themeMusicOff')}</p>
      )}
    </Section>
  )
}

/** The assistant's music step: the theme song is the default; songs of your own replace it. */
export function WizardThemeSong() {
  const project = useStore((s) => s.project)
  const themeTracks = useStore((s) => s.themeTracks)
  const song = project ? themeTracks.find((x) => x.theme === chosenTheme(project.settings)) : undefined
  const listen = useListen(song?.id)
  if (!project) return null
  const st = project.settings
  if (!song) return <p className="empty-note">{t('wizardNoMusic')}</p>
  return (
    <div className="wizard-theme-song">
      <Music size={13} aria-hidden />
      <Check
        className="t"
        checked={st.themeMusic === true}
        testId="wizard-theme-music"
        onChange={(v) => useStore.getState().setSettings(v ? { themeMusic: true, themeSong: st.themeSong ?? 'auto' } : { themeMusic: false })}
      >
        {t('themeMusic')}: {songCredit(song)}
      </Check>
      <button
        className="listen"
        title={listen.playing === song.id ? t('stop') : t('listen')}
        aria-label={`${listen.playing === song.id ? t('stop') : t('listen')}: ${song.title}`}
        onClick={() => listen.toggle(song)}
      >
        {listen.playing === song.id ? <Square size={12} /> : <Play size={13} />}
      </button>
    </div>
  )
}
