// Project files: format versions and migrations, validation of broken entries, rescuing cut-off files,
// and the project store / import built on it (damaged list, repair, backups).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProjectReportEvent, RepairReport } from '@shared/diagnostics'
import { classifyError } from '@shared/friendlyError'
import { DEFAULT_SETTINGS, type MediaItem, type Project } from '@shared/types'
import { importProjectFile } from '../src/main/projectFile'
import { createProjectStore } from '../src/main/projects'
import { migrateProject, PROJECT_VERSION, ProjectFormatError, readProjectText, salvageJson, validateProject } from '../src/main/projectSchema'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-schema-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

function media(id: string, kind: 'photo' | 'video' = 'photo'): MediaItem {
  return { id, path: `C:\\Fotos\\${id}.${kind === 'photo' ? 'jpg' : 'mp4'}`, name: `${id}.jpg`, kind, format: 'JPEG', width: 4000, height: 3000, captureTime: 1000, status: 'ready', thumb: `C:\\cache\\${id}\\thumb.jpg`, display: `C:\\cache\\${id}\\display.jpg` }
}

function sample(id = 'trip'): Project {
  return {
    version: 1,
    id,
    name: 'Klassenfahrt',
    createdAt: 1,
    updatedAt: 2,
    entries: [
      { id: 't0', type: 'text', title: 'Tag 1', auto: 'day' },
      { id: 'e1', type: 'photo', mediaId: 'p1', privacy: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], texts: [{ id: 'x1', text: 'Hallo', x: 0.5, y: 0.5, size: 0.08, font: 'theme', color: '#fff', bold: true, box: 'shadow', rotation: 0 }] },
      { id: 'e2', type: 'video', mediaId: 'v1', trimIn: 1, trimOut: 4 },
      { id: 'e3', type: 'photo', mediaId: 'p2', crop: { x: 0.5, y: 0.4, zoom: 1.2 } }
    ],
    media: [media('p1'), media('v1', 'video'), media('p2')],
    music: [{ id: 's1', path: 'C:\\Musik\\song.mp3', title: 'Song', duration: 180, status: 'ready', beats: [0.5, 1, 1.5] }],
    settings: structuredClone(DEFAULT_SETTINGS),
    people: [{ id: 'per1', desc: [[0.1, 0.2, 0.3]] }]
  }
}

const codes = (r: RepairReport): Record<string, number> => Object.fromEntries(r.changes.map((c) => [c.code, c.count]))

describe('project format versions', () => {
  it('reads the current format unchanged', () => {
    const p = sample()
    const { project, report } = readProjectText(JSON.stringify(p, null, 1))
    expect(report.changes).toEqual([])
    expect(project).toEqual(p)
  })

  it('refuses files of a newer app politely', () => {
    const text = JSON.stringify({ ...sample(), version: PROJECT_VERSION + 1 })
    let err: unknown
    try {
      readProjectText(text)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProjectFormatError)
    expect((err as ProjectFormatError).code).toBe('too-new')
    expect((err as ProjectFormatError).version).toBe(PROJECT_VERSION + 1)
    // the marker survives IPC (only the message does) and maps to the friendly text
    expect(classifyError(new Error(`Error invoking remote method 'project:load': Error: ${(err as Error).message}`), 'project')).toBe('projectTooNew')
  })

  it('runs older files through the migration chain, step by step', () => {
    // a future format 3: v1 → v2 renames `name` to `title`, v2 → v3 adds `tags`
    const migrations = {
      1: (d: Record<string, unknown>) => ({ ...d, title: d.name }),
      2: (d: Record<string, unknown>) => ({ ...d, tags: [] })
    }
    const out = migrateProject({ version: 1, name: 'Alt' }, { current: 3, migrations })
    expect(out).toEqual({ data: { version: 3, name: 'Alt', title: 'Alt', tags: [] }, fromVersion: 1 })
    expect(migrateProject({ version: 2, name: 'x', title: 'x' }, { current: 3, migrations }).fromVersion).toBe(2)
    expect(migrateProject({ version: 3 }, { current: 3, migrations }).fromVersion).toBeUndefined()
    // a gap in the chain is an error, not a silent pass
    expect(() => migrateProject({ version: 1 }, { current: 3, migrations: { 1: migrations[1] } })).toThrow(/project-damaged: no way from format 2 to 3/)
    // too new for that app
    expect(() => migrateProject({ version: 4 }, { current: 3, migrations })).toThrow(/project-too-new/)
  })

  it('takes a file without version as the oldest format', () => {
    const { version: _v, ...old } = sample()
    const { project, report } = readProjectText(JSON.stringify(old))
    expect(project.version).toBe(PROJECT_VERSION)
    expect(report.changes).toEqual([])
  })
})

describe('project validation', () => {
  it('drops unknown and broken entries and repairs the rest, with a report', () => {
    const p = sample() as unknown as Record<string, unknown>
    const entries = p.entries as Record<string, unknown>[]
    entries.push(
      { id: 'n1', type: 'map', where: 'Berlin' }, // from a newer app
      { id: 'n2', type: 'photo', mediaId: 'gone' }, // its photo is not in the media list
      'garbage' as never,
      { type: 'photo', mediaId: 'p1' }, // no id
      { id: 'e1', type: 'photo', mediaId: 'p2', duration: 'long', texts: [{ id: 'bad' }], privacy: [{ x: 1 }, { x: 0, y: 0, w: 0.1, h: 0.1 }] }
    )
    ;(p.media as unknown[]).push({ id: 'broken' }, media('p1'))
    const { project, report } = validateProject(p, { newId: () => 'new-id' })
    expect(codes(report)).toEqual({ entriesDropped: 2, entriesMissingMedia: 1, entriesRepaired: 2, mediaDropped: 2 })
    expect(project.entries.map((e) => e.id)).toEqual(['t0', 'e1', 'e2', 'e3', 'new-id', 'new-id'])
    const fixed = project.entries[5] as unknown as Record<string, unknown>
    expect(fixed.duration).toBeUndefined()
    expect(fixed.texts).toBeUndefined()
    expect(fixed.privacy).toEqual([{ x: 0, y: 0, w: 0.1, h: 0.1 }])
    expect(project.media.map((m) => m.id)).toEqual(['p1', 'v1', 'p2'])
  })

  it('rebuilds media items with broken sizes instead of dropping them', () => {
    const p = sample()
    ;(p.media[0] as unknown as Record<string, unknown>).width = 'wide'
    ;(p.media[1] as unknown as Record<string, unknown>).kind = undefined
    const { project, report } = validateProject(p)
    expect(codes(report)).toEqual({ mediaRepaired: 2 })
    expect(project.media[0]).toMatchObject({ id: 'p1', status: 'pending', width: 1, height: 3000 })
    expect(project.media[0].thumb).toBeUndefined()
    expect(project.media[1].kind).toBe('video')
  })

  it('resets broken settings, but leaves fields an older file lacks', () => {
    const p = sample()
    const s = p.settings as unknown as Record<string, unknown>
    s.theme = 'hologram'
    s.audio = { ...DEFAULT_SETTINGS.audio, musicVolume: 'loud', normalize: undefined }
    delete s.showTitle
    s.transition = { type: 'dissolve', speed: 0.5 }
    const { project, report } = validateProject(p)
    expect(codes(report)).toEqual({ settings: 3 })
    expect(project.settings.theme).toBe('kenburns')
    expect(project.settings.audio.musicVolume).toBe(DEFAULT_SETTINGS.audio.musicVolume)
    // "missing" means off in an older file: not filled in with today's default
    expect(project.settings.audio.normalize).toBeUndefined()
    expect(project.settings.showTitle).toBeUndefined()
    expect(project.settings.transition.direction).toBe('left')
  })

  it('repairs a text style field by field instead of dropping it', () => {
    const p = sample()
    ;(p.settings as unknown as Record<string, unknown>).text = { font: 'hand', scale: 1.4, color: 7, position: 'center' }
    const { project, report } = validateProject(p)
    expect(codes(report)).toEqual({ settings: 2 })
    expect(project.settings.text).toEqual({ font: 'hand', scale: 1.4, color: '', position: 'center', uppercase: 'theme' })
  })

  it('keeps fields it does not know (a newer app saved them)', () => {
    const p = { ...sample(), chapters: [{ t: 1 }], settings: { ...DEFAULT_SETTINGS, watermark: 'x' } }
    const { project, report } = validateProject(p)
    expect(report.changes).toEqual([])
    expect((project as unknown as Record<string, unknown>).chapters).toEqual([{ t: 1 }])
    expect((project.settings as unknown as Record<string, unknown>).watermark).toBe('x')
  })

  it('fills in a missing media list and refuses what is no project at all', () => {
    const { media: _m, ...rest } = sample()
    const { project, report } = validateProject(rest, {})
    expect(codes(report)).toEqual({ listsMissing: 1, entriesMissingMedia: 3 })
    expect(project.entries.map((e) => e.type)).toEqual(['text'])
    expect(project.media).toEqual([])
    expect(() => validateProject([1, 2, 3])).toThrow(/project-damaged/)
    expect(() => validateProject({ hello: 'world' })).toThrow(/not a Diashow Studio project/)
    expect(() => readProjectText('"just a string"')).toThrow(/project-damaged/)
  })
})

describe('rescuing cut-off files', () => {
  const text = JSON.stringify(sample(), null, 1)

  it('refuses a cut-off file unless asked to rescue it', () => {
    const cut = text.slice(0, Math.floor(text.length * 0.6))
    expect(() => readProjectText(cut)).toThrow(/project-damaged/)
    const { project, report } = readProjectText(cut, { salvage: true })
    expect(codes(report).truncated).toBe(1)
    expect(project.name).toBe('Klassenfahrt')
    expect(project.entries.length).toBeGreaterThan(0)
  })

  it('reads every cut-off point of a project without throwing', () => {
    // from the end of the "entries" key on, every prefix gives a project the editor can open
    const from = text.indexOf('"entries"')
    for (let n = from; n < text.length; n += 3) {
      const { project } = readProjectText(text.slice(0, n), { salvage: true, fallbackId: 'trip' })
      expect(Array.isArray(project.entries)).toBe(true)
      for (const e of project.entries) if (e.type !== 'text') expect(project.media.some((m) => m.id === e.mediaId)).toBe(true)
    }
  })

  it('handles zero bytes after a power loss, a BOM, and garbage in the middle', () => {
    const zeros = text + '\u0000'.repeat(4096)
    expect(readProjectText(zeros).report.changes).toEqual([])
    expect(readProjectText('\uFEFF' + text).project.id).toBe('trip')
    const broken = text.slice(0, 900) + '\u0000\u0000##' + text.slice(904)
    const rescued = readProjectText(broken, { salvage: true })
    expect(codes(rescued.report).truncated).toBe(1)
    expect(salvageJson('nothing here')).toBeUndefined()
    expect(salvageJson('{"a":[1,2,{"b":"c')?.value).toEqual({ a: [1, 2, {}] })
    // a number right at the end may be cut itself: not trusted
    expect(salvageJson('{"a":1,"b":12')?.value).toEqual({ a: 1 })
  })
})

describe('project store with damaged files', () => {
  const dir = join(tmp, 'store')
  const reports: ProjectReportEvent[] = []
  let clock = Date.UTC(2026, 5, 1, 10)
  const store = createProjectStore(dir, { now: () => clock, onReport: (e) => reports.push(e) })

  it('opens a project with broken entries, reports it and keeps the old file as a backup', async () => {
    const p = sample('broken') as unknown as Record<string, unknown>
    ;(p.entries as unknown[]).push({ id: 'x', type: 'photo', mediaId: 'nowhere' })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.dshow'), JSON.stringify(p))
    const loaded = await store.load('broken')
    expect(loaded.entries).toHaveLength(4)
    expect(reports).toEqual([{ projectId: 'broken', source: 'open', report: { changes: [{ code: 'entriesMissingMedia', count: 1 }] } }])
    const backups = await store.listBackups('broken')
    expect(backups).toHaveLength(1)
    expect(backups[0].slideCount).toBe(5)
  })

  it('lists cut-off and too-new files instead of hiding them, and rescues them', async () => {
    reports.length = 0
    const good = sample('cut')
    // backups are named by the file's save time: give each save its own
    const saved = async (p: Project): Promise<void> => {
      await store.save(p)
      utimesSync(join(dir, 'cut.dshow'), clock / 1000, clock / 1000)
      clock += 20 * 60_000
    }
    await saved(good)
    // a backup with 2 slides, then the current file is cut off while saving
    await saved({ ...good, entries: good.entries.slice(0, 2) })
    await saved(good)
    const full = readFileSync(join(dir, 'cut.dshow'), 'utf8')
    writeFileSync(join(dir, 'cut.dshow'), full.slice(0, Math.floor(full.length * 0.45)))
    writeFileSync(join(dir, 'future.dshow'), JSON.stringify({ ...sample('future'), version: PROJECT_VERSION + 5 }))

    expect((await store.list()).map((s) => s.id).sort()).toEqual(['broken'])
    const damaged = await store.damaged()
    expect(damaged.map((d) => [d.id, d.reason, d.name ?? null, d.version ?? null])).toEqual(
      expect.arrayContaining([
        ['cut', 'damaged', 'Klassenfahrt', null],
        ['future', 'too-new', null, PROJECT_VERSION + 5]
      ])
    )
    expect(damaged.find((d) => d.id === 'cut')!.backups).toBeGreaterThan(0)
    await expect(store.load('cut')).rejects.toThrow(/project-damaged/)
    await expect(store.load('future')).rejects.toThrow(/project-too-new/)

    const plan = await store.inspectRepair('cut')
    expect(plan.salvage).not.toBeNull()
    expect(plan.salvage!.report.changes[0]).toEqual({ code: 'truncated', count: 1 })
    expect(plan.backups.length).toBeGreaterThan(0)

    // go back to the backup with 2 slides
    const two = plan.backups.find((b) => b.slideCount === 2)!
    const restored = await store.repair('cut', { kind: 'backup', file: two.file })
    expect(restored.entries).toHaveLength(2)
    expect((await store.load('cut')).entries).toHaveLength(2)
    // the damaged file is kept next to the backups, not among them
    const kept = readdirSync(join(dir, '.backups', 'cut'))
    expect(kept.some((n) => n.endsWith('.damaged'))).toBe(true)
    expect((await store.listBackups('cut')).every((b) => b.file.endsWith('.dshow'))).toBe(true)
    expect(reports.at(-1)).toMatchObject({ projectId: 'cut', source: 'repair' })
    await expect(store.repair('cut', { kind: 'backup', file: join(tmp, 'elsewhere', '20260101-120000.dshow') })).rejects.toThrow(/not a backup/)
  })

  it('rescues what is readable from a file without backups', async () => {
    const p = sample('lonely')
    writeFileSync(join(dir, 'lonely.dshow'), JSON.stringify(p, null, 1).slice(0, 700))
    // its only backup is damaged too: listed, but marked
    mkdirSync(join(dir, '.backups', 'lonely'), { recursive: true })
    writeFileSync(join(dir, '.backups', 'lonely', '20260101-100000.dshow'), '{"version":1,"entr')
    const plan = await store.inspectRepair('lonely')
    expect(plan.backups.map((b) => b.damaged)).toEqual([true])
    await expect(store.repair('lonely', { kind: 'backup', file: plan.backups[0].file })).rejects.toThrow(/project-damaged/)
    const rescued = await store.repair('lonely', { kind: 'salvage' })
    expect(rescued.name).toBe('Klassenfahrt')
    expect((await store.damaged()).some((d) => d.id === 'lonely')).toBe(false)
  })
})

describe('importing project files', () => {
  const dir = join(tmp, 'import-store')
  const store = createProjectStore(dir)

  it('refuses newer and non-project files, validates and reports older ones', async () => {
    const elsewhere = join(tmp, 'usb')
    mkdirSync(elsewhere, { recursive: true })
    const future = join(elsewhere, 'future.dshow')
    writeFileSync(future, JSON.stringify({ ...sample('f1'), version: PROJECT_VERSION + 1 }))
    await expect(importProjectFile(future, store)).rejects.toThrow(/project-too-new/)
    const txt = join(elsewhere, 'notes.txt')
    writeFileSync(txt, '{}')
    await expect(importProjectFile(txt, store)).rejects.toThrow(/\.dshow/)

    const events: ProjectReportEvent[] = []
    const odd = sample('packed') as unknown as Record<string, unknown>
    ;(odd.entries as unknown[]).push({ type: 'hologram' })
    const file = join(elsewhere, 'packed.dshow')
    writeFileSync(file, JSON.stringify(odd))
    const p = await importProjectFile(file, store, { onReport: (e) => events.push(e) })
    expect(p.entries).toHaveLength(4)
    expect(events).toEqual([{ projectId: p.id, source: 'import', report: { changes: [{ code: 'entriesDropped', count: 1 }] } }])
    expect(existsSync(join(dir, `${p.id}.dshow`))).toBe(true)
  })

  it('rescues a cut-off packed project on request', async () => {
    const file = join(tmp, 'usb', 'cut.dshow')
    writeFileSync(file, JSON.stringify(sample('cut-usb'), null, 1).slice(0, 900))
    await expect(importProjectFile(file, store)).rejects.toThrow(/project-damaged/)
    const p = await importProjectFile(file, store, { salvage: true })
    expect(p.name).toBe('Klassenfahrt')
  })
})
