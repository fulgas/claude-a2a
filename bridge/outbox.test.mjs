// A task's outbox: the files a task leaves in its folder, read into named artifacts, and everything refused.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { OUTBOX_LIMITS, readOutbox } from './outbox.mjs'

const outbox = files => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-outbox-test-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

describe('a task outbox', () => {
  test('is empty when the task leaves nothing', () => {
    assert.deepEqual(readOutbox(outbox({})), [])
  })

  test('a .json file is one data artifact, named without its extension', () => {
    const [artifact] = readOutbox(outbox({ 'pheme.plan.v1.json': '{"title":"x","beats":[1,2]}' }))
    assert.deepEqual(artifact, { name: 'pheme.plan.v1', parts: [{ data: { title: 'x', beats: [1, 2] } }] })
  })

  test('any other file is one file artifact, as bytes, with its name and media type', () => {
    const artifacts = readOutbox(outbox({ 'poster.jpg': Buffer.from([0xff, 0xd8, 0xff]), 'notes.bin': 'x' }))
    assert.deepEqual(
      artifacts.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'notes', parts: [{ raw: 'eA==', filename: 'notes.bin', mediaType: 'application/octet-stream' }] },
        { name: 'poster', parts: [{ raw: '/9j/', filename: 'poster.jpg', mediaType: 'image/jpeg' }] },
      ],
    )
  })

  test('a .json file that is not one object fails the task', () => {
    for (const content of ['[1]', '"text"', 'null', '{"open":', '']) {
      assert.throws(() => readOutbox(outbox({ 'reply.json': content })), /reply\.json: not one JSON object/)
    }
  })

  test('a link, a folder or anything but a regular file fails the task', () => {
    const linked = outbox({ 'real.txt': 'x' })
    symlinkSync(join(linked, 'real.txt'), join(linked, 'link.txt'))
    assert.throws(() => readOutbox(linked), /link\.txt: not a regular file/)
    const nested = outbox({})
    mkdirSync(join(nested, 'sub'))
    assert.throws(() => readOutbox(nested), /sub: not a regular file/)
  })

  test('a name that is not one, or two files with one name, fails the task', () => {
    assert.throws(() => readOutbox(outbox({ '.hidden': 'x' })), /\.hidden: not a valid artifact name/)
    assert.throws(() => readOutbox(outbox({ 'reply.json': '{}', 'reply.txt': 'x' })), /two files are named reply/)
  })

  test('the limits default to 15 files, 32 MiB in one and 90 MiB in all', () => {
    assert.deepEqual(OUTBOX_LIMITS, { files: 15, fileMiB: 32, totalMiB: 90 })
  })

  test('more files, a bigger file or more bytes than the limits fail the task', () => {
    const limits = { files: 2, fileMiB: 1, totalMiB: 2 }
    const MiB = 1024 * 1024
    assert.throws(() => readOutbox(outbox({ 'a.txt': 'x', 'b.txt': 'x', 'c.txt': 'x' }), limits), /more than 2 files/)
    assert.throws(() => readOutbox(outbox({ 'big.bin': Buffer.alloc(MiB + 1) }), limits), /big\.bin: over 1 MiB/)
    const heavy = { 'a.bin': Buffer.alloc(MiB), 'b.bin': Buffer.alloc(MiB), 'c.json': '{}' }
    assert.throws(() => readOutbox(outbox(heavy), { ...limits, files: 3 }), /over 2 MiB in all/)
    assert.equal(readOutbox(outbox({ 'a.bin': Buffer.alloc(MiB), 'b.bin': Buffer.alloc(MiB) }), limits).length, 2)
  })
})
