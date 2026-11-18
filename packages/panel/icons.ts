import { writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

/**
 * A placeholder logo until the owner's arrives: a blue-to-cyan ring on the panel's dark background,
 * drawn here so the repository holds no binary. It fills the whole square, so it also works maskable.
 */
const BACKGROUND = [0x0b, 0x12, 0x20]
const BLUE = [0x2f, 0x80, 0xff]
const CYAN = [0x28, 0xe6, 0xff]

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function pixel(x: number, y: number, size: number): number[] {
  const r = Math.hypot(x - size / 2, y - size / 2) / (size / 2)
  if (r < 0.42 || r > 0.62) {
    return BACKGROUND
  }
  const t = (x + y) / (2 * size)
  return BLUE.map((from, i) => Math.round(from + (CYAN[i]! - from) * t))
}

export function icon(size: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows: number[] = []
  for (let y = 0; y < size; y++) {
    rows.push(0)
    for (let x = 0; x < size; x++) {
      rows.push(...pixel(x, y, size))
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const writeIcon = (path: string, size: number) => writeFile(path, icon(size))
