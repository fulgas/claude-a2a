// A task's outbox: the files a task leaves in its folder, read into named artifacts, and everything refused.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { MAX_FILE_BYTES, MAX_FILES, readOutbox } from './outbox.mjs'

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

  test('more files, a bigger file or more bytes than the limits fail the task', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_FILES + 1 }, (_, i) => [`f${i}.txt`, 'x']))
    assert.throws(() => readOutbox(outbox(many)), /more than 15 files/)
    assert.throws(() => readOutbox(outbox({ 'big.bin': Buffer.alloc(MAX_FILE_BYTES + 1) })), /big\.bin: over 32 MiB/)
    const heavy = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`f${i}.bin`, Buffer.alloc(MAX_FILE_BYTES)]))
    assert.throws(() => readOutbox(outbox(heavy)), /over 90 MiB in all/)
  })
})
