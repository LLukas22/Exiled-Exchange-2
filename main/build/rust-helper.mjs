import child_process from 'child_process'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

const helperManifest = path.resolve('native/ee2-wayland-helper/Cargo.toml')
const helperDistDir = path.resolve('dist/native')
const helperBinaryName = (process.platform === 'win32') ? 'ee2-wayland-helper.exe' : 'ee2-wayland-helper'

export function buildRustHelper ({ release = false } = {}) {
  fs.mkdirSync(helperDistDir, { recursive: true })

  if (process.platform !== 'linux') {
    return
  }

  if (!fs.existsSync(helperManifest)) {
    throw new Error(`Rust helper manifest not found: ${helperManifest}`)
  }

  const args = ['build', '--manifest-path', helperManifest]
  if (release) args.push('--release')

  const result = child_process.spawnSync('cargo', args, {
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`cargo ${args.join(' ')} failed with exit code ${result.status}`)
  }

  const profile = release ? 'release' : 'debug'
  const source = path.resolve('native/ee2-wayland-helper/target', profile, helperBinaryName)
  const dest = path.join(helperDistDir, helperBinaryName)
  fs.copyFileSync(source, dest)
  fs.chmodSync(dest, 0o755)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildRustHelper({ release: process.argv.includes('--release') })
}
