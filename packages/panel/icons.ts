import { writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

/*
 * The DefiMind logo (public/icons/logo.svg) as plain geometry, so the icons are drawn at build
 * time without a browser or an image library. Every shape is the SVG's own, in its 1000-unit
 * viewBox; keep the two in step if the logo changes. It lives here because the image build copies
 * only build.ts and icons.ts.
 */
type Point = [number, number]
type Rgb = [number, number, number]

const TOP: Rgb = [0x2f, 0x8c, 0xff]
const BOTTOM: Rgb = [0x21, 0x66, 0xe8]
const SHADE: Rgb = [0x0c, 0x3f, 0xa6]
const SWOOSH: Rgb = [0x25, 0xe4, 0xff]

/** The part of the viewBox the logo covers, to centre and scale it. */
const BOUNDS = { x: 263, y: 192, width: 424, height: 602 }

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

const inRect = (x: number, y: number, x0: number, y0: number, w: number, h: number) =>
  x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h

/** A quadratic Bézier from a to b through control c, as a polyline. */
function curve(a: Point, c: Point, b: Point, steps = 48): Point[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps
    const u = 1 - t
    return [
      u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
      u * u * a[1] + 2 * u * t * c[1] + t * t * b[1],
    ]
  })
}

const LOW: Point[] = [
  [200, 748],
  [355, 748],
  ...curve([355, 748], [640, 720], [687, 430]),
  [1000, 430],
  [1000, 1000],
  [200, 1000],
]

const BAND: Point[] = [
  [350, 742],
  ...curve([350, 742], [636, 718], [687, 424]),
  [687, 478],
  ...curve([687, 478], [648, 748], [372, 764]),
]

/** Even-odd point in polygon. */
function inside(x: number, y: number, polygon: Point[]): boolean {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!
    const [xj, yj] = polygon[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      hit = !hit
    }
  }
  return hit
}

/** The logo's colour at a viewBox point, or undefined where it is transparent. */
function logoAt(x: number, y: number): Rgb | undefined {
  const shape =
    (inEllipse(x, y, 475, 558, 212, 236) || inRect(x, y, 585, 192, 102, 380)) &&
    !inEllipse(x, y, 455, 542, 100, 123) &&
    !inRect(x, y, 555, 0, 30, 420) &&
    x < 687
  if (!shape) {
    return undefined
  }
  if (inside(x, y, BAND)) {
    return SWOOSH
  }
  if (inside(x, y, LOW)) {
    return SHADE
  }
  const t = y / 1000
  return TOP.map((from, i) => from + (BOTTOM[i]! - from) * t) as Rgb
}

/**
 * The PWA icons: the DefiMind logo at about 60% on its navy, drawn here so the repository holds no
 * binary. The logo sits inside a maskable icon's safe zone.
 */
const BACKGROUND: Rgb = [0x03, 0x0b, 0x26]
const SAMPLES = 4

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

/** One pixel, averaged over a few samples so the edges are smooth. */
function pixel(x: number, y: number, size: number): number[] {
  const scale = BOUNDS.height / (size * 0.6)
  const left = BOUNDS.x + BOUNDS.width / 2 - (size / 2) * scale
  const top = BOUNDS.y + BOUNDS.height / 2 - (size / 2) * scale
  const sum = [0, 0, 0]
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const colour =
        logoAt(left + (x + (i + 0.5) / SAMPLES) * scale, top + (y + (j + 0.5) / SAMPLES) * scale) ??
        BACKGROUND
      colour.forEach((c, k) => (sum[k]! += c))
    }
  }
  return sum.map((c) => Math.round(c / SAMPLES ** 2))
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
