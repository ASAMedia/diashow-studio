// Checks a release before its tag is pushed, the way GitHub will: run it on the commit to be tagged.
//   npm run release-check            everything (about 15 minutes)
//   npm run release-check -- --quick without the end-to-end tests
//
// 1. The working tree is clean, package.json and package-lock.json have the same version, CHANGELOG.md
//    has its section (with the downloads and THIRD_PARTY_NOTICES), and the tag isn't taken yet.
// 2. Type check and unit tests with freshly generated test media, as on a new runner (test-media/ is
//    set aside and put back if the generation fails).
// 3. The build and the end-to-end tests of .github/workflows/ci.yml with its environment (English UI,
//    software WebGL), read from the workflow so the two never drift apart.
// At the end it prints what to push, in which order.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { releaseNotes } from './release-notes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The spec list and the DIASHOW_* environment of the end-to-end step in ci.yml; null when there is none. */
export function ciE2e(yml) {
  const lines = yml.replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex((l) => /^\s*-\s*run:\s*npx playwright test\s/.test(l))
  if (at < 0) return null
  const specs = lines[at].replace(/^\s*-\s*run:\s*npx playwright test\s+/, '').trim().split(/\s+/)
  const env = {}
  // the step's own keys (env:, timeout-minutes:) are indented deeper than its "- run:"
  const indent = lines[at].indexOf('-')
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() && l.search(/\S/) <= indent) break
    const m = /^\s*(DIASHOW_[A-Z_]+):\s*'?([^'#\s]*)'?/.exec(l)
    if (m) env[m[1]] = m[2]
  }
  return { specs, env }
}

const read = (p) => readFileSync(join(root, p), 'utf8')
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })

function run(cmd, args, env = {}) {
  // npm and npx are .cmd files on Windows, which need a shell
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } })
  return r.status === 0
}

const results = []

/** Runs one check; `fn` returns what is wrong, or nothing. */
function step(name, fn) {
  const t0 = Date.now()
  let problem
  try {
    problem = fn()
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
  }
  const s = Math.round((Date.now() - t0) / 1000)
  results.push({ name, problem, s })
  console.log(`\n${problem ? '✗' : '✓'} ${name}${problem ? `: ${problem}` : ''} (${s} s)\n`)
}

function main() {
  const quick = process.argv.includes('--quick')
  const version = JSON.parse(read('package.json')).version
  const tag = `v${version}`
  let tagged = false

  step(`Version ${version}, changelog and tag`, () => {
    const dirty = git('status', '--porcelain').stdout.trim()
    if (dirty) return `the working tree has changes:\n${dirty}`
    const lock = JSON.parse(read('package-lock.json'))
    if (lock.version !== version || lock.packages?.['']?.version !== version) return `package-lock.json says ${lock.version}, package.json ${version} (npm install)`
    const notes = releaseNotes(read('CHANGELOG.md'), version)
    if (!notes) return `CHANGELOG.md has no section for ${version}`
    for (const want of [`Setup-${version}.exe`, `${version}-portable.exe`, 'THIRD_PARTY_NOTICES']) if (!notes.includes(want)) return `the ${version} section doesn't mention ${want}`
    const head = git('rev-parse', 'HEAD').stdout.trim()
    const local = git('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`).stdout.trim()
    if (local && local !== head) return `the tag ${tag} already exists on another commit (${local.slice(0, 7)})`
    tagged = !!local
    const remote = git('ls-remote', '--tags', 'origin', tag)
    if (remote.status === 0 && remote.stdout.trim()) return `${tag} is already on GitHub`
    return undefined
  })

  step('Type check and unit tests with fresh test media', () => {
    const media = join(root, 'test-media')
    const aside = join(root, 'test-media.before-release-check')
    if (existsSync(aside)) return `${aside} is left over from an earlier run; put it back or delete it`
    if (existsSync(media)) renameSync(media, aside)
    const ok = run('npm', ['run', 'typecheck']) && run('npx', ['vitest', 'run'])
    if (existsSync(join(media, '.complete-v2'))) rmSync(aside, { recursive: true, force: true })
    else if (existsSync(aside)) {
      rmSync(media, { recursive: true, force: true })
      renameSync(aside, media)
    }
    return ok ? undefined : 'failed (see above)'
  })

  if (!quick) {
    step('Build and the end-to-end tests of the CI', () => {
      const ci = ciE2e(read('.github/workflows/ci.yml'))
      if (!ci) return 'no "npx playwright test" step found in .github/workflows/ci.yml'
      if (!run('npx', ['electron-vite', 'build'])) return 'the build failed'
      console.log(`CI environment: ${JSON.stringify(ci.env)}, ${ci.specs.length} specs`)
      return run('npx', ['playwright', 'test', ...ci.specs], ci.env) ? undefined : 'failed (see above)'
    })
  }

  console.log('Release check')
  for (const r of results) console.log(`  ${r.problem ? '✗' : '✓'} ${r.name} (${r.s} s)`)
  if (results.some((r) => r.problem)) process.exit(1)

  const ahead = git('rev-list', '--count', 'origin/main..HEAD').stdout.trim()
  const workflows = git('diff', '--name-only', 'origin/main..HEAD', '--', '.github/workflows').stdout.trim()
  console.log(`\nReady${quick ? ' (without the end-to-end tests)' : ''}. Then:`)
  if (ahead !== '0') console.log(`  git push origin main${workflows ? '   (changes a workflow: needs the "workflow" scope, gh auth refresh -s workflow)' : ''}`)
  if (!tagged) console.log(`  git tag ${tag}`)
  console.log(`  git push origin ${tag}`)
  console.log('Push one version tag at a time and wait for its release, or "Latest" may land on an older one.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
