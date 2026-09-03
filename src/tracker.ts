/** Full-resolution patch match around the lock point. */

const PATCH = 36
const SEARCH = 48
const STEP = 2
const MAX_JUMP = 44
const MISS_LIMIT = 12

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

  private readonly patch = document.createElement('canvas')
  private readonly patchCtx: CanvasRenderingContext2D
  private readonly work = document.createElement('canvas')
  private readonly workCtx: CanvasRenderingContext2D
  private template: Uint8Array | null = null
  private baseline = 1
  private misses = 0

  constructor() {
    this.patch.width = PATCH
    this.patch.height = PATCH
    const pctx = this.patch.getContext('2d', { willReadFrequently: true })
    const wctx = this.work.getContext('2d', { willReadFrequently: true })
    if (!pctx || !wctx) throw new Error('2D canvas unavailable')
    this.patchCtx = pctx
    this.workCtx = wctx
    this.work.width = PATCH + SEARCH * 2
    this.work.height = PATCH + SEARCH * 2
  }

  lock(source: CanvasImageSource, srcW: number, srcH: number, x: number, y: number): boolean {
    this.foundX = clamp(x, PATCH, srcW - PATCH)
    this.foundY = clamp(y, PATCH, srcH - PATCH)
    blitPatch(this.patchCtx, source, this.foundX, this.foundY, PATCH)
    this.template = readGray(this.patchCtx, PATCH, PATCH)
    this.baseline = Math.max(1, variance(this.template))
    this.locked = true
    this.lost = false
    this.misses = 0
    this.score = 1
    return this.baseline > 18
  }

  unlock(): void {
    this.locked = false
    this.lost = false
    this.template = null
    this.misses = 0
  }

  update(source: CanvasImageSource, srcW: number, srcH: number): TrackResult {
    if (!this.locked || !this.template) {
      return { foundX: srcW / 2, foundY: srcH / 2, score: 0, lost: true }
    }

    const win = PATCH + SEARCH * 2
    blitPatch(this.workCtx, source, this.foundX, this.foundY, win)
    const gray = readGray(this.workCtx, win, win)
    const { x, y, cost } = search(gray, win, this.template)
    const origin = win / 2
    const rawX = this.foundX + (x - origin)
    const rawY = this.foundY + (y - origin)
    const n = PATCH * PATCH
    const meanAbs = cost / n
    const good =
      meanAbs < 38 &&
      Math.hypot(rawX - this.foundX, rawY - this.foundY) <= MAX_JUMP

    if (good) {
      this.foundX = clamp(rawX, PATCH, srcW - PATCH)
      this.foundY = clamp(rawY, PATCH, srcH - PATCH)
      this.misses = Math.max(0, this.misses - 2)
      this.score = clamp01(1 - meanAbs / 38)
    } else {
      this.misses += 1
      this.score = clamp01(1 - meanAbs / 50)
    }
    this.lost = this.misses >= MISS_LIMIT
    return {
      foundX: this.foundX,
      foundY: this.foundY,
      score: this.score,
      lost: this.lost,
    }
  }
}

function search(
  gray: Uint8Array,
  gw: number,
  templ: Uint8Array,
): { x: number; y: number; cost: number } {
  const min = Math.floor(PATCH / 2)
  const max = gw - min - 1
  let best = Infinity
  const origin = Math.floor(gw / 2)
  let bx = origin
  let by = origin
  for (let y = min; y <= max; y += STEP) {
    for (let x = min; x <= max; x += STEP) {
      const cost = sad(gray, gw, x, y, templ)
      if (cost < best) {
        best = cost
        bx = x
        by = y
      }
    }
  }
  for (let y = by - 1; y <= by + 1; y++) {
    for (let x = bx - 1; x <= bx + 1; x++) {
      if (x < min || x > max || y < min || y > max) continue
      const cost = sad(gray, gw, x, y, templ)
      if (cost < best) {
        best = cost
        bx = x
        by = y
      }
    }
  }
  return { x: bx, y: by, cost: best }
}

function sad(
  gray: Uint8Array,
  gw: number,
  cx: number,
  cy: number,
  templ: Uint8Array,
): number {
  const half = Math.floor(PATCH / 2)
  let s = 0
  let t = 0
  for (let y = cy - half; y < cy - half + PATCH; y++) {
    let i = y * gw + (cx - half)
    for (let x = 0; x < PATCH; x++) s += Math.abs(gray[i++] - templ[t++])
  }
  return s
}

function blitPatch(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  cx: number,
  cy: number,
  size: number,
): void {
  if (ctx.canvas.width !== size || ctx.canvas.height !== size) {
    ctx.canvas.width = size
    ctx.canvas.height = size
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  const sx = Math.round(cx - size / 2)
  const sy = Math.round(cy - size / 2)
  ctx.drawImage(source, sx, sy, size, size, 0, 0, size, size)
}

function readGray(ctx: CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const data = ctx.getImageData(0, 0, w, h).data
  const gray = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
  }
  return gray
}

function variance(gray: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < gray.length; i++) sum += gray[i]
  const mean = sum / gray.length
  let v = 0
  for (let i = 0; i < gray.length; i++) {
    const d = gray[i] - mean
    v += d * d
  }
  return v / gray.length
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
