import { FileUp, FolderOpen, Plus, Trash2, Play } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import { useStore } from '../store'
import { localeTag, t } from '../i18n'

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
    <div className="home">
      <div className="hero">
        <h1>{t('yourProjects')}</h1>
        <button
          className="btn"
          onClick={async () => {
            const p = await window.api.openProjectFile()
            if (p) await useStore.getState().openProjectData(p)
          }}
        >
          <FileUp size={15} /> {t('openFile')}
        </button>
        <button className="btn" onClick={quickShow} title={t('quickShowHint')}>
          <Play size={15} /> {t('quickShow')}
        </button>
        <button className="btn primary" onClick={newProject}>
          <Plus size={15} /> {t('newProject')}
        </button>
      </div>
      <div className="drop">
        <FolderOpen size={28} style={{ opacity: 0.6 }} />
        <div style={{ marginTop: 8 }}>{projects.length ? t('dropHere') : t('noProjects')}</div>
        <div className="formats">JPEG · HEIC · HIF · ARW · DNG · PNG · WebP · AVIF — MOV · MP4 · XAVC S/HS/S-I · AVCHD (MTS) · MKV · WebM</div>
      </div>
      {projects.length > 0 && (
        <div className="projects">
          {projects.map((p) => (
            <div key={p.id} className="project" onClick={() => void useStore.getState().openProject(p.id)}>
              {p.cover ? <img className="cover" src={mediaUrl(p.cover)} alt="" /> : <div className="cover" />}
              <div className="meta">
                <b>{p.name}</b>
                <span>
                  {p.slideCount} {t('slides')} · {new Date(p.updatedAt).toLocaleDateString(localeTag())}
                </span>
              </div>
              <button
                className="btn small icon del"
                title={t('delete')}
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`${t('confirmDelete')}\n${p.name}`)) void useStore.getState().deleteProject(p.id)
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
