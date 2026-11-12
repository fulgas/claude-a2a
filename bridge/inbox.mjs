// A task's inbox: the folder an incoming message's large parts are written to, so they reach the task as files and
// stay out of the prompt. Text and data up to INLINE_BYTES stay inline; larger ones, and all bytes, become files the
// prompt names, one line each. Files are written once and read-only (0400).
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const INLINE_BYTES = 64 * 1024

const size = bytes =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`

// A caller's file name, kept to one plain name inside the inbox.
const safe = filename =>
  basename(filename ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100)

/** Writes `parts`' large ones into `dir`, and returns the prompt text: small parts inline, a line for each file. */
export function writeInbox(dir, parts = []) {
  return parts
    .map((part, i) => {
      const n = i + 1
      const c = part.content
      if (!c) return ''
      if (c.$case === 'url') return c.value
      const file = (name, bytes, kind) => {
        const path = join(dir, name)
        writeFileSync(path, bytes, { mode: 0o400, flag: 'wx' })
        return `[part ${n}: ${kind}, ${size(bytes.length)}, in ${path}]`
      }
      if (c.$case === 'raw') {
        const name = safe(part.filename)
        return file(name ? `part-${n}-${name}` : `part-${n}.bin`, c.value, part.mediaType || 'application/octet-stream')
      }
      const value = c.$case === 'data' ? JSON.stringify(c.value) : c.value
      const bytes = Buffer.from(value, 'utf8')
      if (bytes.length <= INLINE_BYTES) return value
      return c.$case === 'data' ? file(`part-${n}.json`, bytes, 'data') : file(`part-${n}.txt`, bytes, 'text')
    })
    .filter(Boolean)
    .join('\n')
}
