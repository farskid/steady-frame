/**
 * Hard pin tracker: color mean-shift (follows a head that turns) +
 * whole-frame template search. FaceDetector only snaps when it agrees —
 * stale face boxes are what let a fast head “escape”.
 */

const WORK_W = 160
const COARSE_PATCH = 12
const FINE_PATCH = 24
const FINE_SEARCH = 22
const H_BINS = 16
const S_BINS = 8
const MISS_LIMIT = 24

export type TrackResult = {
  foundX: number
  foundY: number
  foundSize: number
  score: number
  lost: boolean
  visual: boolean
  via: 'face' | 'patch' | 'color'
}

type FaceBox = { cx: number; cy: number; size: number }

type FaceDetectorLike = {
  detect: (image: ImageBitmapSource) => Promise<Array<{ boundingBox: DOMRectReadOnly }>>
}

export class SubjectTracker {
  locked = false
  lost = false
  foundX = 0
  foundY = 0
  foundSize = 0
  lockSize = 1
  score = 1

  private readonly work = document.createElement('canvas')
  private readonly workCtx: CanvasRenderingContext2D
  private readonly fine = document.createElement('canvas')
  private readonly fineCtx: CanvasRenderingContext2D
  private coarse: Uint8Array | null = null
  private fineT: Uint8Array | null = null
  private hist = new Float32Array(H_BINS * S_BINS)
  private misses = 0
  private faces: FaceBox[] = []
  private detecting = false
  private readonly detector: FaceDetectorLike | null
  private srcW = 1
  private srcH = 1
  private vx = 0
  private vy = 0

  constructor() {
    const wctx = this.work.getContext('2d', { willReadFrequently: true })
    const fctx = this.fine.getContext('2d', { willReadFrequently: true })
    if (!wctx || !fctx) throw new Error('2D canvas unavailable')
    this.workCtx = wctx
    this.fineCtx = fctx
    this.detector = createFaceDetector()
  }

  lock(source: CanvasImageSource, srcW: number, srcH: number, x: number, y: number): boolean {
    this.srcW = srcW
    this.srcH = srcH
    this.foundX = clamp(x, 8, srcW - 8)
    this.foundY = clamp(y, 8, srcH - 8)
    this.vx = 0
    this.vy = 0
    this.downscale(source, srcW, srcH)
    const pixels = this.workCtx.getImageData(0, 0, this.work.width, this.work.height).data
    const sx = this.work.width / srcW
    const sy = this.work.height / srcH
    const wx = this.foundX * sx
    const wy = this.foundY * sy
    this.hist.set(colorHist(pixels, this.work.width, this.work.height, wx, wy, 14))
    const gray = rgbaToGray(pixels, this.work.width, this.work.height)
    const cx = clampInt(Math.round(wx), COARSE_PATCH, this.work.width - COARSE_PATCH - 1)
    const cy = clampInt(Math.round(wy), COARSE_PATCH, this.work.height - COARSE_PATCH - 1)
    this.coarse = extractPatch(gray, this.work.width, cx, cy, COARSE_PATCH)
    blit(this.fineCtx, source, this.foundX, this.foundY, FINE_PATCH)
    this.fineT = readGray(this.fineCtx, FINE_PATCH, FINE_PATCH)
    this.lockSize = Math.max(srcW, srcH) * 0.22
    this.foundSize = this.lockSize
    this.locked = true
    this.lost = false
    this.misses = 0
    this.score = 1
    void this.pollFaces(source)
    return true
  }

  unlock(): void {
    this.locked = false
    this.lost = false
    this.coarse = null
    this.fineT = null
    this.faces = []
    this.misses = 0
  }

  update(source: CanvasImageSource, srcW: number, srcH: number): TrackResult {
    if (!this.locked) {
      return {
        foundX: srcW / 2,
        foundY: srcH / 2,
        foundSize: 0,
        score: 0,
        lost: true,
        visual: false,
        via: 'patch',
      }
    }
    this.srcW = srcW
    this.srcH = srcH
    void this.pollFaces(source)
    this.downscale(source, srcW, srcH)
    const pixels = this.workCtx.getImageData(0, 0, this.work.width, this.work.height).data
    const scaleX = srcW / this.work.width
    const scaleY = srcH / this.work.height

    const predictedX = this.foundX + this.vx
    const predictedY = this.foundY + this.vy
    const color = meanShift(
      pixels,
      this.work.width,
      this.work.height,
      this.hist,
      predictedX / scaleX,
      predictedY / scaleY,
    )

    let guessX = color.x * scaleX
    let guessY = color.y * scaleY
    let via: TrackResult['via'] = 'color'
    let score = color.score

    if (this.coarse) {
      const gray = rgbaToGray(pixels, this.work.width, this.work.height)
      const coarseHit = searchWhole(gray, this.work.width, this.work.height, this.coarse)
      const patchX = coarseHit.x * scaleX
      const patchY = coarseHit.y * scaleY
      const patchScore = clamp01(1 - coarseHit.cost / (COARSE_PATCH * COARSE_PATCH * 40))
      const colorWeak = color.score < 0.28
      const patchNear =
        Math.hypot(patchX - guessX, patchY - guessY) < Math.max(srcW, srcH) * 0.2
      if (colorWeak || patchNear) {
        guessX = patchX
        guessY = patchY
        via = 'patch'
        score = Math.max(score, patchScore)
      }
    }

    const face = this.pickFace(guessX, guessY)
    if (face) {
      guessX = face.cx
      guessY = face.cy
      this.foundSize = face.size
      via = 'face'
      score = 1
    }

    const win = FINE_PATCH + FINE_SEARCH * 2
    if (this.fineT) {
      blit(this.fineCtx, source, guessX, guessY, win)
      const fineGray = readGray(this.fineCtx, win, win)
      const fineHit = searchLocal(fineGray, win, this.fineT)
      const origin = win / 2
      guessX += fineHit.x - origin
      guessY += fineHit.y - origin
      const meanAbs = fineHit.cost / (FINE_PATCH * FINE_PATCH)
      score = Math.max(score, clamp01(1 - meanAbs / 42))
    }

    const prevX = this.foundX
    const prevY = this.foundY
    this.foundX = clamp(guessX, 0, srcW)
    this.foundY = clamp(guessY, 0, srcH)
    this.vx = this.foundX - prevX
    this.vy = this.foundY - prevY
    this.score = score
    if (score < 0.12) this.misses += 1
    else this.misses = Math.max(0, this.misses - 2)
    this.lost = this.misses >= MISS_LIMIT
    return this.result(score >= 0.12, via)
  }

  private result(visual: boolean, via: TrackResult['via']): TrackResult {
    return {
      foundX: this.foundX,
      foundY: this.foundY,
      foundSize: this.foundSize,
      score: this.score,
      lost: this.lost,
      visual,
      via,
    }
  }

  private pickFace(nearX: number, nearY: number): FaceBox | null {
    if (this.faces.length === 0) return null
    let best: FaceBox | null = null
    let bestD = Math.max(this.srcW, this.srcH) * 0.18
    for (const face of this.faces) {
      const d = Math.hypot(face.cx - nearX, face.cy - nearY)
      if (d < bestD) {
        best = face
        bestD = d
      }
    }
    return best
  }

  private async pollFaces(source: CanvasImageSource): Promise<void> {
    if (!this.detector || this.detecting) return
    if (!(source instanceof HTMLCanvasElement)) return
    this.detecting = true
    try {
      const hits = await this.detector.detect(source)
      this.faces = hits.map((hit) => {
        const b = hit.boundingBox
        return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, size: Math.max(b.width, b.height) }
      })
    } catch {
      this.faces = []
    }
    this.detecting = false
  }

  private downscale(source: CanvasImageSource, srcW: number, srcH: number): void {
    const h = Math.max(90, Math.round((WORK_W * srcH) / srcW))
    if (this.work.width !== WORK_W || this.work.height !== h) {
      this.work.width = WORK_W
      this.work.height = h
    }
    this.workCtx.setTransform(1, 0, 0, 1, 0, 0)
    this.workCtx.drawImage(source, 0, 0, WORK_W, h)
  }
}

function createFaceDetector(): FaceDetectorLike | null {
  const ctor = (globalThis as unknown as { FaceDetector?: new (o?: object) => FaceDetectorLike })
    .FaceDetector
  if (!ctor) return null
  try {
    return new ctor({ fastMode: true, maxDetectedFaces: 1 })
  } catch {
    return null
  }
}

function colorHist(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
): Float32Array {
  const hist = new Float32Array(H_BINS * S_BINS)
  const r2 = radius * radius
  let total = 0
  const x0 = Math.max(0, Math.floor(cx - radius))
  const x1 = Math.min(w - 1, Math.ceil(cx + radius))
  const y0 = Math.max(0, Math.floor(cy - radius))
  const y1 = Math.min(h - 1, Math.ceil(cy + radius))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy > r2) continue
      const i = (y * w + x) * 4
      const hs = rgbToHS(data[i], data[i + 1], data[i + 2])
      if (hs.s < 0.12 || hs.v < 0.12) continue
      const hb = Math.min(H_BINS - 1, Math.floor((hs.h / 180) * H_BINS))
      const sb = Math.min(S_BINS - 1, Math.floor(hs.s * S_BINS))
      hist[hb * S_BINS + sb] += 1
      total += 1
    }
  }
  if (total > 0) {
    for (let i = 0; i < hist.length; i++) hist[i] /= total
  }
  return hist
}

function meanShift(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  hist: Float32Array,
  startX: number,
  startY: number,
): { x: number; y: number; score: number } {
  const prob = new Float32Array(w * h)
  let peak = 0
  let px = startX
  let py = startY
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const hs = rgbToHS(data[i], data[i + 1], data[i + 2])
      let p = 0
      if (hs.s >= 0.12 && hs.v >= 0.12) {
        const hb = Math.min(H_BINS - 1, Math.floor((hs.h / 180) * H_BINS))
        const sb = Math.min(S_BINS - 1, Math.floor(hs.s * S_BINS))
        p = hist[hb * S_BINS + sb]
      }
      prob[y * w + x] = p
      if (p > peak) {
        peak = p
        px = x
        py = y
      }
    }
  }
  let cx = clamp(startX, 0, w - 1)
  let cy = clamp(startY, 0, h - 1)
  if (peak > 0) {
    cx = px
    cy = py
  }
  const rad = Math.max(10, Math.round(Math.min(w, h) * 0.12))
  for (let iter = 0; iter < 8; iter++) {
    let sw = 0
    let sx = 0
    let sy = 0
    const x0 = Math.max(0, Math.round(cx) - rad)
    const x1 = Math.min(w - 1, Math.round(cx) + rad)
    const y0 = Math.max(0, Math.round(cy) - rad)
    const y1 = Math.min(h - 1, Math.round(cy) + rad)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = prob[y * w + x]
        sw += p
        sx += p * x
        sy += p * y
      }
    }
    if (sw < 1e-6) break
    cx = sx / sw
    cy = sy / sw
  }
  return { x: cx, y: cy, score: clamp01(peak * 8) }
}

function rgbToHS(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const v = max
  const d = max - min
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 30
  }
  return { h, s, v }
}

function searchWhole(
  gray: Uint8Array,
  gw: number,
  gh: number,
  templ: Uint8Array,
): { x: number; y: number; cost: number } {
  const half = Math.floor(COARSE_PATCH / 2)
  const minX = half
  const maxX = gw - half - 1
  const minY = half
  const maxY = gh - half - 1
  let best = Infinity
  let bx = Math.floor(gw / 2)
  let by = Math.floor(gh / 2)
  for (let y = minY; y <= maxY; y += 2) {
    for (let x = minX; x <= maxX; x += 2) {
      const cost = sad(gray, gw, x, y, templ, COARSE_PATCH)
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
      const cost = sad(gray, gw, x, y, templ, COARSE_PATCH)
      if (cost < best) {
        best = cost
        bx = x
        by = y
      }
    }
  }
  return { x: bx, y: by, cost: best }
}

function searchLocal(
  gray: Uint8Array,
  gw: number,
  templ: Uint8Array,
): { x: number; y: number; cost: number } {
  const half = Math.floor(FINE_PATCH / 2)
  const min = half
  const max = gw - half - 1
  let best = Infinity
  let bx = Math.floor(gw / 2)
  let by = bx
  for (let y = min; y <= max; y += 2) {
    for (let x = min; x <= max; x += 2) {
      const cost = sad(gray, gw, x, y, templ, FINE_PATCH)
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
      const cost = sad(gray, gw, x, y, templ, FINE_PATCH)
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

function blit(
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
  ctx.drawImage(
    source,
    Math.round(cx - size / 2),
    Math.round(cy - size / 2),
    size,
    size,
    0,
    0,
    size,
    size,
  )
}

function readGray(ctx: CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  return rgbaToGray(ctx.getImageData(0, 0, w, h).data, w, h)
}

function rgbaToGray(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const gray = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
  }
  return gray
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v | 0))
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
