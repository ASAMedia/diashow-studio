// Project files (.dshow): format versions, migrations, validation and rescuing damaged files.
//
// - Format version: `Project.version`. MIGRATIONS[n] turns a version-n file into version n+1; files of
//   older versions run through the chain when they are read. A file newer than PROJECT_VERSION is
//   refused with a "project-too-new" error (the UI asks to update the app) instead of being guessed at.
// - Validation: every project read from disk goes through validateProject. What would break the editor
//   (an entry without type, a slide whose photo is not in the media list, a text box without numbers…)
//   is dropped or repaired, and the changes are counted in a RepairReport the UI shows. Fields this
//   version does not know are kept as they are (a newer app's additions survive a round trip).
// - Rescue: salvageJson reads what is left of a cut-off file (power loss while saving).
// Pure, no Electron.
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { classify } from '@shared/formats'
import { validDeleteAt } from '@shared/cleanup'
import type { RepairCode, RepairReport } from '@shared/diagnostics'
import { PROJECT_DAMAGED, PROJECT_TOO_NEW } from '@shared/friendlyError'
import { LOOKS, THEMES, TRANSITIONS } from '@shared/themes'
import { sanitizeEdit } from '@shared/mediaEdit'
import { DEFAULT_SETTINGS, DEFAULT_TEXT_STYLE, type Project } from '@shared/types'

/** Format version this app writes. */
export const PROJECT_VERSION = 1
/** Oldest format there ever was; files without a version are taken as this one. */
export const OLDEST_VERSION = 1

type Data = Record<string, unknown>
export type Migration = (data: Data) => Data

/**
 * MIGRATIONS[n]: version n → n + 1. Empty while the format is still at its first version; a change
 * to the format adds the step here and raises PROJECT_VERSION (tests/projectSchema.test.ts shows how).
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {}

export class ProjectFormatError extends Error {
  constructor(
    readonly code: 'damaged' | 'too-new',
    message: string,
    readonly version?: number
  ) {
    super(message)
    this.name = 'ProjectFormatError'
  }
}

const isObj = (v: unknown): v is Data => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): v is string => typeof v === 'string'
const ID = /^[A-Za-z0-9_-]{1,128}$/

/** Counts changes for the report. */
class Changes {
  private counts = new Map<RepairCode, number>()
  add(code: RepairCode, n = 1): void {
    if (n > 0) this.counts.set(code, (this.counts.get(code) ?? 0) + n)
  }
  report(fromVersion?: number): RepairReport {
    const changes = [...this.counts.entries()].map(([code, count]) => ({ code, count }))
    return fromVersion !== undefined ? { fromVersion, changes } : { changes }
  }
}

// ---------------------------------------------------------------- versions and migrations

/** The format version a file claims, or null when it has none (or nonsense). */
export function formatVersion(data: unknown): number | null {
  const v = isObj(data) ? data.version : undefined
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

export interface MigrateOptions {
  current?: number
  migrations?: Readonly<Record<number, Migration>>
}

/** Brings a file to the current format; throws "project-too-new" for files of a newer app. */
export function migrateProject(data: Data, opts: MigrateOptions = {}): { data: Data; fromVersion?: number } {
  const current = opts.current ?? PROJECT_VERSION
  const migrations = opts.migrations ?? MIGRATIONS
  const claimed = formatVersion(data)
  if (claimed !== null && claimed > current) {
    throw new ProjectFormatError('too-new', `${PROJECT_TOO_NEW}: the file has format ${claimed}, this app reads up to format ${current}`, claimed)
  }
  let v = Math.max(OLDEST_VERSION, claimed ?? OLDEST_VERSION)
  const from = v
  let out: Data = { ...data }
  while (v < current) {
    const step = migrations[v]
    if (!step) throw new ProjectFormatError('damaged', `${PROJECT_DAMAGED}: no way from format ${v} to ${v + 1}`)
    out = { ...step(out), version: v + 1 }
    v++
  }
  out.version = current
  return from < current ? { data: out, fromVersion: from } : { data: out }
}

// ---------------------------------------------------------------- rescuing cut-off files

/**
 * Reads what is left of JSON that was cut off (or broken somewhere): the text up to the last complete
 * value, with the open brackets closed. undefined when not even the start is readable.
 */
export function salvageJson(text: string): { value: unknown; usedChars: number } | undefined {
  type Frame = { kind: '{' | '['; expect: 'key' | 'colon' | 'value' | 'comma' }
  const frames: Frame[] = []
  const cuts: { pos: number; closers: string }[] = []
  const closers = (): string =>
    frames
      .map((f) => (f.kind === '{' ? '}' : ']'))
      .reverse()
      .join('')
  const valueDone = (end: number): void => {
    const top = frames[frames.length - 1]
    if (!top) return
    top.expect = 'comma'
    cuts.push({ pos: end, closers: closers() })
  }
  const n = text.length
  let i = 0
  scan: while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i++
      continue
    }
    const top = frames[frames.length - 1]
    switch (c) {
      case '"': {
        let j = i + 1
        while (j < n && text[j] !== '"') {
          // raw control characters (zero bytes of a damaged sector) never occur in valid JSON strings
          if (text.charCodeAt(j) < 0x20) break scan
          j += text[j] === '\\' ? 2 : 1
        }
        if (j >= n) break scan
        j++
        if (top?.kind === '{' && top.expect === 'key') top.expect = 'colon'
        else valueDone(j)
        i = j
        continue
      }
      case '{':
      case '[':
        if (top && top.expect !== 'value') break scan
        frames.push({ kind: c, expect: c === '{' ? 'key' : 'value' })
        cuts.push({ pos: i + 1, closers: closers() })
        i++
        continue
      case '}':
      case ']':
        if (!top || (c === '}') !== (top.kind === '{')) break scan
        frames.pop()
        valueDone(i + 1)
        i++
        continue
      case ':':
        if (!top || top.expect !== 'colon') break scan
        top.expect = 'value'
        i++
        continue
      case ',':
        if (!top || top.expect !== 'comma') break scan
        top.expect = top.kind === '{' ? 'key' : 'value'
        i++
        continue
      default: {
        const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64))
        // a number right at the end may itself be cut off (12 of 125)
        if (!m || !top || top.expect !== 'value' || i + m[0].length >= n) break scan
        valueDone(i + m[0].length)
        i += m[0].length
      }
    }
  }
  // the last cuts first; then ever larger steps back, in case the damage is further up than the scan saw
  const tried = new Set<number>()
  const attempt = (k: number): { value: unknown; usedChars: number } | undefined => {
    if (k < 0 || tried.has(k)) return undefined
    tried.add(k)
    const cut = cuts[k]
    try {
      return { value: JSON.parse(text.slice(0, cut.pos) + cut.closers), usedChars: cut.pos }
    } catch {
      return undefined
    }
  }
  const last = cuts.length - 1
  for (let k = last; k >= Math.max(0, last - 8); k--) {
    const r = attempt(k)
    if (r) return r
  }
  for (let step = 16; last - step >= 0; step *= 2) {
    const r = attempt(last - step)
    if (r) return r
  }
  return attempt(0)
}

/** Text of a project file without BOM and without the zero bytes a power loss can leave at the end. */
export function cleanProjectText(text: string): string {
  return text.replace(/^﻿/, '').replace(/[\u0000\s]+$/, '')
}

// ---------------------------------------------------------------- validation

const ASPECTS = ['16:9', '4:3', '1:1', '9:16']
const DIRECTIONS = ['left', 'right', 'up', 'down']
const ENTRY_TYPES = ['photo', 'video', 'text']
const MEDIA_STATUS = ['pending', 'processing', 'ready', 'error']
const DERIVED = ['thumb', 'display', 'playback', 'audio', 'liveVideo', 'stabilized'] as const

function rect(v: unknown): boolean {
  return isObj(v) && num(v.x) && num(v.y) && num(v.w) && num(v.h)
}

/** Drops the given keys when their value fails `ok`; returns how many were dropped. */
function dropBad(o: Data, keys: string[], ok: (v: unknown) => boolean): number {
  let n = 0
  for (const k of keys) {
    if (o[k] !== undefined && !ok(o[k])) {
      delete o[k]
      n++
    }
  }
  return n
}

const numberList = (v: unknown): v is number[] => Array.isArray(v) && v.every(num)

/** Valid rects of a list; `bad` counts the dropped ones. */
function rects(v: unknown, bad: { n: number }): Data[] | undefined {
  if (!Array.isArray(v)) {
    if (v !== undefined) bad.n++
    return undefined
  }
  const ok = v.filter(rect) as Data[]
  bad.n += v.length - ok.length
  return ok
}

function validateMedia(raw: unknown): { item: Data | null; repaired: boolean } {
  if (!isObj(raw) || !str(raw.id) || !raw.id || !str(raw.path) || !raw.path) return { item: null, repaired: false }
  const m: Data = { ...raw }
  let fixes = 0
  if (m.kind !== 'photo' && m.kind !== 'video') {
    const kind = classify(m.path as string)
    if (kind !== 'photo' && kind !== 'video') return { item: null, repaired: false }
    m.kind = kind
    fixes++
  }
  if (!str(m.name)) {
    m.name = basename(m.path as string)
    fixes++
  }
  if (!str(m.format)) {
    m.format = ''
    fixes++
  }
  if (!num(m.captureTime)) {
    m.captureTime = 0
    fixes++
  }
  let reprocess = false
  if (!(num(m.width) && m.width > 0 && num(m.height) && m.height > 0)) {
    m.width = num(m.width) && m.width > 0 ? m.width : 1
    m.height = num(m.height) && m.height > 0 ? m.height : 1
    reprocess = true
  }
  if (!MEDIA_STATUS.includes(m.status as string)) reprocess = true
  fixes += dropBad(m, [...DERIVED, 'format', 'device', 'error', 'hash', 'hash2'], str)
  fixes += dropBad(m, ['duration', 'fps', 'progress', 'sharpness', 'loudness', 'bitrate', 'stabilizing'], num)
  fixes += dropBad(m, ['hasAudio', 'hdr', 'proxied'], (v) => typeof v === 'boolean')
  fixes += dropBad(m, ['faceFocus'], (v) => isObj(v) && num(v.x) && num(v.y) && v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1)
  if (m.live !== undefined && !(isObj(m.live) && str(m.live.source) && m.live.source && num(m.live.duration))) {
    delete m.live
    fixes++
  }
  if (m.faces !== undefined) {
    const bad = { n: 0 }
    const faces = rects(m.faces, bad)
    if (bad.n) {
      fixes++
      if (faces) m.faces = faces
      else delete m.faces
      // descriptors are aligned with the faces: no longer trustworthy
      delete m.faceDesc
    }
  }
  if (m.faceDesc !== undefined && !(Array.isArray(m.faceDesc) && m.faceDesc.every(numberList) && Array.isArray(m.faces) && m.faceDesc.length === m.faces.length)) {
    delete m.faceDesc
    fixes++
  }
  if (m.videoFaces !== undefined) {
    const ok = Array.isArray(m.videoFaces) && m.videoFaces.every((s) => isObj(s) && num(s.t) && Array.isArray(s.faces) && s.faces.every(rect))
    if (!ok) {
      delete m.videoFaces
      fixes++
    }
  }
  if (m.edit !== undefined) {
    // rotate / straighten / crop: bad numbers rounded or clamped, nonsense dropped (shows the unedited picture)
    const { edit, fixed } = sanitizeEdit(m.edit)
    if (edit) m.edit = edit
    else delete m.edit
    if (fixed) fixes++
  }
  if (reprocess) {
    // a fresh pass through the pipeline rebuilds what is missing
    m.status = 'pending'
    for (const k of DERIVED) delete m[k]
    delete m.progress
    delete m.error
    fixes++
  }
  return { item: m, repaired: fixes > 0 }
}

function validateTrack(raw: unknown): { track: Data | null; repaired: boolean } {
  if (!isObj(raw) || !str(raw.id) || !raw.id || !str(raw.path) || !raw.path) return { track: null, repaired: false }
  const t: Data = { ...raw }
  let fixes = 0
  if (!str(t.title)) {
    t.title = basename(t.path as string).replace(/\.[^.]+$/, '')
    fixes++
  }
  if (!(num(t.duration) && t.duration >= 0)) {
    t.duration = 0
    t.status = 'pending'
    fixes++
  }
  if (!MEDIA_STATUS.includes(t.status as string)) {
    t.status = 'pending'
    fixes++
  }
  fixes += dropBad(t, ['artist', 'error', 'playback'], str)
  fixes += dropBad(t, ['bpm', 'loudness', 'trimIn', 'trimOut'], num)
  fixes += dropBad(t, ['beats'], numberList)
  return { track: t, repaired: fixes > 0 }
}

function validFreeText(v: unknown): boolean {
  return isObj(v) && str(v.id) && str(v.text) && num(v.x) && num(v.y) && num(v.size) && v.size > 0 && (v.rotation === undefined || num(v.rotation))
}

function validateEntry(raw: Data, mediaKinds: Map<string, string>): { entry: Data | null; missingMedia: boolean; repaired: boolean } {
  const e: Data = { ...raw }
  let fixes = 0
  if (e.type === 'photo' || e.type === 'video') {
    if (!str(e.mediaId) || !mediaKinds.has(e.mediaId)) return { entry: null, missingMedia: true, repaired: false }
  } else if (e.type === 'text') {
    if (!str(e.title)) {
      e.title = ''
      fixes++
    }
    fixes += dropBad(e, ['subtitle', 'auto', 'titleStyle'], str)
    fixes += dropBad(e, ['music'], (v) => Array.isArray(v) && v.every(str))
  }
  fixes += dropBad(e, ['duration'], (v) => num(v) && v > 0)
  fixes += dropBad(e, ['groupBreak', 'caption', 'layout'], str)
  fixes += dropBad(e, ['excluded'], (v) => typeof v === 'boolean')
  fixes += dropBad(e, ['rating'], (v) => num(v) && v >= 0 && v <= 5)
  fixes += dropBad(e, ['place'], (v) => rect(v) && num((v as Data).rot) && num((v as Data).z))
  if (e.texts !== undefined) {
    if (!Array.isArray(e.texts)) {
      delete e.texts
      fixes++
    } else {
      const ok = e.texts.filter(validFreeText)
      if (ok.length !== e.texts.length) {
        fixes++
        if (ok.length) e.texts = ok
        else delete e.texts
      }
    }
  }
  if (e.type === 'photo' || e.type === 'video') {
    fixes += dropBad(e, ['crop'], (v) => isObj(v) && num(v.x) && num(v.y) && num(v.zoom))
    fixes += dropBad(e, ['whole'], (v) => typeof v === 'boolean')
    if (e.privacy !== undefined) {
      const bad = { n: 0 }
      const list = rects(e.privacy, bad)
      if (bad.n) {
        fixes++
        if (list) e.privacy = list
        else delete e.privacy
      }
    }
  }
  if (e.type === 'photo') {
    fixes += dropBad(e, ['kenBurns'], (v) => isObj(v) && rect(v.start) && rect(v.end))
    fixes += dropBad(e, ['playLive'], (v) => typeof v === 'boolean')
  }
  if (e.type === 'video') {
    fixes += dropBad(e, ['trimIn', 'trimOut', 'volume', 'speed'], num)
    if (num(e.speed) && e.speed <= 0) {
      delete e.speed
      fixes++
    }
    fixes += dropBad(e, ['muted', 'duck', 'stabilize'], (v) => typeof v === 'boolean')
    fixes += dropBad(e, ['privacyTracks'], (v) => Array.isArray(v) && v.every((track) => Array.isArray(track) && track.every((k) => isObj(k) && num(k.t) && rect(k.r))))
  }
  return { entry: e, missingMedia: false, repaired: fixes > 0 }
}

/** Audio settings that older files may lack; missing means off, so they are never filled in. */
const OPTIONAL_AUDIO = ['normalize']

/**
 * Settings with wrong values reset to their defaults. Fields that are simply missing stay missing
 * (an older file means "off" by that), except for what the editor cannot do without: theme, look,
 * aspect ratio and the timing, transition and audio groups.
 */
function validateSettings(raw: unknown, changes: Changes): Project['settings'] {
  const d = structuredClone(DEFAULT_SETTINGS) as unknown as Data
  if (!isObj(raw)) {
    changes.add('settings')
    return d as unknown as Project['settings']
  }
  const s: Data = { ...raw }
  let fixes = 0
  const reset = (key: string, ok: boolean): void => {
    if (ok) return
    if (d[key] === undefined) delete s[key]
    else s[key] = structuredClone(d[key])
    fixes++
  }
  reset('theme', THEMES.some((t) => t.id === s.theme))
  reset('look', LOOKS.some((l) => l.id === s.look))
  reset('aspect', ASPECTS.includes(s.aspect as string))
  for (const key of ['scaleToFill', 'playFullVideos', 'playLivePhotos', 'loop', 'showTitle']) reset(key, s[key] === undefined || typeof s[key] === 'boolean')
  for (const key of ['titleText', 'subtitleText', 'titleStyle']) reset(key, s[key] === undefined || str(s[key]))
  reset('maxVideoSeconds', s.maxVideoSeconds === undefined || (num(s.maxVideoSeconds) && s.maxVideoSeconds >= 0))
  const timing = s.timing
  if (isObj(timing)) {
    const t: Data = { ...timing }
    if (t.mode !== 'fitToMusic' && t.mode !== 'custom') {
      t.mode = 'fitToMusic'
      fixes++
    }
    if (!(num(t.customTotal) && t.customTotal > 0)) {
      t.customTotal = (d.timing as Data).customTotal
      fixes++
    }
    if (t.beatSync !== undefined && typeof t.beatSync !== 'boolean') {
      delete t.beatSync
      fixes++
    }
    s.timing = t
  } else reset('timing', false)
  const tr = s.transition
  if (isObj(tr)) {
    const t: Data = { ...tr }
    const def = d.transition as Data
    if (!TRANSITIONS.some((x) => x.id === t.type)) {
      t.type = def.type
      fixes++
    }
    if (!num(t.speed)) {
      t.speed = def.speed
      fixes++
    }
    if (!DIRECTIONS.includes(t.direction as string)) {
      t.direction = def.direction
      fixes++
    }
    s.transition = t
  } else reset('transition', false)
  const audio = s.audio
  if (isObj(audio)) {
    const a: Data = { ...audio }
    for (const [k, v] of Object.entries(d.audio as Data)) {
      if (OPTIONAL_AUDIO.includes(k)) {
        if (a[k] !== undefined && typeof a[k] !== typeof v) {
          delete a[k]
          fixes++
        }
      } else if (typeof a[k] !== typeof v || (typeof v === 'number' && !num(a[k]))) {
        a[k] = v
        fixes++
      }
    }
    s.audio = a
  } else reset('audio', false)
  if (s.text !== undefined) {
    const t = s.text
    if (!isObj(t)) {
      delete s.text
      fixes++
    } else {
      // a field with a wrong value goes back to the theme's choice; the others stay
      const style: Data = { ...t }
      const def = DEFAULT_TEXT_STYLE as unknown as Data
      for (const k of ['font', 'color', 'position', 'uppercase']) {
        if (!str(style[k])) {
          style[k] = def[k]
          fixes++
        }
      }
      if (!(num(style.scale) && style.scale > 0)) {
        style.scale = def.scale
        fixes++
      }
      s.text = style
    }
  }
  changes.add('settings', fixes)
  return s as unknown as Project['settings']
}

export interface ValidateOptions {
  /** Id to use when the file has none (its file name). */
  fallbackId?: string
  now?: number
  newId?: () => string
}

/**
 * A project the editor can open safely, built from whatever a file contained (after migration), with
 * the report of what had to change. Throws only for data that is no project at all.
 */
export function validateProject(raw: unknown, opts: ValidateOptions = {}): { project: Project; report: RepairReport } {
  // a project has its lists or settings, or at least its header (what is left of a badly cut file)
  const header = formatVersion(raw) !== null && isObj(raw) && str(raw.id)
  if (!isObj(raw) || (!Array.isArray(raw.entries) && !Array.isArray(raw.media) && !isObj(raw.settings) && !header)) {
    throw new ProjectFormatError('damaged', `${PROJECT_DAMAGED}: not a Diashow Studio project`)
  }
  const changes = new Changes()
  const now = opts.now ?? Date.now()
  const newId = opts.newId ?? randomUUID
  const p: Data = { ...raw }

  let basics = 0
  if (!(str(p.id) && ID.test(p.id))) {
    p.id = opts.fallbackId && ID.test(opts.fallbackId) ? opts.fallbackId : newId()
    basics++
  }
  if (!str(p.name)) {
    p.name = 'Diashow'
    basics++
  }
  if (!num(p.createdAt)) {
    p.createdAt = num(p.updatedAt) ? p.updatedAt : now
    basics++
  }
  if (!num(p.updatedAt)) {
    p.updatedAt = now
    basics++
  }
  // optional dates (deletion reminder, face data removed by the clean-up): a wrong one is dropped
  for (const key of ['deleteAt', 'faceDataRemovedAt']) {
    if (p[key] !== undefined && !validDeleteAt(p[key])) {
      delete p[key]
      basics++
    }
  }
  changes.add('basics', basics)

  if (!Array.isArray(p.entries) || !Array.isArray(p.media)) changes.add('listsMissing')

  // media: valid items, each id once
  const media: Data[] = []
  const kinds = new Map<string, string>()
  let mediaDropped = 0
  let mediaRepaired = 0
  for (const raw of Array.isArray(p.media) ? p.media : []) {
    const { item, repaired } = validateMedia(raw)
    if (!item || kinds.has(item.id as string)) {
      mediaDropped++
      continue
    }
    if (repaired) mediaRepaired++
    kinds.set(item.id as string, item.kind as string)
    media.push(item)
  }
  changes.add('mediaDropped', mediaDropped)
  changes.add('mediaRepaired', mediaRepaired)

  const music: Data[] = []
  const trackIds = new Set<string>()
  let musicDropped = 0
  let musicRepaired = 0
  for (const raw of Array.isArray(p.music) ? p.music : []) {
    const { track, repaired } = validateTrack(raw)
    if (!track || trackIds.has(track.id as string)) {
      musicDropped++
      continue
    }
    if (repaired) musicRepaired++
    trackIds.add(track.id as string)
    music.push(track)
  }
  changes.add('musicDropped', musicDropped)
  changes.add('musicRepaired', musicRepaired)

  // entries: known types only, unique ids, existing media
  const entries: Data[] = []
  const entryIds = new Set<string>()
  let dropped = 0
  let missing = 0
  let repaired = 0
  for (const raw of Array.isArray(p.entries) ? p.entries : []) {
    if (!isObj(raw) || !ENTRY_TYPES.includes(raw.type as string)) {
      dropped++
      continue
    }
    const r = validateEntry(raw, kinds)
    if (!r.entry) {
      if (r.missingMedia) missing++
      else dropped++
      continue
    }
    let fixed = r.repaired
    if (!(str(r.entry.id) && r.entry.id) || entryIds.has(r.entry.id as string)) {
      r.entry.id = newId()
      fixed = true
    }
    entryIds.add(r.entry.id as string)
    if (fixed) repaired++
    entries.push(r.entry)
  }
  changes.add('entriesDropped', dropped)
  changes.add('entriesMissingMedia', missing)
  changes.add('entriesRepaired', repaired)

  if (p.people !== undefined) {
    const list = Array.isArray(p.people) ? p.people : []
    const people = list
      .filter((x): x is Data => isObj(x) && str(x.id) && Array.isArray(x.desc))
      .map((x): Data => {
        const person: Data = { ...x, desc: (x.desc as unknown[]).filter(numberList) }
        if (person.name !== undefined && !str(person.name)) delete person.name
        return person
      })
      .filter((x) => (x.desc as number[][]).length > 0)
    changes.add('peopleDropped', (Array.isArray(p.people) ? p.people.length : 1) - people.length)
    if (people.length) p.people = people
    else delete p.people
  }

  p.entries = entries
  p.media = media
  p.music = music
  p.settings = validateSettings(p.settings, changes)
  p.version = PROJECT_VERSION
  return { project: p as unknown as Project, report: changes.report() }
}

export interface ReadOptions extends ValidateOptions, MigrateOptions {
  /** Rescue a cut-off file instead of refusing it. */
  salvage?: boolean
}

/**
 * Parses, migrates and validates the text of a .dshow file. Throws ProjectFormatError ('damaged' for
 * unreadable files unless `salvage`, 'too-new' for files of a newer app).
 */
export function readProjectText(text: string, opts: ReadOptions = {}): { project: Project; report: RepairReport } {
  const clean = cleanProjectText(text)
  let data: unknown
  let truncated = false
  try {
    data = JSON.parse(clean)
  } catch (err) {
    const rescued = opts.salvage ? salvageJson(clean) : undefined
    if (!rescued) throw new ProjectFormatError('damaged', `${PROJECT_DAMAGED}: ${err instanceof Error ? err.message : String(err)}`)
    data = rescued.value
    truncated = true
  }
  if (!isObj(data)) throw new ProjectFormatError('damaged', `${PROJECT_DAMAGED}: not a Diashow Studio project`)
  const { data: migrated, fromVersion } = migrateProject(data, opts)
  const { project, report } = validateProject(migrated, opts)
  const changes = [...report.changes]
  if (truncated) changes.unshift({ code: 'truncated', count: 1 })
  if (fromVersion !== undefined) changes.unshift({ code: 'migrated', count: 1 })
  return { project, report: fromVersion !== undefined ? { fromVersion, changes } : { changes } }
}

/** True when the report holds anything worth telling the user. */
export function hasChanges(report: RepairReport): boolean {
  return report.changes.length > 0
}

/** True when the report says that data was lost (as opposed to filled in or converted). */
export function lostData(report: RepairReport): boolean {
  return report.changes.some((c) => c.code === 'truncated' || c.code.endsWith('Dropped') || c.code === 'entriesMissingMedia' || c.code === 'listsMissing')
}
