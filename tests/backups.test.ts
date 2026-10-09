// Project backups (project:backups / project:restore-backup), project references for the cache
// cleanup, app settings and the keep-awake reference count.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Entry, type Project } from '@shared/types'
import { createAppSettingsStore, sanitizeAppSettings } from '../src/main/appSettings'
import { createKeepAwake } from '../src/main/keepAwake'
import { backupStamp, backupTime, createProjectStore } from '../src/main/projects'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-backups-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const MIN = 60_000

function project(id: string, slides: number): Project {
  const entries: Entry[] = Array.from({ length: slides }, (_, i) => ({ id: `e${i}`, type: 'text', title: `Slide ${i}` }))
  return { version: 1, id, name: `Show ${slides}`, createdAt: 1, updatedAt: slides, entries, media: [], music: [], settings: DEFAULT_SETTINGS }
}

/** A store on a fake clock; the project file's modification time follows the clock like a real save. */
function setup(name: string, keepBackups = 20) {
  const dir = join(tmp, name)
  let clock = Date.UTC(2026, 9, 9, 10, 0, 0)
  const store = createProjectStore(dir, { now: () => clock, keepBackups })
  const save = async (p: Project): Promise<void> => {
    await store.save(p)
    const t = new Date(clock)
    utimesSync(join(dir, `${p.id}.dshow`), t, t)
  }
  return { dir, store, save, advance: (ms: number) => (clock += ms), now: () => clock }
}

describe('project backups', () => {
  it('names backups by save time (local) and parses them back', () => {
    const t = new Date(2026, 0, 18, 9, 5, 7).getTime()
    expect(backupStamp(t)).toBe('20260118-090507')
    expect(backupTime('20260118-090507.dshow')).toBe(t)
    expect(backupTime('notes.dshow')).toBeNull()
  })

  it('keeps the previous version at most every 10 minutes, newest 20 (here 3) only', async () => {
    const { dir, store, save, advance } = setup('interval', 3)
    await save(project('show', 1))
    advance(MIN)
    await save(project('show', 2))
    advance(MIN)
    await save(project('show', 3))
    // quick saves of a new project: no backups yet
    expect(existsSync(join(dir, '.backups'))).toBe(false)
    expect(await store.listBackups('show')).toEqual([])

    advance(9 * MIN)
    await save(project('show', 4)) // 10 minutes after the session's first save: backs up version 3
    advance(MIN)
    await save(project('show', 5)) // too soon
    let list = await store.listBackups('show')
    expect(list.map((b) => b.slideCount)).toEqual([3])

    for (const n of [6, 7, 8]) {
      advance(10 * MIN)
      await save(project('show', n))
    }
    list = await store.listBackups('show')
    // versions 5, 6, 7 were backed up before 6, 7, 8; only the newest 3 are kept (3 and 5 → 3 dropped)
    expect(list.map((b) => b.slideCount)).toEqual([7, 6, 5])
    expect(list[0].savedAt).toBeGreaterThan(list[1].savedAt)
    expect(list[0].file).toBe(join(dir, '.backups', 'show', `${backupStamp(list[0].savedAt)}.dshow`))
    expect(readdirSync(join(dir, '.backups', 'show'))).toHaveLength(3)
    // the projects list ignores the backups folder
    expect((await store.list()).map((s) => s.id)).toEqual(['show'])
  })

  it('backs up the version a previous session left at the first save', async () => {
    const { dir, store, save, now } = setup('session')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old.dshow'), JSON.stringify(project('old', 9)))
    const yesterday = new Date(now() - 24 * 60 * MIN)
    utimesSync(join(dir, 'old.dshow'), yesterday, yesterday)
    await save(project('old', 10))
    const [backup] = await store.listBackups('old')
    expect(backup).toMatchObject({ slideCount: 9, savedAt: Math.floor(yesterday.getTime() / 1000) * 1000 })
  })

  it('restores a backup as the current version and keeps the replaced one as a backup', async () => {
    const { dir, store, save, advance } = setup('restore')
    await save(project('trip', 1))
    advance(10 * MIN)
    await save(project('trip', 2)) // backs up 1
    advance(MIN)
    await save(project('trip', 3))
    const [one] = await store.listBackups('trip')
    expect(one.slideCount).toBe(1)

    advance(MIN)
    const restored = await store.restoreBackup(one.file)
    expect(restored.id).toBe('trip')
    expect(restored.entries).toHaveLength(1)
    expect((await store.load('trip')).entries).toHaveLength(1)
    // undo: version 3 is now the newest backup
    const list = await store.listBackups('trip')
    expect(list.map((b) => b.slideCount)).toEqual([3, 1])
    const undone = await store.restoreBackup(list[0].file)
    expect(undone.entries).toHaveLength(3)
    expect(JSON.parse(readFileSync(join(dir, 'trip.dshow'), 'utf8')).entries).toHaveLength(3)

    await expect(store.restoreBackup(join(dir, 'trip.dshow'))).rejects.toThrow()
    await expect(store.restoreBackup(join(dir, '.backups', 'trip', 'evil.dshow'))).rejects.toThrow()
    await expect(store.restoreBackup(join(tmp, '.backups', 'trip', '20260101-000000.dshow'))).rejects.toThrow()

    await store.delete('trip')
    expect(existsSync(join(dir, '.backups', 'trip'))).toBe(false)
  })

  it('collects the media, music and original paths saved projects use', async () => {
    const { store, save } = setup('refs')
    const p = project('a', 0)
    p.entries = [{ id: 'e1', type: 'photo', mediaId: 'm1' }, { id: 'e2', type: 'video', mediaId: 'm2' }]
    p.media = [
      { id: 'm1', path: 'C:\\f\\1.jpg', name: '1.jpg', kind: 'photo', format: 'JPEG', width: 1, height: 1, captureTime: 0, status: 'ready', live: { source: 'C:\\f\\1.mov', duration: 2 } },
      { id: 'm2', path: 'C:\\f\\2.mp4', name: '2.mp4', kind: 'video', format: 'H.264', width: 1, height: 1, captureTime: 0, status: 'ready' }
    ]
    p.music = [{ id: 't1', path: 'C:\\m\\song.mp3', title: 'Song', duration: 1, status: 'ready' }]
    await save(p)
    const refs = await store.references()
    expect(refs.ids).toEqual(new Set(['m1', 'm2', 't1']))
    expect(refs.paths.sort()).toEqual(['C:\\f\\1.jpg', 'C:\\f\\1.mov', 'C:\\f\\2.mp4', 'C:\\m\\song.mp3'])
  })
})

describe('app settings', () => {
  it('persists settings as JSON and validates the kiosk project id', async () => {
    const file = join(tmp, 'userData', 'settings.json')
    const store = createAppSettingsStore(file)
    expect(await store.get()).toEqual({})
    await store.set({ kioskProjectId: 'trip-1' })
    expect(await createAppSettingsStore(file).get()).toEqual({ kioskProjectId: 'trip-1' })
    await store.set({ kioskProjectId: null })
    expect(await store.get()).toEqual({ kioskProjectId: null })
    expect(sanitizeAppSettings({ kioskProjectId: '../evil', other: 1 })).toEqual({ other: 1 })
    expect(sanitizeAppSettings('nope')).toEqual({})
    writeFileSync(file, '{broken')
    expect(await store.get()).toEqual({})
  })
})

describe('keep awake', () => {
  it('holds one blocker while any window has requests, released per window', () => {
    const calls: string[] = []
    let next = 1
    const awake = createKeepAwake({
      start: () => {
        calls.push('start')
        return next++
      },
      stop: (id) => calls.push(`stop ${id}`)
    })
    awake.set(1, true)
    awake.set(1, true) // e.g. fullscreen show and kiosk in the same window
    awake.set(2, true)
    expect(calls).toEqual(['start'])
    awake.set(1, false)
    awake.set(2, false)
    expect(awake.active).toBe(true)
    awake.set(1, false)
    expect(awake.active).toBe(false)
    expect(calls).toEqual(['start', 'stop 1'])
    awake.set(2, false) // more offs than ons are ignored
    awake.set(3, true)
    awake.release(3) // window closed
    expect(calls).toEqual(['start', 'stop 1', 'start', 'stop 2'])
    expect(awake.active).toBe(false)
  })
})
