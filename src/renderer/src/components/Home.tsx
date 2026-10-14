import { useState } from 'react'
import { Copy, Eraser, FileArchive, FileUp, FolderOpen, Plus, Trash2, Play, Wand2 } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import { splitAudio } from '@shared/formats'
import { useStore } from '../store'
import { droppedPaths, handledDrops } from '../insert'
import { Tip } from './Tip'
import { openWizard } from './Wizard'
import { DamagedProjects, importProjectSafely, openProjectSafely } from './ProjectRepair'
import { CleanupBanner, DeadlineBadge, openCleanup } from './Cleanup'
import { openArchive } from './Archive'
import { TrashButton } from './Trash'
import { duplicateShow } from './Duplicate'
import { count, localeTag, t } from '../i18n'

const FORMATS = 'JPEG · HEIC · HIF · ARW · DNG · PNG · WebP · AVIF — MOV · MP4 · XAVC S/HS/S-I · AVCHD (MTS) · MKV · WebM'

/**
 * Files dropped onto a show's card: the show opens, and they go in like "Add photos", each sorted into
 * its day (with a new day title where the show has them), as one undo step. What the show has already
 * is skipped with the notice (repeats.ts); songs go into its music.
 */
async function dropOntoShow(id: string, paths: string[]): Promise<void> {
  const { audio, media } = splitAudio(paths)
  await openProjectSafely(id)
  // it couldn't be opened (the notice says why, a damaged one offers "Repair…"): nothing goes in
  if (useStore.getState().project?.id !== id) return
  if (media.length) await useStore.getState().importMedia(media, 'byTime')
  if (audio.length) await useStore.getState().addMusic(audio)
}

export function Home() {
  const projects = useStore((s) => s.projects)
  const createProject = useStore((s) => s.createProject)
  /** The show whose card files from Explorer hover over. */
  const [over, setOver] = useState<string | null>(null)

  // Files over a show's card go into that show; on the drop box or anywhere else they make a new one
  // (windowDrop.ts). dragenter is accepted like dragover (Chromium may decide the drop by it alone).
  // The mark lies over the card, so nothing moves under the pointer and the card's name stays the same.
  const filesOver = (id: string) => (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setOver(id)
  }
  // the dragleave of the cover or a button bubbles up to the card: only leaving the card (or the
  // window, or Esc: nowhere to go) clears its mark
  const filesLeave = (id: string) => (e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === id ? null : o))
  }
  const filesDrop = (id: string) => (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setOver(null)
    // the window's drop handler leaves them alone
    handledDrops.add(e.nativeEvent)
    const paths = droppedPaths(e.dataTransfer)
    if (paths.length) void dropOntoShow(id, paths)
  }

  const newProject = async (): Promise<void> => {
    const paths = await window.api.pickMedia()
    await createProject(paths)
  }

  const quickShow = async (): Promise<void> => {
    const folders = await window.api.pickFolder()
    if (!folders.length) return
    const name = folders[0].split(/[\\/]/).filter(Boolean).pop()
    await createProject(folders, name)
    useStore.getState().set({ fullscreen: true })
  }

  return (
    <main className="home">
      <div className="home-inner">
        <div className="hero">
          <h1>{t('yourProjects')}</h1>
          <button className="btn" onClick={() => void importProjectSafely(null)}>
            <FileUp size={16} /> {t('openFile')}
          </button>
          <button className="btn" onClick={quickShow} title={t('quickShowHint')}>
            <Play size={16} /> {t('quickShow')}
          </button>
          <button className="btn" onClick={openWizard}>
            <Wand2 size={16} /> {t('wizardOpen')}
          </button>
          <button className="btn primary" onClick={newProject}>
            <Plus size={16} /> {t('newProject')}
          </button>
        </div>
        <CleanupBanner />
        <Tip id="home">{t('onboardHome')}</Tip>
        {projects.length > 0 ? (
          <div className="drop compact">
            <FolderOpen size={22} aria-hidden />
            <div>
              <div>{t('dropHere')}</div>
              <div className="formats">{FORMATS}</div>
            </div>
          </div>
        ) : (
          <div className="drop">
            <FolderOpen size={30} aria-hidden />
            <div style={{ marginTop: 8 }}>{t('noProjects')}</div>
            <div className="formats">{FORMATS}</div>
          </div>
        )}
        {projects.length > 0 && (
          <section aria-label={t('yourProjects')}>
            <div className="projects">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`project ${over === p.id ? 'files-over' : ''}`}
                  data-id={p.id}
                  data-drop-label={t('dropOntoShow')}
                  onDragEnter={filesOver(p.id)}
                  onDragOver={filesOver(p.id)}
                  onDragLeave={filesLeave(p.id)}
                  onDrop={filesDrop(p.id)}
                >
                  <button className="open" title={p.name} onClick={() => void openProjectSafely(p.id)}>
                    {p.cover ? <img className="cover" src={mediaUrl(p.cover)} alt="" /> : <span className="cover" />}
                    <span className="meta">
                      <b>{p.name}</b>
                      <span>
                        {count('slideCount', p.slideCount)} · {new Date(p.updatedAt).toLocaleDateString(localeTag())}
                      </span>
                    </span>
                  </button>
                  <DeadlineBadge project={p} />
                  <button className="btn small icon dup" title={t('duplicate')} aria-label={`${t('duplicate')}: ${p.name}`} onClick={() => void duplicateShow(p.id)}>
                    <Copy size={14} />
                  </button>
                  <button className="btn small icon archive" title={t('archive')} aria-label={`${t('archive')}: ${p.name}`} onClick={() => openArchive(p.id)}>
                    <FileArchive size={14} />
                  </button>
                  <button className="btn small icon clean" title={t('cleanupMenu')} aria-label={`${t('cleanupMenu')}: ${p.name}`} onClick={() => openCleanup(p.id)}>
                    <Eraser size={14} />
                  </button>
                  <button
                    className="btn small icon del"
                    title={t('deleteShowDots')}
                    aria-label={`${t('deleteShowDots')}: ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      // lists what goes into the trash with it (Trash.tsx restores it for 30 days)
                      openCleanup(p.id, 'delete')
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        <DamagedProjects />
        <TrashButton />
      </div>
    </main>
  )
}
