// The editor for pixelated areas over the preview: click detected faces or drag out areas.
// - Photos: a clicked face is pixelated on this photo.
// - Videos: the editor shows the frame in the middle of the trimmed part; a clicked face is followed
//   through the whole clip (privacyTracks, from the faces found every 0.5 s); dragged areas apply to
//   the whole clip.
// - The person button on a face marks the person: their face is then pixelated in every photo and
//   video where it is recognised ("this person everywhere"); on a recognised face it corrects a
//   wrong match.
import { useEffect, useRef, useState } from 'react'
import { UserPlus, UserX } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import type { MediaItem, PhotoEntry, Rect, VideoEntry } from '@shared/types'
import { allVideoTracks, faceArea, followFace, isCovered, matchPerson, mergeFaces, rectAt, videoPersonTracks } from '@shared/people'
import { analyzeSoon, analyzePicture, saveFaces, trackFace } from '../faces'
import { analyzeBitmap } from '../vision/client'
import { markPerson, notThisPerson, personLabel, takeRequestedStill } from '../personActions'
import { useStore } from '../store'
import { t } from '../i18n'
import { togglePrivacy } from './SlideTools'
import { EditedPicture } from './EditedPicture'
import { areaToSource, rectToEdit, shownAspect, sourceAspect } from '@shared/mediaEdit'
import './people.css'

/** Photos searched with the fine tile grid in this session (the result is stored with the media). */
const searched = new Set<string>()

/** Source time of the still a video is edited on: the middle of its trimmed part. */
export function stillTime(e: VideoEntry, m: MediaItem): number {
  const from = e.trimIn ?? 0
  const to = e.trimOut ?? m.duration ?? from
  return Math.round(((from + Math.max(from, to)) / 2) * 1000) / 1000
}

const sameArea = (a: Rect, b: Rect): boolean => Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.w - b.w) < 1e-4
const round = (r: Rect): Rect => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) })
/** Rounded outwards, so the area never shrinks. */
const roundOut = (r: Rect): Rect => {
  const x = Math.floor(r.x * 1e4) / 1e4
  const y = Math.floor(r.y * 1e4) / 1e4
  return { x, y, w: +(Math.ceil((r.x + r.w) * 1e4) / 1e4 - x).toFixed(4), h: +(Math.ceil((r.y + r.h) * 1e4) / 1e4 - y).toFixed(4) }
}

interface Still {
  url: string
  faces: Rect[]
  desc?: number[][]
  /** The close search of the still is done. */
  done: boolean
}

export function PrivacyEditor({ entryId, w, h }: { entryId: string; w: number; h: number }) {
  const project = useStore((s) => s.project)!
  const setEntry = useStore((s) => s.setEntry)
  const found = project.entries.find((e) => e.id === entryId)
  const entry: PhotoEntry | VideoEntry | undefined = found && found.type !== 'text' ? found : undefined
  const media = entry ? project.media.find((m) => m.id === entry.mediaId) : undefined
  const isVideo = media?.kind === 'video' && entry?.type === 'video'
  // the still: the frame asked for (review), else the middle of the trimmed part; a slider moves it
  const [picked, setPicked] = useState<number | null>(() => takeRequestedStill(entryId))
  const [slider, setSlider] = useState<number | null>(null)
  const tStill = isVideo ? Math.round((picked ?? stillTime(entry as VideoEntry, media!)) * 1000) / 1000 : 0
  const [still, setStill] = useState<Still | null>(null)
  const [searching, setSearching] = useState(false)
  const [draft, setDraft] = useState<Rect | null>(null)
  /** Faces of a video being followed frame by frame (not in the sampled analysis). */
  const [pending, setPending] = useState<{ r: Rect; desc?: number[] }[]>([])
  const [note, setNote] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const areaRef = useRef<HTMLDivElement>(null)
  const people = project.people ?? []

  // videos: the frame in the middle of the trimmed part, searched closely (with descriptors)
  useEffect(() => {
    if (!media || !isVideo) return
    let alive = true
    let url = ''
    setStill(null)
    if (media.videoFaces === undefined) analyzeSoon(media.id)
    void (async () => {
      const [jpeg] = await window.api.videoFrames(media.playback ?? media.path, [tStill], 1280)
      if (!alive || !jpeg?.length) return
      const blob = new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
      url = URL.createObjectURL(blob)
      setStill({ url, faces: [], done: false })
      // searched like the sampled frames, so a face found here is found there too
      const r = await analyzeBitmap(await createImageBitmap(blob), { levels: 'frame', describe: true }).catch(() => null)
      if (alive) setStill({ url, faces: r?.faces ?? [], desc: r?.desc, done: true })
    })().catch(() => {})
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [media?.id, tStill]) // eslint-disable-line react-hooks/exhaustive-deps

  // photos: the background detection skips tiny faces; look again closely before pixelating
  useEffect(() => {
    if (!media || media.kind !== 'photo' || !media.display || searched.has(media.id)) return
    let alive = true
    const id = media.id
    setSearching(true)
    analyzePicture(media.display, true)
      .then(({ faces, desc }) => {
        searched.add(id)
        // keep the faces known so far (areas and marked people refer to them), add the new ones
        const cur = useStore.getState().project?.media.find((m) => m.id === id)
        const merged = mergeFaces(cur?.faces ?? [], cur?.faceDesc, faces, desc)
        return saveFaces(id, merged.faces, merged.desc)
      })
      .catch(() => {})
      .finally(() => alive && setSearching(false))
    return () => {
      alive = false
    }
  }, [media?.id, media?.display]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!entry || !media) return null
  const src = isVideo ? still?.url : media.display ? mediaUrl(media.display) : media.thumb ? mediaUrl(media.thumb) : undefined
  // the picture as it is shown (rotated, straightened, cropped); faces and areas stay in original coordinates
  const source = sourceAspect(media)
  const aspect = shownAspect(media)
  // the picture stays clear of the bar at the bottom (faces under it could not be clicked)
  const iw = Math.min(w * 0.94, (h - 96) * aspect)
  const ih = iw / aspect
  const ix = (w - iw) / 2
  const iy = Math.max(8, (h - 88 - ih) / 2)
  const areas = entry.privacy ?? []
  const tracks = entry.type === 'video' ? (entry.privacyTracks ?? []) : []
  const trackRects = tracks.map((k) => rectAt(k, tStill))
  const faces = (isVideo ? still?.faces : media.faces) ?? []
  const descs = isVideo ? still?.desc : media.faceDesc
  const busy = isVideo ? !still?.done : media.faces === undefined || searching
  const analysing = isVideo && media.videoFaces === undefined
  // marked people in the clip at the still's time (photos: their faces are among `faces`)
  const personRects = isVideo ? videoPersonTracks(media, people).map((x) => ({ r: rectAt(x.keys, tStill), name: personLabel(x.person, people) })) : []

  const save = (patch: Partial<VideoEntry>): void => setEntry(entry.id, patch as Partial<PhotoEntry>)
  const at = (r: Rect): React.CSSProperties => ({ left: ix + r.x * iw, top: iy + r.y * ih, width: r.w * iw, height: r.h * ih })
  const box = (r: Rect): React.CSSProperties => at(rectToEdit(r, media.edit, source))
  /** A face or area still (mostly) on the edited picture: those cropped away get no button. */
  const shown = (r: Rect): boolean => {
    const e = rectToEdit(r, media.edit, source)
    const w = Math.max(0, Math.min(1, e.x + e.w) - Math.max(0, e.x))
    const h = Math.max(0, Math.min(1, e.y + e.h) - Math.max(0, e.y))
    return w * h >= 0.25 * e.w * e.h
  }

  /**
   * Follows clicked faces of the video through the clip: by the sampled analysis (position and
   * descriptor, also when the person comes back later), else frame by frame from the still. A face
   * not found anywhere gets a fixed area for the whole clip.
   */
  async function follow(list: { r: Rect; desc?: number[] }[]): Promise<void> {
    const m = useStore.getState().project?.media.find((x) => x.id === media!.id)
    if (!m) return
    const e = entry as VideoEntry
    const from = Math.max(0, (e.trimIn ?? 0) - 2)
    const to = Math.min(m.duration ?? Infinity, (e.trimOut ?? m.duration ?? tStill) + 2)
    let lost = false
    for (const f of list) {
      let keys = followFace(m.videoFaces, tStill, f.r, f.desc)
      if (!keys) {
        setPending((p) => [...p, f])
        setNote(t('privacyFollowing'))
        keys = await trackFace(m, tStill, f.r, from, to, f.desc, () => !alive.current).catch(() => [])
        setPending((p) => p.filter((x) => x !== f))
        if (!keys.length) keys = null
      }
      const cur = useStore.getState().project?.entries.find((x) => x.id === entryId)
      if (!cur || cur.type !== 'video') return
      if (keys) setEntry(entryId, { privacyTracks: [...(cur.privacyTracks ?? []), keys] } as Partial<VideoEntry>)
      else {
        setEntry(entryId, { privacy: [...(cur.privacy ?? []), round(faceArea(f.r))] } as Partial<VideoEntry>)
        lost = true
      }
    }
    if (alive.current) setNote(lost ? t('privacyFollowFailed') : '')
  }

  const clickFace = (i: number): void => {
    const f = faces[i]
    if (!isVideo) {
      save({ privacy: togglePrivacy(entry, faceArea(f)) })
      return
    }
    const d = descs?.[i]?.length ? descs[i] : undefined
    void follow([{ r: f, desc: d }])
  }

  const startDraw = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const rect = areaRef.current!.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const at = (pe: PointerEvent): Rect => {
      const x = Math.min(1, Math.max(0, (pe.clientX - rect.left) / rect.width))
      const y = Math.min(1, Math.max(0, (pe.clientY - rect.top) / rect.height))
      return { x: Math.min(fx, x), y: Math.min(fy, y), w: Math.abs(x - fx), h: Math.abs(y - fy) }
    }
    const move = (pe: PointerEvent): void => setDraft(at(pe))
    const up = (pe: PointerEvent): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      const r = at(pe)
      setDraft(null)
      // drawn on the edited picture, stored for the original (an area that covers the drawn one)
      if (r.w > 0.02 && r.h > 0.02) save({ privacy: [...areas, roundOut(areaToSource(r, media!.edit, source))] })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  // faces not pixelated yet (photos: not an area; videos: not followed or in an area)
  const covering = [...areas, ...trackRects.filter((r): r is Rect => !!r)]
  const state = faces.map((f, i) => {
    const d = descs?.[i]?.length ? descs[i] : undefined
    const match = d ? matchPerson(d, people) : null
    const on = isVideo ? isCovered(f, covering) : areas.some((a) => sameArea(a, faceArea(f)))
    const waiting = pending.some((p) => sameArea(p.r, f))
    return { f, d, match, on, waiting }
  })
  const free = state.filter((s) => !s.on && !s.match && !s.waiting)

  const all = (): void => {
    if (!isVideo) save({ privacy: [...areas, ...free.map((s) => round(faceArea(s.f)))] })
    else if (media.videoFaces) {
      // every face of the clip, also those not on the still
      const key = (k: { t: number; r: Rect }[]): string => JSON.stringify(k[0])
      const have = new Set(tracks.map(key))
      const next = [...tracks, ...allVideoTracks(entry as VideoEntry, media).filter((k) => !have.has(key(k)))]
      save({ privacyTracks: next.length ? next : undefined })
      const rects = next.map((k) => rectAt(k, tStill)).filter((r): r is Rect => !!r)
      const rest = free.filter((s) => !isCovered(s.f, rects))
      if (rest.length) void follow(rest.map((s) => ({ r: s.f, desc: s.d })))
    } else void follow(free.map((s) => ({ r: s.f, desc: s.d })))
  }

  const hint = busy ? t('facesPending') : faces.length === 0 ? t('noFacesFound') : t('privacyHint')

  return (
    <div className="privacy-edit">
      {src && <EditedPicture src={src} edit={media.edit} aspect={source} box={{ x: ix, y: iy, w: iw, h: ih }} />}
      <div ref={areaRef} className="privacy-area" style={{ left: ix, top: iy, width: iw, height: ih }} onPointerDown={startDraw} />
      {state.map((s, i) =>
        s.on || !shown(s.f) ? null : (
          <div key={`f${i}`} className={`privacy-face-wrap ${s.match ? 'person' : ''} ${s.waiting ? 'waiting' : ''}`} style={box(s.f)}>
            <button
              className={`privacy-face ${s.match ? 'person' : ''} ${s.waiting ? 'draft' : ''}`}
              title={s.match ? t('personAuto').replace('{name}', personLabel(s.match.person, people)) : s.d ? t('privacyEdit') : `${t('privacyEdit')} · ${t('personUnknown')}`}
              onClick={() => clickFace(i)}
            />
            {s.d && !s.match && (
              <button
                className="person-badge"
                title={t('personMark')}
                onClick={() => {
                  const id = markPerson(s.d!)
                  const all = useStore.getState().project?.people ?? []
                  const p = all.find((x) => x.id === id)
                  if (p) setNote(t('personAdded').replace('{name}', personLabel(p, all)))
                }}
              >
                <UserPlus size={12} />
              </button>
            )}
            {s.d && s.match && (
              <button className="person-badge on" title={`${t('personNotThis')} (${personLabel(s.match.person, people)})`} onClick={() => notThisPerson(s.match!.person.id, s.d!)}>
                <UserX size={12} />
              </button>
            )}
            {s.match && <span className="person-name">{personLabel(s.match.person, people)}</span>}
          </div>
        )
      )}
      {areas.map((a, i) => (
        <button key={`a${i}`} className="privacy-face on" style={box(a)} title={t('privacyNone')} onClick={() => save({ privacy: togglePrivacy(entry, a) })} />
      ))}
      {trackRects.map((r, i) =>
        r ? (
          <button
            key={`t${i}`}
            className="privacy-face on track"
            style={box(r)}
            title={t('privacyNone')}
            onClick={() => {
              const next = tracks.filter((_, k) => k !== i)
              save({ privacyTracks: next.length ? next : undefined })
            }}
          />
        ) : null
      )}
      {personRects.map((p, i) =>
        p.r && !state.some((s) => s.match && isCovered(s.f, [p.r!])) ? (
          <div key={`p${i}`} className="privacy-face person passive" style={box(p.r)} title={t('personAuto').replace('{name}', p.name)}>
            <span className="person-name">{p.name}</span>
          </div>
        ) : null
      )}
      {draft && <div className="privacy-face draft" style={at(draft)} />}
      <div className="kb-bar">
        <span className="hint privacy-hint" style={{ margin: 0, flex: 1 }} title={note || hint}>
          {note || hint}
          {isVideo && !note ? ` ${t('privacyVideoFollow')}` : ''}
          {analysing ? ` ${t('videoAnalyzing')}` : ''}
        </span>
        {isVideo && entry.type === 'video' && (
          <input
            type="range"
            className="still-time"
            title={t('privacyStillTime')}
            min={entry.trimIn ?? 0}
            max={entry.trimOut ?? media.duration ?? 0}
            step={0.1}
            value={slider ?? tStill}
            onChange={(e) => setSlider(Number(e.target.value))}
            onPointerUp={() => slider !== null && (setPicked(slider), setSlider(null))}
            onKeyUp={() => slider !== null && (setPicked(slider), setSlider(null))}
          />
        )}
        {(free.length > 0 || (isVideo && !!media.videoFaces?.some((s) => s.faces.length))) && (
          <button className="btn small" onClick={all}>
            {t('privacyAll')}
          </button>
        )}
        {(areas.length > 0 || tracks.length > 0) && (
          <button className="btn small ghost" onClick={() => save({ privacy: undefined, privacyTracks: undefined })}>
            {t('privacyNone')}
          </button>
        )}
        <button className="btn small primary" onClick={() => useStore.getState().set({ privacyEdit: null })}>
          {t('done')}
        </button>
      </div>
    </div>
  )
}
