/** Downscaled grayscale template match so a locked patch can be followed in 2D. */

const WORK_W = 160
const PATCH = 18
const SEARCH = 26
const STEP = 2

export type TrackResult = {
  foundX: number
  foundY: number
  score: number
  lost: boolean
}

export class SubjectTracker {
  locked = false
  lost = false
  foundX = 0
  foundY = 0
  score = 1

  private readonly work = document.createElement('canvas')
  private readonly workCtx: CanvasRenderingContext2D
  private template: Uint8Array | null = null
  private baseline = 0
  private lastWorkX = 0
  private lastWorkY = 0

  constructor() {
    const ctx = this.work.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2D canvas unavailable')
    this.workCtx = ctx
  }

  lock(source: CanvasImageSource, srcW: number, srcH: number, x: number, y: number): boolean {
    this.prepareWork(srcW, srcH)
    this.workCtx.drawImage(source, 0, 0, this.work.width, this.work.height)
    const gray = readGray(this.workCtx, this.work.width, this.work.height)
    const sx = this.work.width / srcW
    const sy = this.work.height / srcH
    const wx = clampInt(Math.round(x * sx), PATCH, this.work.width - PATCH - 1)
    const wy = clampInt(Math.round(y * sy), PATCH, this.work.height - PATCH - 1)
    this.template = extractPatch(gray, this.work.width, wx, wy, PATCH)
    this.baseline = sad(gray, this.work.width, wx, wy, this.template, PATCH)
    this.lastWorkX = wx
    this.lastWorkY = wy
    this.foundX = x
    this.foundY = y
    this.locked = true
    this.lost = false
    this.score = 1
    return true
  }

  unlock(): void {
    this.locked = false
    this.lost = false
    this.template = null
  }

  update(source: CanvasImageSource, srcW: number, srcH: number): TrackResult {
    if (!this.locked || !this.template) {
      return { foundX: srcW / 2, foundY: srcH / 2, score: 0, lost: true }
    }
    this.prepareWork(srcW, srcH)
    this.workCtx.drawImage(source, 0, 0, this.work.width, this.work.height)
    const gray = readGray(this.workCtx, this.work.width, this.work.height)
    const { x, y, cost } = search(
      gray,
      this.work.width,
      this.work.height,
      this.template,
      this.lastWorkX,
      this.lastWorkY,
    )
    this.lastWorkX = x
    this.lastWorkY = y
    const sx = srcW / this.work.width
    const sy = srcH / this.work.height
    this.foundX = x * sx
    this.foundY = y * sy
    const denom = Math.max(1, this.baseline)
    this.score = clamp01(1 - (cost - this.baseline) / (denom * 3))
    this.lost = cost > this.baseline * 2.4 + PATCH * PATCH * 8
    return {
      foundX: this.foundX,
      foundY: this.foundY,
      score: this.score,
      lost: this.lost,
    }
  }

  private prepareWork(srcW: number, srcH: number): void {
    const h = Math.max(90, Math.round((WORK_W * srcH) / srcW))
    if (this.work.width !== WORK_W || this.work.height !== h) {
      this.work.width = WORK_W
      this.work.height = h
    }
  }
}

function search(
  gray: Uint8Array,
  gw: number,
  gh: number,
  templ: Uint8Array,
  cx: number,
  cy: number,
): { x: number; y: number; cost: number } {
  const minX = PATCH
  const maxX = gw - PATCH - 1
  const minY = PATCH
  const maxY = gh - PATCH - 1
  const x0 = clampInt(cx - SEARCH, minX, maxX)
  const x1 = clampInt(cx + SEARCH, minX, maxX)
  const y0 = clampInt(cy - SEARCH, minY, maxY)
  const y1 = clampInt(cy + SEARCH, minY, maxY)

  let best = Infinity
  let bx = cx
  let by = cy
  for (let y = y0; y <= y1; y += STEP) {
    for (let x = x0; x <= x1; x += STEP) {
      const cost = sad(gray, gw, x, y, templ, PATCH)
      if (cost < best) {
        best = cost
        bx = x
        by = y
      }
    }
  }
  for (let y = by - 1; y <= by + 1; y++) {
    for (let x = bx - 1; x <= bx + 1; x++) {
      if (x < minX || x > maxX || y < minY || y > maxY) continue
      const cost = sad(gray, gw, x, y, templ, PATCH)
      if (cost < best) {
        best = cost
        bx = x
        by = y
      }
    }
  }
  return { x: bx, y: by, cost: best }
}

function extractPatch(
  gray: Uint8Array,
  gw: number,
  cx: number,
  cy: number,
  size: number,
): Uint8Array {
  const out = new Uint8Array(size * size)
  const half = Math.floor(size / 2)
  let i = 0
  for (let y = cy - half; y < cy - half + size; y++) {
    const row = y * gw + (cx - half)
    for (let x = 0; x < size; x++) out[i++] = gray[row + x] ?? 0
  }
  return out
}

function sad(
  gray: Uint8Array,
  gw: number,
  cx: number,
  cy: number,
  templ: Uint8Array,
  size: number,
): number {
  const half = Math.floor(size / 2)
  let s = 0
  let t = 0
  for (let y = cy - half; y < cy - half + size; y++) {
    let i = y * gw + (cx - half)
    for (let x = 0; x < size; x++) s += Math.abs(gray[i++] - templ[t++])
  }
  return s
}

function readGray(ctx: CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const data = ctx.getImageData(0, 0, w, h).data
  const gray = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
  }
  return gray
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v | 0))
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
