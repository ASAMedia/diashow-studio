import { create } from 'zustand'
import type {
  Entry, FreeText, MediaEdit, MediaItem, MusicTrack, Project, ProjectSettings, ProjectSummary, ThemeId
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { ExportJobInfo } from '@shared/exportQueue'
import { themeMeta } from '@shared/themes'
import type { ThemeTrack } from '@shared/themeMusic'
import { withProjectFields } from '@shared/mediaEdit'
import { applyChain, HISTORY_STEPS, HistoryRecorder, type HistoryRestore, type HistoryUpload } from '@shared/history'
import { t } from './i18n'
import { notifyError } from './errors'
import type { Player } from './engine/player'
import * as edits from './entryEdits'
import { entriesFor, uid } from './entryEdits'
import { againPaths, importChecked, noticeRepeats, serially, type CheckedImport } from './repeats'

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
  /** Rotate / straighten / crop of the picture of an entry in the viewer (photoEdit.ts); `before`: its edit when the editor opened (Cancel). */
  photoEdit: { entryId: string; mediaId: string; before?: MediaEdit } | null
  /** Selected free text box (its id). */
  textSel: string | null
  canUndo: boolean
  canRedo: boolean
  /** 'share': photos from phones / video to phones over the Wi-Fi; 'systemcheck': opened from Settings. */
  dialog: 'rejects' | 'pack' | 'settings' | 'backups' | 'help' | 'queue' | 'share' | 'systemcheck' | 'privacyReview' | 'handbook' | 'about' | null
  /** Export queue, oldest first (kept by the main process). */
  exportJobs: ExportJobInfo[]
  presenting: boolean
  /** Fullscreen started by kiosk mode: loops whatever the project says. */
  kiosk: boolean
  /** The bundled theme songs (loaded once at start, src/shared/themeMusic.ts). */
  themeTracks: ThemeTrack[]
  loadProjects(): Promise<void>
  createProject(paths?: string[], name?: string): Promise<Project>
  openProject(id: string): Promise<void>
  closeProject(): void
  /**
   * Changes the project and records an undo step. Edits with the same `key` that follow each
   * other within a moment (slider and drag moves) form one step.
   */
  update(fn: (p: Project) => void, key?: string): void
  undo(): void
  redo(): void
  /**
   * Opens a project (loaded, or from a file: packed project, backup, repair). Its stored undo history
   * comes back in the background when it belongs to exactly this state (src/main/history.ts).
   */
  openProjectData(p: Project): Promise<void>
  /** Checks the open project's files again (e.g. after access to a network share was allowed). */
  reloadMedia(): Promise<void>
  /** Custom on-screen time of a slide (undefined = automatic), stored on its first entry. */
  setSlideDuration(slideIds: string[], seconds: number | undefined): void
  /** Text slides at every new day ('date') or every new subfolder ('folder'). */
  insertDayTitles(mode: 'date' | 'folder'): void
  removeAutoTitles(): void
  sortByDate(): void
  setSettings(patch: Partial<ProjectSettings>): void
  setTheme(theme: ThemeId): void
  /**
   * New files go behind the selection, or (`byTime`) where their capture time belongs. What the show has
   * already is skipped with a notice (repeats.ts; `quiet`: none, the share dialog counts them itself).
   */
  importMedia(paths: string[], placement?: 'selection' | 'byTime', opts?: { quiet?: boolean }): Promise<{ added: MediaItem[]; skipped: MediaItem[] }>
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
  /** The theme groups the photos again: of these slides' entries, or of the whole show. */
  autoGroup(ids?: string[]): void
  select(ids: string[]): void
  set(patch: Partial<State>): void
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
/** The project the waiting save will write. */
let pendingSave: Project | null = null
/** Set while the clean-up rewrites the open project's file: the editor's own saves wait. */
let savesHeld = false
function scheduleSave(p: Project): void {
  clearTimeout(saveTimer)
  pendingSave = null
  if (savesHeld) return
  pendingSave = p
  saveTimer = setTimeout(() => {
    pendingSave = null
    // held meanwhile (the clean-up rewrites the file): this save would write the show as it was
    if (savesHeld) return
    // a failed save (disk full, locked folder) must not go unnoticed
    void saveNow(p).catch((e) => notifyError(e, 'save'))
  }, 600)
}

/** Drops the waiting save; returns the project it would have written. */
function takePendingSave(): Project | null {
  clearTimeout(saveTimer)
  const p = pendingSave
  pendingSave = null
  return p
}

/**
 * Before another show takes over the editor: a save still waiting for the show before is made now,
 * with that show's undo history; one for `id` itself is dropped (its file was just replaced by a
 * backup, a repair or the clean-up, or is the one being opened).
 */
function settlePendingSave(id: string): void {
  const p = takePendingSave()
  if (p && p.id !== id) void saveNow(p).catch((e) => notifyError(e, 'save'))
}

/**
 * Saves a project with the undo history the editor keeps for it (the main process writes it to the
 * app's data folder a moment later; `flush`: before this resolves). The history goes along only
 * while it is this show's and not still being loaded.
 */
async function saveNow(p: Project, flush = false): Promise<void> {
  const mine = persisted.owner === p.id && !persisted.restoring
  const past = history.past.slice()
  const future = history.future.slice()
  const upload = (): HistoryUpload | undefined => (mine ? recorder.upload(p, past, future, flush) : undefined)
  const r = await window.api.saveProject(p, upload())
  if (r?.resendHistory && mine) {
    // the main process lost track of the steps (it cleared them meanwhile): once more with all of them
    recorder.resend()
    await window.api.saveProject(p, upload())
  }
}

/**
 * For the clean-up of the open project: its pending changes are saved now, then saves wait until
 * the returned function is called (the main process rewrites the file meanwhile).
 */
export async function holdSaves(): Promise<() => void> {
  takePendingSave()
  const p = useStore.getState().project
  if (p) await saveNow(p, true)
  savesHeld = true
  // one scheduled while that save was on its way (a background update) is dropped as well: the show
  // the clean-up leaves replaces the open one afterwards (Cleanup.tsx runCleanup)
  takePendingSave()
  return () => {
    savesHeld = false
  }
}

/**
 * The window closes (also when the app quits): a save still waiting goes out now, with the undo history
 * written at once. The main process takes it before it quits (projectsMain.ts settleSaves); without
 * this, an edit made less than a moment before closing was lost.
 */
export function saveBeforeClose(): void {
  const p = takePendingSave()
  if (p) void saveNow(p, true).catch(() => {})
}

/** Saves the open project now, with its undo history, when it is `projectId` (before the clean-up or an archive lists it). */
export async function saveOpenProject(projectId: string): Promise<void> {
  const p = useStore.getState().project
  if (p?.id !== projectId) return
  takePendingSave()
  await saveNow(p, true)
}

// Undo history. Snapshots are whole projects (cheap to keep: media items are shared data);
// restoring keeps the current processing state of media and music. It goes to disk with every save
// as the differences between neighbouring states (@shared/history), and comes back when the show
// opens again (restoreHistory).
const history = { past: [] as Project[], future: [] as Project[], key: '' as string | undefined, at: 0 }
const HISTORY_LIMIT = HISTORY_STEPS
const recorder = new HistoryRecorder()
/**
 * Whose history the editor keeps (`owner`), and whether the stored one is still being loaded: until
 * then saves don't send it, so the one on disk stays. `gen` counts openings (a late answer is dropped).
 */
const persisted = { owner: null as string | null, restoring: false, gen: 0 }

function resetHistory(): void {
  history.past = []
  history.future = []
  history.key = undefined
}

/** A fresh history for the show `owner` (null: none open); `restoring`: its stored history is asked for. */
function startHistory(owner: string | null, restoring = false): void {
  resetHistory()
  persisted.owner = owner
  persisted.restoring = restoring
  persisted.gen++
}

/**
 * Loads the stored history of a show just opened (as `p`, before anything changed it) and puts it
 * below the steps made since. Every state in it was validated by the main process.
 */
async function restoreHistory(p: Project): Promise<void> {
  const gen = persisted.gen
  let stored: HistoryRestore | null = null
  try {
    stored = await window.api.loadHistory(p.id)
  } catch {
    // no history then; the main process logged why
  }
  if (gen !== persisted.gen) return
  persisted.restoring = false
  if (stored && (stored.undo.length || stored.redo.length)) {
    try {
      const undo = applyChain(p, stored.undo).reverse()
      const untouched = !history.past.length && !history.future.length
      history.past = [...undo, ...history.past].slice(-HISTORY_LIMIT)
      // an edit since the show opened has made the redo steps obsolete
      if (untouched) history.future = applyChain(p, stored.redo).reverse()
      useStore.setState({ canUndo: history.past.length > 0, canRedo: history.future.length > 0 })
    } catch {
      // a step that doesn't fit: the steps made since opening stay
    }
  }
  // the next save sends the whole history again (anchored to that save)
  const cur = useStore.getState().project
  if (cur?.id === p.id) scheduleSave(cur)
}

/** Forgets the open show's undo history (clean-up, Settings → Privacy); the stored one is deleted by the caller. */
export function forgetUndoHistory(): void {
  const owner = persisted.owner
  startHistory(owner)
  useStore.setState({ canUndo: false, canRedo: false })
}

/** Media of `next` that `cur` doesn't have: an undo or redo brought them back. */
const cameBack = (next: Project, cur: Project): boolean => {
  const ids = new Set(cur.media.map((m) => m.id))
  return next.media.some((m) => !ids.has(m.id))
}

function withCurrentMedia(snapshot: Project, current: Project): Project {
  const media = new Map(current.media.map((m) => [m.id, m]))
  const music = new Map(current.music.map((m) => [m.id, m]))
  return {
    ...snapshot,
    // the photo edit (rotate, straighten, crop) is the user's: it goes back with the snapshot
    media: snapshot.media.map((m) => (media.has(m.id) ? keepEdit(media.get(m.id)!, m) : m)),
    // and so does the part of a song that plays (its trim)
    music: snapshot.music.map((m) => (music.has(m.id) ? withTrimOf(music.get(m.id)!, m) : m))
  }
}

/** A song as it is now (processing), with the trim of `snapshot` (an undo step); no trim when it has none. */
function withTrimOf(cur: MusicTrack, snapshot: MusicTrack): MusicTrack {
  if (cur.trimIn === snapshot.trimIn && cur.trimOut === snapshot.trimOut) return cur
  const { trimIn: _i, trimOut: _o, ...rest } = cur
  return { ...rest, ...(snapshot.trimIn != null ? { trimIn: snapshot.trimIn } : {}), ...(snapshot.trimOut != null ? { trimOut: snapshot.trimOut } : {}) }
}

/** Fields of a song the user sets in the editor; processing updates from the main process keep them. */
function keepTrim(update: MusicTrack, cur: MusicTrack | undefined): MusicTrack {
  return cur && (cur.trimIn != null || cur.trimOut != null) ? { ...update, trimIn: cur.trimIn, trimOut: cur.trimOut } : update
}

/** A media item of the current state with the photo edit of `cur` (an undo snapshot: the edit goes back with it). */
function keepEdit(update: MediaItem, cur: MediaItem | undefined): MediaItem {
  if (!cur || update.edit === cur.edit) return update
  const { edit: _old, ...rest } = update
  return cur.edit ? { ...rest, edit: cur.edit } : rest
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
  photoEdit: null,
  textSel: null,
  canUndo: false,
  canRedo: false,
  dialog: null,
  exportJobs: [],
  presenting: false,
  kiosk: false,
  themeTracks: [],

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
    settlePendingSave(project.id)
    startHistory(project.id)
    set({ project, view: 'editor', selection: [], playhead: 0, tab: 'themes', canUndo: false, canRedo: false })
    await saveNow(project).catch((e) => notifyError(e, 'save'))
    if (paths.length) await get().importMedia(paths)
    return get().project!
  },

  async openProject(id) {
    await get().openProjectData(await window.api.loadProject(id))
  },

  async reloadMedia() {
    const p = get().project
    if (!p) return
    const [media, music] = await Promise.all([window.api.restoreMedia(p.media), window.api.restoreMusic(p.music)])
    const cur = get().project
    if (!cur || cur.id !== p.id) return
    const byId = new Map(media.map((m) => [m.id, m]))
    const songs = new Map(music.map((m) => [m.id, m]))
    set({ project: { ...cur, media: cur.media.map((m) => (byId.has(m.id) ? withProjectFields(byId.get(m.id)!, m) : m)), music: cur.music.map((m) => songs.get(m.id) ?? m) } })
  },

  async openProjectData(p) {
    settlePendingSave(p.id)
    startHistory(p.id, true)
    set({ project: p, view: 'editor', selection: [], playhead: 0, tab: 'themes', canUndo: false, canRedo: false })
    // the stored undo history in the background: opening doesn't wait for it
    void restoreHistory(p)
    const [media, music] = await Promise.all([window.api.restoreMedia(p.media), window.api.restoreMusic(p.music)])
    const cur = get().project
    if (!cur || cur.id !== p.id) return
    const old = new Map(cur.music.map((m) => [m.id, m]))
    const shown = new Map(cur.media.map((m) => [m.id, m]))
    const next = { ...cur, media: media.map((m) => withProjectFields(m, shown.get(m.id))), music: music.map((m) => keepTrim(m, old.get(m.id))) }
    set({ project: next })
    scheduleSave(next)
  },

  closeProject() {
    const p = get().project
    takePendingSave()
    // with its undo history, written at once (the upload is taken before the history is reset)
    if (p) void saveNow(p, true).catch((e) => notifyError(e, 'save'))
    startHistory(null)
    set({ project: null, view: 'home', selection: [], fullscreen: false, canUndo: false, canRedo: false, privacyEdit: null, photoEdit: null, textSel: null })
    void get().loadProjects()
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
    // a photo that comes back (also from a history of an earlier session) gets its cached copies checked
    if (cameBack(next, cur)) void get().reloadMedia()
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
    if (cameBack(next, cur)) void get().reloadMedia()
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

  importMedia(paths, placement = 'selection', opts = {}) {
    // the show the files are for: once another one is open (the queue waited, or the files took a
    // while to read) they go into none
    const owner = get().project?.id
    const gone = (): boolean => get().project?.id !== owner
    return serially(async () => {
      if (gone()) return { added: [], skipped: [] }
      let checked: CheckedImport
      try {
        checked = await importChecked(paths, get().project)
      } catch (e) {
        notifyError(e, 'import')
        return { added: [], skipped: [] }
      }
      if (gone()) return { added: [], skipped: [] }
      const { selection } = get()
      // behind entry `behind` (else at the end), or by capture time; returns the new entry ids
      const put = (items: MediaItem[], behind = selection[selection.length - 1]): string[] => {
        const fresh = entriesFor(items)
        get().update((p) => {
          const known = new Set(p.media.map((m) => m.id))
          for (const m of items) if (!known.has(m.id)) p.media.push(m)
          if (placement === 'byTime') {
            const media = new Map(p.media.map((m) => [m.id, m]))
            const dated = edits.hasDateTitles(p.entries, media)
            p.entries = edits.insertByTime(p.entries, fresh, media)
            // a show with day titles gets one for a day that came in new
            if (dated) p.entries = edits.addMissingDayTitles(p.entries, media)
            return
          }
          const after = behind ? p.entries.findIndex((e) => e.id === behind) : -1
          if (after >= 0) p.entries.splice(after + 1, 0, ...fresh)
          else p.entries.push(...fresh)
        })
        return fresh.map((e) => e.id)
      }
      const added = checked.fresh.length ? put(checked.fresh) : []
      const p = get().project
      if (checked.skipped.length && !opts.quiet && p) {
        // "Add anyway": behind the ones this import added (or where they would have gone), in one undo step
        noticeRepeats(p, checked, () =>
          serially(async () => {
            const items = await window.api.importPaths(againPaths(checked.skipped))
            const cur = get().project
            if (!items.length || cur?.id !== p.id) return []
            return put(items, [...added].reverse().find((id) => cur.entries.some((e) => e.id === id)))
          })
        )
      }
      return { added: checked.fresh, skipped: checked.skipped }
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

  autoGroup(ids) {
    get().update((p) => edits.autoGroup(p, ids))
  },

  resizeSlide(slideIds, delta) {
    get().update((p) => edits.resizeSlide(p, slideIds, delta))
  },

  select(ids) {
    set({ selection: ids, kbEdit: null, privacyEdit: null, photoEdit: null, textSel: null })
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
      media: media.size ? p.media.map((m) => (media.has(m.id) ? withProjectFields(media.get(m.id)!, m) : m)) : p.media,
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
