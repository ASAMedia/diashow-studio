import { useEffect, useMemo, useState } from 'react'
import { mediaUrl } from '@shared/api'
import type { MediaItem, Project } from '@shared/types'
import { useStore } from '../store'
import { t } from '../i18n'

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
  reason: 'blurry' | 'duplicate'
  /** Sharpness in %, or the entry number of the photo it duplicates. */
  detail: string
}

/**
 * Blurry photos (sharpness below the threshold) and near-duplicates (difference hashes at most
 * a few bits apart); of every group of duplicates the sharpest photo stays.
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
  return [...out.values()]
}

export function RejectsDialog() {
  const project = useStore((s) => s.project)!
  const set = useStore((s) => s.set)
  const [threshold, setThreshold] = useState(0.35)
  const rejects = useMemo(() => findRejects(project, threshold), [project, threshold])
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const chosen = rejects.filter((r) => !unchecked.has(r.entryId))
  const pending = project.media.filter((m) => m.kind === 'photo' && m.status === 'ready' && m.sharpness == null).length
  return (
    <div className="overlay">
      <div className="dialog wide">
        <h2>{t('rejectsTitle')}</h2>
        <div className="row">
          <label>{t('blurThreshold')}</label>
          <input type="range" min={0.05} max={0.6} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: 160 }} />
          <span className="val">{Math.round(threshold * 100)} %</span>
        </div>
        {pending > 0 && <p className="hint">{t('notAnalysed').replace('{n}', String(pending))}</p>}
        {rejects.length === 0 ? (
          <p className="hint">{t('noRejects')}</p>
        ) : (
          <div className="reject-grid">
            {rejects.map((r) => (
              <label key={r.entryId} className={`reject ${unchecked.has(r.entryId) ? 'off' : ''}`} title={r.media.name}>
                {r.media.thumb && <img src={mediaUrl(r.media.thumb)} alt="" loading="lazy" />}
                <input
                  type="checkbox"
                  checked={!unchecked.has(r.entryId)}
                  onChange={(e) => {
                    const next = new Set(unchecked)
                    if (e.target.checked) next.delete(r.entryId)
                    else next.add(r.entryId)
                    setUnchecked(next)
                  }}
                />
                <span className={`reason ${r.reason}`}>
                  {r.reason === 'blurry' ? t('blurry') : t('duplicateOf')} {r.detail}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="actions">
          <button className="btn" onClick={() => set({ dialog: null })}>
            {t('cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!chosen.length}
            onClick={() => {
              useStore.getState().removeEntries(chosen.map((r) => r.entryId))
              set({ dialog: null })
            }}
          >
            {t('removeN').replace('{n}', String(chosen.length))}
          </button>
        </div>
      </div>
    </div>
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
  return (
    <div className="overlay">
      <div className="dialog">
        <h2>{t('packTitle')}</h2>
        {phase === 'running' && <p>{t('packing')} {message}</p>}
        {phase === 'done' && (
          <>
            <p>{t('packDone')}</p>
            <p className="hint" style={{ wordBreak: 'break-all' }}>
              {result}
            </p>
          </>
        )}
        {phase === 'error' && <p className="error">{result}</p>}
        <div className="actions">
          {phase === 'done' && (
            <button className="btn" onClick={() => void window.api.revealInFolder(result)}>
              {t('showInFolder')}
            </button>
          )}
          <button className="btn primary" disabled={phase === 'running'} onClick={() => set({ dialog: null })}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}
