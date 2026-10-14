// Looking into the app's own folders (cache, clean-up, trash): a path that is missing or can't be read
// counts as absent or empty, and links are not followed. Electron-free.
import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'

/** The entries of a folder; none when it is missing or can't be read. */
export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Something is there: a file, a folder or a link. */
export async function present(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

/** A folder is there (not a link or junction to one). */
export async function isDir(p: string): Promise<boolean> {
  try {
    const st = await lstat(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}
