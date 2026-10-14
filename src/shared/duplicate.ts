// "Duplizieren": what the copy of a slideshow is called and what it holds (pure; src/main/duplicate.ts
// writes it). The copy is a show of its own: everything the show holds, under a new id. What belongs
// to the id stays with the original (older versions, undo history, export jobs); the media cache is
// shared by media id anyway, and the pupils' uploads and pasted pictures stay where they are and are
// used by both (the clean-up and the trash keep what another show uses, src/main/cleanup.ts).
import type { Project } from './types'

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

/**
 * The name of a copy: "Klassenfahrt (Kopie)", or "(Kopie 2)", "(Kopie 3)" … when that is taken (case
 * and spaces don't count). A copy of a copy counts on from the original name: "Klassenfahrt (Kopie)"
 * gives "Klassenfahrt (Kopie 2)". `word`: "Kopie" or "Copy", in the language of the UI.
 */
export function copyName(name: string, taken: Iterable<string>, word: string): string {
  const own = new RegExp(`\\s*\\(${escape(word)}(?: \\d+)?\\)$`, 'i')
  const base = name.trim().replace(own, '').trim() || name.trim()
  const used = new Set([...taken].map(norm))
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n === 1 ? word : `${word} ${n}`})`.trim()
    if (!used.has(norm(candidate))) return candidate
  }
}

/**
 * The copy of a show under `id` and `name`: an independent deep copy of everything it holds (slides,
 * settings, music, photo edits, captions, pixelation, the people list and face data). Only the id,
 * the name and its times are new. The title slide keeps its text: without a title of its own it shows
 * the show's name, and the copy's video must not say "(Kopie)". The deletion date goes along: the
 * copy holds the same pupils' photos and face data, so the same reminder applies (it can be changed
 * on the copy).
 */
export function duplicateProject(p: Project, id: string, name: string, now: number): Project {
  const copy: Project = { ...structuredClone(p), id, name, createdAt: now, updatedAt: now }
  if (!p.settings.titleText?.trim() && p.name.trim()) copy.settings.titleText = p.name
  return copy
}
