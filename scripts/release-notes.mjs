// Prints the CHANGELOG.md section of a version, for the GitHub release (.github/workflows/release.yml).
//   node scripts/release-notes.mjs v1.0.0 > notes.md
// Fails when the section is missing, so a release can't go out without notes.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The body of "## [1.0.0] …" (or "## 1.0.0 …") up to the next "## " heading, trimmed; null if missing. */
export function releaseNotes(changelog, version) {
  const v = String(version).trim().replace(/^v(?=\d)/, '')
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = changelog.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${esc}\\]?(\\s|$)`).test(l))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  if (end < 0) end = lines.length
  // link definitions at the end of the file ("[1.0.0]: https://…") don't belong to the section
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l))
  const text = body.join('\n').trim()
  return text || null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: node scripts/release-notes.mjs <version>')
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const notes = releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)
  if (!notes) {
    console.error(`CHANGELOG.md has no section for ${version}`)
    process.exit(1)
  }
  process.stdout.write(`${notes}\n`)
}
