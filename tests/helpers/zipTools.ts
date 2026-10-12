// Independent ZIP readers for the archive tests: Windows' tar.exe (bsdtar / libarchive), Python's
// zipfile and .NET's System.IO.Compression (PowerShell). Each is skipped where it is not installed.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Windows' own tar.exe (bsdtar), not Git's GNU tar (which can't read ZIP files). */
export const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
export const hasTar = existsSync(TAR)

function findPython(): string[] | null {
  for (const cmd of [['py', '-3'], ['python'], ['python3']]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), '-c', 'import zipfile, json; print(1)'], { encoding: 'utf8', timeout: 20_000 })
    if (r.status === 0 && r.stdout.trim() === '1') return cmd
  }
  return null
}
export const PYTHON = findPython()

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
export const hasPowerShell = process.platform === 'win32' && existsSync(POWERSHELL)

export interface PythonZip {
  /** First entry with a bad CRC (testzip), or null. */
  bad: string | null
  names: string[]
  sizes: number[]
  methods: number[]
}

/** Python's zipfile: names, sizes, methods and a full CRC test of every entry. */
export function pythonRead(file: string): PythonZip {
  if (!PYTHON) throw new Error('no python')
  const script = [
    'import zipfile, sys, json',
    'z = zipfile.ZipFile(sys.argv[1])',
    'bad = z.testzip()',
    'info = z.infolist()',
    "print(json.dumps({'bad': bad, 'names': [i.filename for i in info], 'sizes': [i.file_size for i in info], 'methods': [i.compress_type for i in info]}))"
  ].join('\n')
  const out = execFileSync(PYTHON[0], [...PYTHON.slice(1), '-I', '-c', script, file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  return JSON.parse(out) as PythonZip
}

/** Characters of Windows-1252 (the ANSI code page of German and English Windows) beyond Latin-1. */
const CP1252_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178
])

/**
 * Names tar.exe can extract: it converts UTF-8 names to the Windows ANSI code page, so letters outside
 * it (CJK, emoji) are skipped by tar.exe itself (Explorer, 7-Zip, Python and .NET extract them).
 */
export const tarSafeName = (name: string): boolean =>
  [...name].every((c) => {
    const k = c.codePointAt(0)!
    return (k >= 0x20 && k <= 0xff) || CP1252_EXTRA.has(k)
  })

/**
 * Extracts with tar.exe into `dir` and returns every file below it (relative, forward slashes) with
 * its size. Fails unless tar.exe reported problems only for names it can't write (tarSafeName).
 */
export function tarExtract(file: string, dir: string, names: string[] = []): Map<string, number> {
  mkdirSync(dir, { recursive: true })
  const r = spawnSync(TAR, ['-xf', file, '-C', dir], { encoding: 'utf8' })
  if (r.status !== 0 && names.every(tarSafeName)) throw new Error(`tar.exe failed: ${r.stderr}`)
  return listFiles(dir)
}

/** Number of entries tar.exe lists. */
export function tarCount(file: string): number {
  const out = execFileSync(TAR, ['-tf', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return out.split(/\r?\n/).filter(Boolean).length
}

/** Extracts with PowerShell's Expand-Archive (.NET) into `dir`; the files below it with their sizes. */
export function powershellExtract(file: string, dir: string): Map<string, number> {
  // paths through the environment: arguments after -Command become part of the command text
  execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:ZIP_FILE -DestinationPath $env:ZIP_DEST -Force'], {
    stdio: 'pipe',
    timeout: 120_000,
    env: { ...process.env, ZIP_FILE: file, ZIP_DEST: dir }
  })
  return listFiles(dir)
}

export function listFiles(dir: string, root = dir, out = new Map<string, number>()): Map<string, number> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) listFiles(p, root, out)
    else out.set(relative(root, p).split('\\').join('/'), st.size)
  }
  return out
}
