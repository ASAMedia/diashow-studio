// Parser of the in-app handbook's Markdown subset (src/renderer/src/handbook/*.md, rendered by
// handbook/markdown.tsx): chapters, blocks and the search. Pure TypeScript, unit-tested.

export type Block =
  | { type: 'p' | 'h3' | 'tip'; text: string }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'img'; file: string; alt: string }
  | { type: 'table'; rows: string[][] }

export interface Chapter {
  id: string
  title: string
  blocks: Block[]
  /** Plain text of title and body, lower case, for the search. */
  search: string
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Text without inline markup. */
export function plain(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

export function parseHandbook(md: string): { title: string; chapters: Chapter[] } {
  let title = ''
  const chapters: Chapter[] = []
  let ch: Chapter | null = null
  let para: string[] = []
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null
  let tip: string[] = []
  let table: string[][] | null = null

  const flush = (): void => {
    if (!ch) {
      para = []
      list = null
      tip = []
      table = null
      return
    }
    if (para.length) ch.blocks.push({ type: 'p', text: para.join(' ') })
    if (list) ch.blocks.push(list)
    if (tip.length) ch.blocks.push({ type: 'tip', text: tip.join(' ') })
    if (table) ch.blocks.push({ type: 'table', rows: table })
    para = []
    list = null
    tip = []
    table = null
  }

  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    let m: RegExpExecArray | null
    if ((m = /^#\s+(.*)$/.exec(line))) {
      flush()
      title = m[1].trim()
    } else if ((m = /^##\s+(.*?)(?:\s*\{#([\w-]+)\})?$/.exec(line))) {
      flush()
      ch = { id: m[2] ?? slug(m[1]), title: m[1].trim(), blocks: [], search: '' }
      chapters.push(ch)
    } else if ((m = /^###\s+(.*)$/.exec(line))) {
      flush()
      ch?.blocks.push({ type: 'h3', text: m[1].trim() })
    } else if ((m = /^!\[([^\]]*)\]\(([\w.-]+)\)$/.exec(line.trim()))) {
      flush()
      ch?.blocks.push({ type: 'img', alt: m[1], file: m[2] })
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      if (para.length || list || table) flush()
      tip.push(m[1].trim())
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line)) && !/^\s{2,}/.test(line)) {
      if (para.length || tip.length || table || list?.type === 'ol') flush()
      list ??= { type: 'ul', items: [] }
      list.items.push(m[1].trim())
    } else if ((m = /^\d+\.\s+(.*)$/.exec(line))) {
      if (para.length || tip.length || table || list?.type === 'ul') flush()
      list ??= { type: 'ol', items: [] }
      list.items.push(m[1].trim())
    } else if (/^\s*\|/.test(line)) {
      if (para.length || tip.length || list) flush()
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue
      table ??= []
      table.push(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    } else if (list && /^\s{2,}\S/.test(line)) {
      // continuation of the last list item
      list.items[list.items.length - 1] += ` ${line.trim()}`
    } else {
      if (list || tip.length || table) flush()
      para.push(line.trim())
    }
  }
  flush()
  for (const c of chapters) {
    const body = c.blocks.map((b) => ('text' in b ? b.text : 'items' in b ? b.items.join(' ') : 'rows' in b ? b.rows.flat().join(' ') : b.alt))
    c.search = plain([c.title, ...body].join(' ')).toLowerCase()
  }
  return { title, chapters }
}

/** Words of a search, lower case; every word has to occur in a chapter. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
}

export function matches(chapter: Chapter, words: string[]): boolean {
  return words.every((w) => chapter.search.includes(w))
}
