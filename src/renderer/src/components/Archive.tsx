// "Diashow als ZIP archivieren": the dialog that lists what the archive of a show holds (photos and
// videos, music or the theme song, finished exports, the project) with sizes and the free space on
// the target drive, then writes it with progress and cancel (src/main/archive) and sums it up, with
// the deletion date. Opened from the "⋯" menu (next to "Pack project…") and the project card on the
// home screen; mounted once (App.tsx) like the clean-up.
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { AlertTriangle, Film, Loader2, Plus } from 'lucide-react'
import { archiveSize, type ArchiveInventory, type ArchiveProgress, type ArchiveResult, type ArchiveTarget, type ArchiveVideo } from '@shared/archive'
import { errorMessage } from '@shared/friendlyError'
import { saveOpenProject } from '../store'
import { localeTag, t, type StringKey } from '../i18n'
import { ErrorText } from '../errors'
import { Modal } from './Modal'
import { fmtBytes } from './Cleanup'
import './archive.css'

const useArchive = create<{ projectId: string | null }>(() => ({ projectId: null }))

/** Opens the archive dialog of a show. */
export function openArchive(projectId: string): void {
  useArchive.setState({ projectId })
}

/** Mounted once (App.tsx): the dialog while one is open. */
export function ArchiveHost() {
  const projectId = useArchive((s) => s.projectId)
  if (!projectId) return null
  return <ArchiveDialog key={projectId} projectId={projectId} onClose={() => useArchive.setState({ projectId: null })} />
}

const fill = (key: StringKey, values: Record<string, string | number>): string => Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key))

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' })

/** At most a few names, then "…". */
const someNames = (names: string[], n = 5): string => (names.length > n ? `${names.slice(0, n).join(', ')} …` : names.join(', '))

/** Saves the open show now (the archive is made from the saved file; never with its undo history) and loads what would go in. */
async function loadInventory(projectId: string): Promise<ArchiveInventory> {
  await saveOpenProject(projectId)
  return window.api.archiveInventory(projectId)
}

function Part(props: { title: string; size?: string; testId?: string; children?: React.ReactNode }) {
  return (
    <div className="archive-part" data-testid={props.testId}>
      <div className="archive-head">
        <b>{props.title}</b>
        {props.size && <span className="val">{props.size}</span>}
      </div>
      {props.children}
    </div>
  )
}

export function ArchiveDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [inv, setInv] = useState<ArchiveInventory | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [leftOut, setLeftOut] = useState(false)
  const [noFaces, setNoFaces] = useState(true)
  const [videos, setVideos] = useState<ArchiveVideo[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<ArchiveTarget | null>(null)
  const [phase, setPhase] = useState<'choose' | 'running' | 'done'>('choose')
  const [progress, setProgress] = useState<ArchiveProgress | null>(null)
  const [result, setResult] = useState<ArchiveResult | null>(null)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    let alive = true
    loadInventory(projectId).then(
      (i) => {
        if (!alive) return
        setInv(i)
        setVideos(i.exports)
        setChosen(new Set(i.exports.map((v) => v.path)))
        setTarget({ path: i.target, free: i.free, maxFile: i.maxFile })
      },
      (e) => alive && setError(e)
    )
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(() => {
    if (phase !== 'running') return
    return window.api.onArchiveProgress(setProgress)
  }, [phase])

  const picked = useMemo(() => videos.filter((v) => chosen.has(v.path)), [videos, chosen])
  const total = inv ? archiveSize(inv, leftOut, picked) : 0
  const short = !!target && target.free !== null && target.free < total
  // FAT32 (many USB sticks) holds no file of 4 GB or more
  const tooLarge = !!target && target.maxFile !== null && total > target.maxFile
  const busy = phase === 'running'

  const toggle = (path: string, on: boolean): void =>
    setChosen((c) => {
      const next = new Set(c)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })

  const addVideos = async (): Promise<void> => {
    try {
      const more = (await window.api.pickArchiveVideos()).filter((v) => !videos.some((x) => x.path.toLowerCase() === v.path.toLowerCase()))
      if (!more.length) return
      setVideos((list) => [...list, ...more])
      setChosen((c) => new Set([...c, ...more.map((v) => v.path)]))
    } catch (e) {
      setError(e)
    }
  }

  const run = async (): Promise<void> => {
    if (!inv || !target) return
    setError(null)
    let where: ArchiveTarget | null
    try {
      where = await window.api.pickArchiveTarget(target.path, total)
    } catch (e) {
      setError(e)
      return
    }
    if (!where) return
    setTarget(where)
    // not enough room there, or FAT32 and 4 GB or more: the dialog says so and another place can be picked
    if ((where.free !== null && where.free < total) || (where.maxFile !== null && total > where.maxFile)) return
    setProgress(null)
    setStopping(false)
    setPhase('running')
    try {
      const r = await window.api.archiveRun(projectId, { leftOut, withoutFaceData: inv.faceData && noFaces, videos: picked.map((v) => v.path), lang: localeTag().startsWith('de') ? 'de' : 'en' }, where.path)
      setResult(r)
      setPhase('done')
    } catch (e) {
      // cancelled: back to the choice, nothing was written
      if (errorMessage(e) !== 'cancelled') setError(e)
      setPhase('choose')
    }
  }

  const cancel = (): void => {
    setStopping(true)
    void window.api.archiveCancel()
  }

  const actions =
    phase === 'done' && result ? (
      <>
        <button className="btn" data-testid="archive-reveal" onClick={() => void window.api.revealInFolder(result.path)}>
          {t('showInFolder')}
        </button>
        <button className="btn primary" onClick={onClose}>
          {t('close')}
        </button>
      </>
    ) : busy ? (
      <button className="btn" data-testid="archive-cancel" disabled={stopping} onClick={cancel}>
        {t('cancel')}
      </button>
    ) : (
      <>
        <button className="btn" onClick={onClose}>
          {t('cancel')}
        </button>
        <button className="btn primary" data-testid="archive-run" disabled={!inv} onClick={() => void run()}>
          {t('arRun')}
        </button>
      </>
    )

  const pct = progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0
  return (
    <Modal title={t('arTitle')} onClose={busy ? undefined : onClose} className="wide archive-dialog" testId="archive-dialog" actions={actions}>
      {inv && <p className="archive-name">{inv.name}</p>}
      {!!error && <ErrorText err={error} context="save" />}
      {!inv && !error && <p className="hint">{t('loading')}</p>}

      {inv && phase === 'choose' && (
        <>
          <p className="hint lead">{t('arIntro')}</p>
          <div className="archive-parts">
            <Part title={t('arMedia')} size={`${fill('arFiles', { n: inv.media.files })} · ${fmtBytes(inv.media.bytes)}`} testId="archive-media">
              {inv.leftOut.items > 0 && (
                <label className="check">
                  <input type="checkbox" data-testid="archive-leftout" checked={leftOut} onChange={(e) => setLeftOut(e.target.checked)} />
                  <span>
                    {fill('arLeftOut', { n: inv.leftOut.items })} · {fmtBytes(inv.leftOut.bytes)}
                  </span>
                </label>
              )}
            </Part>
            {inv.theme ? (
              <Part title={fill('arTheme', { title: inv.theme.title })} size={fmtBytes(inv.theme.bytes)} testId="archive-theme">
                <p className="hint">{t('arThemeHint')}</p>
              </Part>
            ) : (
              <Part title={t('arMusic')} size={inv.music.files ? `${fill('arFiles', { n: inv.music.files })} · ${fmtBytes(inv.music.bytes)}` : undefined} testId="archive-music">
                {!inv.music.files && <p className="hint">{t('arNoMusic')}</p>}
              </Part>
            )}
            <Part title={t('arVideos')} size={picked.length ? fmtBytes(picked.reduce((n, v) => n + v.bytes, 0)) : undefined} testId="archive-videos">
              {!videos.length && <p className="hint">{t('arVideosNone')}</p>}
              {videos.map((v) => (
                <label key={v.path} className="check archive-video" title={v.path}>
                  <input type="checkbox" data-testid="archive-video" data-path={v.path} checked={chosen.has(v.path)} onChange={(e) => toggle(v.path, e.target.checked)} />
                  <Film size={14} aria-hidden />
                  <span className="grow">{v.name}</span>
                  <span className="val">{fmtBytes(v.bytes)}</span>
                </label>
              ))}
              <button className="btn small" data-testid="archive-add-video" onClick={() => void addVideos()}>
                <Plus size={14} aria-hidden /> {t('arAddVideo')}
              </button>
            </Part>
            <Part title={t('arProject')} size={fmtBytes(inv.project.bytes)} testId="archive-project">
              {inv.faceData && (
                <>
                  <label className="check">
                    <input type="checkbox" data-testid="archive-noface" checked={noFaces} onChange={(e) => setNoFaces(e.target.checked)} />
                    <span>{t('arNoFaces')}</span>
                  </label>
                  <p className="hint">{t('arNoFacesHint')}</p>
                </>
              )}
            </Part>
          </div>
          {(() => {
            const missing = inv.missing.filter((m) => leftOut || !m.leftOut)
            return (
              missing.length > 0 && (
                <p className="callout warn" data-testid="archive-missing">
                  <AlertTriangle size={14} aria-hidden /> <span>{fill('arMissing', { n: missing.length, names: someNames(missing.map((m) => m.name)) })}</span>
                </p>
              )
            )
          })()}
          <div className="archive-total">
            <span>{t('arTotal')}</span>
            <b data-testid="archive-total">{fmtBytes(total)}</b>
          </div>
          {target && (
            <div className="archive-target">
              <span className="hint">{t('arTarget')}</span>
              <span className="path" data-testid="archive-target">
                {target.path}
              </span>
              {target.free !== null && (
                <span className={`hint ${short ? 'short' : ''}`} data-testid="archive-free">
                  {fill('arFree', { size: fmtBytes(target.free) })}
                </span>
              )}
            </div>
          )}
          {short && target?.free != null && (
            <p className="callout warn" data-testid="archive-nospace">
              <AlertTriangle size={14} aria-hidden /> <span>{fill('arNoSpace', { need: fmtBytes(total), free: fmtBytes(target.free) })}</span>
            </p>
          )}
          {tooLarge && (
            <p className="callout warn" data-testid="archive-fat32">
              <AlertTriangle size={14} aria-hidden /> <span>{t('arFat32')}</span>
            </p>
          )}
          {inv.deleteAt !== undefined && <p className="hint">{fill('arDeleteAt', { date: fmtDate(inv.deleteAt) })}</p>}
        </>
      )}

      {busy && (
        <div className="archive-progress" data-testid="archive-progress" aria-busy>
          <p className="busy-line" role="status">
            <Loader2 size={14} className="spin" aria-hidden /> {progress?.phase === 'verify' ? t('arVerifying') : t('arWriting')}
            {progress && progress.total > 0 && <span className="val">{fill('arOf', { done: fmtBytes(progress.done), total: fmtBytes(progress.total) })}</span>}
          </p>
          <div className="bar" role="progressbar" aria-label={t('arTitle')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div style={{ width: `${pct}%` }} />
          </div>
          {progress?.phase === 'write' && progress.file && <p className="hint ellipsis">{progress.file}</p>}
        </div>
      )}

      {phase === 'done' && result && (
        <div className="archive-summary" data-testid="archive-summary">
          <p>
            <b>{t('arDone')}</b>
          </p>
          <p className="hint path">{result.path}</p>
          <ul>
            <li>{fill('arDoneMedia', { n: result.media })}</li>
            {result.music > 0 && <li>{fill('arDoneMusic', { n: result.music })}</li>}
            {result.theme && <li>{t('arDoneTheme')}</li>}
            {result.videos > 0 && <li>{fill('arDoneVideos', { n: result.videos })}</li>}
            <li>{fill('arDoneSize', { files: result.files, size: fmtBytes(result.bytes) })}</li>
          </ul>
          <p className="hint">{result.verified.checked >= result.verified.entries ? t('arCheckedAll') : fill('arCheckedSome', { checked: result.verified.checked, entries: result.verified.entries })}</p>
          {result.missing.length > 0 && (
            <p className="callout warn">
              <AlertTriangle size={14} aria-hidden /> <span>{fill('arMissingDone', { n: result.missing.length, names: someNames(result.missing.map((m) => m.name)) })}</span>
            </p>
          )}
          <p className="hint">{t('arOpenHint')}</p>
          {result.deleteAt !== undefined ? (
            <p className="callout warn" data-testid="archive-deadline">
              <AlertTriangle size={14} aria-hidden /> <span>{fill('arCopyNote', { date: fmtDate(result.deleteAt) })}</span>
            </p>
          ) : (
            <p className="hint">{t('arPrivacy')}</p>
          )}
        </div>
      )}
    </Modal>
  )
}
