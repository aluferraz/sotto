// Bundles the main process and the preload script, and copies the built web app next to them.
import { build } from 'esbuild'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const web = join(here, '..', 'web', 'dist')
if (!existsSync(join(web, 'index.html'))) {
  console.error('Build the web app first: npm --prefix ../web run build')
  process.exit(1)
}

await build({
  entryPoints: [join(here, 'src/main.ts'), join(here, 'src/preload.ts')],
  outdir: join(here, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Electron provides itself; the key listener is a native module loaded from node_modules.
  external: ['electron', 'uiohook-napi'],
  sourcemap: true,
})

rmSync(join(here, 'web'), { recursive: true, force: true })
cpSync(web, join(here, 'web'), {
  recursive: true,
  // The engine test page is a developer tool, not part of the app.
  filter: (source) => !/harness/.test(source),
})
console.log('built dist/ and web/')
