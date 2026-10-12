import { Eraser, FileUp, FolderOpen, Plus, Trash2, Play, Wand2 } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import { useStore } from '../store'
import { Tip } from './Settings'
import { openWizard } from './Wizard'
import { DamagedProjects, importProjectSafely, openProjectSafely } from './ProjectRepair'
import { CleanupBanner, DeadlineBadge, openCleanup } from './Cleanup'
import { localeTag, t } from '../i18n'

const FORMATS = 'JPEG · HEIC · HIF · ARW · DNG · PNG · WebP · AVIF — MOV · MP4 · XAVC S/HS/S-I · AVCHD (MTS) · MKV · WebM'

export function Home() {
  const projects = useStore((s) => s.projects)
  const createProject = useStore((s) => s.createProject)

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
                <div key={p.id} className="project">
                  <button className="open" title={p.name} onClick={() => void openProjectSafely(p.id)}>
                    {p.cover ? <img className="cover" src={mediaUrl(p.cover)} alt="" /> : <span className="cover" />}
                    <span className="meta">
                      <b>{p.name}</b>
                      <span>
                        {p.slideCount} {t('slides')} · {new Date(p.updatedAt).toLocaleDateString(localeTag())}
                      </span>
                    </span>
                  </button>
                  <DeadlineBadge project={p} />
                  <button className="btn small icon clean" title={t('cleanupMenu')} aria-label={`${t('cleanupMenu')}: ${p.name}`} onClick={() => openCleanup(p.id)}>
                    <Eraser size={14} />
                  </button>
                  <button
                    className="btn small icon del"
                    title={t('deleteShow')}
                    aria-label={`${t('deleteShow')}: ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      // asks what else goes with it (caches, uploads, exports) and says that it is final
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
      </div>
    </main>
  )
}
