// Ctrl+V in the editor (renderer insert.ts): what the clipboard holds as photos and videos to insert.
// - Files copied in Explorer (Ctrl+C) arrive as file:// URLs in text/uri-list: Chromium makes that
//   list from the Windows file list (CF_HDROP), one line per file or folder of a multiple selection.
// - A copied picture without a file (Win+Shift+S, "Copy image" in a browser) arrives as image/png and
//   is saved as a PNG named after the time in <Documents>/Diashow Studio/Eingefügt/<project>/
//   ("Pasted" in English). The clean-up treats that folder like the pupils' uploads (cleanup.ts).
import { clipboard, ipcMain } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { showFolderName } from './share/server'
import { isInsideRoot } from './safeDelete'

const PASTED = { de: 'Eingefügt', en: 'Pasted' } as const
/** A pasted picture larger than this is refused (a 8K screenshot is far below). */
const MAX_PNG = 256 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Where pasted pictures go, in the UI language: <projects folder>/Eingefügt or /Pasted. */
export function pastedRoot(projectsDir: string, locale: string): string {
  return join(projectsDir, locale.toLowerCase().startsWith('de') ? PASTED.de : PASTED.en)
}

/** Both folders of pasted pictures (the language may have changed since): the clean-up looks in each. */
export function pastedRoots(projectsDir: string): string[] {
  return [join(projectsDir, PASTED.de), join(projectsDir, PASTED.en)]
}

/** Local file paths of a text/uri-list: file: URLs only; comments and other URLs are skipped. */
export function filesFromUriList(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#') || !/^file:/i.test(s)) continue
    try {
      out.push(fileURLToPath(s))
    } catch {
      // not a file URL Windows can open
    }
  }
  return out
}

const two = (n: number): string => String(n).padStart(2, '0')

/** "2026-10-13 14-05-33.png", "2026-10-13 14-05-33 (2).png" for a second picture in the same second. */
export function pastedName(at: Date, n = 1): string {
  const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}`
  return n > 1 ? `${stamp} (${n}).png` : `${stamp}.png`
}

const isPng = (b: Uint8Array): boolean => b.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((x, i) => b[i] === x)

/** Writes a pasted picture into the project's folder under `root` without overwriting anything; returns its path. */
export async function savePastedPng(root: string, projectName: string, bytes: Uint8Array, at = new Date()): Promise<string> {
  if (!isPng(bytes) || bytes.length > MAX_PNG) throw new Error('the clipboard holds no usable picture')
  const dir = join(root, showFolderName(projectName))
  if (!isInsideRoot(dir, root)) throw new Error('invalid project name')
  await mkdir(dir, { recursive: true })
  for (let n = 1; n < 1000; n++) {
    const path = join(dir, pastedName(at, n))
    try {
      await writeFile(path, bytes, { flag: 'wx' })
      return path
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('no free file name for the pasted picture')
}

export function registerPaste(opts: { projectsDir: string; locale: () => string }): void {
  ipcMain.handle('clipboard:media', async (_e, projectName: unknown) => {
    const items = await clipboard.read()
    for (const item of items) {
      if (!item.types.includes('text/uri-list')) continue
      const list = (await item.getType('text/uri-list')) as Blob
      const files = filesFromUriList(await list.text())
      if (files.length) return files
    }
    for (const item of items) {
      if (!item.types.includes('image/png')) continue
      const blob = (await item.getType('image/png')) as Blob
      if (!blob.size || blob.size > MAX_PNG) continue
      const name = typeof projectName === 'string' ? projectName : ''
      return [await savePastedPng(pastedRoot(opts.projectsDir, opts.locale()), name, new Uint8Array(await blob.arrayBuffer()))]
    }
    return []
  })
}
