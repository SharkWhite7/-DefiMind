import { writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

/**
 * The DefiMind mark (PANEL-18): a square in a square, in the ink blue on the panel's background,
 * drawn here so the repository holds no binary. It sits in the middle 45%, inside a maskable icon's
 * safe zone.
 */
const BACKGROUND = [0x0a, 0x0f, 0x1a]
const INK = [0x9d, 0xb7, 0xf0]

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
  const side = size * 0.45
  // From the mockup's 14px mark: a 2px ring, a 1px gap, then the filled centre.
  const ring = side / 7
  const gap = side * (3 / 14) - ring
  const d = Math.max(Math.abs(x + 0.5 - size / 2), Math.abs(y + 0.5 - size / 2))
  const edge = side / 2
  const inRing = d <= edge && d > edge - ring
  const inCore = d <= edge - ring - gap
  return inRing || inCore ? INK : BACKGROUND
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
