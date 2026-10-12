// The one way the app deletes files of the clean-up ("Nach dem Projekt aufräumen") and of a deleted
// project: only inside its own data folders (media cache, uploads, project backups, export jobs), for
// good (no recycle bin). Paths come from the app's own lists, but a project file from elsewhere can
// hold any string, and a folder inside may be a junction to the user's pictures: everything is
// checked again here. Electron-free.
import type { Dirent, Stats } from 'node:fs'
import { chmod, lstat, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export interface RemoveResult {
  /** Files deleted, and their bytes. */
  files: number
  bytes: number
  /** Paths that could not be deleted (in use, no permission). */
  failed: string[]
  /** Paths refused: outside the roots, a root itself, not an ordinary absolute path. */
  refused: string[]
}

const lower = (p: string): string => resolve(p).toLowerCase()

/** An ordinary absolute path: no device or \\?\ prefix, no zero bytes. */
function ordinary(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length < 4000 && !p.includes('\0') && isAbsolute(p) && !/^[\\/]{2}[?.][\\/]/.test(p)
}

/** `path` lies strictly inside `root` (by name; case-insensitive like Windows). */
export function isInsideRoot(path: string, root: string): boolean {
  const r = lower(root)
  const p = lower(path)
  return p.startsWith(r.endsWith(sep) ? r : r + sep) && p.length > r.length + 1
}

/** The root of `roots` that holds `path` (by name), or null. */
export function rootOf(path: unknown, roots: readonly string[]): string | null {
  if (!ordinary(path)) return null
  return roots.find((r) => ordinary(r) && isInsideRoot(path, r)) ?? null
}

/** The real place of a folder (junctions and links resolved), or null when it doesn't exist. */
async function real(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Deletes one file; a read-only file is made writable first, a busy one is tried once more. */
async function removeFile(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
    await chmod(p, 0o666).catch(() => {})
    await sleep(150)
    await unlink(p)
  }
}

/** Removes a link (symbolic link or junction) itself; what it points to stays untouched. */
async function removeLink(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch {
    // a junction or a directory link is removed like an (empty) folder: rmdir doesn't follow it
    await rmdir(p)
  }
}

/**
 * Deletes files and folders (with everything in them) that lie inside one of `roots`. Refused, and
 * reported: relative or device paths, a root itself, anything outside the roots, also when a folder
 * on the way is a junction or link that leads outside. Links inside are removed themselves, never
 * followed. Paths in `keep` stay, and so do the folders holding them. Missing paths count as done.
 */
export async function removeInside(targets: readonly string[], roots: readonly string[], keep: readonly string[] = []): Promise<RemoveResult> {
  const out: RemoveResult = { files: 0, bytes: 0, failed: [], refused: [] }
  const kept = new Set(keep.filter(ordinary).map(lower))
  const realRoots = new Map<string, string | null>()
  const realRoot = async (root: string): Promise<string | null> => {
    if (!realRoots.has(root)) realRoots.set(root, await real(root))
    return realRoots.get(root)!
  }

  /** Deletes a folder's content (not following links); true when the folder is empty afterwards. */
  const removeTree = async (dir: string): Promise<boolean> => {
    let list: Dirent[]
    try {
      list = await readdir(dir, { withFileTypes: true })
    } catch {
      out.failed.push(dir)
      return false
    }
    let empty = true
    for (const e of list) {
      const p = join(dir, e.name)
      if (kept.has(lower(p))) {
        empty = false
        continue
      }
      try {
        if (e.isSymbolicLink()) await removeLink(p)
        else if (e.isDirectory()) {
          if (!(await removeTree(p))) {
            empty = false
            continue
          }
          await rmdir(p)
        } else {
          const size = (await lstat(p)).size
          await removeFile(p)
          out.files++
          out.bytes += size
        }
      } catch {
        out.failed.push(p)
        empty = false
      }
    }
    return empty
  }

  for (const raw of targets) {
    const root = rootOf(raw, roots)
    if (!root) {
      out.refused.push(String(raw))
      continue
    }
    const target = resolve(raw)
    // the real place of its folder must be inside the real root (a junction on the way would lead out)
    const [parent, top] = await Promise.all([real(dirname(target)), realRoot(root)])
    if (!parent) continue // nothing there
    if (!top || !(lower(parent) === lower(top) || isInsideRoot(parent, top))) {
      out.refused.push(target)
      continue
    }
    if (kept.has(lower(target))) continue
    let st: Stats
    try {
      st = await lstat(target)
    } catch {
      continue // already gone
    }
    try {
      if (st.isSymbolicLink()) await removeLink(target)
      else if (st.isDirectory()) {
        if (await removeTree(target)) await rmdir(target)
      } else {
        await removeFile(target)
        out.files++
        out.bytes += st.size
      }
    } catch {
      out.failed.push(target)
    }
  }
  return out
}

/** Removes folders that are empty (deepest first), inside the roots only; returns how many. */
export async function pruneEmptyDirs(dirs: readonly string[], roots: readonly string[]): Promise<number> {
  let n = 0
  const list = [...new Set(dirs.filter((d) => !!rootOf(d, roots)).map((d) => resolve(d)))].sort((a, b) => b.length - a.length)
  for (const dir of list) {
    try {
      const st = await lstat(dir)
      if (!st.isDirectory() || st.isSymbolicLink() || (await readdir(dir)).length) continue
      const parent = await real(dirname(dir))
      const root = rootOf(dir, roots)!
      const top = await real(root)
      if (!parent || !top || !(lower(parent) === lower(top) || isInsideRoot(parent, top))) continue
      await rmdir(dir)
      n++
    } catch {
      // gone or in use: stays
    }
  }
  return n
}

/** Size of a file or folder (not following links): bytes and number of files. */
export async function sizeOf(path: string): Promise<{ files: number; bytes: number }> {
  let st: Stats
  try {
    st = await lstat(path)
  } catch {
    return { files: 0, bytes: 0 }
  }
  if (st.isSymbolicLink()) return { files: 0, bytes: 0 }
  if (!st.isDirectory()) return { files: 1, bytes: st.size }
  let files = 0
  let bytes = 0
  let list: Dirent[] = []
  try {
    list = await readdir(path, { withFileTypes: true })
  } catch {
    return { files, bytes }
  }
  for (const e of list) {
    if (e.isSymbolicLink()) continue
    const p = join(path, e.name)
    if (e.isDirectory()) {
      const s = await sizeOf(p)
      files += s.files
      bytes += s.bytes
    } else {
      try {
        bytes += (await stat(p)).size
        files++
      } catch {
        // vanished
      }
    }
  }
  return { files, bytes }
}
