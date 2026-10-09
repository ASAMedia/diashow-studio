import { create } from 'zustand'
import type {
  Entry, MediaItem, MusicTrack, Project, ProjectSettings, ProjectSummary, ThemeId
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { themeMeta } from '@shared/themes'
import { t } from './i18n'
import type { Player } from './engine/player'

export type InspectorTab = 'themes' | 'music' | 'timing' | 'slide'

interface State {
  view: 'home' | 'editor'
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
  loadProjects(): Promise<void>
  createProject(paths?: string[], name?: string): Promise<Project>
  openProject(id: string): Promise<void>
  closeProject(): void
  deleteProject(id: string): Promise<void>
  update(fn: (p: Project) => void): void
  setSettings(patch: Partial<ProjectSettings>): void
  setTheme(theme: ThemeId): void
  importMedia(paths: string[]): Promise<void>
  addMusic(paths: string[]): Promise<void>
  addText(): void
  removeEntries(ids: string[]): void
  setEntry(id: string, patch: Partial<Entry>): void
  select(ids: string[]): void
  set(patch: Partial<State>): void
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSave(p: Project): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void window.api.saveProject(p), 600)
}

const uid = (): string => crypto.randomUUID()

function entriesFor(items: MediaItem[]): Entry[] {
  return items.map((m) => (m.kind === 'video' ? { id: uid(), type: 'video', mediaId: m.id } : { id: uid(), type: 'photo', mediaId: m.id }))
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
    set({ project, view: 'editor', selection: [], playhead: 0, tab: 'themes' })
    await window.api.saveProject(project)
    if (paths.length) await get().importMedia(paths)
    return get().project!
  },

  async openProject(id) {
    const p = await window.api.loadProject(id)
    set({ project: p, view: 'editor', selection: [], playhead: 0, tab: 'themes' })
    const [media, music] = await Promise.all([window.api.restoreMedia(p.media), window.api.restoreMusic(p.music)])
    get().update((d) => {
      d.media = media
      d.music = music
    })
  },

  closeProject() {
    const p = get().project
    if (p) void window.api.saveProject(p)
    set({ project: null, view: 'home', selection: [], fullscreen: false })
    void get().loadProjects()
  },

  async deleteProject(id) {
    await window.api.deleteProject(id)
    await get().loadProjects()
  },

  update(fn) {
    const cur = get().project
    if (!cur) return
    const next = structuredClone(cur)
    fn(next)
    next.updatedAt = Date.now()
    set({ project: next })
    scheduleSave(next)
  },

  setSettings(patch) {
    get().update((p) => Object.assign(p.settings, patch))
  },

  setTheme(theme) {
    get().update((p) => {
      p.settings.theme = theme
      p.settings.look = themeMeta(theme).defaultLook
    })
  },

  async importMedia(paths) {
    const items = await window.api.importPaths(paths)
    if (!items.length) return
    const { selection } = get()
    get().update((p) => {
      const known = new Set(p.media.map((m) => m.id))
      for (const m of items) if (!known.has(m.id)) p.media.push(m)
      const fresh = entriesFor(items)
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
    })
  },

  select(ids) {
    set({ selection: ids, kbEdit: null })
  },

  set(patch) {
    set(patch)
  }
}))

/** Applies background processing updates from the main process to the open project. */
export function wireMediaUpdates(): () => void {
  const apply = <T extends { id: string }>(list: T[], item: T): T[] => list.map((x) => (x.id === item.id ? item : x))
  const offMedia = window.api.onMediaUpdate((item: MediaItem) => {
    const p = useStore.getState().project
    if (!p || !p.media.some((m) => m.id === item.id)) return
    useStore.setState({ project: { ...p, media: apply(p.media, item) } })
    scheduleSave(useStore.getState().project!)
  })
  const offMusic = window.api.onMusicUpdate((track: MusicTrack) => {
    const p = useStore.getState().project
    if (!p || !p.music.some((m) => m.id === track.id)) return
    useStore.setState({ project: { ...p, music: apply(p.music, track) } })
    scheduleSave(useStore.getState().project!)
  })
  return () => {
    offMedia()
    offMusic()
  }
}

/** The editor's preview player, shared by viewer, filmstrip and keyboard shortcuts. */
export const playerRef: { current: Player | null } = { current: null }
