import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matches, parseHandbook, plain, searchWords } from '@shared/handbook'

const root = join(__dirname, '..')
const read = (lang: string): string => readFileSync(join(root, 'src', 'renderer', 'src', 'handbook', `${lang}.md`), 'utf8')
const ACTIONS = ['shortcuts', 'about', 'settings', 'wizard']

describe('handbook markdown', () => {
  it('parses chapters, headings, lists, tips, tables and pictures', () => {
    const book = parseHandbook(
      [
        '# Book',
        '## First chapter {#one}',
        'Some **bold** text',
        'on two lines.',
        '',
        '- a',
        '- b with',
        '  a second line',
        '1. step',
        '> tip [[Ctrl+Z]]',
        '![Caption](shot.jpg)',
        '### Sub',
        '| [[F1]] | Help |',
        '|---|---|',
        '| x | y |',
        '## Zweites Kapitel'
      ].join('\r\n')
    )
    expect(book.title).toBe('Book')
    expect(book.chapters.map((c) => c.id)).toEqual(['one', 'zweites-kapitel'])
    expect(book.chapters[0].blocks).toEqual([
      { type: 'p', text: 'Some **bold** text on two lines.' },
      { type: 'ul', items: ['a', 'b with a second line'] },
      { type: 'ol', items: ['step'] },
      { type: 'tip', text: 'tip [[Ctrl+Z]]' },
      { type: 'img', alt: 'Caption', file: 'shot.jpg' },
      { type: 'h3', text: 'Sub' },
      { type: 'table', rows: [['[[F1]]', 'Help'], ['x', 'y']] }
    ])
    expect(plain('**a** [[b]] `c` [d](#e)')).toBe('a b c d')
  })

  it('search needs every word, ignores case and markup', () => {
    const [c] = parseHandbook('## Privacy\nPixelate **faces** in [[videos]].').chapters
    expect(matches(c, searchWords('FACES videos'))).toBe(true)
    expect(matches(c, searchWords('faces music'))).toBe(false)
    // one-letter words don't filter
    expect(searchWords('a  faces ')).toEqual(['faces'])
  })

  it('German and English have the same chapters, working links and every picture', () => {
    const de = parseHandbook(read('de')).chapters
    const en = parseHandbook(read('en')).chapters
    expect(de.length).toBeGreaterThanOrEqual(12)
    expect(en.map((c) => c.id)).toEqual(de.map((c) => c.id))
    for (const [lang, chapters, text] of [['de', de, read('de')], ['en', en, read('en')]] as const) {
      const ids = new Set(chapters.map((c) => c.id))
      for (const m of text.matchAll(/\]\(#([\w-]+)\)/g)) expect(ids, `${lang}: link #${m[1]}`).toContain(m[1])
      for (const m of text.matchAll(/\]\(app:([\w-]+)\)/g)) expect(ACTIONS, `${lang}: action ${m[1]}`).toContain(m[1])
      const pictures = chapters.flatMap((c) => c.blocks.filter((b) => b.type === 'img').map((b) => (b as { file: string }).file))
      expect(pictures.length).toBeGreaterThanOrEqual(8)
      for (const file of pictures) expect(existsSync(join(root, 'src', 'renderer', 'public', 'handbook', lang, file)), `${lang}/${file}`).toBe(true)
    }
    // the handbook covers the features the README lists
    const ids = de.map((c) => c.id)
    for (const id of ['start', 'edit', 'themes', 'music', 'privacy', 'share', 'export', 'cull', 'settings', 'shortcuts', 'trouble']) expect(ids).toContain(id)
  })
})
