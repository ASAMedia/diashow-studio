// The undo history of each show on disk, so Ctrl+Z still works after the app was closed: one file per
// show in <userData>/history/<id>.json.gz (never next to the .dshow, which may be copied or sent on;
// never in a pack, an archive or the diagnostics package). The editor sends its history with every
// save (shared/history.ts: patches between neighbouring states); it is written a moment later, or at
// once when the show closes, atomically, and at the latest when the app quits.
//
// A stored history belongs to exactly one state of its show: the file holds the SHA-256 of the
// .dshow text it was saved with ("anchor"). When the show opens, it is restored only if the file
// read is that text and needed no repair; otherwise (changed on another PC, a backup restored, a
// repair, saved by an older version) it is discarded and logged. Every state it leads to goes
// through the same validation as a project file (projectSchema.ts); a damaged file is discarded
// too, and never stops a show from opening. Restoring a backup, a repair, the clean-up and an import
// start with an empty history (projectsMain.ts, ipc.ts, cleanup.ts). A deleted show's history goes
// into the trash with it and comes back when the show is restored (trash.ts). Electron-free.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as zlib from 'node:zlib'
import { applyPatch, diffProject, HISTORY_BYTES, HISTORY_STEPS, type HistoryRestore, type HistoryUpload, type StepPatch } from '@shared/history'
import type { Project } from '@shared/types'
import { checkProjectId, validateProject } from './projectSchema'
import { replaceFile } from './replaceFile'
import { removeInside } from './safeDelete'
import { serialByKey } from './serial'

const gzip = promisify(zlib.gzip)
const gunzipRaw = promisify(zlib.gunzip)

export const HISTORY_FORMAT = 'diashow-history'
export const HISTORY_VERSION = 1
const EXT = '.json.gz'
/** A stored history larger than this (compressed) is not even read. */
const MAX_FILE = 64 * 1024 * 1024

/** What happened to the history a save carried: written, missing patches (send all again), or none sent. */
export type HistorySaveStatus = 'ok' | 'resend' | 'ignored'

export interface HistoryStoreOptions {
  /** <userData>/history */
  dir: string
  /** Pause after a save before the history is written (default 1 s). */
  delayMs?: number
  maxSteps?: number
  /** JSON bytes of the stored steps, before compression. */
  maxBytes?: number
  /** Notes for the log: restored, discarded and why (project ids only, nothing personal). */
  log?: (message: string) => void
  now?: () => number
}

export interface HistoryStore {
  readonly dir: string
  /** The history file of a show. */
  fileOf(id: string): string
  /** The editor read a show's file (`text`, as `project` after validation): the state a stored history must belong to. */
  opened(id: string, text: string, project: Project, repaired: boolean): void
  /** The stored history of the show opened last, checked and validated; null when there is none that fits (discarded then). */
  load(id: string): Promise<HistoryRestore | null>
  /** The editor saved `text` for a show, with its history (`upload`, unchecked) or without (undefined). */
  saved(id: string, text: string, upload: unknown): HistorySaveStatus
  /**
   * A show that is not open was saved from `before` to `after` without the editor (the deletion
   * reminder on the home screen): its stored history moves along when it belonged to `before`.
   * Returns whether it did.
   */
  rebase(id: string, before: string, after: string): Promise<boolean>
  /** Writes what is waiting: of one show, or of all. */
  flush(id?: string): Promise<void>
  /** Writes what is waiting for a show and forgets it, leaving its file (the show goes into the trash, trash.ts). */
  release(id: string): Promise<void>
  /** Deletes a show's history (and forgets what was waiting); returns what was removed, and what could not be. */
  clear(id: string): Promise<{ files: number; bytes: number; failed: string[] }>
  /** Deletes the history of every show. */
  clearAll(): Promise<{ files: number; bytes: number }>
  /** Size of a show's stored history (after writing what was waiting). */
  size(id: string): Promise<{ files: number; bytes: number }>
}

/** SHA-256 of a project file's text: what a stored history is anchored to. */
export function projectHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const stepIds = (v: unknown): v is number[] => Array.isArray(v) && v.length <= HISTORY_STEPS && v.every((n) => Number.isSafeInteger(n) && n > 0)

/** The renderer's upload with its shape checked; null when it is none (or nonsense). */
export function checkUpload(raw: unknown): HistoryUpload | null {
  if (!isObj(raw) || typeof raw.session !== 'string' || !raw.session || raw.session.length > 100) return null
  if (!stepIds(raw.undo) || !stepIds(raw.redo) || !isObj(raw.patches)) return null
  const patches: Record<string, StepPatch> = {}
  for (const [k, p] of Object.entries(raw.patches)) {
    if (!/^[1-9]\d{0,15}$/.test(k) || !isObj(p)) return null
    patches[k] = p as StepPatch
  }
  return { session: raw.session, undo: raw.undo, redo: raw.redo, patches, ...(raw.flush === true ? { flush: true } : {}) }
}

interface Live {
  session: string
  patches: Map<number, { patch: StepPatch; json?: string }>
  undo: number[]
  redo: number[]
  /** Text of the save the chains belong to, until its hash is taken (when writing). */
  text: string | null
  anchor: string
  dirty: boolean
  timer?: ReturnType<typeof setTimeout>
}

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))

export function createHistoryStore(opts: HistoryStoreOptions): HistoryStore {
  const dir = opts.dir
  const delay = opts.delayMs ?? 1000
  const maxSteps = opts.maxSteps ?? HISTORY_STEPS
  const maxBytes = opts.maxBytes ?? HISTORY_BYTES
  // a stored history holds at most maxBytes of steps: one that unpacks to much more is damaged (or made
  // to fill the memory) and is not unpacked further
  const gunzip = (data: Buffer): Promise<Buffer> => gunzipRaw(data, { maxOutputLength: 4 * maxBytes + 65_536 })
  const now = opts.now ?? Date.now
  const log = (m: string): void => opts.log?.(m)
  const fileOf = (id: string): string => join(dir, `${checkProjectId(id)}${EXT}`)
  const lives = new Map<string, Live>()
  /** Per show: the file text and project the editor opened last (until its history is loaded). */
  const openedShows = new Map<string, { text: string; project: Project; repaired: boolean }>()
  /** Writes, loads and deletions of one show run one after another. */
  const serial = serialByKey()

  /** The stored steps of a chain, nearest first, within the limits left. */
  function take(live: Live, ids: number[], budget: { steps: number; bytes: number }): string[] {
    const out: string[] = []
    for (const n of ids) {
      const e = live.patches.get(n)
      if (!e) break
      e.json ??= JSON.stringify(e.patch)
      if (budget.steps < 1 || budget.bytes < e.json.length) break
      budget.steps--
      budget.bytes -= e.json.length
      out.push(e.json)
    }
    return out
  }

  async function write(id: string): Promise<void> {
    const live = lives.get(id)
    if (!live || !live.dirty) return
    live.dirty = false
    const file = fileOf(id)
    if (!live.undo.length && !live.redo.length) {
      await rm(file, { force: true })
      return
    }
    if (live.text !== null) {
      live.anchor = projectHash(live.text)
      live.text = null
    }
    // redo steps are newer than every undo step: the oldest undo steps go first
    const budget = { steps: maxSteps, bytes: maxBytes }
    const redo = take(live, live.redo, budget)
    const undo = take(live, live.undo, budget)
    const head = JSON.stringify({ format: HISTORY_FORMAT, version: HISTORY_VERSION, projectId: id, anchor: live.anchor, savedAt: now() })
    await store(file, `${head.slice(0, -1)},"undo":[${undo.join(',')}],"redo":[${redo.join(',')}]}`)
  }

  /** Writes a history file through a temp file. */
  async function store(file: string, body: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.${now()}.tmp`
    await writeFile(tmp, await gzip(Buffer.from(body, 'utf8')))
    try {
      await replaceFile(tmp, file)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  const writeLogged = (id: string): Promise<void> =>
    serial(id, () => write(id)).catch((err: unknown) => log(`history of ${id} not written: ${err instanceof Error ? err.message : String(err)}`))

  function flushOne(id: string): Promise<void> {
    const live = lives.get(id)
    if (live?.timer) {
      clearTimeout(live.timer)
      live.timer = undefined
      return writeLogged(id)
    }
    return serial(id, async () => {})
  }

  /** Deletes the file (and leftovers of a write that was cut off) inside the history folder only. */
  async function removeFiles(id: string): Promise<{ files: number; bytes: number; failed: string[] }> {
    const name = `${id}${EXT}`.toLowerCase()
    const names = await readdir(dir).catch(() => [] as string[])
    const targets = names.filter((n) => n.toLowerCase() === name || (n.toLowerCase().startsWith(`${name}.`) && n.toLowerCase().endsWith('.tmp'))).map((n) => join(dir, n))
    if (!targets.length) return { files: 0, bytes: 0, failed: [] }
    const r = await removeInside(targets, [dir])
    return { files: r.files, bytes: r.bytes, failed: [...r.failed, ...r.refused] }
  }

  /** The states a stored chain leads to from `base`, each validated, as patches from one to the next. */
  async function decode(id: string, base: Project, chain: unknown, what: string): Promise<StepPatch[]> {
    if (!Array.isArray(chain)) return []
    const out: StepPatch[] = []
    let prev = base
    for (let i = 0; i < chain.length && out.length < maxSteps; i++) {
      let next: Project
      try {
        const { project } = validateProject(applyPatch(prev, chain[i] as StepPatch), { fallbackId: id })
        project.id = id
        next = project
      } catch (err) {
        log(`history of ${id}: ${what} step ${i + 1} of ${chain.length} unusable (${err instanceof Error ? err.message : String(err)}), the steps after it are dropped`)
        break
      }
      // the editor rebuilds the states from these: what validation repaired is in them
      out.push(diffProject(prev, next))
      prev = next
      if (i % 8 === 7) await yieldNow()
    }
    return out
  }

  return {
    dir,
    fileOf,

    opened(id, text, project, repaired) {
      openedShows.delete(checkProjectId(id))
      openedShows.set(id, { text, project, repaired })
      // only the last few opened shows wait for their history
      while (openedShows.size > 4) openedShows.delete(openedShows.keys().next().value!)
    },

    async load(id) {
      checkProjectId(id)
      const rec = openedShows.get(id)
      openedShows.delete(id)
      if (!rec) return null
      await flushOne(id)
      return serial(id, async (): Promise<HistoryRestore | null> => {
        const file = fileOf(id)
        const discard = async (why: string): Promise<null> => {
          log(`history of ${id} discarded: ${why}`)
          await removeFiles(id).catch(() => {})
          return null
        }
        let raw: Buffer
        try {
          if ((await stat(file)).size > MAX_FILE) return discard('the file is too large')
          raw = await readFile(file)
        } catch {
          return null // no history
        }
        if (rec.repaired) return discard('parts of the show were damaged and dropped when it was opened')
        let data: unknown
        try {
          data = JSON.parse((await gunzip(raw)).toString('utf8'))
        } catch {
          return discard('the file is damaged')
        }
        if (!isObj(data) || data.format !== HISTORY_FORMAT || data.version !== HISTORY_VERSION || data.projectId !== id) return discard('not a history of this show')
        if (data.anchor !== projectHash(rec.text)) return discard('it belongs to another state of the show (changed elsewhere, restored, repaired or saved by another version)')
        const undo = await decode(id, rec.project, data.undo, 'undo')
        const redo = await decode(id, rec.project, data.redo, 'redo')
        log(`history of ${id} restored: ${undo.length} undo and ${redo.length} redo steps`)
        return { undo, redo }
      })
    },

    saved(id, text, raw) {
      checkProjectId(id)
      const up = checkUpload(raw)
      // without its history the editor doesn't vouch for the stored one: it stays as it is
      if (!up) return 'ignored'
      let live = lives.get(id)
      if (!live || live.session !== up.session) {
        if (live?.timer) clearTimeout(live.timer)
        live = { session: up.session, patches: new Map(), undo: [], redo: [], text: null, anchor: '', dirty: false }
        lives.set(id, live)
      }
      for (const [k, patch] of Object.entries(up.patches)) live.patches.set(Number(k), { patch })
      if ([...up.undo, ...up.redo].some((n) => !live.patches.has(n))) return 'resend'
      live.undo = up.undo
      live.redo = up.redo
      live.text = text
      const used = new Set([...up.undo, ...up.redo])
      for (const n of live.patches.keys()) if (!used.has(n)) live.patches.delete(n)
      live.dirty = true
      clearTimeout(live.timer)
      const l = live
      l.timer = setTimeout(() => {
        l.timer = undefined
        void writeLogged(id)
      }, up.flush ? 0 : delay)
      return 'ok'
    },

    async rebase(id, before, after) {
      checkProjectId(id)
      await flushOne(id)
      const from = projectHash(before)
      const to = projectHash(after)
      return serial(id, async () => {
        const live = lives.get(id)
        if (live?.anchor === from) live.anchor = to
        const file = fileOf(id)
        let data: unknown
        try {
          if ((await stat(file)).size > MAX_FILE) return false
          data = JSON.parse((await gunzip(await readFile(file))).toString('utf8'))
        } catch {
          return false // none, or damaged: load() discards it
        }
        if (!isObj(data) || data.anchor !== from) return false
        await store(file, JSON.stringify({ ...data, anchor: to, savedAt: now() }))
        log(`history of ${id} moved along with a change made outside the editor`)
        return true
      })
    },

    async flush(id) {
      if (id !== undefined) return flushOne(checkProjectId(id))
      await Promise.all([...lives.keys()].map(flushOne))
    },

    async release(id) {
      await flushOne(checkProjectId(id))
      lives.delete(id)
      openedShows.delete(id)
      // a write or load still running ends first
      await serial(id, async () => {})
    },

    async clear(id) {
      checkProjectId(id)
      const live = lives.get(id)
      if (live?.timer) clearTimeout(live.timer)
      lives.delete(id)
      openedShows.delete(id)
      return serial(id, () => removeFiles(id))
    },

    async clearAll() {
      for (const live of lives.values()) if (live.timer) clearTimeout(live.timer)
      lives.clear()
      openedShows.clear()
      await serial.settled()
      const names = await readdir(dir).catch(() => [] as string[])
      const targets = names.filter((n) => /\.json\.gz(\..*\.tmp)?$/i.test(n)).map((n) => join(dir, n))
      if (!targets.length) return { files: 0, bytes: 0 }
      const r = await removeInside(targets, [dir])
      return { files: r.files, bytes: r.bytes }
    },

    async size(id) {
      await flushOne(checkProjectId(id))
      try {
        const st = await stat(fileOf(id))
        return { files: 1, bytes: st.size }
      } catch {
        return { files: 0, bytes: 0 }
      }
    }
  }
}
