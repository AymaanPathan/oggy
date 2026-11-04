// Publishes build/installer/Oggy-Setup.exe as a GitHub release named after package.json's version (v0.1.0).
// The landing page's Download button points at .../releases/latest/download/Oggy-Setup.exe,
// so the newest release is what people get. Needs the GitHub CLI, logged in (gh auth login).
//
// Run: pnpm release          (builds first, then publishes)
//      node scripts/release.mjs --notes "What changed"
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const tag = `v${version}`
const exe = join(here, '..', 'build', 'installer', 'Oggy-Setup.exe')
const gh = (...args) => spawnSync('gh', args, { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

if (!existsSync(exe)) {
  console.error('[release] build/installer/Oggy-Setup.exe not found: run `pnpm dist` first.')
  process.exit(1)
}
if (gh('release', 'view', tag).status === 0) {
  console.error(`[release] ${tag} already exists on GitHub. Bump "version" in frontend/package.json, rebuild, and run again.`)
  process.exit(1)
}

const i = process.argv.indexOf('--notes')
const notes = i > 0 && process.argv[i + 1]
  ? process.argv[i + 1]
  : `Oggy ${tag} for Windows 10/11 (64-bit).\n\nDownload **Oggy-Setup.exe** below and run it. The first launch asks for your Switch details and code folder, then press Ctrl+Space to talk to Oggy.`

console.log(`[release] publishing ${tag} with Oggy-Setup.exe (${(statSync(exe).size / 1e6).toFixed(0)} MB)…`)
const r = spawnSync('gh', ['release', 'create', tag, exe, '--title', `Oggy ${tag}`, '--notes', notes, '--latest'], { cwd: here, stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
console.log(`[release] done: https://github.com/AymaanPathan/oggy/releases/tag/${tag}`)
