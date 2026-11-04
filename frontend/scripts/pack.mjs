// Builds ../build/oggy: everything the installed app needs to run its own backend.
// electron-builder copies it to resources/oggy (see "extraResources" in package.json),
// and src/main/server.ts starts it from there:
//
//   build/oggy/node/node.exe            Node to run the backend (this machine's Node 22)
//   build/oggy/backend/server.mjs       the backend, bundled into one file
//   build/oggy/backend/node_modules/    better-sqlite3 (native, so it can't be bundled) and its runtime deps
//   build/oggy/vscode-bridge/           the VS Code bridge extension
//   build/oggy/switch/config.example.json  what the first-run setup window fills in
//
// Run: pnpm pack:backend   (or as part of pnpm dist)
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'build', 'oggy')
const backend = join(root, 'backend')
const step = (msg) => console.log(`[pack] ${msg}`)

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor !== 22) {
  console.error(`[pack] Run this with Node 22 (found ${process.version}): node.exe is copied from here and better-sqlite3 must match it.`)
  process.exit(1)
}
if (!existsSync(join(backend, 'node_modules', 'better-sqlite3'))) {
  console.error('[pack] backend/node_modules is missing: run `pnpm install` in backend first.')
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 1. Node
step(`node.exe ${process.version}`)
mkdirSync(join(out, 'node'))
cpSync(process.execPath, join(out, 'node', 'node.exe'))

// 2. The backend, one ESM file. CommonJS deps inside it still need require/__dirname, so give it those.
step('bundling backend/src/index.ts')
await build({
  entryPoints: [join(backend, 'src', 'index.ts')],
  outfile: join(out, 'backend', 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3'],
  legalComments: 'none',
  logLevel: 'warning',
  banner: {
    js: [
      "import { createRequire as __oggyRequire } from 'node:module';",
      "import { fileURLToPath as __oggyPath } from 'node:url';",
      "import { dirname as __oggyDir } from 'node:path';",
      'const require = __oggyRequire(import.meta.url);',
      'const __filename = __oggyPath(import.meta.url);',
      'const __dirname = __oggyDir(__filename);'
    ].join('\n')
  }
})

// 3. better-sqlite3 and what it needs at runtime (not its install-time helpers), copied out of pnpm's store.
const SKIP = new Set(['prebuild-install'])
const copied = new Set()
function copyPackage(name, fromDir) {
  if (copied.has(name) || SKIP.has(name)) return
  copied.add(name)
  const req = createRequire(join(fromDir, 'noop.js'))
  const pkgJson = req.resolve(`${name}/package.json`)
  const src = realpathSync(dirname(pkgJson))
  const dest = join(out, 'backend', 'node_modules', name)
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    // native sources and build leftovers aren't needed to run
    filter: (p) => !/[\\/](deps|src|test|docs|benchmark|\.github)([\\/]|$)/.test(p.slice(src.length)) && !/\.(md|map|ts)$/.test(p) || p.endsWith('.node')
  })
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackage(dep, src)
}
copyPackage('better-sqlite3', backend)
const native = join(out, 'backend', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
if (!existsSync(native)) {
  console.error('[pack] better_sqlite3.node is missing from the copy: the backend could not open its database.')
  process.exit(1)
}
step(`native modules: ${[...copied].join(', ')}`)

// 4. The VS Code bridge and the example config
cpSync(join(root, 'vscode-bridge'), join(out, 'vscode-bridge'), { recursive: true })
cpSync(join(root, 'switch', 'config.example.json'), join(out, 'switch', 'config.example.json'))

const mb = (statSync(join(out, 'backend', 'server.mjs')).size / 1e6).toFixed(1)
step(`done: build/oggy (server.mjs ${mb} MB)`)
