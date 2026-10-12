// The one deletion function of the clean-up (src/main/safeDelete.ts): only inside the app's folders,
// never through a junction to somewhere else, links removed but not followed, kept files stay.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { isInsideRoot, pruneEmptyDirs, removeInside, rootOf, sizeOf } from '../src/main/safeDelete'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-safedelete-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

function file(path: string, bytes: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 7))
  return path
}

describe('paths inside the roots', () => {
  it('is strictly inside, case-insensitive, never the root itself', () => {
    const root = 'C:\\Data\\cache'
    expect(isInsideRoot('C:\\Data\\cache\\abc', root)).toBe(true)
    expect(isInsideRoot('c:\\data\\CACHE\\abc\\d.jpg', root)).toBe(true)
    expect(isInsideRoot('C:\\Data\\cache', root)).toBe(false)
    expect(isInsideRoot('C:\\Data\\cache\\', root)).toBe(false)
    expect(isInsideRoot('C:\\Data\\cache2\\x', root)).toBe(false)
    expect(isInsideRoot('C:\\Data\\cache\\..\\photos\\x.jpg', root)).toBe(false)
    expect(isInsideRoot('C:\\Data', root)).toBe(false)
  })

  it('only takes ordinary absolute paths', () => {
    const roots = ['C:\\Data\\cache']
    expect(rootOf('C:\\Data\\cache\\x', roots)).toBe('C:\\Data\\cache')
    for (const bad of ['cache\\x', '\\\\?\\C:\\Data\\cache\\x', '\\\\.\\C:\\Data\\cache\\x', 'C:\\Data\\cache\\x\0', '', 42, null]) expect(rootOf(bad, roots)).toBeNull()
  })
})

describe('removeInside', () => {
  let n = 0
  let root: string
  let outside: string
  beforeEach(() => {
    const base = join(tmp, `case${++n}`)
    root = join(base, 'app')
    outside = join(base, 'Pictures')
    mkdirSync(root, { recursive: true })
    file(join(outside, 'class-trip.jpg'), 50)
  })

  it('deletes files and folders inside, counts them, and refuses everything else', async () => {
    file(join(root, 'aaaa', 'thumb.jpg'), 100)
    file(join(root, 'aaaa', 'strip-4x64', '000.jpg'), 20)
    file(join(root, 'single.json'), 5)
    const r = await removeInside(
      [join(root, 'aaaa'), join(root, 'single.json'), join(outside, 'class-trip.jpg'), root, 'relative\\x', join(root, '..', 'Pictures', 'class-trip.jpg'), join(root, 'missing')],
      [root]
    )
    expect(r.files).toBe(3)
    expect(r.bytes).toBe(125)
    expect(existsSync(join(root, 'aaaa'))).toBe(false)
    expect(existsSync(join(root, 'single.json'))).toBe(false)
    expect(existsSync(root)).toBe(true)
    expect(existsSync(join(outside, 'class-trip.jpg'))).toBe(true)
    expect(r.refused).toHaveLength(4)
    expect(r.failed).toEqual([])
  })

  it('never follows a junction: the link goes, what it points to stays', async () => {
    // a folder inside the app's folder that is a junction to the user's pictures
    symlinkSync(outside, join(root, 'link'), 'junction')
    file(join(root, 'tree', 'a.jpg'), 10)
    symlinkSync(outside, join(root, 'tree', 'inner-link'), 'junction')
    const r = await removeInside([join(root, 'link'), join(root, 'tree')], [root])
    expect(existsSync(join(root, 'link'))).toBe(false)
    expect(existsSync(join(root, 'tree'))).toBe(false)
    expect(readFileSync(join(outside, 'class-trip.jpg')).length).toBe(50)
    expect(r.files).toBe(1)
  })

  it('refuses a path that leads outside through a junction on the way', async () => {
    symlinkSync(outside, join(root, 'pictures'), 'junction')
    const r = await removeInside([join(root, 'pictures', 'class-trip.jpg')], [root])
    expect(r.refused).toEqual([join(root, 'pictures', 'class-trip.jpg')])
    expect(existsSync(join(outside, 'class-trip.jpg'))).toBe(true)
  })

  it('keeps kept files and the folders holding them', async () => {
    file(join(root, 'Uploads', 'Show', 'Mia', 'a.jpg'), 10)
    const kept = file(join(root, 'Uploads', 'Show', 'Mia', 'used-elsewhere.jpg'), 10)
    const r = await removeInside([join(root, 'Uploads', 'Show'), kept], [root], [kept.toUpperCase()])
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(join(root, 'Uploads', 'Show', 'Mia', 'a.jpg'))).toBe(false)
    expect(r.files).toBe(1)
  })

  it('deletes read-only files', async () => {
    const f = file(join(root, 'ro.jpg'), 3)
    chmodSync(f, 0o444)
    const r = await removeInside([f], [root])
    expect(existsSync(f)).toBe(false)
    expect(r.failed).toEqual([])
  })

  it('removes empty folders only, deepest first, inside the roots', async () => {
    mkdirSync(join(root, 'Uploads', 'Show', 'Mia'), { recursive: true })
    file(join(root, 'Uploads', 'Show', 'Ben', 'b.jpg'), 1)
    mkdirSync(join(outside, 'empty'))
    const n = await pruneEmptyDirs([join(root, 'Uploads', 'Show'), join(root, 'Uploads', 'Show', 'Mia'), join(root, 'Uploads', 'Show', 'Ben'), join(outside, 'empty')], [join(root, 'Uploads')])
    expect(n).toBe(1)
    expect(existsSync(join(root, 'Uploads', 'Show', 'Mia'))).toBe(false)
    expect(existsSync(join(root, 'Uploads', 'Show', 'Ben', 'b.jpg'))).toBe(true)
    expect(existsSync(join(outside, 'empty'))).toBe(true)
  })

  it('measures folders without following links', async () => {
    file(join(root, 'm', 'a'), 10)
    file(join(root, 'm', 'b', 'c'), 5)
    symlinkSync(outside, join(root, 'm', 'link'), 'junction')
    expect(await sizeOf(join(root, 'm'))).toEqual({ files: 2, bytes: 15 })
    expect(await sizeOf(join(root, 'nothing'))).toEqual({ files: 0, bytes: 0 })
  })
})
