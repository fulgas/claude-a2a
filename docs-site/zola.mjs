// Zola, pinned, downloaded once into docs-site/.zola: nothing to install by hand.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

const VERSION = '0.23.6'
const dir = new URL('.zola/', import.meta.url).pathname
const zola = `${dir}zola`

const installed = existsSync(zola) && spawnSync(zola, ['--version']).stdout?.toString().includes(VERSION)
if (!installed) {
  const target = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  }[`${process.platform}-${process.arch}`]
  if (!target) throw new Error(`no Zola ${VERSION} download for ${process.platform}-${process.arch}`)

  const res = await fetch(
    `https://github.com/getzola/zola/releases/download/v${VERSION}/zola-v${VERSION}-${target}.tar.gz`,
  )
  if (!res.ok) throw new Error(`Zola download failed: ${res.status}`)
  mkdirSync(dir, { recursive: true })
  const tar = spawnSync('tar', ['xz', '-C', dir], { input: Buffer.from(await res.arrayBuffer()) })
  if (tar.status !== 0) throw new Error(`could not unpack Zola: ${tar.stderr}`)
}
