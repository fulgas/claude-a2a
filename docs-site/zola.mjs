// Zola, pinned, downloaded once into docs-site/.zola: nothing to install by hand.
// Each download is checked against its SHA-256 before it is unpacked or run.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'

const VERSION = '0.23.6'
// From the release's asset digests; update them with VERSION.
const TARGETS = {
  'darwin-arm64': ['aarch64-apple-darwin', 'cbffbd29b3f59c3f52633507c8cb945a7a02d8b1399b43b235f5932912297aa3'],
  'darwin-x64': ['x86_64-apple-darwin', '79a4d0ab51a4d863c068e6e594c6fce36f0aa17429a414ea63066f5910d14460'],
  'linux-x64': ['x86_64-unknown-linux-gnu', '8f5132b3522412d04e395e0b25f6d68613ad272a873e54a2b3ebf664873024a4'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '266448fffbf7c7004ca399d0e76dd699541771096d8a42aede98cebe2a029d02'],
}
const dir = new URL('.zola/', import.meta.url).pathname
const zola = `${dir}zola`

const installed = existsSync(zola) && spawnSync(zola, ['--version']).stdout?.toString().includes(VERSION)
if (!installed) {
  const [target, sha256] = TARGETS[`${process.platform}-${process.arch}`] ?? []
  if (!target) throw new Error(`no Zola ${VERSION} download for ${process.platform}-${process.arch}`)

  const res = await fetch(
    `https://github.com/getzola/zola/releases/download/v${VERSION}/zola-v${VERSION}-${target}.tar.gz`,
  )
  if (!res.ok) throw new Error(`Zola download failed: ${res.status}`)
  const archive = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(archive).digest('hex')
  if (got !== sha256) throw new Error(`Zola ${VERSION} ${target}: SHA-256 ${got}, expected ${sha256}`)

  mkdirSync(dir, { recursive: true })
  const tar = spawnSync('tar', ['xz', '-C', dir], { input: archive })
  if (tar.status !== 0) throw new Error(`could not unpack Zola: ${tar.stderr}`)
}
