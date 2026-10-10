// What the engine pixelates on each picture: the areas drawn in the editor, faces followed through
// a clip (privacyTracks), and every face recognised as a marked person ("this person everywhere").
// Computed at render time from the project; nothing is written into the entries.
import type { MediaItem, Person, Project, Rect } from '@shared/types'
import { faceArea, faceDataKey, peopleKey, photoPersonFaces, rectAt, stabilizedArea, videoPersonTracks } from '@shared/people'

type Keys = { t: number; r: Rect }[]

export class PrivacyIndex {
  /** Fixed areas per media id (from every entry that uses the media). */
  private areas = new Map<string, Rect[]>()
  /** Followed faces per media id (keyframes in source seconds). */
  private tracks = new Map<string, Keys[]>()
  private people: Person[] = []
  private peopleSig = ''
  /** Marked people per media id: areas of photos, keyframes of videos. */
  private matches = new Map<string, { key: string; rects: Rect[]; tracks: Keys[] }>()

  setProject(project: Project): void {
    this.areas.clear()
    this.tracks.clear()
    for (const e of project.entries) {
      if (e.type === 'text') continue
      if (e.privacy?.length) this.areas.set(e.mediaId, [...(this.areas.get(e.mediaId) ?? []), ...e.privacy])
      if (e.type === 'video' && e.privacyTracks?.length) this.tracks.set(e.mediaId, [...(this.tracks.get(e.mediaId) ?? []), ...e.privacyTracks])
    }
    const sig = peopleKey(project.people)
    if (sig !== this.peopleSig) {
      this.peopleSig = sig
      this.people = project.people ?? []
      this.matches.clear()
    }
  }

  private matchesOf(m: MediaItem): { rects: Rect[]; tracks: Keys[] } {
    const key = faceDataKey(m)
    let hit = this.matches.get(m.id)
    if (!hit || hit.key !== key) {
      const rects = photoPersonFaces(m, this.people).map((x) => faceArea(m.faces![x.i]))
      hit = { key, rects, tracks: videoPersonTracks(m, this.people).map((x) => x.keys) }
      this.matches.set(m.id, hit)
    }
    return hit
  }

  /**
   * Areas to pixelate on a picture of media `m`; `time` is the source time of a video frame (also
   * the motion of a Live Photo, which keeps the photo's areas); `stabilized`: the frame comes from
   * the stabilised copy (areas zoomed and grown like it).
   */
  at(m: MediaItem, time?: number, stabilized = false): Rect[] {
    const out = this.areas.get(m.id)?.slice() ?? []
    const add = (tracks: Keys[] | undefined): void => {
      if (time === undefined || !tracks) return
      for (const k of tracks) {
        const r = rectAt(k, time)
        if (r) out.push(r)
      }
    }
    add(this.tracks.get(m.id))
    if (this.people.length) {
      const hit = this.matchesOf(m)
      out.push(...hit.rects)
      add(hit.tracks)
    }
    return stabilized ? out.map((r) => stabilizedArea(r, m.width, m.height)) : out
  }
}
