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

  mergeEntries(ids) {
    const want = new Set(ids)
    get().update((p) => {
      const block = p.entries.filter((e) => want.has(e.id) && e.type !== 'text')
      if (block.length < 2) return
      const firstIdx = p.entries.indexOf(block[0])
      const moving = new Set(block)
      const rest = p.entries.filter((e) => !moving.has(e))
      const at = p.entries.slice(0, firstIdx).filter((e) => !moving.has(e)).length
      rest.splice(at, 0, ...block)
      block.forEach((e, i) => (e.groupBreak = i === 0 ? 'force' : 'join'))
      const after = rest[at + block.length]
      if (after) after.groupBreak = 'force'
      p.entries = rest
    })
  },

  splitSlide(ids) {
    const want = new Set(ids)
    get().update((p) => p.entries.forEach((e) => want.has(e.id) && (e.groupBreak = 'force')))
  },

  releaseEntry(slideIds, id) {
    const want = new Set(slideIds)
    get().update((p) => {
      const slide = p.entries.filter((e) => want.has(e.id))
      const e = p.entries.find((x) => x.id === id)
      const keep = slide.filter((x) => x.id !== id)
      if (!e || keep.length === 0) return
      p.entries = p.entries.filter((x) => x !== e)
      const at = p.entries.indexOf(keep[keep.length - 1]) + 1
      p.entries.splice(at, 0, e)
      e.groupBreak = 'force'
      if (keep[0].groupBreak === 'join') keep[0].groupBreak = 'force'
      const next = p.entries[at + 1]
      if (next) next.groupBreak = 'force'
    })
  },

  resizeSlide(slideIds, delta) {
    const want = new Set(slideIds)
    get().update((p) => {
      const slide = p.entries.filter((e) => want.has(e.id))
      if (!slide.length) return
      const last = slide[slide.length - 1]
      if (delta < 0) {
        if (slide.length > 1) last.groupBreak = 'force'
        return
      }
      const next = p.entries[p.entries.indexOf(last) + 1]
      if (!next || next.type === 'text') return
      next.groupBreak = 'join'
      const after = p.entries[p.entries.indexOf(next) + 1]
      if (after && after.groupBreak !== 'join') after.groupBreak = 'force'
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
