import childProcess from 'child_process'
import fs from 'fs'
import path from 'path'

export function buildWineClipboard () {
  if (process.platform !== 'linux') return

  const outDir = path.resolve('dist/native')
  fs.mkdirSync(outDir, { recursive: true })
  const output = path.join(outDir, 'ee2-win-clipboard.exe')
  const result = childProcess.spawnSync('winegcc', [
    path.resolve('native/ee2-win-clipboard.c'),
    '-O2',
    '-o',
    output
  ], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`winegcc failed with exit code ${result.status}`)
}
