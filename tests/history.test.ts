// Undo history across restarts (src/shared/history.ts, src/main/history.ts): the steps as differences
// between neighbouring states and back, on a real-looking show of 500 photos and videos with face data;
// the limits (steps and size); a history that belongs to another state of the show, a damaged file and
// broken steps are dropped and logged; every restored state is validated like a project file; the
// clean-up and deleting a show remove it; packing, the ZIP archive and the diagnostics package never
// contain it. Also measures what 50 edits of a 500-item show cost on disk.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { NOTHING } from '@shared/cleanup'
import { applyChain, applyPatch, diffProject, HISTORY_STEPS, HistoryRecorder, sameValue, type HistoryUpload, type StepPatch } from '@shared/history'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type Project } from '@shared/types'
import { writeArchive } from '../src/main/archive/archive'
import { entryDataOffset, fileInput, readCentralDirectory } from '../src/main/archive/zip64'
import { inventoryOf, runCleanup, scanProject, trashProjectData, type CleanupDeps } from '../src/main/cleanup'
import { packageFiles, type PackageSources } from '../src/main/diagnostics/package'
import { checkUpload, createHistoryStore, HISTORY_FORMAT, projectHash, type HistoryStore } from '../src/main/history'
import { packProject } from '../src/main/projectFile'
import { createProjectStore } from '../src/main/projects'
import { validateProject } from '../src/main/projectSchema'
import { createTrash } from '../src/main/trash'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-history-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

let seed = 7
/** Deterministic pseudo-random numbers in [0, 1) with full double precision, like real descriptors. */
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return (seed / 2147483648) * 0.37 + Math.sin(seed) * 1e-9
}
const hex16 = (i: number): string => (0x1000000000000000n + BigInt(i) * 7919n).toString(16).slice(-16)
const desc = (): number[] => Array.from({ length: 128 }, () => rnd() - 0.18)
const rect = () => ({ x: rnd(), y: rnd(), w: 0.1 + rnd() / 4, h: 0.1 + rnd() / 4 })

/** A class trip of `n` photos and videos as the app saves it: face data, faces in videos, people, day titles, two songs. */
function bigShow(n = 500, id = 'big'): Project {
  const media: MediaItem[] = []
  const entries: Entry[] = []
  for (let i = 0; i < n; i++) {
    const video = i % 10 === 9
    const mid = hex16(i)
    const name = video ? `VID_${1000 + i}.MOV` : `IMG_${1000 + i}.HEIC`
    const m: MediaItem = {
      id: mid,
      path: `C:\\Users\\anna\\Pictures\\Klassenfahrt Berlin\\Tag ${1 + Math.floor(i / 100)}\\${name}`,
      name,
      kind: video ? 'video' : 'photo',
      format: video ? 'MOV · HEVC 10-bit' : 'HEIC',
      device: 'iPhone 15',
      width: video ? 1920 : 4032,
      height: video ? 1080 : 3024,
      captureTime: 1_780_000_000_000 + i * 60_000,
      status: 'ready',
      thumb: `C:\\Users\\anna\\AppData\\Roaming\\Diashow Studio\\cache\\${mid}\\thumb.jpg`,
      ...(video
        ? {
            duration: 12,
            fps: 30,
            hasAudio: true,
            playback: `C:\\Users\\anna\\AppData\\Roaming\\Diashow Studio\\cache\\${mid}\\proxy.mp4`,
            proxied: true,
            videoFaces: Array.from({ length: 24 }, (_, k) => ({ t: k * 0.5, faces: [rect()], desc: [desc()] }))
          }
        : {
            display: `C:\\Users\\anna\\AppData\\Roaming\\Diashow Studio\\cache\\${mid}\\display.jpg`,
            faces: [rect(), rect()],
            faceDesc: [desc(), desc()],
            sharpness: rnd()
          }),
      hash: mid
    }
    media.push(m)
    if (i % 50 === 0) entries.push({ id: `day-${i}`, type: 'text', title: `Tag ${1 + i / 50}`, auto: 'day' })
    entries.push(video ? { id: `e${i}`, type: 'video', mediaId: mid } : { id: `e${i}`, type: 'photo', mediaId: mid, ...(i % 7 === 0 ? { caption: `Am Brandenburger Tor mit Lena ${i}` } : {}) })
  }
  return {
    version: 1,
    id,
    name: 'Klassenfahrt Berlin 7b',
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_100_000,
    entries,
    media,
    music: [
      { id: 'a000000000000001', path: 'C:\\Users\\anna\\Music\\Abschied.mp3', title: 'Abschied', duration: 180, status: 'ready', bpm: 120, beats: Array.from({ length: 360 }, (_, k) => k * 0.5) },
      { id: 'a000000000000002', path: 'C:\\Users\\anna\\Music\\Sommer.mp3', title: 'Sommer', duration: 150, status: 'ready', trimIn: 4 }
    ],
    settings: structuredClone(DEFAULT_SETTINGS),
    people: [
      { id: 'lena', name: 'Lena', desc: [desc(), desc()] },
      { id: 'tom', name: 'Tom', desc: [desc()] }
    ]
  }
}

// ---------------------------------------------------------------- the editor's history, as store.ts keeps it

/** store.ts in small: update (with the same sharing of media items), undo and redo. */
class Editor {
  past: Project[] = []
  future: Project[] = []
  constructor(public current: Project) {}
  update(fn: (p: Project) => void): void {
    const { media, ...rest } = this.current
    const next: Project = { ...structuredClone(rest), media: media.slice() }
    fn(next)
    next.updatedAt = this.current.updatedAt + 1000
    this.past.push(this.current)
    if (this.past.length > HISTORY_STEPS) this.past.shift()
    this.future = []
    this.current = next
  }
  undo(): void {
    const prev = this.past.pop()!
    this.future.push(this.current)
    this.current = withCurrentMedia(prev, this.current)
  }
  redo(): void {
    const fwd = this.future.pop()!
    this.past.push(this.current)
    this.current = withCurrentMedia(fwd, this.current)
  }
}

/** As in store.ts: undo keeps the processing state of media and songs, but the photo edit goes back. */
function withCurrentMedia(snapshot: Project, current: Project): Project {
  const media = new Map(current.media.map((m) => [m.id, m]))
  const music = new Map(current.music.map((m) => [m.id, m]))
  return {
    ...snapshot,
    media: snapshot.media.map((m) => {
      const cur = media.get(m.id)
      if (!cur) return m
      if (cur.edit === m.edit) return cur
      const { edit: _e, ...rest } = cur
      return m.edit ? { ...rest, edit: m.edit } : rest
    }),
    music: snapshot.music.map((m) => music.get(m.id) ?? m)
  }
}

/** 50 edits of every kind the editor makes: theme, captions, text boxes, crops and turns, order, deleting, durations, people. */
function fiftyEdits(ed: Editor): void {
  const themes = ['kenburns', 'origami', 'classic', 'magazine', 'scrapbook'] as const
  for (let k = 0; k < 50; k++) {
    // a slide somewhere in the show, another one each time
    const at = (p: Project): number => (k * 37) % Math.max(1, p.entries.length - 6)
    switch (k % 10) {
      case 0:
        ed.update((p) => void (p.settings.theme = themes[(k / 10) % themes.length]))
        break
      case 1:
        ed.update((p) => void (p.entries[at(p)].caption = `Neue Unterschrift ${k}`))
        break
      case 2:
        ed.update((p) => {
          const e = p.entries[at(p)]
          e.texts = [...(e.texts ?? []), { id: `t${k}`, text: `Text ${k}`, x: 0.5, y: 0.5, size: 0.08, font: 'theme', color: '#ffffff', bold: true, box: 'shadow', rotation: 0 }]
        })
        break
      case 3:
        ed.update((p) => {
          const mid = p.media[at(p) % p.media.length].id
          p.media = p.media.map((m) => (m.id === mid ? { ...m, edit: { rotate: 90, straighten: 2.5, crop: { x: 0.1, y: 0.05, w: 0.8, h: 0.9 } } } : m))
        })
        break
      case 4:
        ed.update((p) => {
          const i = at(p)
          const [moved] = p.entries.splice(i, 1)
          p.entries.splice(i + 5, 0, moved)
        })
        break
      case 5:
        ed.update((p) => {
          const i = at(p)
          const drop = new Set(p.entries.slice(i, i + 3).map((e) => e.id))
          p.entries = p.entries.filter((e) => !drop.has(e.id))
          const used = new Set(p.entries.flatMap((e) => (e.type === 'text' ? [] : [e.mediaId])))
          p.media = p.media.filter((m) => used.has(m.id))
        })
        break
      case 6:
        ed.update((p) => void (p.entries[at(p)].duration = 3 + (k % 5)))
        break
      case 7:
        ed.update((p) => void p.entries.splice(at(p), 0, { id: `title-${k}`, type: 'text', title: `Kapitel ${k}` }))
        break
      case 8:
        ed.update((p) => void (p.people = (p.people ?? []).map((x) => (x.id === 'tom' ? { ...x, name: `Tom ${k}` } : x))))
        break
      default:
        ed.update((p) => Object.assign(p.settings, { transition: { ...p.settings.transition, speed: 0.5 + k / 100 } }))
    }
  }
}

/** A project as it comes back from a file. */
const asSaved = (p: Project): Project => JSON.parse(JSON.stringify(p)) as Project

/** The states of an editor's history as undo reaches them, nearest first (as JSON, to compare). */
function undoStates(ed: Editor): string[] {
  const probe = new Editor(ed.current)
  probe.past = ed.past.slice()
  probe.future = ed.future.slice()
  const out: string[] = []
  while (probe.past.length) {
    probe.undo()
    out.push(JSON.stringify(probe.current))
  }
  return out
}

/** The same states rebuilt from restored patches, undone like the editor does. */
function restoredStates(base: Project, undo: StepPatch[], redo: StepPatch[] = []): string[] {
  const ed = new Editor(base)
  ed.past = applyChain(base, undo).reverse()
  ed.future = applyChain(base, redo).reverse()
  return undoStates(ed)
}

/** Every saved field except the processing ones, to compare restored states with what undo showed. */
const userView = (json: string): unknown => {
  const p = JSON.parse(json) as Project
  return { ...p, media: p.media.map((m) => ({ id: m.id, path: m.path, edit: m.edit, faces: m.faces?.length })) }
}

function historyStore(name: string, extra: Partial<Parameters<typeof createHistoryStore>[0]> = {}): { store: HistoryStore; dir: string; log: string[] } {
  const dir = join(tmp, name, 'userData', 'history')
  const log: string[] = []
  return { store: createHistoryStore({ dir, delayMs: 5, log: (m) => log.push(m), ...extra }), dir, log }
}

/** What the editor's save sends, and the file text that save wrote. */
function saveOf(ed: Editor, rec = new HistoryRecorder()): { text: string; upload: HistoryUpload; rec: HistoryRecorder } {
  return { text: JSON.stringify(ed.current, null, 1), upload: rec.upload(ed.current, ed.past, ed.future), rec }
}

/** Opens a saved text like projects.load and asks for its history. */
async function reopen(store: HistoryStore, id: string, text: string, repaired = false): Promise<{ project: Project; restored: Awaited<ReturnType<HistoryStore['load']>> }> {
  const { project } = validateProject(JSON.parse(text), { fallbackId: id })
  store.opened(id, text, project, repaired)
  return { project, restored: await store.load(id) }
}

// ---------------------------------------------------------------- tests

describe('steps as differences', () => {
  it('round trip on a real-looking show: every edit of 50 comes back exactly', () => {
    const ed = new Editor(asSaved(bigShow(500)))
    fiftyEdits(ed)
    const states = [...ed.past, ed.current]
    for (let k = states.length - 1; k > 0; k--) {
      const patch = diffProject(states[k], states[k - 1])
      expect(sameValue(applyPatch(states[k], patch), states[k - 1]), `step ${k}`).toBe(true)
      // through JSON, as stored
      expect(sameValue(applyPatch(states[k], JSON.parse(JSON.stringify(patch))), states[k - 1])).toBe(true)
    }
    // redo direction too, after undoing ten steps
    for (let k = 0; k < 10; k++) ed.undo()
    const rec = new HistoryRecorder()
    const up = rec.upload(ed.current, ed.past, ed.future)
    expect(up.undo).toHaveLength(40)
    expect(up.redo).toHaveLength(10)
    const redo = applyChain(ed.current, up.redo.map((n) => up.patches[n]))
    for (let k = 0; k < 10; k++) expect(sameValue(redo[k], ed.future[ed.future.length - 1 - k])).toBe(true)
  })

  it('a step only holds what changed: one caption is a few hundred bytes, background processing adds nothing', () => {
    const a = asSaved(bigShow(200))
    const b: Project = { ...a, entries: a.entries.map((e) => (e.id === 'e3' ? { ...e, caption: 'Hallo' } : e)), updatedAt: a.updatedAt + 1 }
    const patch = diffProject(b, a)
    expect(JSON.stringify(patch).length).toBeLessThan(400)
    expect(patch.entries?.items).toEqual([a.entries.find((e) => e.id === 'e3')])
    expect(patch.entries?.order).toBeUndefined()
    expect(patch.media).toBeUndefined()
    // thumbnails and faces that arrived in between: not a change for the history (undo keeps today's)
    const processed: Project = { ...b, media: b.media.map((m) => ({ ...m, status: 'ready', thumb: `${m.thumb}.new`, faces: [] })) }
    expect(diffProject(processed, a).media).toBeUndefined()
    // a photo edit is
    const edited: Project = { ...b, media: b.media.map((m, i) => (i === 3 ? { ...m, edit: { rotate: 180, straighten: 0 } } : m)) }
    expect(diffProject(a, edited).media?.items?.map((m) => m.id)).toEqual([a.media[3].id])
  })

  it('a field set to undefined counts as missing; damaged steps throw instead of guessing', () => {
    const a = asSaved(bigShow(5))
    const b = { ...a, deleteAt: undefined, entries: a.entries.map((e, i) => (i === 1 ? { ...e, duration: undefined } : e)) }
    expect(diffProject(a, b)).toEqual({})
    expect(() => applyPatch(a, { entries: { order: ['nope'] } })).toThrow()
    expect(() => applyPatch(a, { media: { items: [{} as never] } })).toThrow()
    expect(() => applyPatch(a, 'x' as never)).toThrow()
    // the prototype of the project can't be changed from a file
    const evil = applyPatch(a, JSON.parse('{"set":{"__proto__":{"polluted":1}}}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(evil)).toBe(Object.prototype)
  })

  it('the recorder sends each step once, numbered, and everything again when asked', () => {
    const ed = new Editor(asSaved(bigShow(20)))
    fiftyEdits(ed)
    const rec = new HistoryRecorder()
    const first = rec.upload(ed.current, ed.past, ed.future)
    expect(Object.keys(first.patches)).toHaveLength(50)
    ed.update((p) => void (p.name = 'Neu'))
    const second = rec.upload(ed.current, ed.past, ed.future)
    // only the new nearest step: the others are known by number
    expect(Object.keys(second.patches)).toHaveLength(1)
    expect(second.undo.slice(1)).toEqual(first.undo)
    rec.resend()
    expect(Object.keys(rec.upload(ed.current, ed.past, ed.future).patches)).toHaveLength(51)
    expect(checkUpload(second)).toEqual(second)
    expect(checkUpload({ ...second, undo: ['1'] })).toBeNull()
    expect(checkUpload({ ...second, patches: { x: {} } })).toBeNull()
    expect(checkUpload(undefined)).toBeNull()
  })
})

describe('the stored history', () => {
  it('comes back after a restart for exactly the saved state: undo step by step, redo too', async () => {
    const { store, dir, log } = historyStore('restart')
    const ed = new Editor(asSaved(bigShow(120, 'show1')))
    fiftyEdits(ed)
    for (let k = 0; k < 4; k++) ed.undo()
    const { text, upload } = saveOf(ed)
    expect(store.saved('show1', text, upload)).toBe('ok')
    await store.flush()
    const file = join(dir, 'show1.json.gz')
    const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'))
    expect(data).toMatchObject({ format: HISTORY_FORMAT, version: 1, projectId: 'show1', anchor: projectHash(text) })
    expect([data.undo.length, data.redo.length]).toEqual([46, 4])

    // "the next day": a new store (a new app session), the file read back
    const next = createHistoryStore({ dir, log: (m) => log.push(m) })
    const { project, restored } = await reopen(next, 'show1', text)
    expect(restored).not.toBeNull()
    expect([restored!.undo.length, restored!.redo.length]).toEqual([46, 4])
    const want = undoStates(ed).map(userView)
    const got = restoredStates(project, restored!.undo, restored!.redo).map(userView)
    expect(got).toEqual(want)
    // redo goes forward again to the newest state
    const red = new Editor(project)
    red.future = applyChain(project, restored!.redo).reverse()
    for (let k = 0; k < 4; k++) red.redo()
    const newest = new Editor(ed.current)
    newest.future = ed.future.slice()
    for (let k = 0; k < 4; k++) newest.redo()
    expect(userView(JSON.stringify(red.current))).toEqual(userView(JSON.stringify(newest.current)))
    expect(log.some((m) => /restored: 46 undo and 4 redo/.test(m))).toBe(true)
    // asked once per opening: a second ask without opening gets nothing
    expect(await next.load('show1')).toBeNull()
  })

  it('keeps the last 100 steps or the size limit, dropping the oldest first', async () => {
    const ed = new Editor(asSaved(bigShow(40, 'caps')))
    for (let k = 0; k < 130; k++) ed.update((p) => void (p.name = `Name ${k}`))
    expect(ed.past).toHaveLength(100)
    for (let k = 0; k < 3; k++) ed.undo()
    const { text, upload } = saveOf(ed)
    // steps: 3 redo + the 7 nearest undo steps
    const few = historyStore('caps-steps', { maxSteps: 10 })
    few.store.saved('caps', text, upload)
    await few.store.flush()
    let r = (await reopen(few.store, 'caps', text)).restored!
    expect([r.undo.length, r.redo.length]).toEqual([7, 3])
    const names = applyChain(validateProject(JSON.parse(text)).project, r.undo).map((p) => p.name)
    expect(names).toEqual(Array.from({ length: 7 }, (_, k) => `Name ${125 - k}`))
    // size: each step is about the same size; room for 5 of them
    const one = JSON.stringify(upload.patches[upload.undo[1]]).length
    const small = historyStore('caps-bytes', { maxBytes: one * 5 + 10 })
    small.store.saved('caps', text, upload)
    await small.store.flush()
    r = (await reopen(small.store, 'caps', text)).restored!
    expect(r.redo.length + r.undo.length).toBe(5)
    expect(r.redo.length).toBe(3)
    // the full history of 100 steps, as the editor sends it
    const all = historyStore('caps-all')
    expect(upload.undo.length + upload.redo.length).toBe(100)
    all.store.saved('caps', text, upload)
    await all.store.flush()
    r = (await reopen(all.store, 'caps', text)).restored!
    expect(r.undo.length + r.redo.length).toBe(100)
  })

  it('is discarded and logged when the show was changed elsewhere, repaired or the file is damaged', async () => {
    const ed = new Editor(asSaved(bigShow(30, 'other')))
    fiftyEdits(ed)
    const { text, upload } = saveOf(ed)
    const { store, dir, log } = historyStore('mismatch')
    const file = join(dir, 'other.json.gz')
    const fresh = async (): Promise<void> => {
      store.saved('other', text, upload)
      await store.flush()
      expect(existsSync(file)).toBe(true)
    }

    // the .dshow was changed on another PC (or restored, or saved by an older version)
    await fresh()
    const changed = text.replace('"Klassenfahrt Berlin 7b"', '"Klassenfahrt Berlin 7c"')
    expect((await reopen(store, 'other', changed)).restored).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(log.at(-1)).toMatch(/discarded: it belongs to another state/)

    // parts were dropped when it was opened
    await fresh()
    expect((await reopen(store, 'other', text, true)).restored).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(log.at(-1)).toMatch(/discarded: parts of the show were damaged/)

    // damaged files: garbage, cut off, not ours; never an error
    for (const [what, bytes] of [
      ['garbage', Buffer.from('not a history at all')],
      ['cut off', gzipSync(Buffer.from('{"format":"diashow-history","version":1,"projectId":"other","anch')).subarray(0, 30)],
      ['not ours', gzipSync(Buffer.from(JSON.stringify({ format: 'something', version: 1, projectId: 'other' })))],
      ['other show', gzipSync(Buffer.from(JSON.stringify({ format: HISTORY_FORMAT, version: 1, projectId: 'someone', anchor: projectHash(text), undo: [], redo: [] })))],
      ['newer version', gzipSync(Buffer.from(JSON.stringify({ format: HISTORY_FORMAT, version: 2, projectId: 'other', anchor: projectHash(text), undo: [], redo: [] })))]
    ] as const) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, bytes)
      expect((await reopen(store, 'other', text)).restored, what).toBeNull()
      expect(existsSync(file), what).toBe(false)
      expect(log.at(-1), what).toMatch(/discarded/)
    }
    // no file: nothing, and nothing to log
    const before = log.length
    expect((await reopen(store, 'other', text)).restored).toBeNull()
    expect(log.length).toBe(before)
    // the log names the show by its id only
    expect(log.join('\n')).not.toMatch(/Lena|Klassenfahrt|anna|Brandenburger/)
  })

  it('a file that unpacks to far more than a history can hold is not unpacked, and discarded', async () => {
    const base = asSaved(bigShow(5, 'bomb'))
    const text = JSON.stringify(base, null, 1)
    const { store, dir, log } = historyStore('bomb', { maxBytes: 1000 })
    mkdirSync(dir, { recursive: true })
    // a megabyte of spaces packs into a few hundred bytes
    writeFileSync(join(dir, 'bomb.json.gz'), gzipSync(Buffer.alloc(1_000_000, 32)))
    expect((await reopen(store, 'bomb', text)).restored).toBeNull()
    expect(existsSync(join(dir, 'bomb.json.gz'))).toBe(false)
    expect(log.at(-1)).toMatch(/discarded: the file is damaged/)
  })

  it('a broken step ends the chain there; the steps before it stay', async () => {
    const base = asSaved(bigShow(10, 'broken'))
    const text = JSON.stringify(base, null, 1)
    const good: StepPatch = { set: { name: 'Eins' } }
    const alsoGood: StepPatch = { set: { name: 'Zwei' } }
    const unknownItem: StepPatch = { entries: { order: ['e1', 'gibt-es-nicht'] } }
    const upload: HistoryUpload = { session: 's', undo: [1, 2, 3, 4], redo: [], patches: { 1: good, 2: alsoGood, 3: unknownItem, 4: good } }
    const { store, log } = historyStore('broken')
    expect(store.saved('broken', text, upload)).toBe('ok')
    await store.flush()
    const r = (await reopen(store, 'broken', text)).restored!
    expect(r.undo).toHaveLength(2)
    expect(applyChain(base, r.undo).map((p) => p.name)).toEqual(['Eins', 'Zwei'])
    expect(log.some((m) => /undo step 3 of 4 unusable/.test(m))).toBe(true)
  })

  it('every restored state is validated like a project file', async () => {
    const base = asSaved(bigShow(10, 'valid'))
    const text = JSON.stringify(base, null, 1)
    const m3 = base.media[3]
    const steps: StepPatch[] = [
      // a theme this version doesn't know, an entry whose photo is gone
      { set: { settings: { ...base.settings, theme: 'gibt-es-nicht' } }, entries: { order: [...base.entries.map((e) => e.id), 'ghost'], items: [{ id: 'ghost', type: 'photo', mediaId: 'no-such-media' } as never] } },
      // a photo edit with a turn of 37° and an entry without type
      { media: { items: [{ ...m3, edit: { rotate: 37, straighten: 99 } } as never] }, entries: { order: [...base.entries.map((e) => e.id), 'typeless'], items: [{ id: 'typeless' } as never] } },
      // the id of the show and the format version can't be changed by a step
      { set: { id: 'someone-else', version: 99 } }
    ]
    const upload: HistoryUpload = { session: 's', undo: [1, 2, 3], redo: [], patches: { 1: steps[0], 2: steps[1], 3: steps[2] } }
    const { store } = historyStore('validate')
    store.saved('valid', text, upload)
    await store.flush()
    const { project, restored } = await reopen(store, 'valid', text)
    const states = applyChain(project, restored!.undo)
    expect(states).toHaveLength(3)
    for (const s of states) {
      // what the editor gets is what validation lets through, unchanged by validating again
      const again = validateProject(JSON.parse(JSON.stringify(s)), { fallbackId: 'valid' })
      expect(again.report.changes, JSON.stringify(again.report)).toEqual([])
      expect(s.id).toBe('valid')
      expect(s.version).toBe(1)
      expect(s.entries.some((e) => e.id === 'ghost' || e.id === 'typeless')).toBe(false)
    }
    expect(states[0].settings.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(states[1].media.find((m) => m.id === m3.id)!.edit).toEqual({ rotate: 0, straighten: 45 })
  })

  it('without its history a save leaves the stored one alone; missing steps are asked for again; clearing cancels a pending write', async () => {
    const ed = new Editor(asSaved(bigShow(20, 'flow')))
    fiftyEdits(ed)
    const { text, upload, rec } = saveOf(ed)
    const { store, dir } = historyStore('flow')
    const file = join(dir, 'flow.json.gz')
    store.saved('flow', text, upload)
    await store.flush()
    const stored = readFileSync(file)
    // a save without history (still loading it, or another show's): the file stays as it was
    expect(store.saved('flow', `${text} `, undefined)).toBe('ignored')
    await store.flush()
    expect(readFileSync(file).equals(stored)).toBe(true)
    // a new window (another session) refers to steps the main process doesn't know
    ed.update((p) => void (p.name = 'x'))
    const again = new HistoryRecorder()
    const partial = again.upload(ed.current, ed.past, ed.future)
    expect(store.saved('flow', JSON.stringify(ed.current, null, 1), { ...partial, patches: {} })).toBe('resend')
    expect(store.saved('flow', JSON.stringify(ed.current, null, 1), partial)).toBe('ok')
    // an empty history removes the file
    store.saved('flow', text, { session: rec.session, undo: [], redo: [], patches: {} })
    await store.flush()
    expect(existsSync(file)).toBe(false)
    // clear() before the pause is over: nothing is written afterwards
    const slow = createHistoryStore({ dir, delayMs: 50 })
    slow.saved('flow', text, upload)
    expect(await slow.clear('flow')).toEqual({ files: 0, bytes: 0, failed: [] })
    await new Promise((r) => setTimeout(r, 120))
    expect(existsSync(file)).toBe(false)
    // clearAll: every show's file
    for (const id of ['a1', 'a2']) store.saved(id, text, upload)
    await store.flush()
    expect(readdirSync(dir).sort()).toEqual(['a1.json.gz', 'a2.json.gz'])
    const all = await store.clearAll()
    expect(all.files).toBe(2)
    expect(readdirSync(dir)).toEqual([])
  })

  it('the project store hands the history the text it wrote and read', async () => {
    const projects = createProjectStore(join(tmp, 'pstore'))
    const p = asSaved(bigShow(5, 'pstore'))
    let written = ''
    await projects.save(p, (text) => (written = text))
    expect(written).toBe(readFileSync(join(tmp, 'pstore', 'pstore.dshow'), 'utf8'))
    let read: [string, boolean] | null = null
    await projects.load('pstore', (text, repaired) => (read = [text, repaired]))
    expect(read).toEqual([written, false])
    // a file that loses data when read counts as repaired
    writeFileSync(join(tmp, 'pstore', 'pstore.dshow'), written.replace(/"mediaId": "[0-9a-f]+"/, '"mediaId": "gone"'))
    await projects.load('pstore', (text, repaired) => (read = [text, repaired]))
    expect(read![1]).toBe(true)
  })

  it('moves along when the deletion reminder is set on the home screen, and only then', async () => {
    const projects = createProjectStore(join(tmp, 'remind-store'))
    const ed = new Editor(asSaved(bigShow(30, 'remind')))
    fiftyEdits(ed)
    for (let k = 0; k < 2; k++) ed.undo()
    const { upload } = saveOf(ed)
    let text = ''
    await projects.save(ed.current, (t) => (text = t))
    const { store, dir, log } = historyStore('remind')
    expect(store.saved('remind', text, upload)).toBe('ok')
    await store.flush()
    // what cleanup:delete-at does (cleanupMain.ts): read, set the date, save, move the history along
    const setReminder = async (at: number): Promise<boolean> => {
      let before = ''
      let after = ''
      const p = await projects.peek('remind', (t) => (before = t))
      p.deleteAt = at
      await projects.save(p, (t) => (after = t))
      return store.rebase('remind', before, after)
    }
    const at = Date.UTC(2027, 1, 1)
    expect(await setReminder(at)).toBe(true)
    expect(log.at(-1)).toMatch(/moved along/)
    const after = readFileSync(join(tmp, 'remind-store', 'remind.dshow'), 'utf8')
    const { project, restored } = await reopen(store, 'remind', after)
    expect([restored!.undo.length, restored!.redo.length]).toEqual([48, 2])
    // every earlier state comes back, with the reminder as it is now
    const want = undoStates(ed).map((s) => userView(JSON.stringify({ ...JSON.parse(s), deleteAt: at })))
    expect(restoredStates(project, restored!.undo, restored!.redo).map(userView)).toEqual(want)

    // a history that already didn't fit the file is not made to fit by a new reminder
    writeFileSync(join(tmp, 'remind-store', 'remind.dshow'), after.replace('"Klassenfahrt Berlin 7b"', '"Klassenfahrt Berlin 7c"'))
    expect(await setReminder(at + 86_400_000)).toBe(false)
    const changed = readFileSync(join(tmp, 'remind-store', 'remind.dshow'), 'utf8')
    expect((await reopen(store, 'remind', changed)).restored).toBeNull()
    // no history: nothing to move
    expect(existsSync(join(dir, 'remind.json.gz'))).toBe(false)
    expect(await setReminder(at)).toBe(false)
  })
})

describe('size and speed', () => {
  it('a 500-item show with 50 edits', async () => {
    const show = asSaved(bigShow(500, 'measure'))
    const projectBytes = JSON.stringify(show, null, 1).length
    const ed = new Editor(show)
    fiftyEdits(ed)
    const rec = new HistoryRecorder()
    let t = performance.now()
    const upload = rec.upload(ed.current, ed.past, ed.future)
    const encodeMs = performance.now() - t
    // a save after one more edit: only the new step is computed and sent
    ed.update((p) => void (p.name = 'noch eins'))
    t = performance.now()
    const next = rec.upload(ed.current, ed.past, ed.future)
    const nextMs = performance.now() - t
    expect(Object.keys(next.patches)).toHaveLength(1)
    const text = JSON.stringify(ed.current, null, 1)
    const { store, dir } = historyStore('measure')
    store.saved('measure', JSON.stringify(show, null, 1), upload)
    store.saved('measure', text, next)
    await store.flush()
    const gz = statSync(join(dir, 'measure.json.gz')).size
    const json = gunzipSync(readFileSync(join(dir, 'measure.json.gz'))).length
    t = performance.now()
    const { project, restored } = await reopen(store, 'measure', text)
    const loadMs = performance.now() - t
    expect(restored!.undo).toHaveLength(51)
    console.log(
      `500 items, 50 edits (+1): project file ${(projectBytes / 1e6).toFixed(2)} MB; history ${(json / 1e3).toFixed(0)} KB JSON, ${(gz / 1e3).toFixed(0)} KB on disk (gzip); ` +
        `whole snapshots would be ${((51 * projectBytes) / 1e6).toFixed(0)} MB. Encoding all steps ${encodeMs.toFixed(0)} ms, one new step ${nextMs.toFixed(1)} ms, ` +
        `restoring with validation ${loadMs.toFixed(0)} ms`
    )
    expect(gz).toBeLessThan(2e6)
    expect(nextMs).toBeLessThan(200)
    const want = undoStates(ed).map(userView)
    expect(restoredStates(project, restored!.undo).map(userView)).toEqual(want)
  })
})

// ---------------------------------------------------------------- privacy: clean-up, deleting, pack, archive, diagnostics

/** A show on disk as the app keeps it: the .dshow, its originals, and a stored history with an old caption only it holds. */
async function showWithHistory(name: string) {
  const root = join(tmp, name)
  const docs = join(root, 'Diashow Studio')
  const history = createHistoryStore({ dir: join(root, 'userData', 'history'), delayMs: 5 })
  const projects = createProjectStore(docs)
  const photo = join(root, 'Bilder', 'IMG_0001.JPG')
  mkdirSync(dirname(photo), { recursive: true })
  writeFileSync(photo, 'jpeg bytes')
  const st = statSync(photo)
  const base: Project = {
    version: 1,
    id: name,
    name: 'Klassenfahrt',
    createdAt: 1,
    updatedAt: 2,
    entries: [{ id: 'e1', type: 'photo', mediaId: 'f000000000000001', caption: 'GEHEIM: Lena weint' }],
    media: [{ id: 'f000000000000001', path: photo, name: 'IMG_0001.JPG', kind: 'photo', format: 'JPEG', width: 10, height: 10, captureTime: st.mtimeMs, status: 'ready', faces: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], faceDesc: [desc()] }],
    music: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    people: [{ id: 'p', name: 'Lena', desc: [desc()] }]
  }
  const ed = new Editor(base)
  ed.update((p) => void (p.entries[0] = { ...p.entries[0], caption: 'Am Strand' }))
  await projects.save(ed.current, (text) => history.saved(name, text, new HistoryRecorder().upload(ed.current, ed.past, ed.future)))
  await history.flush()
  const file = history.fileOf(name)
  expect(existsSync(file)).toBe(true)
  const deps: CleanupDeps = {
    projects,
    cacheDir: join(root, 'cache'),
    uploadsRoot: join(docs, 'Uploads'),
    exportsDir: join(root, 'userData', 'exports'),
    media: { forgetFaces: async () => {}, releaseCache: (ids) => ids },
    exports: { jobsOf: async () => [], forget: async () => {} },
    history
  }
  return { root, docs, history, projects, file, deps, project: ed.current }
}

/** Every file below a folder with its text. */
function filesBelow(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...filesBelow(p))
    else out.push({ path: p, text: readFileSync(p, 'latin1') })
  }
  return out
}

describe('privacy', () => {
  it('the clean-up lists the history with its size and removes it when chosen, with face data, uploads, or a rewritten show', async () => {
    const s = await showWithHistory('clean-chosen')
    const inv = inventoryOf(await scanProject(s.deps, 'clean-chosen'))
    expect(inv.history).toEqual({ files: 1, bytes: statSync(s.file).size })
    // other things only: the history stays
    let r = await runCleanup(s.deps, 'clean-chosen', { ...NOTHING, exports: true })
    expect(r.removed.history).toEqual({ files: 0, bytes: 0 })
    expect(existsSync(s.file)).toBe(true)
    // chosen
    r = await runCleanup(s.deps, 'clean-chosen', { ...NOTHING, history: true })
    expect(r.removed.history).toEqual(inv.history)
    expect(r.freed).toBe(inv.history.bytes)
    expect(existsSync(s.file)).toBe(false)

    // with the face data, even when not chosen
    const f = await showWithHistory('clean-faces')
    r = await runCleanup(f.deps, 'clean-faces', { ...NOTHING, faces: true })
    expect(r.removed.history.files).toBe(1)
    expect(existsSync(f.file)).toBe(false)
  })

  it('deleting a show takes its history into the trash, restoring brings it back, deleting it for good deletes it', async () => {
    const s = await showWithHistory('delete')
    const trash = createTrash({ projectsDir: s.docs, dataDir: join(s.root, 'userData', 'trash'), historyDir: s.history.dir, exportsDir: join(s.root, 'userData', 'exports') })
    const deps = { ...s.deps, trash }
    expect('entry' in (await trashProjectData(deps, 'delete'))).toBe(true)
    expect(existsSync(s.file)).toBe(false)
    expect(existsSync(join(s.docs, 'delete.dshow'))).toBe(false)
    // back: the same file, so the history still fits it
    await trash.restore('delete')
    let read = ''
    const p = await s.projects.load('delete', (text) => (read = text))
    s.history.opened('delete', read, p, false)
    expect((await s.history.load('delete'))?.undo).toHaveLength(1)
    // deleted again, and for good
    expect('entry' in (await trashProjectData(deps, 'delete'))).toBe(true)
    await trash.purge('delete')
    expect(existsSync(s.file)).toBe(false)
    expect(readdirSync(join(s.root, 'userData', 'trash'))).toEqual([])
    expect(readdirSync(trash.dir)).toEqual([])
  })

  it('Pack project, the ZIP archive and the diagnostics package never contain it', async () => {
    const s = await showWithHistory('outside')
    const secret = 'GEHEIM: Lena weint'
    expect(gunzipSync(readFileSync(s.file)).toString('utf8')).toContain(secret)
    // pack
    const packed = await packProject(s.project, join(s.root, 'USB'))
    const packFiles = filesBelow(dirname(packed))
    expect(packFiles.some((f) => /history|\.json\.gz$/i.test(relative(dirname(packed), f.path)))).toBe(false)
    expect(packFiles.some((f) => f.text.includes(secret))).toBe(false)
    // archive
    const zip = join(s.root, 'Archiv', 'Klassenfahrt.zip')
    mkdirSync(dirname(zip), { recursive: true })
    await writeArchive(
      { projects: s.projects, themeMusic: async () => [], exports: { jobsOf: async () => [] }, documentsDir: s.root, appVersion: '1.3.0', freeSpace: async () => 1e12 },
      'outside',
      { leftOut: true, withoutFaceData: false, videos: [], lang: 'de' },
      [],
      zip
    )
    const fh = await open(zip, 'r')
    try {
      const input = fileInput(fh, (await fh.stat()).size)
      const dir = await readCentralDirectory(input)
      expect(dir.entries.map((e) => e.name).some((n) => /history|\.json\.gz$/i.test(n))).toBe(false)
      for (const e of dir.entries) {
        const raw = Buffer.alloc(e.compressedSize)
        await fh.read(raw, 0, raw.length, await entryDataOffset(input, e))
        expect((e.method === 8 ? inflateRawSync(raw) : raw).toString('utf8').includes(secret), e.name).toBe(false)
      }
    } finally {
      await fh.close()
    }
    // diagnostics: the open show is summarised; logs of the history name only the show's id
    const log: string[] = []
    const h = createHistoryStore({ dir: dirname(s.file), log: (m) => log.push(m) })
    const text = readFileSync(join(s.docs, 'outside.dshow'), 'utf8')
    h.opened('outside', `${text} `, s.project, false)
    await h.load('outside')
    const sources: PackageSources = {
      now: Date.now(),
      home: 'C:\\Users\\anna',
      versions: { app: '1.3.0' },
      system: { error: 'skipped' },
      settings: {},
      input: { projectId: 'outside' },
      project: s.project,
      projects: [{ slides: 1 }],
      damaged: [],
      logs: [{ name: 'diashow.log', text: log.join('\n') }]
    }
    const files = packageFiles(sources)
    expect(files.some((f) => /history/i.test(f.name))).toBe(false)
    expect(files.some((f) => f.text.includes(secret) || f.text.includes('Am Strand'))).toBe(false)
  })
})
