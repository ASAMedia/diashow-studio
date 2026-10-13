// Content keys of media files, for finding byte-identical copies when photos and videos come in
// (repeats.ts). Cheap first: only files that share their size with another file are read at all. A
// photo (up to 8 MiB) is then read whole in one go; of a bigger file (a video) the first and last MiB
// come first, and the whole file only when those match too. The keys are kept per file (path, size and
// time, like a media id) for the session and, when the file has a cache folder, in its content.json, so
// the next import reads nothing again.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJson } from './cacheMeta'
import { createLimiter } from './queue'
import { mediaId } from './scan'

/** Bytes read at each end of a big file for the first comparison. */
export const EDGE = 1 << 20
/** Files up to this size are read whole at once (reading the edges first would save little). */
export const WHOLE = 8 * EDGE
const FILE = 'content.json'
const HEX = /^[0-9a-f]{64}$/

export interface HashFile {
  path: string
  size: number
  mtimeMs: number
  /** A new file of the import: only groups with one of these are read. */
  wanted: boolean
}

export interface Hasher {
  /** Hash of the size and the first and last MiB (of the whole file when it has at most WHOLE bytes). */
  edge(f: HashFile): Promise<string>
  /** Hash of the whole file. */
  full(f: HashFile): Promise<string>
}

/** sha256 of the size, the first and the last EDGE bytes; of the whole file when it has at most WHOLE bytes. */
export async function edgeHash(path: string, size: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const h = createHash('sha256').update(`${size}:`)
    const whole = size <= WHOLE
    const buf = Buffer.alloc(whole ? size : EDGE)
    for (const at of whole ? [0] : [0, size - EDGE]) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, at)
      if (bytesRead !== buf.length) throw new Error('the file changed while it was read')
      h.update(buf)
    }
    return h.digest('hex')
  } finally {
    await fh.close()
  }
}

/** sha256 of the whole file (about 1.9 GB/s on one core; the disk is usually slower). */
export async function fullHash(path: string, signal?: AbortSignal): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20, signal })) h.update(chunk as Buffer)
  return h.digest('hex')
}

interface Stored {
  size: number
  edge?: string
  full?: string
}

/**
 * The hasher of a media service: each key is computed once per file (four files at a time) and kept in
 * memory, and in content.json of the file's cache folder when it has one (`folder`: of a media id).
 */
export class ContentHashes implements Hasher {
  private known = new Map<string, Stored>()
  private running = new Map<string, Promise<string>>()
  private limit = createLimiter(4)
  /** Files read (for the tests). */
  reads = 0

  constructor(
    private folder?: (id: string) => string,
    private signal?: AbortSignal
  ) {}

  edge(f: HashFile): Promise<string> {
    return this.get(f, 'edge')
  }

  full(f: HashFile): Promise<string> {
    // a small file's edge hash covers all of it
    return this.get(f, f.size <= WHOLE ? 'edge' : 'full')
  }

  private async get(f: HashFile, kind: 'edge' | 'full'): Promise<string> {
    const id = mediaId(f.path, f.size, f.mtimeMs)
    const s = this.known.get(id) ?? (await this.load(id, f.size))
    const done = s[kind]
    if (done) return done
    const key = `${kind}:${id}`
    let job = this.running.get(key)
    if (!job) {
      job = this.limit(async () => {
        this.reads++
        const hash = kind === 'edge' ? await edgeHash(f.path, f.size) : await fullHash(f.path, this.signal)
        s[kind] = hash
        await this.save(id, s)
        return hash
      }).finally(() => this.running.delete(key))
      this.running.set(key, job)
    }
    return job
  }

  private async load(id: string, size: number): Promise<Stored> {
    const stored = this.folder ? await readJson<Stored>(join(this.folder(id), FILE)) : null
    const s: Stored = { size }
    if (stored?.size === size) {
      if (typeof stored.edge === 'string' && HEX.test(stored.edge)) s.edge = stored.edge
      if (typeof stored.full === 'string' && HEX.test(stored.full)) s.full = stored.full
    }
    // a key computed meanwhile wins
    const now = this.known.get(id)
    if (now) return now
    this.known.set(id, s)
    return s
  }

  private async save(id: string, s: Stored): Promise<void> {
    const dir = this.folder?.(id)
    // only next to a cache folder that exists: a file never processed leaves nothing behind
    if (dir && existsSync(dir)) await writeJson(join(dir, FILE), s).catch(() => {})
  }
}

function groupBy<T>(list: T[], key: (x: T) => string | number): T[][] {
  const map = new Map<string | number, T[]>()
  for (const x of list) {
    const k = key(x)
    const g = map.get(k)
    if (g) g.push(x)
    else map.set(k, [x])
  }
  return [...map.values()]
}

/** Groups of two or more files with at least one new one: only those can hold a copy of a new file. */
const mayRepeat = (g: HashFile[]): boolean => g.length > 1 && g.some((f) => f.wanted)

/**
 * Content keys (`size:sha256` of the whole file) of the files that share their size with another
 * file, in groups with a new file: their edges are compared first, and only files whose edges match
 * are read whole. By lower-case path; a file that can't be read gets no key.
 */
export async function contentKeys(files: HashFile[], hasher: Hasher): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    groupBy(files, (f) => f.size)
      .filter(mayRepeat)
      .map(async (group) => {
        const edges = new Map<HashFile, string>()
        await Promise.all(group.map(async (f) => hasher.edge(f).then((h) => void edges.set(f, h), () => {})))
        const same = groupBy(group.filter((f) => edges.has(f)), (f) => edges.get(f)!).filter(mayRepeat)
        await Promise.all(
          same.flat().map(async (f) => {
            const full = await hasher.full(f).catch(() => null)
            if (full) out.set(f.path.toLowerCase(), `${f.size}:${full}`)
          })
        )
      })
  )
  return out
}
