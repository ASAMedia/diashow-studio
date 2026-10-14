// "Duplizieren" on the home screen and in the editor's "⋯" menu: writes an independent copy of a show
// (src/shared/duplicate.ts) under a new id into the projects folder. The show is read as it is on disk
// (the editor saves an open show first) and validated like any project file; the copy starts without
// older versions, undo history and export jobs, which belong to the original's id. Electron-free.
import { randomUUID } from 'node:crypto'
import { copyName, duplicateProject } from '@shared/duplicate'
import type { Project } from '@shared/types'
import type { ProjectStore } from './projects'

/** The word of a copy's name from the renderer ("Kopie", "Copy"): plain text, short. */
export function copyWord(raw: unknown): string {
  const w = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30) : ''
  return w || 'Copy'
}

/** Copies show `id`; resolves with the copy as written. */
export async function duplicateShow(projects: ProjectStore, id: string, word: unknown): Promise<Project> {
  // in the show's queue: a save still on its way (the editor was just closed) is written first
  const source = await projects.exclusive(id, () => projects.peek(id))
  const shows = await projects.list()
  const taken = [...shows.map((s) => s.name), ...(await projects.damaged()).flatMap((d) => (d.name ? [d.name] : []))]
  // a fresh id: never one of a show here or in the trash (that one may come back)
  let copyId = randomUUID()
  while (shows.some((s) => s.id === copyId) || (await projects.inTrash(copyId))) copyId = randomUUID()
  const copy = duplicateProject(source, copyId, copyName(source.name, taken, copyWord(word)), Date.now())
  await projects.save(copy)
  return copy
}
