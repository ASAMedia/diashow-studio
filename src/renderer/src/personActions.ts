// Editing the marked people (Project.people): each is a set of face descriptors; every face in the
// show that matches one is pixelated by the engine (engine/privacy.ts). One undo step per action.
import type { Person } from '@shared/types'
import { matchPerson, withoutMatch } from '@shared/people'
import { playerRef, useStore } from './store'
import { t } from './i18n'

/** Display name: the given name, or "Person n" by position. */
export function personLabel(p: Person, people: readonly Person[]): string {
  return p.name?.trim() || t('personUnnamed').replace('{n}', String(people.indexOf(p) + 1))
}

/**
 * "Pixelate this person everywhere": adds the face's descriptor to the person it already matches,
 * or to `personId`, or starts a new person. Returns the person's id.
 */
export function markPerson(desc: number[], personId?: string): string {
  const people = useStore.getState().project?.people ?? []
  const id = personId ?? matchPerson(desc, people)?.person.id ?? crypto.randomUUID()
  useStore.getState().update((p) => {
    const list = (p.people ??= [])
    const found = list.find((x) => x.id === id)
    if (found) {
      if (!found.desc.some((d) => d.every((v, i) => v === desc[i]))) found.desc.push([...desc])
    } else list.push({ id, desc: [[...desc]] })
  })
  return id
}

/**
 * Correction of a wrong match: the person keeps only descriptors that don't match this face. A
 * person left without descriptors is removed.
 */
export function notThisPerson(personId: string, desc: number[] | number[][]): void {
  const person = useStore.getState().project?.people?.find((x) => x.id === personId)
  if (!person) return
  // the wrong face is close to every reference face: only removing the person helps
  if (!withoutMatch(person, desc).length && !window.confirm(t('peopleWrongLast'))) return
  useStore.getState().update((p) => {
    const person = p.people?.find((x) => x.id === personId)
    if (!person) return
    person.desc = withoutMatch(person, desc)
    if (!person.desc.length) p.people = p.people!.filter((x) => x.id !== personId)
    if (!p.people?.length) delete p.people
  })
}

export function removePerson(personId: string): void {
  useStore.getState().update((p) => {
    p.people = p.people?.filter((x) => x.id !== personId)
    if (!p.people?.length) delete p.people
  })
}

export function renamePerson(personId: string, name: string): void {
  useStore.getState().update((p) => {
    const person = p.people?.find((x) => x.id === personId)
    if (person) person.name = name.trim() ? name : undefined
  }, `person-name:${personId}`)
}

/** A time asked for by the next pixelation editor opened on an entry (the review shows a video's faces at one). */
let requested: { entryId: string; t: number } | null = null

/** The editor of `entryId` takes the time asked for, once (null: none). */
export function takeRequestedStill(entryId: string): number | null {
  const t = requested?.entryId === entryId ? requested.t : null
  requested = null
  return t
}

/**
 * Opens the pixelation editor for an entry: selects its slide, moves the playhead there. `t`: for
 * a video, the source time of the frame to show.
 */
export function openPrivacyEditor(entryId: string, t?: number): void {
  requested = t === undefined ? null : { entryId, t }
  const s = useStore.getState()
  const slide = playerRef.current?.tl?.slides.find((x) => x.entries.some((e) => e.id === entryId))
  s.select(slide ? slide.entries.map((e) => e.id) : [entryId])
  if (s.playing) playerRef.current?.pause()
  s.set({ privacyEdit: entryId, tab: 'slide', dialog: null, exportOpen: false, view: 'editor', kbEdit: null })
  if (slide) playerRef.current?.seek(slide.start + slide.transIn)
}
