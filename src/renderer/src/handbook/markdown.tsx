// A small Markdown subset for the handbook (handbook/de.md, en.md), rendered as React elements
// (no HTML from the text is ever injected):
//   ## Chapter {#id}   ### Heading   paragraphs   - lists   1. lists   > tip   | table |
//   ![Caption](screenshot.jpg)   **bold**   `code`   [[Ctrl+Z]] keys
//   [text](https://…) opens the browser, [text](#chapter) jumps, [text](app:action) runs an action
import type { ReactNode } from 'react'
import type { Block } from '@shared/handbook'

export { matches, parseHandbook, plain, searchWords, type Block, type Chapter } from '@shared/handbook'

export interface InlineContext {
  /** Search words to highlight. */
  words: string[]
  onJump(id: string): void
  onAction(action: string): void
}

function highlight(text: string, words: string[], key: string): ReactNode[] {
  if (!words.length) return [text]
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(re).map((part, i) => (i % 2 ? <mark key={`${key}-${i}`}>{part}</mark> : part))
}

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g

export function Inline({ text, ctx }: { text: string; ctx: InlineContext }) {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(...highlight(text.slice(last, at), ctx.words, `t${k++}`))
    const key = `i${k++}`
    if (m[1] != null) out.push(<strong key={key}>{highlight(m[1], ctx.words, key)}</strong>)
    else if (m[2] != null) out.push(<code key={key}>{highlight(m[2], ctx.words, key)}</code>)
    else if (m[3] != null) out.push(<kbd key={key}>{m[3]}</kbd>)
    else {
      const label = highlight(m[4], ctx.words, key)
      const href = m[5]
      if (href.startsWith('#')) {
        out.push(
          <a key={key} href={href} onClick={(e) => (e.preventDefault(), ctx.onJump(href.slice(1)))}>
            {label}
          </a>
        )
      } else if (href.startsWith('app:')) {
        out.push(
          <a key={key} href="#" className="action" onClick={(e) => (e.preventDefault(), ctx.onAction(href.slice(4)))}>
            {label}
          </a>
        )
      } else if (/^https:\/\//.test(href)) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        )
      } else out.push(<span key={key}>{label}</span>)
    }
    last = at + m[0].length
  }
  if (last < text.length) out.push(...highlight(text.slice(last), ctx.words, `t${k++}`))
  return <>{out}</>
}

export function Blocks({ blocks, ctx, imageBase }: { blocks: Block[]; ctx: InlineContext; imageBase: string }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'p':
            return (
              <p key={i}>
                <Inline text={b.text} ctx={ctx} />
              </p>
            )
          case 'h3':
            return (
              <h4 key={i}>
                <Inline text={b.text} ctx={ctx} />
              </h4>
            )
          case 'tip':
            return (
              <div key={i} className="hb-tip">
                <Inline text={b.text} ctx={ctx} />
              </div>
            )
          case 'ul':
          case 'ol': {
            const Tag = b.type
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} ctx={ctx} />
                  </li>
                ))}
              </Tag>
            )
          }
          case 'table':
            return (
              <table key={i} className="hb-table">
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, n) => (
                        <td key={n}>
                          <Inline text={c} ctx={ctx} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          case 'img':
            return (
              <figure key={i} className="hb-shot">
                <img
                  src={`${imageBase}${b.file}`}
                  alt={b.alt}
                  loading="lazy"
                  onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')}
                />
                {b.alt && <figcaption>{b.alt}</figcaption>}
              </figure>
            )
        }
      })}
    </>
  )
}
