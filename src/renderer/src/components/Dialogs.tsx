import { useEffect, useMemo, useState } from 'react'
import { sameClipGroups } from '@shared/duplicates'
import type { MediaItem, Project } from '@shared/types'
import { Loader2 } from 'lucide-react'
import { useStore } from '../store'
import { count, t } from '../i18n'
import { ErrorText } from '../errors'
import { Modal } from './Modal'
import { Slider } from './ui'
import { MediaThumb } from './EditedPicture'

// ---------------------------------------------------------------- rejects

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function hashDistance(a: string, b: string): number {
  return popcount32((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + popcount32((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0)
}

export interface Reject {
  entryId: string
  media: MediaItem
  /** 'sameClip': a video that is another copy of a clip in the show (e.g. forwarded through a messenger). */
  reason: 'blurry' | 'duplicate' | 'sameClip'
  /** Sharpness in %, or the entry number of the photo / clip it duplicates. */
  detail: string
}

/** Label of a reject in the dialog and the review grid. */
export function rejectLabel(r: Reject): string {
  return r.reason === 'blurry' ? `${t('blurry')} ${r.detail}` : `${t(r.reason === 'sameClip' ? 'sameClip' : 'duplicateOf')} ${r.detail}`
}

/**
 * Blurry photos (sharpness below the threshold) and near-duplicates (difference hashes at most
 * a few bits apart); of every group of duplicates the sharpest photo stays. Videos that are the same
 * clip (length and two frame hashes, see @shared/duplicates) are grouped too; the copy with the
 * original resolution and bit rate stays.
 */
// measured on real photos: 0-4 bits apart = same shot / burst, 5-10 = another moment of the scene
export function findRejects(project: Project, threshold: number, maxDistance = 4): Reject[] {
  const media = new Map(project.media.map((m) => [m.id, m]))
  const photos = project.entries
    .map((e, i) => ({ e, i, m: e.type === 'photo' ? media.get(e.mediaId) : undefined }))
    .filter((x): x is { e: (typeof project.entries)[number]; i: number; m: MediaItem } => !!x.m && x.m.status === 'ready')
  const out = new Map<string, Reject>()
  // duplicates: union-find over close hashes
  const parent = photos.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let a = 0; a < photos.length; a++) {
    const ha = photos[a].m.hash
    if (!ha) continue
    for (let b = a + 1; b < photos.length; b++) {
      const hb = photos[b].m.hash
      if (hb && hashDistance(ha, hb) <= maxDistance) parent[find(b)] = find(a)
    }
  }
  const groups = new Map<number, number[]>()
  photos.forEach((_, i) => {
    const r = find(i)
    groups.set(r, [...(groups.get(r) ?? []), i])
  })
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const keep = g.reduce((best, i) => ((photos[i].m.sharpness ?? 0) > (photos[best].m.sharpness ?? 0) ? i : best), g[0])
    for (const i of g) if (i !== keep) out.set(photos[i].e.id, { entryId: photos[i].e.id, media: photos[i].m, reason: 'duplicate', detail: `#${photos[keep].i + 1}` })
  }
  for (const p of photos) {
    if (out.has(p.e.id) || p.m.sharpness == null || p.m.sharpness >= threshold) continue
    out.set(p.e.id, { entryId: p.e.id, media: p.m, reason: 'blurry', detail: `${Math.round(p.m.sharpness * 100)} %` })
  }
  const videos = project.entries
    .map((e, i) => ({ e, i, m: e.type === 'video' ? media.get(e.mediaId) : undefined }))
    .filter((x): x is { e: (typeof project.entries)[number]; i: number; m: MediaItem } => !!x.m && x.m.status === 'ready')
  for (const [keep, ...rest] of sameClipGroups(videos.map((v) => v.m))) {
    for (const i of rest) out.set(videos[i].e.id, { entryId: videos[i].e.id, media: videos[i].m, reason: 'sameClip', detail: `#${videos[keep].i + 1}` })
  }
  return [...out.values()]
}

export function RejectsDialog() {
  const project = useStore((s) => s.project)!
  const set = useStore((s) => s.set)
  const [threshold, setThreshold] = useState(0.35)
  const rejects = useMemo(() => findRejects(project, threshold), [project, threshold])
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const chosen = rejects.filter((r) => !unchecked.has(r.entryId))
  const pending = project.media.filter((m) => m.status === 'ready' && (m.kind === 'photo' ? m.sharpness == null : m.hash == null || m.hash2 == null)).length
  const close = (): void => set({ dialog: null })
  return (
    <Modal
      title={t('rejectsTitle')}
      onClose={close}
      className="wide"
      actions={
        <>
          <button className="btn" onClick={close}>
            {t('cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!chosen.length}
            onClick={() => {
              useStore.getState().removeEntries(chosen.map((r) => r.entryId))
              close()
            }}
          >
            {t('removeN').replace('{n}', String(chosen.length))}
          </button>
        </>
      }
    >
      <p className="hint lead">{t('rejectsIntro')}</p>
      <Slider label={t('blurThreshold')} value={threshold} min={0.05} max={0.6} step={0.01} display={`${Math.round(threshold * 100)} %`} onChange={setThreshold} />
      {pending > 0 && <p className="hint">{count('notAnalysedMedia', pending)}</p>}
      {rejects.length === 0 ? (
        <p className="empty-note">{t('noRejectsMedia')}</p>
      ) : (
        <div className="reject-grid">
          {rejects.map((r) => (
            <label key={r.entryId} className={`reject ${unchecked.has(r.entryId) ? 'off' : ''}`} title={`${r.media.name} · ${rejectLabel(r)}`}>
              {r.media.thumb && <MediaThumb m={r.media} loading="lazy" />}
              <input
                type="checkbox"
                aria-label={`${r.media.name}: ${rejectLabel(r)}`}
                checked={!unchecked.has(r.entryId)}
                onChange={(e) => {
                  const next = new Set(unchecked)
                  if (e.target.checked) next.delete(r.entryId)
                  else next.add(r.entryId)
                  setUnchecked(next)
                }}
              />
              <span className={`reason ${r.reason}`}>{rejectLabel(r)}</span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------- pack

export function PackDialog() {
  const project = useStore((s) => s.project)!
  const set = useStore((s) => s.set)
  const [phase, setPhase] = useState<'running' | 'done' | 'error'>('running')
  const [message, setMessage] = useState('')
  const [result, setResult] = useState('')
  useEffect(() => {
    const off = window.api.onExportProgress((p) => p.phase === 'prepare' && setMessage(p.message ?? ''))
    let alive = true
    void (async () => {
      const dir = await window.api.pickPackDir()
      if (!alive) return
      if (!dir) {
        set({ dialog: null })
        return
      }
      try {
        const file = await window.api.packProject(project, dir)
        if (!alive) return
        setResult(file)
        setPhase('done')
      } catch (e) {
        if (!alive) return
        setResult((e as Error).message)
        setPhase('error')
      }
    })()
    return () => {
      alive = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const close = phase === 'running' ? undefined : (): void => set({ dialog: null })
  return (
    <Modal
      title={t('packTitle')}
      onClose={close}
      actions={
        <>
          {phase === 'done' && (
            <button className="btn" onClick={() => void window.api.revealInFolder(result)}>
              {t('showInFolder')}
            </button>
          )}
          <button className="btn primary" disabled={phase === 'running'} onClick={() => set({ dialog: null })}>
            {t('close')}
          </button>
        </>
      }
    >
      {phase === 'running' && (
        <p className="busy-line" role="status">
          <Loader2 size={14} className="spin" aria-hidden /> {t('packing')} <span className="ellipsis">{message}</span>
        </p>
      )}
      {phase === 'done' && (
        <>
          <p>{t('packDone')}</p>
          <p className="hint path">{result}</p>
        </>
      )}
      {phase === 'error' && <ErrorText err={result} context="save" />}
    </Modal>
  )
}
