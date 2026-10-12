// Replacing a file Windows keeps busy for a moment (a virus scanner, Explorer's preview, a reader
// without delete sharing) retries instead of failing; settings reads and writes take turns.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// the first renames onto a "busy" path fail like Windows does while another program holds the file
const busy = new Map<string, number>()
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      const left = busy.get(to) ?? 0
      if (left > 0) {
        busy.set(to, left - 1)
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      return fs.rename(from, to)
    }
  }
})

const { createAppSettingsStore } = await import('../src/main/appSettings')
const { replaceFile } = await import('../src/main/replaceFile')

const dir = mkdtempSync(join(tmpdir(), 'diashow-replace-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('replacing busy files', () => {
  it('retries while the target is busy', async () => {
    const target = join(dir, 'target.json')
    writeFileSync(target, 'old')
    writeFileSync(`${target}.tmp`, 'new')
    busy.set(target, 3)
    await replaceFile(`${target}.tmp`, target)
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(busy.get(target)).toBe(0)
  })

  it('gives up after a while, and at once on other errors', async () => {
    const target = join(dir, 'stuck.json')
    writeFileSync(`${target}.tmp`, 'x')
    busy.set(target, 99)
    await expect(replaceFile(`${target}.tmp`, target, { attempts: 3, delayMs: 1 })).rejects.toMatchObject({ code: 'EPERM' })
    await expect(replaceFile(join(dir, 'missing.tmp'), join(dir, 'x.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('saves settings while a scanner holds the file, and keeps every change when the UI reads and writes at once', async () => {
    const file = join(dir, 'settings.json')
    const store = createAppSettingsStore(file)
    busy.set(file, 2)
    await store.update({ kioskProjectId: 'abc' })
    expect((await store.get()).kioskProjectId).toBe('abc')
    const jobs: Promise<unknown>[] = []
    for (let i = 0; i < 20; i++) jobs.push(store.get(), store.update({ [`k${i}`]: i } as never), store.get())
    await Promise.all(jobs)
    const s = (await store.get()) as Record<string, unknown>
    for (let i = 0; i < 20; i++) expect(s[`k${i}`]).toBe(i)
    expect(s.kioskProjectId).toBe('abc')
  })
})
