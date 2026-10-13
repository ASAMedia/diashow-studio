// Photos and videos that are already in the show are not added twice (the rule: src/shared/repeats.ts).
// Every import into a show goes through importChecked (the store's importMedia, insert.ts): the main
// process leaves out what the show has already, also left-out slides, and only the rest goes in. Imports
// run one after another, so each one sees what the last one added: two pupils sending the same photo a
// moment apart give one slide. Skipping makes no undo step; the notice (components/RepeatNotice.tsx)
// says what was skipped and offers "Add anyway" (one undo step) and "Show".
import { create } from 'zustand'
import { showCandidates } from '@shared/repeats'
import type { MediaItem, Project } from '@shared/types'
import { t } from './i18n'

export interface CheckedImport {
  /** New photos and videos, in show order. */
  fresh: MediaItem[]
  /** Those the show (or an earlier file of this import) has already. */
  skipped: MediaItem[]
  /** Id of a skipped item → id of the item it repeats. */
  repeatOf: Record<string, string>
}

/** Imports `paths` for `project` (null: a new show), sorting out what it has already. */
export async function importChecked(paths: string[], project: Project | null): Promise<CheckedImport> {
  if (!paths.length) return { fresh: [], skipped: [], repeatOf: {} }
  const { items, repeats } = await window.api.importNew(paths, showCandidates(project))
  const skip = (m: MediaItem): boolean => Object.hasOwn(repeats, m.id)
  return { fresh: items.filter((m) => !skip(m)), skipped: items.filter(skip), repeatOf: repeats }
}

let queue: Promise<unknown> = Promise.resolve()
/** Runs imports one after another: each checks against what the ones before it added. */
export function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

/** The files to import again for "Add anyway": a Live Photo with its motion part. */
export const againPaths = (items: MediaItem[]): string[] => items.flatMap((m) => (m.live?.source ? [m.path, m.live.source] : [m.path]))

export interface RepeatNotice {
  id: number
  projectId: string
  photos: number
  videos: number
  /** Nothing of the import was new. */
  all: boolean
  /** Media ids the skipped ones repeat: in the show, or added by the same import. */
  targets: string[]
  /** Adds the skipped ones where they would have gone, in one undo step; resolves with the new entry ids. */
  addAnyway: () => Promise<string[]>
}

interface NoticeState {
  notice: RepeatNotice | null
  /** For screen readers (a polite live region): what the last notice said. */
  announce: string
}

export const useRepeatNotice = create<NoticeState>(() => ({ notice: null, announce: '' }))
let seq = 0

/** "3 Fotos sind schon in der Diashow und wurden übersprungen." */
export function repeatText(n: Pick<RepeatNotice, 'photos' | 'videos' | 'all'>): string {
  const total = n.photos + n.videos
  const what =
    n.photos && n.videos
      ? t('repeatMixed').replace('{n}', String(total))
      : n.videos
        ? (n.videos === 1 ? t('repeatVideo') : t('repeatVideos')).replace('{n}', String(n.videos))
        : (n.photos === 1 ? t('repeatPhoto') : t('repeatPhotos')).replace('{n}', String(n.photos))
  if (n.all && total === 1) return t(n.videos ? 'repeatAllVideo' : 'repeatAllPhoto')
  return t(n.all ? 'repeatAllMany' : total === 1 ? 'repeatSkippedOne' : 'repeatSkippedMany').replace('{what}', what)
}

/** Of the media `targets`, those whose slides are all left out (they show up in the review grid only). */
export function leftOutTargets(p: Project, targets: string[]): number {
  const want = new Set(targets)
  const shown = new Set<string>()
  const left = new Set<string>()
  for (const e of p.entries) {
    if (e.type === 'text' || !want.has(e.mediaId)) continue
    if (e.excluded) left.add(e.mediaId)
    else shown.add(e.mediaId)
  }
  return [...left].filter((id) => !shown.has(id)).length
}

/** "1 davon ist herausgenommen …", or '' when every target has a slide in the show. */
export function leftOutText(p: Project, notice: RepeatNotice): string {
  const n = leftOutTargets(p, notice.targets)
  if (!n) return ''
  if (notice.photos + notice.videos === 1) return t('repeatLeftOutOne')
  return n === 1 ? t('repeatLeftOut1') : t('repeatLeftOut').replace('{n}', String(n))
}

/** Shows the notice for an import that skipped something (it replaces an earlier one). */
export function noticeRepeats(project: Project, checked: CheckedImport, addAnyway: () => Promise<string[]>): void {
  const photos = checked.skipped.filter((m) => m.kind === 'photo').length
  const notice: RepeatNotice = {
    id: ++seq,
    projectId: project.id,
    photos,
    videos: checked.skipped.length - photos,
    all: checked.fresh.length === 0,
    targets: [...new Set(Object.values(checked.repeatOf))],
    addAnyway
  }
  const text = [repeatText(notice), leftOutText(project, notice)].filter(Boolean).join(' ')
  // the live region is emptied first, so the same text twice in a row is read out twice
  useRepeatNotice.setState({ notice, announce: '' })
  setTimeout(() => {
    if (useRepeatNotice.getState().notice?.id === notice.id) useRepeatNotice.setState({ announce: text })
  }, 100)
}

export function dismissRepeats(): void {
  useRepeatNotice.setState({ notice: null })
}
