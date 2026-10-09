import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type MediaItem, type Project } from '@shared/types'
import { createProjectStore } from '../src/main/projects'

const dir = join(mkdtempSync(join(tmpdir(), 'diashow-projects-')), 'Diashow Studio')
afterAll(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

function media(id: string, kind: 'photo' | 'video'): MediaItem {
  return { id, path: `C:\\m\\${id}`, name: id, kind, format: 'JPEG', width: 10, height: 10, captureTime: 0, status: 'ready', thumb: `C:\\cache\\${id}\\thumb.jpg` }
}

function project(id: string, name: string, updatedAt: number): Project {
  return {
    version: 1,
    id,
    name,
    createdAt: 1,
    updatedAt,
    entries: [
      { id: 'e0', type: 'text', title: 'Hallo' },
      { id: 'e1', type: 'video', mediaId: 'v1' },
      { id: 'e2', type: 'photo', mediaId: 'p1' }
    ],
    media: [media('v1', 'video'), media('p1', 'photo')],
    music: [],
    settings: DEFAULT_SETTINGS
  }
}

describe('project store', () => {
  const store = createProjectStore(dir)

  it('lists nothing before the folder exists', async () => {
    expect(await store.list()).toEqual([])
  })

  it('saves, lists (newest first), loads and deletes', async () => {
    const a = project('alpha', 'Sommer', 100)
    const b = project('beta-2', 'Winter', 200)
    await store.save(a)
    await store.save(b)
    await store.save({ ...a, name: 'Sommer 2025', updatedAt: 300 })
    expect(readdirSync(dir).sort()).toEqual(['alpha.dshow', 'beta-2.dshow'])

    const list = await store.list()
    expect(list.map((s) => s.id)).toEqual(['alpha', 'beta-2'])
    expect(list[0]).toEqual({ id: 'alpha', name: 'Sommer 2025', updatedAt: 300, slideCount: 3, cover: 'C:\\cache\\p1\\thumb.jpg' })

    const loaded = await store.load('beta-2')
    expect(loaded).toEqual(b)

    await store.delete('alpha')
    expect((await store.list()).map((s) => s.id)).toEqual(['beta-2'])
  })

  it('rejects ids that could escape the folder', async () => {
    await expect(store.load('..\\evil')).rejects.toThrow(/invalid project id/)
    await expect(store.save(project('../x', 'x', 1))).rejects.toThrow(/invalid project id/)
  })
})
