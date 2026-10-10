// Chapter marks of exported videos: the list built from the timeline, the YouTube text, the
// ffmetadata file, what the queue accepts, and the chapters in a joined MP4 (ffprobe -show_chapters).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildChapters, chapterMetadata, chapterStamp, chapterText } from '@shared/chapters'
import { buildTimeline } from '@shared/timeline'
import type { NewExportJob } from '@shared/exportQueue'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type Project } from '@shared/types'
import { openExportQueue } from '../src/main/export/queue'
import { validateChapters, validateNewJob } from '../src/main/export/validate'
import { ff, FFMPEG_DIR } from './helpers/media'

const photo = (id: string, w = 4000, h = 3000): MediaItem => ({
  id, path: `C:\\p\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: w, height: h,
  captureTime: Date.UTC(2026, 6, 12), status: 'ready', display: `C:\\c\\${id}.jpg`
})
const media = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => photo(id))
const p = (id: string): Entry => ({ id, type: 'photo', mediaId: id })

function project(entries: Entry[], patch: Partial<Project['settings']> = {}): Project {
  return { version: 1, id: 'p', name: 'Skicamp 2026', createdAt: 0, updatedAt: 0, entries, media, music: [], settings: { ...DEFAULT_SETTINGS, ...patch } }
}

const days: Entry[] = [
  { id: 'mo', type: 'text', title: 'Montag', subtitle: '12. Juli 2026', auto: 'day' },
  p('a'),
  p('b'),
  { id: 'di', type: 'text', title: 'Dienstag', subtitle: 'Unser erster Tag' },
  p('c'),
  p('d'),
  { id: 'end', type: 'text', title: 'Mitwirkende', subtitle: 'Anna\nBen\nCarla', titleStyle: 'credits' }
]

describe('chapter list', () => {
  it('starts with the show title, then every chapter slide at its start (title slide theme)', () => {
    const pr = project(days, { theme: 'origami', showTitle: true })
    const tl = buildTimeline(pr)
    const chapters = buildChapters(pr, tl)
    const start = (id: string): number => tl.slides.find((s) => s.id === id)!.start
    expect(chapters.map((c) => c.title)).toEqual(['Skicamp 2026', 'Montag – 12. Juli 2026', 'Dienstag – Unser erster Tag', 'Mitwirkende'])
    expect(chapters[0].start).toBe(0)
    expect(chapters[1].start).toBeCloseTo(start('mo'), 3)
    expect(chapters[2].start).toBeCloseTo(start('di'), 3)
    expect(chapters[3].start).toBeCloseTo(start('end'), 3)
    for (let i = 1; i < chapters.length; i++) expect(chapters[i].start).toBeGreaterThan(chapters[i - 1].start)
  })

  it('a chapter slide at the very start replaces the show title', () => {
    const pr = project(days, { theme: 'classic', showTitle: false, titleText: 'Nicht gezeigt' })
    const chapters = buildChapters(pr, buildTimeline(pr))
    expect(chapters[0]).toEqual({ start: 0, title: 'Montag – 12. Juli 2026' })
    expect(chapters).toHaveLength(3)
  })

  it('a show starting with a chapter slide keeps it: the title becomes a slide of its own (themes without title slide)', () => {
    for (const theme of ['kenburns', 'classic', 'retro'] as const) {
      const pr = project(days, { theme, showTitle: true })
      const tl = buildTimeline(pr)
      // before, the title overlay replaced the day title's text, so "Montag" was never shown
      expect(tl.slides.slice(0, 2).map((s) => [s.kind, s.title?.text, !!s.titleOverlay])).toEqual([['title', 'Skicamp 2026', false], ['text', 'Montag', false]])
      expect(buildChapters(pr, tl).map((c) => c.title)).toEqual(['Skicamp 2026', 'Montag – 12. Juli 2026', 'Dienstag – Unser erster Tag', 'Mitwirkende'])
      // a photo first still carries the title
      const photoFirst = buildTimeline(project([p('a'), ...days], { theme, showTitle: true }))
      expect(photoFirst.slides[0]).toMatchObject({ kind: 'photos', titleOverlay: true, title: { text: 'Skicamp 2026' } })
    }
  })

  it('without a title slide the show title (or the project name) still opens the list', () => {
    const pr = project([p('a'), p('b'), { id: 'di', type: 'text', title: 'Dienstag' }, p('c')], { theme: 'classic', showTitle: false })
    const chapters = buildChapters(pr, buildTimeline(pr))
    expect(chapters.map((c) => c.title)).toEqual(['Skicamp 2026', 'Dienstag'])
    const titled = project(pr.entries, { theme: 'classic', showTitle: false, titleText: '  Winter  ' })
    expect(buildChapters(titled, buildTimeline(titled))[0].title).toBe('Winter')
  })

  it('counts text slides shown as captions (Magazine) at the slide that shows them', () => {
    const pr = project([p('a'), p('b'), { id: 'di', type: 'text', title: 'Dienstag' }, p('c'), p('d'), p('e')], { theme: 'magazine', showTitle: true })
    const tl = buildTimeline(pr)
    const shown = tl.slides.find((s) => s.captionEntryId === 'di')!
    expect(shown).toBeDefined()
    expect(tl.slides.some((s) => s.kind === 'text')).toBe(false)
    const chapters = buildChapters(pr, tl)
    expect(chapters).toEqual([{ start: 0, title: 'Skicamp 2026' }, { start: Math.round(shown.start * 1000) / 1000, title: 'Dienstag' }])
  })

  it("leaves out a photo's own caption, empty and excluded text slides; long or multi-line subtitles stay out of the title", () => {
    const pr = project(
      [
        { ...p('a'), caption: 'Am Strand' } as Entry,
        { id: 'empty', type: 'text', title: '   ' },
        p('b'),
        { id: 'gone', type: 'text', title: 'Weg', excluded: true },
        p('c'),
        { id: 'long', type: 'text', title: 'Mittwoch', subtitle: 'x'.repeat(80) },
        p('d'),
        { id: 'only-sub', type: 'text', title: '', subtitle: 'Nur Untertitel' },
        p('e')
      ],
      { theme: 'classic', showTitle: true }
    )
    expect(buildChapters(pr, buildTimeline(pr)).map((c) => c.title)).toEqual(['Skicamp 2026', 'Mittwoch', 'Nur Untertitel'])
  })

  it('chapters closer than a second keep the earlier start with the later title', () => {
    const pr = project([{ id: 't1', type: 'text', title: 'Eins', duration: 0.5 }, { id: 't2', type: 'text', title: 'Zwei' }, p('a')], { theme: 'classic', showTitle: false })
    const tl = buildTimeline(pr)
    expect(tl.slides[1].start).toBeLessThan(1)
    expect(buildChapters(pr, tl)).toEqual([{ start: 0, title: 'Zwei' }])
  })

  it('formats the YouTube list and the ffmetadata file', () => {
    expect(chapterStamp(0)).toBe('0:00')
    expect(chapterStamp(59.99)).toBe('0:59')
    expect(chapterStamp(61)).toBe('1:01')
    expect(chapterStamp(3723.4)).toBe('1:02:03')
    const chapters = [{ start: 0, title: 'Skicamp' }, { start: 42.5, title: 'Dienstag – Pisten = Spaß; #1 \\ Tag' }]
    expect(chapterText(chapters)).toBe('0:00 Skicamp\n0:42 Dienstag – Pisten = Spaß; #1 \\ Tag')
    const meta = chapterMetadata([...chapters, { start: 90, title: 'after the end' }], 60)
    expect(meta).toBe(
      [';FFMETADATA1', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=42500', 'title=Skicamp',
        '[CHAPTER]', 'TIMEBASE=1/1000', 'START=42500', 'END=60000', 'title=Dienstag – Pisten \\= Spaß\\; \\#1 \\\\ Tag', ''].join('\n')
    )
  })
})

describe('chapters in the export queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diashow-chapters-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  let tone = ''
  beforeAll(async () => {
    tone = join(dir, 'tone.wav')
    await ff.run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', tone])
  })

  const W = 160
  const H = 90
  const FPS = 30
  const DURATION = 2.5
  const job = (name: string, chapters?: unknown): NewExportJob =>
    ({
      name,
      project: project([p('a')]),
      request: { outPath: join(dir, `${name}.mp4`), width: W, height: H, fps: FPS, codec: 'h264', quality: 'standard', hardware: false, locale: 'de-DE' },
      audio: { duration: DURATION, clips: [{ id: 'm', kind: 'music', src: tone, start: 0, offset: 0, duration: DURATION, gain: [{ t: 0, g: 0.5 }] }] },
      ...(chapters !== undefined ? { chapters } : {})
    }) as NewExportJob

  it('validates the chapters the renderer sends', () => {
    const ok = validateNewJob(job('ok', [{ start: 0, title: ' Skicamp\n2026 ' }, { start: 1.25, title: 'Dienstag' }]))
    expect(ok.chapters).toEqual([{ start: 0, title: 'Skicamp 2026' }, { start: 1.25, title: 'Dienstag' }])
    expect(validateNewJob(job('none')).chapters).toBeUndefined()
    expect(validateNewJob(job('empty', [])).chapters).toBeUndefined()
    expect(validateChapters([{ start: 0, title: 'x'.repeat(500) }], 10)![0].title).toHaveLength(200)
    const bad: [unknown, RegExp][] = [
      ['all', /invalid chapters/],
      [{ start: 0, title: 'a' }, /invalid chapters/],
      [Array.from({ length: 1001 }, (_, i) => ({ start: i / 1000, title: 'a' })), /invalid chapters/],
      [[null], /chapter 0 invalid/],
      [[{ start: -1, title: 'a' }], /invalid start/],
      [[{ start: Number.NaN, title: 'a' }], /invalid start/],
      [[{ start: '0', title: 'a' }], /invalid start/],
      [[{ start: DURATION, title: 'after the end' }], /invalid start/],
      [[{ start: 0, title: 'a' }, { start: 0, title: 'b' }], /ascending/],
      [[{ start: 1, title: 'a' }, { start: 0.5, title: 'b' }], /ascending/],
      [[{ start: 0, title: '  \n ' }], /invalid title/],
      [[{ start: 0, title: 42 }], /invalid title/]
    ]
    for (const [chapters, err] of bad) expect(() => validateNewJob(job('bad', chapters)), JSON.stringify(chapters).slice(0, 60)).toThrow(err)
  })

  it('writes the chapters into the joined MP4 without re-encoding', async () => {
    const q = await openExportQueue({ dir: join(dir, 'queue'), ffmpegDir: FFMPEG_DIR, segmentSeconds: 1 })
    const chapters = [{ start: 0, title: 'Skicamp 2026' }, { start: 1.2, title: 'Dienstag – Ski = Spaß; #1' }, { start: 2, title: 'Mitwirkende' }]
    const info = await q.add(job('with-chapters', chapters))
    expect(info.chapters).toEqual(chapters)
    const task = (await q.next())!
    const frame = new Uint8Array((W * H * 3) / 2).fill(128)
    for (const k of task.segments) {
      await q.segmentStart(task.jobId, k, 'yuv')
      for (let i = k * task.segmentFrames; i < Math.min(task.totalFrames, (k + 1) * task.segmentFrames); i++) await q.writeFrame(frame)
      await q.segmentFinish(task.jobId, k)
    }
    expect(await q.next()).toBeNull()
    const [done] = q.list()
    expect(done).toMatchObject({ state: 'done', chapters })
    // kept in job.json; the ffmetadata file was a work file
    expect(JSON.parse(readFileSync(join(q.dir, done.id, 'job.json'), 'utf8')).chapters).toEqual(chapters)
    const probe = JSON.parse(
      execFileSync(ff.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_chapters', '-show_streams', done.outPath]).toString('utf8')
    ) as { chapters: { start_time: string; end_time: string; tags?: { title?: string } }[]; streams: { codec_type: string; codec_name: string; nb_frames?: string }[] }
    expect(probe.chapters.map((c) => c.tags?.title)).toEqual(chapters.map((c) => c.title))
    expect(probe.chapters.map((c) => Number(c.start_time))).toEqual([0, 1.2, 2])
    expect(probe.chapters.map((c) => Number(c.end_time))).toEqual([1.2, 2, DURATION])
    const video = probe.streams.find((s) => s.codec_type === 'video')!
    expect(video.codec_name).toBe('h264')
    expect(Number(video.nb_frames)).toBe(Math.ceil(DURATION * FPS))
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true)

    // a job without chapters gets none
    const plain = await q.add(job('without-chapters'))
    expect(plain.chapters).toBeUndefined()
    const t2 = (await q.next())!
    for (const k of t2.segments) {
      await q.segmentStart(t2.jobId, k, 'yuv')
      for (let i = k * t2.segmentFrames; i < Math.min(t2.totalFrames, (k + 1) * t2.segmentFrames); i++) await q.writeFrame(frame)
      await q.segmentFinish(t2.jobId, k)
    }
    expect(await q.next()).toBeNull()
    const none = JSON.parse(execFileSync(ff.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_chapters', plain.outPath]).toString('utf8'))
    expect(none.chapters).toEqual([])
    await q.close()
  })
})
