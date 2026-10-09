import type { LookId, ThemeId, TransitionId } from './types'

export interface ThemeMeta {
  id: ThemeId
  name: { de: string; en: string }
  description: { de: string; en: string }
  /** Maximum photos on one slide (1 = single-photo theme). */
  maxPerSlide: number
  /** Cycle of photo counts used when grouping photos automatically. */
  pattern: number[]
  /** Nominal seconds per single-photo slide when there is no target length. */
  photoSeconds: number
  /** Transition overlap in seconds (Classic derives it from the speed slider). */
  transition: number
  /** Start/end framing is editable per photo. */
  kenBurns: boolean
  /** The user picks the transition type (Classic). */
  freeTransition: boolean
  /** "Scale photos to fit screen" is offered. */
  scaleOption: boolean
  /** Title is its own slide (true) or drawn over the first slide (false). */
  titleSlide: boolean
  /** Look applied when the theme is chosen (the user can change it afterwards). */
  defaultLook: LookId
  /** Photos are cropped into cells whose framing the user can drag in the viewer. */
  cropEdit: boolean
  /** Text slides become captions on the following slide instead of slides of their own. */
  textAsCaption: boolean
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'kenburns',
    name: { de: 'Ken Burns', en: 'Ken Burns' },
    description: { de: 'Langsames Schwenken und Zoomen mit Überblendung', en: 'Slow pan and zoom with crossfades' },
    maxPerSlide: 1,
    pattern: [1],
    photoSeconds: 4.5,
    transition: 1.4,
    kenBurns: true,
    freeTransition: false,
    scaleOption: false,
    titleSlide: false,
    defaultLook: 'natural',
    cropEdit: false,
    textAsCaption: false
  },
  {
    id: 'origami',
    name: { de: 'Origami', en: 'Origami' },
    description: { de: 'Fotoraster, die wie Papier hereinfalten', en: 'Photo grids that fold in like paper' },
    maxPerSlide: 4,
    pattern: [1, 2, 3, 1, 4, 2, 3],
    photoSeconds: 3.5,
    transition: 1.1,
    kenBurns: false,
    freeTransition: false,
    scaleOption: false,
    titleSlide: true,
    defaultLook: 'natural',
    cropEdit: true,
    textAsCaption: false
  },
  {
    id: 'reflections',
    name: { de: 'Reflexionen', en: 'Reflections' },
    description: { de: 'Schwebende Bilder mit Spiegelung auf hellem Grund', en: 'Floating pictures with reflections on a light stage' },
    maxPerSlide: 3,
    pattern: [1, 3, 2, 1, 2],
    photoSeconds: 4,
    transition: 1.3,
    kenBurns: false,
    freeTransition: false,
    scaleOption: false,
    titleSlide: true,
    defaultLook: 'natural',
    cropEdit: false,
    textAsCaption: false
  },
  {
    id: 'panels',
    name: { de: 'Schiebepaneele', en: 'Sliding Panels' },
    description: { de: 'Bildpaneele, die seitlich hereingleiten', en: 'Panels of photos that slide in from the side' },
    maxPerSlide: 3,
    pattern: [1, 2, 3, 2, 1, 3],
    photoSeconds: 3.5,
    transition: 0.9,
    kenBurns: false,
    freeTransition: false,
    scaleOption: false,
    titleSlide: false,
    defaultLook: 'natural',
    cropEdit: true,
    textAsCaption: false
  },
  {
    id: 'vintage',
    name: { de: 'Vintage-Abzüge', en: 'Vintage Prints' },
    description: { de: 'Abzüge mit weißem Rand, die sich stapeln', en: 'White-bordered prints piling up' },
    maxPerSlide: 1,
    pattern: [1],
    photoSeconds: 4,
    transition: 1.1,
    kenBurns: false,
    freeTransition: false,
    scaleOption: false,
    titleSlide: false,
    defaultLook: 'faded',
    cropEdit: false,
    textAsCaption: false
  },
  {
    id: 'classic',
    name: { de: 'Klassisch', en: 'Classic' },
    description: { de: 'Ein Foto nach dem anderen, Übergang frei wählbar', en: 'One photo at a time, any transition' },
    maxPerSlide: 1,
    pattern: [1],
    photoSeconds: 3,
    transition: 1,
    kenBurns: false,
    freeTransition: true,
    scaleOption: true,
    titleSlide: false,
    defaultLook: 'natural',
    cropEdit: true,
    textAsCaption: false
  },
  {
    id: 'magazine',
    name: { de: 'Magazin', en: 'Magazine' },
    description: { de: 'Fotoraster wie im Magazin, Zellen blenden nacheinander ein', en: 'Magazine photo grids, cells fade in one after another' },
    maxPerSlide: 6,
    pattern: [2, 3, 6, 4, 3, 5, 2, 4, 1, 3],
    photoSeconds: 3.5,
    transition: 1.2,
    kenBurns: false,
    freeTransition: false,
    scaleOption: false,
    titleSlide: false,
    defaultLook: 'natural',
    cropEdit: true,
    textAsCaption: true
  },
  {
    id: 'retro',
    name: { de: 'Retro-Film', en: 'Retro Film' },
    description: { de: 'Super-8-Look mit Korn, Vignette und Lichtblitzen', en: 'Super 8 look with grain, vignette and light leaks' },
    maxPerSlide: 1,
    pattern: [1],
    photoSeconds: 3.5,
    transition: 0.8,
    kenBurns: false,
    freeTransition: false,
    scaleOption: false,
    titleSlide: false,
    defaultLook: 'faded',
    cropEdit: true,
    textAsCaption: false
  }
]

export function themeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

export const TRANSITIONS: { id: TransitionId; name: { de: string; en: string }; directional: boolean }[] = [
  { id: 'dissolve', name: { de: 'Überblenden', en: 'Dissolve' }, directional: false },
  { id: 'fadeBlack', name: { de: 'Über Schwarz', en: 'Fade through black' }, directional: false },
  { id: 'fadeWhite', name: { de: 'Über Weiß', en: 'Fade through white' }, directional: false },
  { id: 'push', name: { de: 'Schieben', en: 'Push' }, directional: true },
  { id: 'wipe', name: { de: 'Wischen', en: 'Wipe' }, directional: true },
  { id: 'moveIn', name: { de: 'Hereinbewegen', en: 'Move in' }, directional: true },
  { id: 'reveal', name: { de: 'Aufdecken', en: 'Reveal' }, directional: true },
  { id: 'cube', name: { de: 'Würfel', en: 'Cube' }, directional: true },
  { id: 'flip', name: { de: 'Drehen', en: 'Flip' }, directional: true },
  { id: 'zoom', name: { de: 'Zoom', en: 'Zoom' }, directional: false },
  { id: 'droplet', name: { de: 'Tropfen', en: 'Droplet' }, directional: false }
]

export const LOOKS: { id: LookId; name: { de: string; en: string } }[] = [
  { id: 'natural', name: { de: 'Natürlich', en: 'Natural' } },
  { id: 'vivid', name: { de: 'Lebendig', en: 'Vivid' } },
  { id: 'warm', name: { de: 'Warm', en: 'Warm' } },
  { id: 'cool', name: { de: 'Kühl', en: 'Cool' } },
  { id: 'dramatic', name: { de: 'Dramatisch', en: 'Dramatic' } },
  { id: 'faded', name: { de: 'Verblasst', en: 'Faded' } },
  { id: 'mono', name: { de: 'Schwarzweiß', en: 'Mono' } },
  { id: 'noir', name: { de: 'Noir', en: 'Noir' } }
]

/** Classic transition length from the speed slider (0 = slow, 1 = fast). */
export function classicTransitionSeconds(speed: number): number {
  return 2.2 - 1.9 * Math.min(1, Math.max(0, speed))
}
