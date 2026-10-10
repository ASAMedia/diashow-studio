// Diagnostics: friendly error kinds, cleaning of log text (profile paths, media content, tokens), the
// rotating log file, the zip writer, the diagnostics package (counts only, no names or paths) and the
// rate limits for reports from the windows.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { classifyError, errorMessage } from '@shared/friendlyError'
import { DEFAULT_SETTINGS, type Project } from '@shared/types'
import type { SystemInfo } from '@shared/systemCheck'
import { createLogger, logFileName } from '../src/main/diagnostics/logger'
import { packageFiles, previewOf, projectSummary, zipOf, type PackageSources } from '../src/main/diagnostics/package'
import { redact } from '../src/main/diagnostics/redact'
import { buildZip, crc32, readZip } from '../src/main/diagnostics/zip'
import { createReporter, describeValue } from '@shared/logReport'

vi.mock('electron', () => ({ app: { on: vi.fn(), whenReady: () => new Promise(() => {}) }, ipcMain: { on: vi.fn(), handle: vi.fn() }, session: {}, shell: {}, BrowserWindow: {}, dialog: {} }))
const { cleanEntry, rateLimiter } = await import('../src/main/diagnostics/index')
const { requestAllowed } = await import('../src/main/security')

const tmp = mkdtempSync(join(tmpdir(), 'diashow-diag-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

describe('friendly error kinds', () => {
  const cases: [string, Parameters<typeof classifyError>[1], string | null][] = [
    ['Video could not be converted: spawn C:\\app\\ffmpeg.exe ENOENT', 'import', 'ffmpegMissing'],
    ['ENOSPC: no space left on device, write', 'export', 'diskFull'],
    ["EBUSY: resource busy or locked, unlink 'C:\\x\\a.mp4'", 'export', 'fileLocked'],
    ["EPERM: operation not permitted, rename 'a.tmp' -> 'b.dshow'", 'save', 'fileLocked'],
    ["ENOENT: no such file or directory, open 'C:\\Fotos\\a.jpg'", 'import', 'fileMissing'],
    ['Photo could not be read: Input buffer contains unsupported image format', 'import', 'unsupportedFile'],
    ['Unsupported or damaged video: moov atom not found', 'import', 'unsupportedFile'],
    ['something odd happened', 'import', 'unsupportedFile'],
    ['OpenEncodeSessionEx failed: unsupported device (2): (no details)', 'export', 'encoderFailed'],
    ['the show has 300 frames, the export expects 310', 'export', 'encoderFailed'],
    ['something odd happened', 'export', 'encoderFailed'],
    ['listen EADDRINUSE: address already in use 192.168.1.5', 'share', 'portBlocked'],
    ['listen EACCES: permission denied 192.168.1.5', 'share', 'portBlocked'],
    ['no-network', 'share', 'noNetwork'],
    ['WebGL context lost', 'export', 'gpuLost'],
    ["Error invoking remote method 'project:load': Error: project-damaged: Unexpected end of JSON input", 'project', 'projectDamaged'],
    ['project-too-new: the file has format 3, this app reads up to format 1', 'project', 'projectTooNew'],
    ['something odd happened', 'project', null],
    ['cancelled', 'export', null]
  ]
  it.each(cases)('%s (%s) → %s', (msg, ctx, kind) => {
    expect(classifyError(new Error(msg), ctx)).toBe(kind)
  })

  it('strips the IPC prefix from messages', () => {
    expect(errorMessage(new Error("Error invoking remote method 'x:y': Error: disk full"))).toBe('disk full')
    expect(errorMessage({ message: 'plain object' })).toBe('plain object')
    expect(errorMessage(undefined)).toBe('')
  })
})

describe('log text cleaning', () => {
  const home = 'C:\\Users\\Anna Schmidt'
  it('shortens the user profile in every spelling, and hides other profiles', () => {
    const text = [
      'C:\\Users\\Anna Schmidt\\Pictures\\Klasse 7b\\IMG_1.jpg',
      'c:/users/anna schmidt/Desktop/x.mp4',
      'dsmedia://f/C%3A%5CUsers%5CAnna%20Schmidt%5CPictures%5Ca.jpg',
      '"C:\\\\Users\\\\Anna Schmidt\\\\AppData"',
      'C:\\Users\\Anna Schmidtke\\x.jpg',
      'D:\\Users\\Bernd\\Videos\\clip.mov',
      'C:\\Users\\Public\\Pictures\\p.jpg'
    ].join('\n')
    expect(redact(text, { home }).split('\n')).toEqual([
      '%USERPROFILE%\\Pictures\\Klasse 7b\\IMG_1.jpg',
      '%USERPROFILE%/Desktop/x.mp4',
      'dsmedia://f/%USERPROFILE%%5CPictures%5Ca.jpg',
      '"%USERPROFILE%\\\\AppData"',
      'C:\\Users\\<user>\\x.jpg',
      'D:\\Users\\<user>\\Videos\\clip.mov',
      'C:\\Users\\Public\\Pictures\\p.jpg'
    ])
  })

  it('removes media content, face descriptors and share tokens', () => {
    const descriptor = Array.from({ length: 128 }, (_, i) => (i / 1000 - 0.05).toFixed(4)).join(',')
    const out = redact(`img data:image/jpeg;base64,${'A'.repeat(500)} desc [${descriptor}] b64 ${'x'.repeat(300)} url http://192.168.1.5:51234/${'k'.repeat(32)}/upload`, { home })
    expect(out).toContain('data:image/jpeg,<removed>')
    expect(out).toContain('<128 numbers>')
    expect(out).toContain('<base64 300 chars>')
    expect(out).toContain('http://192.168.1.5:51234/<token>/upload')
    expect(out).not.toContain('0.0010')
  })

  it('caps long text quickly (no runaway patterns)', () => {
    const t0 = performance.now()
    const out = redact('9'.repeat(200_000) + ','.repeat(1000), { maxLength: 1000 })
    expect(out.length).toBeLessThanOrEqual(1001)
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe('rotating log file', () => {
  it('writes cleaned, time-stamped lines and keeps the newest files', () => {
    const dir = join(tmp, 'logs')
    let clock = Date.UTC(2026, 9, 10, 12)
    const log = createLogger({ dir, maxBytes: 600, keep: 2, home: 'C:\\Users\\anna', now: () => clock++ })
    log.info('app', 'start')
    log.error('main', 'failed at C:\\Users\\anna\\Pictures\\x.jpg', 'boom')
    const first = readFileSync(log.file, 'utf8')
    expect(first).toMatch(/^2026-10-10T12:00:00\.000Z INFO  app: start\n/)
    expect(first).toContain('ERROR main: failed at %USERPROFILE%\\Pictures\\x.jpg\n    boom')
    for (let i = 0; i < 40; i++) log.warn('loop', `line ${i} ${'.'.repeat(40)}`)
    const files = log.files()
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual([logFileName(0), logFileName(1), logFileName(2)])
    expect(existsSync(join(dir, logFileName(3)))).toBe(false)
    for (const f of files) expect(readFileSync(f).length).toBeLessThanOrEqual(600)
    expect(readFileSync(files[0], 'utf8')).toContain('line 39')
  })

  it('never throws, even when the folder cannot be created', () => {
    const log = createLogger({ dir: join(tmp, 'logs', 'diashow.log', 'sub'), maxBytes: 100 })
    expect(() => log.error('x', 'y')).not.toThrow()
  })
})

describe('zip writer', () => {
  it('writes deflated UTF-8 entries that read back intact', () => {
    const data = [
      { name: 'README.txt', data: 'Grüße\n'.repeat(100) },
      { name: 'logs/diashow.log', data: Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 7)) },
      { name: 'leer.txt', data: '' }
    ]
    const zip = buildZip(data, Date.UTC(2026, 0, 1))
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    const back = readZip(zip)
    expect(back.map((e) => e.name)).toEqual(['README.txt', 'logs/diashow.log', 'leer.txt'])
    expect(back[0].data.toString('utf8')).toBe('Grüße\n'.repeat(100))
    expect(back[1].data.equals(data[1].data as Buffer)).toBe(true)
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(() => buildZip([{ name: '../evil.txt', data: 'x' }])).toThrow(/invalid zip entry/)
  })
})

function project(): Project {
  return {
    version: 1,
    id: 'p1',
    name: 'Abschied von Frau Müller',
    createdAt: 1,
    updatedAt: 2,
    entries: [
      { id: 't', type: 'text', title: 'Lisa und Tom', subtitle: 'Klasse 7b' },
      { id: 'a', type: 'photo', mediaId: 'm1', caption: 'Lisa am Strand', privacy: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] },
      { id: 'b', type: 'video', mediaId: 'm2', excluded: true }
    ],
    media: [
      { id: 'm1', path: 'C:\\Users\\anna\\Pictures\\Lisa_Strand.jpg', name: 'Lisa_Strand.jpg', kind: 'photo', format: 'HEIC', device: 'iPhone 15', width: 4032, height: 3024, captureTime: 0, status: 'ready', faces: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], faceDesc: [[0.11, 0.22, 0.33]] },
      { id: 'm2', path: 'C:\\Users\\anna\\Videos\\Tom.mov', name: 'Tom.mov', kind: 'video', format: 'MOV · HEVC 10-bit', width: 3840, height: 2160, duration: 30, captureTime: 0, status: 'error', error: 'Video could not be converted: Invalid data found when processing input' }
    ],
    music: [{ id: 's', path: 'D:\\Musik\\Lieblingslied.mp3', title: 'Lieblingslied', duration: 200, status: 'ready' }],
    settings: structuredClone(DEFAULT_SETTINGS),
    people: [{ id: 'x', name: 'Lisa', desc: [[0.5, 0.4]] }]
  }
}

describe('diagnostics package', () => {
  const system = {
    gpu: { devices: [{ vendor: 'NVIDIA', device: 'RTX 4060', driver: '1.2', active: true }], features: { webgl2: 'enabled' } },
    encoders: { h264: ['libx264', 'h264_nvenc'], hevc: ['libx265'], hardware: { h264: 'h264_nvenc' } },
    hevcDirect: true,
    tonemap: null,
    cpu: { model: 'CPU', threads: 16 },
    memory: { total: 16e9, free: 8e9 },
    disk: { path: 'C:\\Users\\anna\\AppData\\Roaming\\Diashow Studio\\cache', free: 1e11, total: 5e11 },
    versions: { app: '1.0.0', electron: '44', chrome: '1', node: '22', ffmpeg: '9', windows: 'Windows 11' }
  } as SystemInfo
  const src = (): PackageSources => ({
    now: Date.UTC(2026, 9, 10),
    home: 'C:\\Users\\anna',
    versions: { app: '1.0.0' },
    system,
    settings: { kioskProjectId: null },
    input: { projectId: 'p1', renderer: { previewQuality: 'high' }, exportJobs: [{ state: 'error', width: 1920, height: 1080, codec: 'h264', error: 'nvenc failed' }] },
    project: project(),
    sizes: new Map([['m1', 3_000_000]]),
    projects: [{ slides: 3 }, { slides: 10 }],
    damaged: [],
    logs: [{ name: 'diashow.log', text: 'error at C:\\Users\\anna\\Pictures\\x.jpg' }]
  })

  it('summarises the project by counts, formats and sizes only', () => {
    const s = projectSummary(project(), new Map([['m1', 3_000_000]])) as Record<string, any>
    expect(s.slides).toEqual({ total: 3, photo: 1, video: 1, text: 1, excluded: 1, withTextBoxes: 0, withPixelation: 1 })
    expect(s.media.formats).toEqual({ 'photo: HEIC': 1, 'video: MOV · HEVC 10-bit': 1 })
    expect(s.media.errors).toEqual({ unsupportedFile: 1 })
    expect(s.media.sizeClasses).toEqual({ 'photo: 8-20 MP': 1, 'video: 4K+': 1 })
    expect(s.music).toMatchObject({ tracks: 1, formats: { mp3: 1 } })
    expect(s.people).toBe(1)
  })

  it('holds no names, captions, paths or face data of the project', () => {
    const files = packageFiles(src())
    expect(files.map((f) => f.name)).toEqual(['README.txt', 'versions.txt', 'system-check.txt', 'settings.json', 'project-summary.json', 'export-queue.json', 'logs/diashow.log'])
    const all = files.map((f) => f.text).join('\n')
    for (const secret of ['Müller', 'Lisa', 'Tom', 'Strand', 'Klasse 7b', 'Lieblingslied', 'anna', '0.11', 'Abschied']) expect([secret, all.includes(secret)]).toEqual([secret, false])
    expect(all).toContain('%USERPROFILE%')
    // the zip holds exactly what the preview shows
    const zipped = readZip(zipOf(files, Date.UTC(2026, 9, 10)))
    expect(zipped.map((e) => e.data.toString('utf8'))).toEqual(files.map((f) => f.text))
    expect(previewOf(files).every((f) => f.bytes > 0)).toBe(true)
  })
})

describe('reports from the windows', () => {
  it('folds repeats and limits the rate in the renderer', () => {
    const sent: { message: string; repeat?: number }[] = []
    let clock = 0
    const report = createReporter((e) => sent.push(e), () => clock)
    for (let i = 0; i < 5; i++) report({ kind: 'error', message: 'same' })
    report({ kind: 'error', message: 'other' })
    expect(sent).toEqual([
      { kind: 'error', message: 'same' },
      { kind: 'error', message: 'same', repeat: 5 },
      { kind: 'error', message: 'other' }
    ])
    for (let i = 0; i < 100; i++) report({ kind: 'console', message: `m${i}` })
    expect(sent.filter((e) => e.message.startsWith('m')).length).toBeLessThanOrEqual(30)
    clock += 61_000
    report({ kind: 'console', message: 'later' })
    expect(sent.at(-1)!.message).toBe('later')
    expect(describeValue({ a: 1, b: [1, 2] })).toBe('[Object {a, b}]')
    expect(describeValue([1, 2, 3])).toBe('[array(3)]')
  })

  it('checks and caps what the main process logs', () => {
    expect(cleanEntry({ kind: 'weird', message: 'x'.repeat(5000), stack: 'y'.repeat(9000), repeat: 3 })).toEqual({ kind: 'error', message: 'x'.repeat(2000), stack: 'y'.repeat(4000), repeat: 3 })
    expect(cleanEntry({ kind: 'error', message: '' })).toBeNull()
    expect(cleanEntry('nope')).toBeNull()
    let clock = 0
    const allow = rateLimiter(3, 1000, () => clock)
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false])
    clock += 1000
    expect([allow(), allow()]).toEqual([true, false])
  })

  it('keeps the app pages off the internet', () => {
    expect(requestAllowed('https://odml.pa.googleapis.com/x', true, undefined)).toBe(false)
    expect(requestAllowed('http://192.168.1.5:5000/', true, undefined)).toBe(false)
    expect(requestAllowed('ws://localhost:5173/', true, 'http://localhost:5173')).toBe(true)
    // not an app page (a test window on the share server): left alone
    expect(requestAllowed('http://127.0.0.1:5000/t/', false, undefined)).toBe(true)
  })
})
