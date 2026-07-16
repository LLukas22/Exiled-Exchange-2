import childProcess from 'child_process'
import fs from 'fs'
import path from 'path'

export function buildWineClipboard () {
  if (process.platform !== 'linux') return

  const manifest = path.resolve('native/wine-clipboard/Cargo.toml')
  const target = 'x86_64-pc-windows-gnu'
  const outDir = path.resolve('dist/native')
  fs.mkdirSync(outDir, { recursive: true })
  const result = childProcess.spawnSync('cargo', [
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    manifest,
    '--target',
    target
  ], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Rust Wine clipboard build failed with exit code ${result.status}`)

  fs.copyFileSync(
    path.resolve('native/wine-clipboard/target', target, 'release', 'ee2-win-clipboard.exe'),
    path.join(outDir, 'ee2-win-clipboard.exe')
  )
}
