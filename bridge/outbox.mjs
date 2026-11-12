// A task's outbox: the folder a task leaves files in, read into named artifacts when it is answered. Each regular file
// directly in it is one artifact named after the file without its extension: a .json file holds one JSON object and
// becomes a data part, any other file a file part of its bytes. Anything else in the folder fails the task.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, parse } from 'node:path'

// The defaults fit a strict caller: 15 files and the text answer are 16 artifacts; 32 MiB in base64 stays under 44 MiB
// for one event; 90 MiB in all under 128 MiB for one stream. The server's options raise or lower them.
export const OUTBOX_LIMITS = { files: 15, fileMiB: 32, totalMiB: 90 }
const MiB = 1024 * 1024

const MEDIA_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
}
// What the agent card says the agent can answer with.
export const OUTPUT_MODES = [
  ...new Set(['text/plain', 'application/json', ...Object.values(MEDIA_TYPES), 'application/octet-stream']),
]

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The artifacts in `dir`, as JSON for TaskArtifactUpdateEvent; throws why the outbox is refused. */
export function readOutbox(dir, limits = OUTBOX_LIMITS) {
  const files = readdirSync(dir)
  if (files.length > limits.files) throw new Error(`the outbox holds more than ${limits.files} files`)
  const names = new Set()
  let total = 0
  return files.map(file => {
    const path = join(dir, file)
    // lstat refuses a link before it is opened; O_NOFOLLOW and fstat refuse one swapped in after.
    if (!lstatSync(path).isFile()) throw new Error(`${file}: not a regular file`)
    const name = parse(file).name
    if (!NAME.test(name)) throw new Error(`${file}: not a valid artifact name`)
    if (names.has(name)) throw new Error(`two files are named ${name}`)
    names.add(name)
    const bytes = readRegular(path, file, limits.fileMiB)
    total += bytes.length
    if (total > limits.totalMiB * MiB) throw new Error(`the outbox holds over ${limits.totalMiB} MiB in all`)
    const ext = extname(file).toLowerCase()
    if (ext === '.json') return { name, parts: [{ data: jsonObject(bytes, file) }] }
    return {
      name,
      parts: [
        { raw: bytes.toString('base64'), filename: file, mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream' },
      ],
    }
  })
}

function readRegular(path, file, maxMiB) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    if (err.code === 'ELOOP') throw new Error(`${file}: not a regular file`)
    throw err
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${file}: not a regular file`)
    if (stat.size > maxMiB * MiB) throw new Error(`${file}: over ${maxMiB} MiB`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function jsonObject(bytes, file) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    value = undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${file}: not one JSON object`)
  return value
}
