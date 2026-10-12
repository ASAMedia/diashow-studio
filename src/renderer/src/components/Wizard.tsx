// First-run assistant: photos or a folder → theme and music → play or export, in three steps.
// It opens by itself on the first start (no projects, never finished or skipped) and from the home
// screen. It only calls the store's actions (createProject, importMedia, setTheme, addMusic) and
// opens the existing export dialog / fullscreen player. It is an overlay that never blocks the app:
// it hides while another dialog, the export or the player is open, and closes for good when a show
// it didn't create is opened (a double-clicked .dshow, a dropped folder, tests driving the store).
import { useEffect } from 'react'
import { create } from 'zustand'
import { Check, Download, Film, FolderOpen, Images, Loader2, Music, Pencil, Play, Plus, X } from 'lucide-react'
import { THEMES, themeMeta } from '@shared/themes'
import { useStore } from '../store'
import { useTimeline } from '../timeline'
import { fmtTime, pick, t } from '../i18n'
import { ThemeThumb } from './ThemesPanel'
import { WizardThemeSong } from './ThemeMusic'
import { Modal, useDialogTitleId } from './Modal'
import './help.css'

type Step = 1 | 2 | 3

interface WizardState {
  open: boolean
  step: Step
  /** The show the assistant created; any other show closes it. */
  projectId: string | null
  busy: boolean
}

export const useWizard = create<WizardState>(() => ({ open: false, step: 1, projectId: null, busy: false }))

const DONE = 'wizard:done'
/** True while the assistant itself creates its show (the store then changes under it). */
let creating = false

function isDone(): boolean {
  try {
    return localStorage.getItem(DONE) === '1'
  } catch {
    return false
  }
}

function markDone(): void {
  try {
    localStorage.setItem(DONE, '1')
  } catch {
    // shown again next start
  }
}

export function openWizard(): void {
  useWizard.setState({ open: true, step: 1, projectId: null, busy: false })
}

/** Closes the assistant and remembers that it was used or skipped. */
export function closeWizard(): void {
  markDone()
  useWizard.setState({ open: false, projectId: null, busy: false })
}

/** On the first start: no projects yet and the assistant was never finished or skipped. */
export async function openWizardOnFirstStart(): Promise<void> {
  if (isDone()) return
  let count: number
  try {
    count = (await window.api.listProjects()).length
  } catch {
    return
  }
  const s = useStore.getState()
  // a show opened meanwhile (file double-click, kiosk, tests driving the store) comes first
  if (count || s.project || s.view !== 'home' || isDone()) return
  openWizard()
}

/** Closes the assistant when a show it didn't create is opened, or its show is closed. */
function watchProjects(): () => void {
  return useStore.subscribe((s, prev) => {
    const w = useWizard.getState()
    if (!w.open || creating || s.project?.id === prev.project?.id) return
    if (s.project ? s.project.id !== w.projectId : !!w.projectId) closeWizard()
  })
}

function StepPhotos() {
  const project = useStore((s) => s.project)
  const { projectId, busy } = useWizard()
  const mine = project && project.id === projectId ? project : null

  const choose = async (folder: boolean): Promise<void> => {
    const paths = folder ? await window.api.pickFolder() : await window.api.pickMedia()
    if (!paths.length) return
    creating = true
    useWizard.setState({ busy: true })
    try {
      if (mine) await useStore.getState().importMedia(paths)
      else {
        const name = folder ? paths[0].split(/[\\/]/).filter(Boolean).pop() : undefined
        const p = await useStore.getState().createProject(paths, name)
        useWizard.setState({ projectId: p.id })
      }
      if (useStore.getState().project?.media.length) useWizard.setState({ step: 2 })
    } finally {
      creating = false
      useWizard.setState({ busy: false })
    }
  }

  return (
    <>
      <p>{t('wizardPickIntro')}</p>
      <div className="wizard-pick">
        <button disabled={busy} onClick={() => void choose(false)}>
          <Images size={30} aria-hidden /> {t('wizardPickFiles')}
        </button>
        <button disabled={busy} onClick={() => void choose(true)}>
          <FolderOpen size={30} aria-hidden /> {t('wizardPickFolder')}
        </button>
      </div>
      {(busy || !!mine?.media.length) && (
        <div className="wizard-status" role="status">
          {busy ? <Loader2 size={14} className="spin" aria-hidden /> : <Film size={14} aria-hidden />}
          {mine?.media.length ? t('wizardImported').replace('{n}', String(mine.media.length)) : '…'}
        </div>
      )}
    </>
  )
}

function StepLook() {
  const project = useStore((s) => s.project)
  if (!project) return null
  const thumbs = project.media.filter((m) => m.kind === 'photo' && m.thumb).slice(0, 3).map((m) => m.thumb!)
  return (
    <>
      <p>{t('wizardThemeIntro')}</p>
      <div className="themes" role="group" aria-label={t('themes')}>
        {THEMES.map((th) => (
          <button
            key={th.id}
            className={`theme-card ${project.settings.theme === th.id ? 'on' : ''}`}
            aria-pressed={project.settings.theme === th.id}
            title={pick(th.description)}
            onClick={() => useStore.getState().setTheme(th.id)}
          >
            <ThemeThumb id={th.id} thumbs={thumbs} />
            <span>{pick(th.name)}</span>
          </button>
        ))}
      </div>
      <div className="wizard-music">
        <h3>{t('music')}</h3>
        <div className="row">
          <span className="hint" style={{ flex: 1, minWidth: 0, margin: 0 }}>
            {t('wizardMusicIntro')}
          </span>
          <button
            className="btn small"
            onClick={async () => {
              const paths = await window.api.pickMusic()
              if (paths.length) await useStore.getState().addMusic(paths)
            }}
          >
            <Plus size={14} /> {t('addMusic')}
          </button>
        </div>
        {project.music.length ? (
          <ul>
            {project.music.map((m) => (
              <li key={m.id}>
                <Music size={13} aria-hidden />
                <span className="t" title={m.title}>
                  {m.title}
                </span>
                <span className="d">{m.duration ? fmtTime(m.duration) : '…'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <WizardThemeSong />
        )}
      </div>
    </>
  )
}

function StepFinish() {
  const project = useStore((s) => s.project)
  const tl = useTimeline()
  if (!project) return null
  const slides = tl?.slides.length ?? 0
  const music = project.music.length
    ? t('wizardSongs').replace('{n}', String(project.music.length))
    : tl?.themeSong
      ? t('wizardThemeSong').replace('{t}', tl.themeSong.title)
      : t('wizardSilent')
  const finish = (patch: Parameters<ReturnType<typeof useStore.getState>['set']>[0]): void => {
    closeWizard()
    useStore.getState().set(patch)
  }
  return (
    <>
      <p>{t('wizardDoneIntro')}</p>
      <div className="wizard-finish">
        <button disabled={!slides} onClick={() => finish({ fullscreen: true })}>
          <Play size={28} aria-hidden /> {t('play')}
        </button>
        <button disabled={!slides} onClick={() => finish({ exportOpen: true })}>
          <Download size={28} aria-hidden /> {t('wizardExport')}
        </button>
        <button onClick={() => finish({})}>
          <Pencil size={28} aria-hidden /> {t('wizardEdit')}
        </button>
      </div>
      <p className="wizard-summary">
        {t('wizardSummary')
          .replace('{n}', String(slides))
          .replace('{theme}', pick(themeMeta(project.settings.theme).name))
          .replace('{music}', music)}
      </p>
    </>
  )
}

export function Wizard() {
  const { open, step, projectId, busy } = useWizard()
  const blocked = useStore((s) => !!s.dialog || s.exportOpen || s.fullscreen || s.presenting)
  const hasProject = useStore((s) => !!s.project && s.project.id === projectId && s.project.media.length > 0)

  useEffect(() => {
    const off = watchProjects()
    void openWizardOnFirstStart()
    return off
  }, [])

  if (!open || blocked) return null
  return (
    <Modal bare onClose={closeWizard} className="wizard" testId="wizard" data={{ step }}>
      <WizardContent step={step} busy={busy} hasProject={hasProject} />
    </Modal>
  )
}

function WizardContent({ step, busy, hasProject }: { step: Step; busy: boolean; hasProject: boolean }) {
  const titleId = useDialogTitleId()
  const titles = [t('wizardStep1'), t('wizardStep2'), t('wizardStep3')]
  return (
    <>
      <div className="wizard-head">
        <h2 id={titleId}>{t('wizardTitle')}</h2>
        <span className="hint">{t('wizardStepOf').replace('{n}', String(step))}</span>
        <button className="btn ghost icon" title={t('wizardSkip')} aria-label={t('wizardSkip')} onClick={closeWizard}>
          <X size={16} />
        </button>
      </div>
      <ol className="wizard-steps">
        {titles.map((title, i) => (
          <li key={title} className={`step ${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}`} aria-current={i + 1 === step ? 'step' : undefined}>
            <span className="dot" aria-hidden>
              {i + 1 < step ? <Check size={12} /> : i + 1}
            </span>
            <span className="ellipsis">{title}</span>
          </li>
        ))}
      </ol>
      <div className="wizard-body">{step === 1 ? <StepPhotos /> : step === 2 ? <StepLook /> : <StepFinish />}</div>
      <div className="wizard-foot">
        <button className="btn ghost" onClick={closeWizard}>
          {t('wizardSkip')}
        </button>
        <div className="grow" />
        {step > 1 && (
          <button className="btn" onClick={() => useWizard.setState({ step: (step - 1) as Step })}>
            {t('back')}
          </button>
        )}
        {step < 3 && (
          <button className="btn primary" disabled={busy || !hasProject} onClick={() => useWizard.setState({ step: (step + 1) as Step })}>
            {t('wizardNext')}
          </button>
        )}
      </div>
    </>
  )
}
