import { create } from 'zustand'
import type {
  Entry, FreeText, MediaItem, MusicTrack, Project, ProjectSettings, ProjectSummary, ThemeId
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { ExportJobInfo } from '@shared/exportQueue'
import { themeMeta } from '@shared/themes'
import { t } from './i18n'
import type { Player } from './engine/player'
import * as edits from './entryEdits'
import { entriesFor, uid } from './entryEdits'

export type InspectorTab = 'themes' | 'music' | 'timing' | 'slide'

interface State {
  /** 'cull': the review grid for sorting photos in and out of the show. */
  view: 'home' | 'editor' | 'cull'
  projects: ProjectSummary[]
  project: Project | null
  /** Selected entry ids. */
  selection: string[]
  tab: InspectorTab
  playhead: number
  playing: boolean
  fullscreen: boolean
  exportOpen: boolean
  kbEdit: 'start' | 'end' | null
  /** Entry whose pixelated areas are being edited in the viewer. */
  privacyEdit: string | null
  /** Selected free text box (its id). */
  textSel: string | null
  canUndo: boolean
  canRedo: boolean
  /** 'share': photos from phones / video to phones over the Wi-Fi; 'systemcheck': opened from Settings. */
  dialog: 'rejects' | 'pack' | 'settings' | 'backups' | 'help' | 'queue' | 'share' | 'systemcheck' | 'privacyReview' | null
  /** Export queue, oldest first (kept by the main process). */
  exportJobs: ExportJobInfo[]
  presenting: boolean
  /** Fullscreen started by kiosk mode: loops whatever the project says. */
  kiosk: boolean
  loadProjects(): Promise<void>
  createProject(paths?: string[], name?: string): Promise<Project>
  openProject(id: string): Promise<void>
  closeProject(): void
  deleteProject(id: string): Promise<void>
  /**
   * Changes the project and records an undo step. Edits with the same `key` that follow each
   * other within a moment (slider and drag moves) form one step.
   */
  update(fn: (p: Project) => void, key?: string): void
  undo(): void
  redo(): void
  /** Opens a project that came from a file (packed project). */
  openProjectData(p: Project): Promise<void>
  /** Custom on-screen time of a slide (undefined = automatic), stored on its first entry. */
  setSlideDuration(slideIds: string[], seconds: number | undefined): void
  /** Text slides at every new day ('date') or every new subfolder ('folder'). */
  insertDayTitles(mode: 'date' | 'folder'): void
  removeAutoTitles(): void
  sortByDate(): void
  setSettings(patch: Partial<ProjectSettings>): void
  setTheme(theme: ThemeId): void
  /** New files go behind the selection, or (`byTime`) where their capture time belongs. */
  importMedia(paths: string[], placement?: 'selection' | 'byTime'): Promise<void>
  addMusic(paths: string[]): Promise<void>
  addText(): void
  /** Rolling end credits as the last slide. */
  addCredits(): void
  removeEntries(ids: string[]): void
  setEntry(id: string, patch: Partial<Entry>): void
  /** Changes several entries in one undo step. */
  updateEntries(ids: string[], fn: (e: Entry) => void, key?: string): void
  /** Plays a song from a chapter's text slide on, or (null) in the show playlist. */
  assignSong(trackId: string, chapterId: string | null): void
  addFreeText(entryId: string): void
  setFreeText(entryId: string, textId: string, patch: Partial<FreeText>): void
  removeFreeText(entryId: string, textId: string): void
  /** Grouping: the given entries become one slide at the position of the first of them. */
  mergeEntries(ids: string[]): void
  /** Every entry of a slide becomes a slide of its own. */
  splitSlide(ids: string[]): void
  /** Takes one entry out of a slide; it follows the slide as a slide of its own. */
  releaseEntry(slideIds: string[], id: string): void
  /** Pulls the next entry of the show into the slide, or hands the last one on. */
  resizeSlide(slideIds: string[], delta: 1 | -1): void
  select(ids: string[]): void
  set(patch: Partial<State>): void
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSave(p: Project): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void window.api.saveProject(p), 600)
}

// Undo history. Snapshots are whole projects (cheap to keep: media items are shared data);
// restoring keeps the current processing state of media and music.
const history = { past: [] as Project[], future: [] as Project[], key: '' as string | undefined, at: 0 }
const HISTORY_LIMIT = 100

function resetHistory(): void {
  history.past = []
  history.future = []
  history.key = undefined
}

function withCurrentMedia(snapshot: Project, current: Project): Project {
  const media = new Map(current.media.map((m) => [m.id, m]))
  const music = new Map(current.music.map((m) => [m.id, m]))
  return {
    ...snapshot,
    media: snapshot.media.map((m) => media.get(m.id) ?? m),
    music: snapshot.music.map((m) => music.get(m.id) ?? m)
  }
}

/** Fields of a song the user sets in the editor; processing updates from the main process keep them. */
function keepTrim(update: MusicTrack, cur: MusicTrack | undefined): MusicTrack {
  return cur && (cur.trimIn != null || cur.trimOut != null) ? { ...update, trimIn: cur.trimIn, trimOut: cur.trimOut } : update
}

export const useStore = create<State>((set, get) => ({
  view: 'home',
  projects: [],
  project: null,
  selection: [],
  tab: 'themes',
  playhead: 0,
  playing: false,
  fullscreen: false,
  exportOpen: false,
  kbEdit: null,
  privacyEdit: null,
  textSel: null,
  canUndo: false,
  canRedo: false,
  dialog: null,
  exportJobs: [],
  presenting: false,
  kiosk: false,

  async loadProjects() {
    set({ projects: await window.api.listProjects() })
  },

  async createProject(paths = [], name) {
    const now = Date.now()
    const project: Project = {
      version: 1,
      id: uid(),
      name: name ?? t('untitled'),
      createdAt: now,
      updatedAt: now,
      entries: [],
      media: [],
      music: [],
      settings: structuredClone(DEFAULT_SETTINGS)
    }
    resetHistory()
    set({ project, view: 'editor', selection: [], playhead: 0, tab: 'themes', canUndo: false, canRedo: false })
    await window.api.saveProject(project)
    if (paths.length) await get().importMedia(paths)
    return get().project!
  },

  async openProject(id) {
    await get().openProjectData(await window.api.loadProject(id))
  },

  async openProjectData(p) {
    resetHistory()
    set({ project: p, view: 'editor', selection: [], playhead: 0, tab: 'themes', canUndo: false, canRedo: false })
    const [media, music] = await Promise.all([window.api.restoreMedia(p.media), window.api.restoreMusic(p.music)])
    const cur = get().project
    if (!cur || cur.id !== p.id) return
    const old = new Map(cur.music.map((m) => [m.id, m]))
    const next = { ...cur, media, music: music.map((m) => keepTrim(m, old.get(m.id))) }
    set({ project: next })
    scheduleSave(next)
  },

  closeProject() {
    const p = get().project
    if (p) void window.api.saveProject(p)
    resetHistory()
    set({ project: null, view: 'home', selection: [], fullscreen: false, canUndo: false, canRedo: false, privacyEdit: null, textSel: null })
    void get().loadProjects()
  },

  async deleteProject(id) {
    await window.api.deleteProject(id)
    await get().loadProjects()
  },

  update(fn, key) {
    const cur = get().project
    if (!cur) return
    // Media items are replaced, never changed in place, so the copy and the undo snapshots share
    // them: their face data (descriptors) made every edit cost ~40 ms in a big project.
    const { media, ...rest } = cur
    const next: Project = { ...structuredClone(rest), media: media.slice() }
    fn(next)
    next.updatedAt = Date.now()
    const now = performance.now()
    if (!(key && key === history.key && now - history.at < 1000)) {
      history.past.push(cur)
      if (history.past.length > HISTORY_LIMIT) history.past.shift()
    }
    history.key = key
    history.at = now
    history.future = []
    set({ project: next, canUndo: true, canRedo: false })
    scheduleSave(next)
  },

  undo() {
    const cur = get().project
    const prev = history.past.pop()
    if (!cur || !prev) return
    history.future.push(cur)
    history.key = undefined
    const next = withCurrentMedia(prev, cur)
    set({ project: next, canUndo: history.past.length > 0, canRedo: true })
    scheduleSave(next)
  },

  redo() {
    const cur = get().project
    const fwd = history.future.pop()
    if (!cur || !fwd) return
    history.past.push(cur)
    history.key = undefined
    const next = withCurrentMedia(fwd, cur)
    set({ project: next, canUndo: true, canRedo: history.future.length > 0 })
    scheduleSave(next)
  },

  setSettings(patch) {
    get().update((p) => Object.assign(p.settings, patch), `settings:${Object.keys(patch).join(',')}`)
  },

  setSlideDuration(slideIds, seconds) {
    const want = new Set(slideIds)
    get().update((p) => {
      const first = p.entries.find((e) => want.has(e.id))
      if (first) first.duration = seconds == null ? undefined : Math.round(Math.min(120, Math.max(0.5, seconds)) * 10) / 10
    }, `duration:${slideIds[0]}`)
  },

  insertDayTitles(mode) {
    get().update((p) => edits.insertDayTitles(p, mode))
  },

  removeAutoTitles() {
    get().update((p) => (p.entries = p.entries.filter((e) => !(e.type === 'text' && e.auto === 'day'))))
  },

  sortByDate() {
    get().update((p) => edits.sortByDate(p))
  },

  setTheme(theme) {
    get().update((p) => {
      p.settings.theme = theme
      p.settings.look = themeMeta(theme).defaultLook
    })
  },

  async importMedia(paths, placement = 'selection') {
    const items = await window.api.importPaths(paths)
    if (!items.length) return
    const { selection } = get()
    get().update((p) => {
      const known = new Set(p.media.map((m) => m.id))
      for (const m of items) if (!known.has(m.id)) p.media.push(m)
      const fresh = entriesFor(items)
      if (placement === 'byTime') {
        const media = new Map(p.media.map((m) => [m.id, m]))
        const dated = edits.hasDateTitles(p.entries, media)
        p.entries = edits.insertByTime(p.entries, fresh, media)
        // a show with day titles gets one for a day that came in new
        if (dated) p.entries = edits.addMissingDayTitles(p.entries, media)
        return
      }
      const after = selection.length ? p.entries.findIndex((e) => e.id === selection[selection.length - 1]) : -1
      if (after >= 0) p.entries.splice(after + 1, 0, ...fresh)
      else p.entries.push(...fresh)
    })
  },

  async addMusic(paths) {
    const tracks = await window.api.importMusic(paths)
    get().update((p) => {
      const known = new Set(p.music.map((m) => m.id))
      for (const tr of tracks) if (!known.has(tr.id)) p.music.push(tr)
    })
  },

  addText() {
    const { selection } = get()
    const entry: Entry = { id: uid(), type: 'text', title: t('textSlide') }
    get().update((p) => {
      const after = selection.length ? p.entries.findIndex((e) => e.id === selection[selection.length - 1]) : -1
      p.entries.splice(after >= 0 ? after + 1 : p.entries.length, 0, entry)
    })
    set({ selection: [entry.id], tab: 'slide' })
  },

  addCredits() {
    const entry: Entry = { id: uid(), type: 'text', title: t('creditsTitle'), subtitle: t('creditsLines'), titleStyle: 'credits' }
    get().update((p) => void p.entries.push(entry))
    set({ selection: [entry.id], tab: 'slide' })
  },

  removeEntries(ids) {
    const drop = new Set(ids)
    get().update((p) => {
      p.entries = p.entries.filter((e) => !drop.has(e.id))
      const used = new Set(p.entries.flatMap((e) => (e.type === 'text' ? [] : [e.mediaId])))
      p.media = p.media.filter((m) => used.has(m.id))
    })
    set({ selection: [] })
  },

  setEntry(id, patch) {
    get().update((p) => {
      const e = p.entries.find((x) => x.id === id)
      if (e) Object.assign(e, patch)
    }, `entry:${id}:${Object.keys(patch).join(',')}`)
  },

  updateEntries(ids, fn, key) {
    const want = new Set(ids)
    get().update((p) => p.entries.forEach((e) => want.has(e.id) && fn(e)), key)
  },

  assignSong(trackId, chapterId) {
    get().update((p) => {
      for (const e of p.entries) {
        if (e.type !== 'text' || !e.music) continue
        e.music = e.music.filter((id) => id !== trackId)
        if (!e.music.length) delete e.music
      }
      const chapter = p.entries.find((e) => e.id === chapterId)
      if (chapter?.type === 'text') chapter.music = [...(chapter.music ?? []), trackId]
    })
  },

  addFreeText(entryId) {
    const ft: FreeText = { id: uid(), text: t('freeTextDefault'), x: 0.5, y: 0.5, size: 0.08, font: 'theme', color: '#ffffff', bold: true, box: 'shadow', rotation: 0 }
    get().update((p) => {
      const e = p.entries.find((x) => x.id === entryId)
      if (e) e.texts = [...(e.texts ?? []), ft]
    })
    set({ textSel: ft.id, tab: 'slide' })
  },

  setFreeText(entryId, textId, patch) {
    get().update((p) => {
      const ft = p.entries.find((x) => x.id === entryId)?.texts?.find((x) => x.id === textId)
      if (ft) Object.assign(ft, patch)
    }, `text:${textId}:${Object.keys(patch).join(',')}`)
  },

  removeFreeText(entryId, textId) {
    get().update((p) => {
      const e = p.entries.find((x) => x.id === entryId)
      if (e?.texts) e.texts = e.texts.filter((x) => x.id !== textId)
      if (e && !e.texts?.length) delete e.texts
    })
    if (get().textSel === textId) set({ textSel: null })
  },

  mergeEntries(ids) {
    get().update((p) => edits.mergeEntries(p, ids))
  },

  splitSlide(ids) {
    get().update((p) => edits.splitSlide(p, ids))
  },

  releaseEntry(slideIds, id) {
    get().update((p) => edits.releaseEntry(p, slideIds, id))
  },

  resizeSlide(slideIds, delta) {
    get().update((p) => edits.resizeSlide(p, slideIds, delta))
  },

  select(ids) {
    set({ selection: ids, kbEdit: null, privacyEdit: null, textSel: null })
  },

  set(patch) {
    set(patch)
  }
}))

/**
 * Applies background processing updates from the main process to the open project. Updates
 * are collected and applied once per animation frame: a big import sends thousands of them.
 */
export function wireMediaUpdates(): () => void {
  const media = new Map<string, MediaItem>()
  const music = new Map<string, MusicTrack>()
  let frame = 0
  const flush = (): void => {
    frame = 0
    const p = useStore.getState().project
    if (!p || (media.size === 0 && music.size === 0)) return
    const next = {
      ...p,
      media: media.size ? p.media.map((m) => media.get(m.id) ?? m) : p.media,
      music: music.size ? p.music.map((m) => (music.has(m.id) ? keepTrim(music.get(m.id)!, m) : m)) : p.music
    }
    media.clear()
    music.clear()
    useStore.setState({ project: next })
    scheduleSave(next)
  }
  const queue = (): void => {
    if (!frame) frame = requestAnimationFrame(flush)
  }
  const offMedia = window.api.onMediaUpdate((item: MediaItem) => {
    media.set(item.id, item)
    queue()
  })
  const offMusic = window.api.onMusicUpdate((track: MusicTrack) => {
    music.set(track.id, track)
    queue()
  })
  return () => {
    cancelAnimationFrame(frame)
    offMedia()
    offMusic()
  }
}

/** The editor's preview player, shared by viewer, filmstrip and keyboard shortcuts. */
export const playerRef: { current: Player | null } = { current: null }
