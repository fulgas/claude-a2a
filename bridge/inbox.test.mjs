// A task's inbox: the parts of an incoming message, inline in the prompt when small, and in files when large.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { INLINE_BYTES, writeInbox } from './inbox.mjs'

const inbox = () => mkdtempSync(join(tmpdir(), 'a2a-inbox-test-'))
const text = value => ({ content: { $case: 'text', value } })
const data = value => ({ content: { $case: 'data', value } })
const raw = (value, filename, mediaType) => ({ content: { $case: 'raw', value }, filename, mediaType })
const url = value => ({ content: { $case: 'url', value } })

describe('a task inbox', () => {
  test('small parts stay in the prompt: text as is, data as JSON, a url as the url', () => {
    const dir = inbox()
    const prompt = writeInbox(dir, [text('hello'), data({ kind: 'plan' }), url('https://x.test/a')])
    assert.equal(prompt, 'hello\n{"kind":"plan"}\nhttps://x.test/a')
  })

  test('a large data part is a file holding the JSON, named in the prompt by one line', () => {
    const dir = inbox()
    const value = { bundle: 'x'.repeat(INLINE_BYTES) }
    const prompt = writeInbox(dir, [text('make the video'), data(value)])
    const path = join(dir, 'part-2.json')
    assert.equal(prompt, `make the video\n[part 2: data, 64.0 KiB, in ${path}]`)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), value)
    assert.equal(statSync(path).mode & 0o777, 0o400)
  })

  test('a large text part is a file too', () => {
    const dir = inbox()
    const prompt = writeInbox(dir, [text('y'.repeat(INLINE_BYTES + 1))])
    assert.equal(prompt, `[part 1: text, 64.0 KiB, in ${join(dir, 'part-1.txt')}]`)
  })

  test('bytes are always a file, under a name that cannot leave the inbox', () => {
    const dir = inbox()
    const prompt = writeInbox(dir, [
      raw(Buffer.from('PK'), '../../etc/source bundle.zip', 'application/zip'),
      raw(Buffer.from([1])),
    ])
    assert.equal(
      prompt,
      [
        `[part 1: application/zip, 2 B, in ${join(dir, 'part-1-source_bundle.zip')}]`,
        `[part 2: application/octet-stream, 1 B, in ${join(dir, 'part-2.bin')}]`,
      ].join('\n'),
    )
    assert.equal(readFileSync(join(dir, 'part-1-source_bundle.zip'), 'utf8'), 'PK')
  })
})
