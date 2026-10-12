// Theme music in the editor (Music tab) and the assistant: switch it on or off, choose a song of the
// show's theme, of another theme or of the music library (by mood), listen to it, or add it to the
// show's own music. Which songs play is decided in one place (src/shared/themeMusic.ts).
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ListPlus, Music, Play, Square } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import { themeMeta } from '@shared/themes'
import { chosenSong, freeLicence, MOODS, moodsIn, songGroups, songsOfTheme, themeMusicOn, type Mood, type ThemeTrack } from '@shared/themeMusic'
import type { ThemeId } from '@shared/types'
import { useStore } from '../store'
import { fmtTime, pick, t } from '../i18n'
import { Check, Section } from './ui'

type Listen = { playing: string | null; toggle: (track: ThemeTrack) => void }

/**
 * Plays one song at a time from its start (the Listen buttons); stops when the panel closes, and when
 * another song is chosen (unless it is the one that plays).
 */
function useListen(chosen: string | undefined): Listen {
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const current = useRef<string | null>(null)
  const stop = (): void => {
    audio.current?.pause()
    audio.current = null
    current.current = null
    setPlaying(null)
  }
  useEffect(() => {
    if (current.current && current.current !== chosen) stop()
  }, [chosen])
  useEffect(() => stop, [])
  const toggle = (track: ThemeTrack): void => {
    const again = current.current === track.id
    stop()
    if (again || !track.playback) return
    const a = new Audio(mediaUrl(track.playback))
    audio.current = a
    current.current = track.id
    a.onended = stop
    void a
      .play()
      .then(() => audio.current === a && setPlaying(track.id))
      .catch(() => audio.current === a && stop())
  }
  return { playing, toggle }
}

/** "Title – Artist · free to use (CC0 / public domain)". */
export function songCredit(song: ThemeTrack): string {
  const licence = freeLicence(song.licence) ? t('themeLicenceFree') : song.licence
  return [`${song.title}${song.artist ? ` – ${song.artist}` : ''}`, licence].filter(Boolean).join(' · ')
}

const themeName = (id: ThemeId): string => pick(themeMeta(id).name)

function SongGroup(props: { label: string; children: ReactNode }) {
  const id = useId()
  return (
    <div className="song-group" role="group" aria-labelledby={id}>
      <div className="song-group-label" id={id}>
        {props.label}
      </div>
      {props.children}
    </div>
  )
}

/** One song: a radio (the choice), its title, artist and length, and a Listen button. */
function SongRow(props: { name: string; value: string; title: string; sub: string; song: ThemeTrack; checked: boolean; listen: Listen; onChoose: () => void }) {
  const { song, listen } = props
  const on = listen.playing === song.id
  return (
    <div className={`song-row ${props.checked ? 'on' : ''}`} data-testid="song-row" data-song={props.value}>
      <label>
        <input type="radio" name={props.name} value={props.value} checked={props.checked} onChange={props.onChoose} />
        <span className="txt">
          <span className="tt">{props.title}</span>
          {props.sub && <span className="ar">{props.sub}</span>}
        </span>
      </label>
      <span className="d" aria-hidden>
        {fmtTime(song.duration)}
      </span>
      {/* only the chosen row's button is a Tab stop: the arrow keys move through the songs */}
      <button
        type="button"
        className={`listen ${on ? 'on' : ''}`}
        data-testid="song-listen"
        tabIndex={props.checked ? 0 : -1}
        title={on ? t('stop') : t('listen')}
        aria-label={`${on ? t('stop') : t('listen')}: ${song.title}`}
        onClick={() => listen.toggle(song)}
      >
        {on ? <Square size={12} /> : <Play size={13} />}
      </button>
    </div>
  )
}

/**
 * The song chooser: "Matches the theme", then the show's theme's songs, the other themes' songs and
 * the music library, all filtered by a mood. One radio group (one Tab stop, the arrow keys choose).
 * Choosing a song switches theme music on.
 */
export function SongChooser(props: { listen: Listen }) {
  const project = useStore((s) => s.project)!
  const tracks = useStore((s) => s.themeTracks)
  const [mood, setMood] = useState<Mood | null>(null)
  const name = useId()
  const list = useRef<HTMLDivElement>(null)
  const st = project.settings
  const value = st.themeSong ?? 'auto'
  // a theme id of 1.2 or an id this catalogue doesn't know: the row of the song that plays
  const checked = value === 'auto' ? 'auto' : chosenSong(st, tracks)?.song
  // the chosen song is in view when the chooser opens
  useLayoutEffect(() => {
    const box = list.current
    const row = box?.querySelector<HTMLElement>('.song-row.on')
    if (box && row && (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)) {
      box.scrollTop = row.offsetTop - box.clientHeight / 3
    }
  }, [])
  const auto = songsOfTheme(st.theme, tracks)[0]
  if (!auto && !tracks.length) return null
  const groups = songGroups(st.theme, tracks, mood)
  const moods = moodsIn(tracks)
  const choose = (song: string): void => useStore.getState().setSettings({ themeMusic: true, themeSong: song })
  const row = (song: ThemeTrack, sub: string): ReactNode => (
    <SongRow key={song.id} name={name} value={song.song} title={song.title} sub={sub} song={song} checked={checked === song.song} listen={props.listen} onChoose={() => choose(song.song)} />
  )
  const join = (...parts: (string | undefined)[]): string => parts.filter(Boolean).join(' · ')
  const empty = !groups.theme.length && !groups.other.length && !groups.library.length
  return (
    <div className="song-chooser" data-testid="song-chooser">
      {moods.length > 0 && (
        <div className="mood-chips" role="group" aria-label={t('songMood')}>
          {[null, ...moods].map((m) => (
            <button key={m ?? 'all'} type="button" className={mood === m ? 'on' : ''} aria-pressed={mood === m} data-testid={`mood-${m ?? 'all'}`} onClick={() => setMood(m)}>
              {m ? pick(MOODS.find((x) => x.id === m)!.name) : t('songMoodAll')}
            </button>
          ))}
        </div>
      )}
      <div className="song-list" role="radiogroup" aria-label={t('themeSong')} data-testid="song-list" ref={list}>
        {auto && (
          <SongRow
            name={name}
            value="auto"
            title={t('themeSongAuto')}
            // the theme's name, not only the song's: "Classic" is a song of Magazine, not the Classic theme
            sub={`${themeName(st.theme)}: ${auto.title}`}
            song={auto}
            checked={checked === 'auto'}
            listen={props.listen}
            onChoose={() => choose('auto')}
          />
        )}
        {groups.theme.length > 0 && <SongGroup label={t('songsOfTheme').replace('{t}', themeName(st.theme))}>{groups.theme.map((s) => row(s, join(s.artist)))}</SongGroup>}
        {groups.other.length > 0 && <SongGroup label={t('songsOtherThemes')}>{groups.other.map((s) => row(s, join(s.artist, s.themes.map(themeName).join(', '))))}</SongGroup>}
        {groups.library.length > 0 && (
          <SongGroup label={t('songsLibrary')}>{groups.library.map((s) => row(s, join(s.artist, ...s.moods.map((m) => pick(MOODS.find((x) => x.id === m)!.name)))))}</SongGroup>
        )}
        {mood && empty && <p className="empty-note">{t('songsNone')}</p>}
      </div>
    </div>
  )
}

/** Music tab: theme music on or off, which song, adding it to the own music, and that own songs replace it. */
export function ThemeMusicSection() {
  const project = useStore((s) => s.project)!
  const themeTracks = useStore((s) => s.themeTracks)
  const setSettings = useStore((s) => s.setSettings)
  const st = project.settings
  const song = chosenSong(st, themeTracks)
  const listen = useListen(song?.id)
  if (!themeTracks.length) return null
  const on = themeMusicOn(st)
  const own = project.music.length > 0
  const added = !!song && project.music.some((m) => m.path.toLowerCase() === song.path.toLowerCase())
  return (
    <Section title={t('themeMusic')} className="theme-music">
      <Check checked={on} testId="theme-music-on" onChange={(v) => setSettings(v ? { themeMusic: true, themeSong: st.themeSong ?? 'auto' } : { themeMusic: false })}>
        {t('themeMusicOn')}
      </Check>
      <SongChooser listen={listen} />
      {song && (
        <div className="theme-song-actions">
          <span className="hint theme-credit" data-testid="theme-credit">
            {songCredit(song)}
          </span>
          {/* a normal song of the playlist then: trim, chapter music, order */}
          <button className="btn small" data-testid="song-add-own" title={t('songAddOwnHint')} disabled={added} onClick={() => void useStore.getState().addMusic([song.path])}>
            <ListPlus size={13} aria-hidden /> {t('songAddOwn')}
          </button>
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

/** The assistant's music step: the theme song is the default; "More music…" opens the chooser; songs of your own replace it. */
export function WizardThemeSong() {
  const project = useStore((s) => s.project)
  const themeTracks = useStore((s) => s.themeTracks)
  const [more, setMore] = useState(false)
  const chooser = useRef<HTMLDivElement>(null)
  const song = project ? chosenSong(project.settings, themeTracks) : undefined
  const listen = useListen(song?.id)
  // the assistant's body scrolls: the opened chooser comes into view
  useEffect(() => {
    if (more) chooser.current?.scrollIntoView({ block: 'nearest' })
  }, [more])
  if (!project) return null
  const st = project.settings
  if (!song) return <p className="empty-note">{t('wizardNoMusic')}</p>
  return (
    <>
      <div className="wizard-theme-song">
        <Music size={13} aria-hidden />
        <Check
          className="t"
          checked={themeMusicOn(st)}
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
        <button className="btn small ghost more" data-testid="wizard-more-music" aria-expanded={more} onClick={() => setMore(!more)}>
          {t('moreMusic')}
        </button>
      </div>
      {more && (
        <div ref={chooser}>
          <SongChooser listen={listen} />
        </div>
      )}
    </>
  )
}
