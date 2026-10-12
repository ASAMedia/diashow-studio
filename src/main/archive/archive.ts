// "Diashow als ZIP archivieren": a finished show in one ZIP file for the school archive or a USB stick,
// with everything needed to open, change and play it again on any PC with Diashow Studio:
// - `<name>.dshow`: the project as "Pack project" writes it (projectFile.ts planPack: relative paths,
//   cache-derived fields removed), so the extracted folder opens exactly like a packed project;
// - media/ and music/: the original photos, videos (with Live Photo videos) and songs; items left out
//   of the show only when asked for. The theme song goes into music/ too when the show plays one, with
//   a note in the .dshow, so it still plays when a later version has other songs (themeSong.ts);
// - videos/: finished exports of the show and other video files, when picked;
// - LIESMICH.txt / README.txt: contents, how to open it, and the data-protection note.
// The archive is written to a temp file next to the target (zip64.ts: streamed, media stored, text
// deflated, ZIP64 when needed), read back and checked, then put in place (replaceFile). Originals are
// only read. Missing originals are skipped and listed. Electron-free.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { open, rm, stat, statfs, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { ArchiveChoice, ArchiveInventory, ArchiveMissing, ArchivePart, ArchiveProgress, ArchiveResult, ArchiveVideo } from '@shared/archive'
import { archiveSize, CHECK_FILE_SYSTEM_FROM, ENTRY_OVERHEAD, FAT_MAX_FILE } from '@shared/archive'
import { faceDataStats, withoutFaceData } from '@shared/cleanup'
import type { ExportJobState } from '@shared/exportQueue'
import { VIDEO_EXT } from '@shared/formats'
import { effectiveMusic, type ThemeTrack } from '@shared/themeMusic'
import { buildTimeline } from '@shared/timeline'
import type { MediaItem, MusicTrack, Project } from '@shared/types'
import { abortError } from '../abort'
import { planPack, safeName } from '../projectFile'
import { PROJECT_EXT, type ProjectStore } from '../projects'
import { replaceFile } from '../replaceFile'
import { ARCHIVED_THEME_SONG, archivedThemeSong, type ArchivedThemeSong } from './themeSong'
import { fileInput, fileSink, fileSource, verifyPlan, verifyZip, ZipWriter } from './zip64'
import { readmeName, readmeText } from './readme'

export interface ArchiveDeps {
  projects: Pick<ProjectStore, 'peek'>
  /** The bundled songs (themeMusic.ts loadThemeMusic). */
  themeMusic: () => Promise<readonly ThemeTrack[]>
  /** Today's folder of the bundled songs (own songs from the music library are found there). */
  themeMusicDir?: string
  /** Finished exports of a show (export/queueMain.ts). */
  exports: { jobsOf(projectId: string): Promise<{ state: ExportJobState; outPath: string }[]> }
  /** Whether a path may be opened (network shares the user hasn't trusted may not); default all. */
  allowPath?: (path: string) => boolean
  /** Where the suggested target goes (Documents). */
  documentsDir: string
  appVersion: string
  now?: () => number
  /** Free bytes on the drive of a folder (tests); default statfs. */
  freeSpace?: (dir: string) => Promise<number | null>
  /** The largest file the drive of a path holds (tests); default maxFileSizeOf. */
  maxFileSize?: (path: string) => Promise<number | null>
}

/** The folders inside the archive (next to the .dshow). */
export const VIDEOS_FOLDER = 'videos'

interface Stat {
  bytes: number
  mtime: number
}

async function fileStat(path: string): Promise<Stat | null> {
  try {
    const st = await stat(path)
    return st.isFile() ? { bytes: st.size, mtime: st.mtimeMs } : null
  } catch {
    return null
  }
}

/** Stats of many files, a few at a time. */
async function statAll(paths: string[]): Promise<Array<Stat | null>> {
  const out: Array<Stat | null> = new Array(paths.length).fill(null)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(16, paths.length) }, async () => {
      for (let i = next++; i < paths.length; i = next++) out[i] = await fileStat(paths[i])
    })
  )
  return out
}

/** Free bytes on the drive of `dir` (or of the nearest folder above it that exists); null when unknown. */
export async function freeSpaceOf(dir: string): Promise<number | null> {
  let d = resolve(dir)
  for (;;) {
    try {
      const s = await statfs(d)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      const up = dirname(d)
      if (up === d) return null
      d = up
    }
  }
}

/**
 * The largest file the drive of `path` holds: just under 4 GB on FAT and FAT32 (many USB sticks),
 * else null (no practical limit, or unknown: a network share, no answer). Asks Windows (Get-Volume).
 */
export async function maxFileSizeOf(path: string): Promise<number | null> {
  const drive = /^([A-Za-z]):\\/.exec(resolve(path))?.[1]
  if (process.platform !== 'win32' || !drive) return null
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const fs = await new Promise<string>((done) =>
    execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Volume -DriveLetter ${drive.toUpperCase()}).FileSystemType`], { timeout: 15_000, windowsHide: true }, (err, out) =>
      done(err ? '' : String(out).trim())
    )
  )
  return /^FAT(12|16|32)?$/i.test(fs) ? FAT_MAX_FILE : null
}

/** The drive's largest file, asked only when an archive of `bytes` may reach the FAT32 limit. */
export async function fileLimitFor(d: Pick<ArchiveDeps, 'maxFileSize'>, path: string, bytes: number): Promise<number | null> {
  return bytes >= CHECK_FILE_SYSTEM_FROM ? (d.maxFileSize ?? maxFileSizeOf)(path).catch(() => null) : null
}

/** yyyy-mm-dd of a local date. */
export function isoDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The suggested archive: "<show name> <yyyy-mm-dd>.zip" in `dir`. */
export function defaultTarget(name: string, dir: string, now: number): string {
  return join(dir, `${safeName(name)} ${isoDate(now)}.zip`)
}

/**
 * The show without what is left out of it: entries marked "left out" (Review, X) and the media only
 * they show. Text slides stay unless they are left out themselves.
 */
export function showOnly(project: Project): Project {
  const entries = project.entries.filter((e) => !e.excluded)
  const used = new Set(entries.flatMap((e) => (e.type === 'text' ? [] : [e.mediaId])))
  return { ...project, entries, media: project.media.filter((m) => used.has(m.id)) }
}

/** One file going into the archive. */
export interface ArchiveFile {
  src: string
  /** Path inside the archive, forward slashes. */
  rel: string
  kind: 'media' | 'music' | 'theme' | 'video'
  bytes: number
  mtime: number
}

export interface ArchivePlan {
  files: ArchiveFile[]
  /** The project as it goes into the archive. */
  project: Project
  /** Name of the project file inside the archive. */
  projectFile: string
  /** The theme song's note in the .dshow, when it is included. */
  themeSong?: ArchivedThemeSong
  theme?: ThemeTrack
  /** Originals that are not there (absolute paths). */
  missing: string[]
}

export interface PlanOptions {
  themeTracks: readonly ThemeTrack[]
  themeMusicDir?: string
  allowPath?: (path: string) => boolean
  /** Videos to add (checked by the caller). */
  videos?: readonly ArchiveVideo[]
  now?: number
  /** For the show's length (day titles); de-DE when missing. */
  locale?: string
}

/** What goes into the archive for a choice: files with their names inside, and the project as written. */
export async function planArchive(project: Project, choice: Pick<ArchiveChoice, 'leftOut' | 'withoutFaceData'>, o: PlanOptions): Promise<ArchivePlan> {
  const now = o.now ?? Date.now()
  let src = choice.leftOut ? project : showOnly(project)
  if (choice.withoutFaceData && hasFaceData(src)) src = withoutFaceData(src, now)
  const allow = o.allowPath ?? (() => true)
  // sizes and times of the originals, a few at a time (a share that isn't allowed is never opened)
  const stats = new Map<string, Stat | null>()
  const known = [...new Set(src.media.flatMap((m) => [m.path, m.live?.source]).concat(src.music.map((t) => t.path)))].filter((p): p is string => typeof p === 'string' && !!p && allow(p))
  ;(await statAll(known)).forEach((s, i) => stats.set(known[i], s))
  const plan = await planPack(src, {
    themeMusicDir: o.themeMusicDir,
    isFile: async (p) => {
      // a song of the bundled library is looked for in today's folder (planPack)
      if (!stats.has(p)) stats.set(p, allow(p) ? await fileStat(p) : null)
      return !!stats.get(p)
    }
  })
  const files: ArchiveFile[] = plan.copies.map((c) => ({ src: c.src, rel: c.rel, kind: c.kind, ...stats.get(c.src)! }))
  const missing = new Set(plan.missing)
  const { media, music } = plan

  // the theme song, when the show plays one (it has no songs of its own)
  let themeSong: ArchivedThemeSong | undefined
  const theme = src.music.length ? undefined : effectiveMusic(src, o.themeTracks).theme
  const themeStat = theme && allow(theme.path) ? await fileStat(theme.path) : null
  if (theme && themeStat) {
    const [rel] = plan.reserve('music', [theme.path])
    files.push({ src: theme.path, rel, kind: 'theme', ...themeStat })
    let seconds: number | undefined
    try {
      seconds = buildTimeline(src, o.locale ?? 'de-DE', o.themeTracks).duration
    } catch {
      seconds = undefined
    }
    themeSong = archivedThemeSong(theme, rel, seconds)
  }

  for (const v of o.videos ?? []) {
    const s = allow(v.path) ? await fileStat(v.path) : null
    if (!s) {
      missing.add(v.path)
      continue
    }
    const [rel] = plan.reserve(VIDEOS_FOLDER, [v.path])
    files.push({ src: v.path, rel, kind: 'video', ...s })
  }

  const archived = { ...src, media, music, ...(themeSong ? { [ARCHIVED_THEME_SONG]: themeSong } : {}) } as Project
  return { files, project: archived, projectFile: `${safeName(project.name)}${PROJECT_EXT}`, themeSong, ...(themeSong ? { theme } : {}), missing: [...missing] }
}

const hasFaceData = (p: Project): boolean => {
  const s = faceDataStats(p)
  return s.media + s.people > 0
}

/** Media and songs whose copies are not in the archive point to their originals again (like missing originals). */
function withAbsolute(p: { media: MediaItem[]; music: MusicTrack[] }, lost: { src: string; rel: string }[]): { media: MediaItem[]; music: MusicTrack[] } {
  const back = new Map(lost.map((c) => [c.rel, c.src]))
  const media = p.media.map((m) => {
    let out = back.has(m.path) ? { ...m, path: back.get(m.path)! } : m
    if (out.live && back.has(out.live.source)) {
      const { live: _l, ...rest } = out
      out = rest
    }
    return out
  })
  const music = p.music.map((t) => (back.has(t.path) ? { ...t, path: back.get(t.path)! } : t))
  return { media, music }
}

const part = (files: { bytes: number }[]): ArchivePart => ({ files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) })

/** Finished exports of the show whose files are there. */
async function finishedExports(d: ArchiveDeps, projectId: string): Promise<ArchiveVideo[]> {
  const jobs = await d.exports.jobsOf(projectId).catch(() => [])
  const seen = new Set<string>()
  const out: ArchiveVideo[] = []
  for (const j of jobs) {
    if (j.state !== 'done' || typeof j.outPath !== 'string' || seen.has(j.outPath.toLowerCase())) continue
    seen.add(j.outPath.toLowerCase())
    const s = (d.allowPath ?? (() => true))(j.outPath) ? await fileStat(j.outPath) : null
    if (s) out.push({ path: j.outPath, name: basename(j.outPath), bytes: s.bytes, fromQueue: true })
  }
  return out
}

/** Everything the dialog shows: the parts with their sizes, missing originals, exports, a target. */
export async function archiveInventory(d: ArchiveDeps, projectId: string): Promise<ArchiveInventory> {
  const now = d.now?.() ?? Date.now()
  const project = await d.projects.peek(projectId)
  const themeTracks = await d.themeMusic()
  const base = { themeTracks, themeMusicDir: d.themeMusicDir, allowPath: d.allowPath, now }
  // faces stay for the sizes: the project file is about as large either way
  const [all, show] = await Promise.all([planArchive(project, { leftOut: true, withoutFaceData: false }, base), planArchive(project, { leftOut: false, withoutFaceData: false }, base)])
  const of = (p: ArchivePlan, kind: ArchiveFile['kind']): ArchiveFile[] => p.files.filter((f) => f.kind === kind)
  const media = part(of(show, 'media'))
  const allMedia = part(of(all, 'media'))
  const showMissing = new Set(show.missing.map((m) => m.toLowerCase()))
  const missing: ArchiveMissing[] = all.missing.map((path) => ({ path, name: basename(path), leftOut: !showMissing.has(path.toLowerCase()) }))
  const json = Buffer.byteLength(JSON.stringify(all.project, null, 1))
  const theme = of(show, 'theme')[0]
  const target = defaultTarget(project.name, d.documentsDir, now)
  const inv: ArchiveInventory = {
    projectId: project.id,
    name: project.name,
    ...(project.deleteAt ? { deleteAt: project.deleteAt } : {}),
    media,
    leftOut: {
      files: allMedia.files - media.files,
      bytes: allMedia.bytes - media.bytes,
      items: project.media.length - showOnly(project).media.length
    },
    music: part(of(show, 'music')),
    ...(theme && show.theme ? { theme: { title: show.theme.title, bytes: theme.bytes } } : {}),
    exports: await finishedExports(d, project.id),
    // the project and the read-me (a few KB)
    project: { files: 2, bytes: json + 4096 },
    missing,
    faceData: hasFaceData(project),
    target,
    free: await (d.freeSpace ?? freeSpaceOf)(dirname(target)),
    maxFile: null
  }
  // the largest archive these choices can make: does the drive take files that large?
  return { ...inv, maxFile: await fileLimitFor(d, target, archiveSize(inv, true, inv.exports)) }
}

export interface WriteOptions {
  signal?: AbortSignal
  onProgress?: (p: ArchiveProgress) => void
  /** ZIP64 records everywhere (tests). */
  forceZip64?: boolean
  /** What the check after writing reads back (zip64.ts verifyZip). */
  checkAllUpTo?: number
  sampleBytes?: number
}

/** The videos of a choice that may go in: finished exports of the show, or files picked by the user (`picked`). */
export async function chosenVideos(d: ArchiveDeps, projectId: string, wanted: readonly string[], picked: ReadonlySet<string>): Promise<ArchiveVideo[]> {
  const exports = await finishedExports(d, projectId)
  const out: ArchiveVideo[] = []
  const seen = new Set<string>()
  for (const raw of wanted) {
    if (typeof raw !== 'string' || !raw) continue
    const key = resolve(raw).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const queued = exports.find((v) => resolve(v.path).toLowerCase() === key)
    if (queued) out.push(queued)
    else if (picked.has(key)) {
      const s = await fileStat(raw)
      if (s) out.push({ path: raw, name: basename(raw), bytes: s.bytes, fromQueue: false })
    } else throw new Error('this video was not offered for the archive')
  }
  return out
}

/** A video file the user may add ("Add another video file…"). */
export const isVideoFile = (path: string): boolean => VIDEO_EXT.includes(extname(path).slice(1).toLowerCase())

/**
 * Writes the archive of a show to `target` (a .zip): to a temp file next to it, checked after
 * writing, then put in place. Cancelling or a failure deletes the temp file; the target is only
 * replaced by a complete, checked archive.
 */
export async function writeArchive(d: ArchiveDeps, projectId: string, choice: ArchiveChoice, videos: readonly ArchiveVideo[], target: string, o: WriteOptions = {}): Promise<ArchiveResult> {
  if (typeof target !== 'string' || !/\.zip$/i.test(target)) throw new Error('the archive must be a .zip file')
  const out = resolve(target)
  const now = d.now?.() ?? Date.now()
  const project = await d.projects.peek(projectId)
  const themeTracks = await d.themeMusic()
  const plan = await planArchive(project, choice, { themeTracks, themeMusicDir: d.themeMusicDir, allowPath: d.allowPath, videos, now, locale: choice.lang === 'de' ? 'de-DE' : 'en-US' })
  if (plan.files.some((f) => resolve(f.src).toLowerCase() === out.toLowerCase())) throw new Error('the archive cannot replace one of its own files')

  // room for it all on the target drive
  const dataBytes = plan.files.reduce((n, f) => n + f.bytes, 0)
  const projectBytes = Buffer.byteLength(JSON.stringify(plan.project, null, 1))
  const needed = dataBytes + projectBytes + 16 * 1024 + (plan.files.length + 2) * ENTRY_OVERHEAD
  const free = await (d.freeSpace ?? freeSpaceOf)(dirname(out))
  if (free !== null && free < needed) throw new Error(`ENOSPC: not enough space on the target drive (${needed} bytes needed, ${free} free)`)
  // FAT32 (many USB sticks): no file of 4 GB or more; it would fail after writing most of it
  const maxFile = await fileLimitFor(d, out, needed)
  if (maxFile !== null && needed > maxFile) throw new Error(`EFBIG: the archive (${needed} bytes) is larger than the drive allows for one file (${maxFile} bytes, FAT32)`)

  const tmp = join(dirname(out), `${basename(out)}.${randomBytes(4).toString('hex')}.part`)
  let fh: FileHandle | null = await open(tmp, 'wx+')
  try {
    let done = 0
    let file: string | undefined
    const total = dataBytes + projectBytes
    let last = 0
    const report = (force = false): void => {
      const t = Date.now()
      if (!force && t - last < 100) return
      last = t
      o.onProgress?.({ phase: 'write', done: Math.min(done, total), total, file })
    }
    const zip = new ZipWriter(fileSink(fh), {
      signal: o.signal,
      forceZip64: o.forceZip64,
      onBytes: (n) => {
        done += n
        report()
      }
    })
    const lost: ArchiveFile[] = []
    for (const f of plan.files) {
      file = basename(f.rel)
      report(true)
      let src: FileHandle
      try {
        src = await open(f.src, 'r')
      } catch (err) {
        // gone since it was planned: skipped like a missing original
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        lost.push(f)
        continue
      }
      try {
        await zip.addStream(f.rel, fileSource(src), f.bytes, { mtime: f.mtime })
      } finally {
        await src.close().catch(() => {})
      }
    }
    let archived = plan.project
    const missing = [...plan.missing, ...lost.map((f) => f.src)]
    const lostTheme = lost.some((f) => f.kind === 'theme')
    if (lost.length) {
      const { media, music } = withAbsolute(archived, lost)
      archived = { ...archived, media, music }
      if (lostTheme) delete (archived as unknown as Record<string, unknown>)[ARCHIVED_THEME_SONG]
    }
    const written = plan.files.filter((f) => !lost.includes(f))
    const count = (kind: ArchiveFile['kind']): number => written.filter((f) => f.kind === kind).length
    const readme = readmeText(
      {
        name: project.name,
        projectFile: plan.projectFile,
        appVersion: d.appVersion,
        date: now,
        media: count('media'),
        music: count('music'),
        theme: plan.theme && plan.themeSong && !lostTheme ? { file: plan.themeSong.path, title: plan.theme.title, artist: plan.theme.artist, licence: plan.theme.licence } : undefined,
        videos: written.filter((f) => f.kind === 'video').map((f) => basename(f.rel)),
        leftOut: choice.leftOut ? 'included' : project.entries.some((e) => e.excluded) ? 'omitted' : 'none',
        faceData: !hasFaceData(project) ? 'none' : choice.withoutFaceData ? 'removed' : 'kept',
        missing: missing.map((p) => basename(p)),
        deleteAt: project.deleteAt
      },
      choice.lang
    )
    file = readmeName(choice.lang)
    await zip.addBuffer(file, Buffer.from(`\uFEFF${readme}`, 'utf8'), { deflate: true, mtime: now })
    file = plan.projectFile
    await zip.addBuffer(file, Buffer.from(JSON.stringify(archived, null, 1), 'utf8'), { deflate: true, mtime: now })
    report(true)
    const summary = await zip.close()

    // read it back: the directory, every header, and the data's CRC (or a spread sample of a huge archive)
    const verifyOpts = { checkAllUpTo: o.checkAllUpTo, sampleBytes: o.sampleBytes, signal: o.signal }
    const verifyTotal = verifyPlan(summary.entries, verifyOpts).reduce((n, i) => n + summary.entries[i].compressedSize, 0)
    let checked = 0
    o.onProgress?.({ phase: 'verify', done: 0, total: verifyTotal })
    const check = await verifyZip(fileInput(fh, summary.size), summary.entries, {
      ...verifyOpts,
      onBytes: (n) => {
        checked += n
        const t = Date.now()
        if (t - last < 100) return
        last = t
        o.onProgress?.({ phase: 'verify', done: Math.min(checked, verifyTotal), total: verifyTotal })
      }
    })
    o.onProgress?.({ phase: 'verify', done: verifyTotal, total: verifyTotal })
    await fh.close()
    fh = null
    if (o.signal?.aborted) throw abortError()
    await replaceFile(tmp, out)
    return {
      path: out,
      bytes: summary.size,
      files: summary.entries.length,
      media: count('media'),
      music: count('music'),
      videos: count('video'),
      theme: !!plan.themeSong && !lostTheme,
      missing: missing.map((p) => ({ name: basename(p), path: p })),
      ...(project.deleteAt ? { deleteAt: project.deleteAt } : {}),
      verified: { entries: check.entries, checked: check.checked }
    }
  } catch (err) {
    await fh?.close().catch(() => {})
    await rm(tmp, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    throw err
  }
}
