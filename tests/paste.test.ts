// Ctrl+V in the editor, main process part (pasteMain.ts): file lists from Explorer, pasted pictures
// saved as PNG files, and the clean-up that treats their folder like the pupils' uploads.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type MediaItem, type Project } from '@shared/types'

vi.mock('electron', () => ({ clipboard: {}, ipcMain: { handle: vi.fn() } }))
const { filesFromUriList, pastedName, pastedRoot, pastedRoots, savePastedPng } = await import('../src/main/pasteMain')
const { inventoryOf, runCleanup, scanProject } = await import('../src/main/cleanup')
const { createProjectStore } = await import('../src/main/projects')

const tmp = mkdtempSync(join(tmpdir(), 'diashow-paste-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

// the smallest valid PNG: 1×1 pixel
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('Ctrl+V: what the clipboard holds', () => {
  it('reads every file of a copied selection from the uri list', () => {
    const a = join(tmp, 'Fotos', 'Strand 1.jpg')
    const b = join(tmp, 'Fotos', 'Ärger & Co', 'b.heic')
    const list = ['# copied in Explorer', pathToFileURL(a).href, pathToFileURL(b).href, 'https://example.com/x.jpg', ''].join('\r\n')
    expect(filesFromUriList(list)).toEqual([a, b])
    expect(filesFromUriList('')).toEqual([])
  })

  it('names pasted pictures after the time, in a folder per show and language', () => {
    const at = new Date(2026, 9, 13, 9, 5, 3)
    expect(pastedName(at)).toBe('2026-10-13 09-05-03.png')
    expect(pastedName(at, 2)).toBe('2026-10-13 09-05-03 (2).png')
    expect(pastedRoot('D:\\Docs\\Diashow Studio', 'de-DE')).toBe(join('D:\\Docs\\Diashow Studio', 'Eingefügt'))
    expect(pastedRoot('D:\\Docs\\Diashow Studio', 'en-US')).toBe(join('D:\\Docs\\Diashow Studio', 'Pasted'))
    expect(pastedRoots('D:\\x')).toEqual([join('D:\\x', 'Eingefügt'), join('D:\\x', 'Pasted')])
  })

  it('saves a picture without overwriting one pasted in the same second, and only PNG data', async () => {
    const root = join(tmp, 'docs1', 'Eingefügt')
    const at = new Date(2026, 9, 13, 9, 5, 3)
    const one = await savePastedPng(root, 'Klassenfahrt: Athen', PNG, at)
    const two = await savePastedPng(root, 'Klassenfahrt: Athen', PNG, at)
    expect(one).toBe(join(root, 'Klassenfahrt_ Athen', '2026-10-13 09-05-03.png'))
    expect(two).toBe(join(root, 'Klassenfahrt_ Athen', '2026-10-13 09-05-03 (2).png'))
    expect(readFileSync(one)).toEqual(PNG)
    // a name can't lead out of the folder
    expect(await savePastedPng(root, '..\\..\\evil', PNG, at)).toBe(join(root, 'evil', '2026-10-13 09-05-03.png'))
    expect(await savePastedPng(root, '', PNG, at)).toBe(join(root, 'Diashow', '2026-10-13 09-05-03.png'))
    await expect(savePastedPng(root, 'x', Buffer.from('not a picture'), at)).rejects.toThrow()
  })
})

describe('clean-up of pasted pictures', () => {
  it('lists them with the uploads and deletes them like uploads, never the user’s own files', async () => {
    const docs = join(tmp, 'docs2', 'Diashow Studio')
    const roots = pastedRoots(docs)
    const own = join(tmp, 'docs2', 'Pictures', 'trip.jpg')
    const inShow = join(roots[0], 'Klassenfahrt', '2026-10-13 09-05-03.png')
    const leftOut = join(roots[0], 'Klassenfahrt', '2026-10-13 09-06-00.png')
    // pasted while the show had another name (and the UI was English): found through the show's media
    const renamed = join(roots[1], 'Old name', '2026-10-12 18-00-00.png')
    // something the user saved there: not a pasted picture, it stays
    const saved = join(roots[0], 'Klassenfahrt', 'Klassenfahrt.mp4')
    for (const f of [own, inShow, leftOut, renamed, saved]) {
      mkdirSync(join(f, '..'), { recursive: true })
      writeFileSync(f, f.endsWith('.png') ? PNG : Buffer.alloc(50, 1))
    }
    const item = (id: string, path: string): MediaItem => ({ id, path, name: 'x', kind: 'photo', format: 'PNG', width: 1, height: 1, captureTime: 0, status: 'ready' })
    const project: Project = {
      version: 1, id: 'showA', name: 'Klassenfahrt', createdAt: 1, updatedAt: 2, settings: DEFAULT_SETTINGS, music: [],
      media: [item('1111111111111111', own), item('2222222222222222', inShow), item('3333333333333333', renamed)],
      entries: [
        { id: 'e1', type: 'photo', mediaId: '1111111111111111' },
        { id: 'e2', type: 'photo', mediaId: '2222222222222222' },
        { id: 'e3', type: 'photo', mediaId: '3333333333333333' }
      ]
    }
    writeFileSync(join(docs, 'showA.dshow'), JSON.stringify(project))
    const deps = {
      projects: createProjectStore(docs),
      cacheDir: join(tmp, 'docs2', 'cache'),
      uploadsRoot: join(docs, 'Uploads'),
      pastedRoots: roots,
      exportsDir: join(tmp, 'docs2', 'exports'),
      media: { forgetFaces: async () => {}, releaseCache: (ids: string[]) => ids },
      exports: { jobsOf: async () => [], forget: async () => {} }
    }
    const scan = await scanProject(deps, 'showA')
    expect(scan.uploads.map((u) => u.path).sort()).toEqual([inShow, leftOut, renamed].sort())
    expect(scan.keep).toContain(own)
    expect(scan.keep).not.toContain(inShow)
    const inv = inventoryOf(scan)
    expect(inv.uploads).toMatchObject({ files: 3, pasted: 3, uploaders: 0, inShow: { files: 2, slides: 2 }, leftOut: { files: 1 } })

    // only what is not in the show
    await runCleanup(deps, 'showA', { faces: false, uploads: 'leftOut', caches: false, backups: false, exports: false })
    expect(existsSync(leftOut)).toBe(false)
    expect(existsSync(inShow)).toBe(true)
    // everything: the slides go, the user's photo and the saved video stay, the empty folder goes
    const result = await runCleanup(deps, 'showA', { faces: false, uploads: 'all', caches: false, backups: false, exports: false })
    expect(existsSync(inShow)).toBe(false)
    expect(existsSync(renamed)).toBe(false)
    expect(existsSync(join(roots[1], 'Old name'))).toBe(false)
    expect(existsSync(own)).toBe(true)
    expect(existsSync(saved)).toBe(true)
    expect(result.project?.entries.map((e) => e.id)).toEqual(['e1'])
  })
})
