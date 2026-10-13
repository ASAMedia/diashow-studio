// Undo and redo that survive closing the app. The editor keeps its history as whole projects
// (store.ts); on disk (src/main/history.ts, <userData>/history/<id>.json.gz) each step is only the
// difference to its neighbour:
// - fields of the project (settings, name, people, …) that differ, with the neighbour's value;
// - for the lists of entries, media and songs: their order (when it changed) and the items that are
//   new or changed, each whole. Media count as changed only when their photo edit did: undo takes
//   everything else of a photo from the current state anyway (store.ts withCurrentMedia), so the
//   background processing (thumbnails, faces) adds nothing to the history.
// The undo chain goes from the saved state backwards, the redo chain forwards, nearest step first.
// Pure, shared by the renderer (recording) and the main process (storing, validating).
import type { Project } from './types'

/** Steps kept per show (undo and redo together), as in the editor. */
export const HISTORY_STEPS = 100
/** At most this much of a show's history is stored (JSON, before compression); the oldest steps go first. */
export const HISTORY_BYTES = 20 * 1024 * 1024

/** A list of items with ids: the neighbour's order (when it differs) and its new or changed items. */
export interface ListPatch {
  order?: string[]
  items?: { id: string }[]
  /** The whole list, for a list whose items have no unique ids. */
  all?: unknown[]
}

/** One step: how a state of the project becomes its neighbour in the history. */
export interface StepPatch {
  /** Fields (other than the three lists) that differ, with the neighbour's value. */
  set?: Record<string, unknown>
  /** Fields the neighbour doesn't have. */
  unset?: string[]
  entries?: ListPatch
  media?: ListPatch
  music?: ListPatch
}

/**
 * What a save of the editor carries: both chains as patch numbers, nearest first, and the patches
 * the main process doesn't have yet (the numbers count up within one `session`, a window load).
 */
export interface HistoryUpload {
  session: string
  undo: number[]
  redo: number[]
  patches: Record<string, StepPatch>
  /** Write the history file before the save resolves (closing the show), not after the usual pause. */
  flush?: boolean
}

/** A stored history as it comes back when a show opens: patches from the opened state, nearest first. */
export interface HistoryRestore {
  undo: StepPatch[]
  redo: StepPatch[]
}

const LISTS = ['entries', 'media', 'music'] as const
type ListKey = (typeof LISTS)[number]
const isList = (k: string): k is ListKey => (LISTS as readonly string[]).includes(k)
/** Never set from stored data: would change the prototype of the project object. */
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep equality of JSON-like values; a field set to undefined counts as missing (as in the saved file). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const x = a as Obj
  const y = b as Obj
  let n = 0
  for (const k in x) {
    if (x[k] === undefined) continue
    if (!sameValue(x[k], y[k])) return false
    n++
  }
  for (const k in y) if (y[k] !== undefined) n--
  return n === 0
}

/** Media differ for the history only in their photo edit (see the top of the file). */
const sameMedia = (a: Obj, b: Obj): boolean => a === b || sameValue(a.edit, b.edit)

/** Every item an object with an id, each id once. */
function keyed(list: unknown): list is { id: string }[] {
  if (!Array.isArray(list)) return false
  const ids = new Set<string>()
  for (const x of list) {
    if (!isObj(x) || typeof x.id !== 'string' || ids.has(x.id)) return false
    ids.add(x.id)
  }
  return true
}

function diffList(a: unknown, b: unknown, same: (x: Obj, y: Obj) => boolean): ListPatch | undefined {
  if (a === b) return undefined
  if (!keyed(a) || !keyed(b)) return sameValue(a, b) ? undefined : { all: Array.isArray(b) ? b : [] }
  const old = new Map(a.map((x) => [x.id, x]))
  const items = b.filter((x) => {
    const o = old.get(x.id)
    return !o || (o !== x && !same(o as Obj, x as Obj))
  })
  const reordered = a.length !== b.length || b.some((x, i) => x.id !== a[i].id)
  if (!items.length && !reordered) return undefined
  const out: ListPatch = {}
  if (reordered) out.order = b.map((x) => x.id)
  if (items.length) out.items = items
  return out
}

/** The step from `from` to its neighbour `to` (values are shared with `to`, not copied). */
export function diffProject(from: Project, to: Project): StepPatch {
  const a = from as unknown as Obj
  const b = to as unknown as Obj
  const patch: StepPatch = {}
  for (const k of Object.keys(b)) {
    if (isList(k) || b[k] === undefined || sameValue(a[k], b[k])) continue
    ;(patch.set ??= {})[k] = b[k]
  }
  for (const k of Object.keys(a)) if (!isList(k) && a[k] !== undefined && b[k] === undefined) (patch.unset ??= []).push(k)
  const entries = diffList(a.entries, b.entries, sameValue)
  const media = diffList(a.media, b.media, sameMedia)
  const music = diffList(a.music, b.music, sameValue)
  if (entries) patch.entries = entries
  if (media) patch.media = media
  if (music) patch.music = music
  return patch
}

function applyList(base: unknown, d: unknown): unknown[] {
  if (!isObj(d)) throw new Error('history: broken list step')
  if (d.all !== undefined) {
    if (!Array.isArray(d.all)) throw new Error('history: broken list')
    return d.all
  }
  const list = Array.isArray(base) ? base : []
  const byId = new Map<string, unknown>()
  for (const x of list) if (isObj(x) && typeof x.id === 'string') byId.set(x.id, x)
  const changed = new Map<string, unknown>()
  if (d.items !== undefined) {
    if (!Array.isArray(d.items)) throw new Error('history: broken items')
    for (const x of d.items) {
      if (!isObj(x) || typeof x.id !== 'string') throw new Error('history: item without id')
      changed.set(x.id, x)
    }
  }
  const order = d.order ?? list.map((x) => (isObj(x) ? x.id : undefined))
  if (!Array.isArray(order)) throw new Error('history: broken order')
  return order.map((id) => {
    const x = typeof id === 'string' ? (changed.get(id) ?? byId.get(id)) : undefined
    if (x === undefined) throw new Error('history: step names an unknown item')
    return x
  })
}

/**
 * The neighbour of `base` that `patch` describes. Items and values are shared with `base` and the
 * patch. Throws on a patch that doesn't fit (a damaged file); the result still needs validation
 * before the editor may use it (src/main/history.ts does that).
 */
export function applyPatch(base: Project, patch: StepPatch): Project {
  if (!isObj(patch)) throw new Error('history: broken step')
  const p = patch as Obj
  const out: Obj = { ...(base as unknown as Obj) }
  if (p.unset !== undefined) {
    if (!Array.isArray(p.unset)) throw new Error('history: broken step')
    for (const k of p.unset) if (typeof k === 'string' && !isList(k)) delete out[k]
  }
  if (p.set !== undefined) {
    if (!isObj(p.set)) throw new Error('history: broken step')
    for (const [k, v] of Object.entries(p.set)) if (!isList(k) && !UNSAFE.has(k)) out[k] = v
  }
  for (const k of LISTS) if (p[k] !== undefined) out[k] = applyList((base as unknown as Obj)[k], p[k])
  return out as unknown as Project
}

/** The states a chain of patches leads to from `base`, nearest first. */
export function applyChain(base: Project, patches: readonly StepPatch[]): Project[] {
  const out: Project[] = []
  let cur = base
  for (const p of patches) {
    cur = applyPatch(cur, p)
    out.push(cur)
  }
  return out
}

interface Cached {
  id: number
  patch: StepPatch
}

/**
 * The editor's side: keeps the step between two neighbouring states once (the history's states are
 * never changed in place), numbers them, and builds what a save sends: the chains from the saved
 * state and only the patches not sent yet.
 */
export class HistoryRecorder {
  readonly session = globalThis.crypto.randomUUID()
  private steps = new WeakMap<object, WeakMap<object, Cached>>()
  private sent = new Set<number>()
  private count = 0

  /** The step from `from` to `to`, computed once per pair. */
  stepOf(from: Project, to: Project): Cached {
    let row = this.steps.get(from)
    if (!row) this.steps.set(from, (row = new WeakMap()))
    let c = row.get(to)
    if (!c) row.set(to, (c = { id: ++this.count, patch: diffProject(from, to) }))
    return c
  }

  /**
   * What a save of `current` sends. `past` and `future` as the editor keeps them: oldest first, and
   * the next redo last.
   */
  upload(current: Project, past: readonly Project[], future: readonly Project[], flush = false): HistoryUpload {
    const patches: Record<string, StepPatch> = {}
    const chain = (list: readonly Project[]): number[] => {
      const ids: number[] = []
      let from = current
      for (let k = list.length - 1; k >= 0 && ids.length < HISTORY_STEPS; k--) {
        const c = this.stepOf(from, list[k])
        if (!this.sent.has(c.id)) {
          patches[c.id] = c.patch
          this.sent.add(c.id)
        }
        ids.push(c.id)
        from = list[k]
      }
      return ids
    }
    const up: HistoryUpload = { session: this.session, undo: chain(past), redo: chain(future), patches }
    if (flush) up.flush = true
    return up
  }

  /** The main process lost track (it asked for everything again): the next upload sends every patch. */
  resend(): void {
    this.sent.clear()
  }
}
