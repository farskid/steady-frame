/** Pin a subject: global coarse match + local refine. FaceDetector when the browser has it. */

const WORK_W = 128
const COARSE_PATCH = 14
const FINE_PATCH = 28
const FINE_SEARCH = 18
const COARSE_STEP = 2
const MISS_LIMIT = 18

export type TrackResult = {
  foundX: number
  foundY: number
  foundSize: number
  score: number
  lost: boolean
  visual: boolean
  via: 'face' | 'patch'
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
  private misses = 0
  private faces: FaceBox[] = []
  private detecting = false
  private readonly detector: FaceDetectorLike | null
  private srcW = 1
  private srcH = 1

  constructor() {
    const wctx = this.work.getContext('2d', { willReadFrequently: true })
    const fctx = this.fine.getContext('2d', { willReadFrequently: true })
    if (!wctx || !fctx) throw new Error('2D canvas unavailable')
    this.workCtx = wctx
    this.fineCtx = fctx
    this.fine.width = FINE_PATCH + FINE_SEARCH * 2
    this.fine.height = FINE_PATCH + FINE_SEARCH * 2
    this.detector = createFaceDetector()
  }

  lock(source: CanvasImageSource, srcW: number, srcH: number, x: number, y: number): boolean {
    this.srcW = srcW
    this.srcH = srcH
    this.foundX = clamp(x, 8, srcW - 8)
    this.foundY = clamp(y, 8, srcH - 8)
    this.downscale(source, srcW, srcH)
    const sx = this.work.width / srcW
    const sy = this.work.height / srcH
    const gray = readGray(this.workCtx, this.work.width, this.work.height)
    const wx = clampInt(Math.round(this.foundX * sx), COARSE_PATCH, this.work.width - COARSE_PATCH - 1)
    const wy = clampInt(Math.round(this.foundY * sy), COARSE_PATCH, this.work.height - COARSE_PATCH - 1)
    this.coarse = extractPatch(gray, this.work.width, wx, wy, COARSE_PATCH)
    blit(this.fineCtx, source, this.foundX, this.foundY, FINE_PATCH)
    this.fineT = readGray(this.fineCtx, FINE_PATCH, FINE_PATCH)
    this.lockSize = Math.max(srcW, srcH) * 0.22
    this.foundSize = this.lockSize
    this.locked = true
    this.lost = false
    this.misses = 0
    this.score = 1
    void this.pollFaces(source)
    return variance(this.fineT) > 12
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

    const face = this.pickFace()
    if (face) {
      this.foundX = face.cx
      this.foundY = face.cy
      this.foundSize = face.size
      this.misses = 0
      this.lost = false
      this.score = 1
      return this.result(true, 'face')
    }

    if (!this.coarse || !this.fineT) return this.result(false, 'patch')

    this.downscale(source, srcW, srcH)
    const gray = readGray(this.workCtx, this.work.width, this.work.height)
    const coarseHit = searchWhole(gray, this.work.width, this.work.height, this.coarse)
    const scaleX = srcW / this.work.width
    const scaleY = srcH / this.work.height
    const guessX = coarseHit.x * scaleX
    const guessY = coarseHit.y * scaleY

    const win = FINE_PATCH + FINE_SEARCH * 2
    blit(this.fineCtx, source, guessX, guessY, win)
    const fineGray = readGray(this.fineCtx, win, win)
    const fineHit = searchLocal(fineGray, win, this.fineT)
    const origin = win / 2
    const rawX = guessX + (fineHit.x - origin)
    const rawY = guessY + (fineHit.y - origin)
    const meanAbs = fineHit.cost / (FINE_PATCH * FINE_PATCH)
    const good = meanAbs < 42

    if (good) {
      this.foundX = clamp(rawX, 8, srcW - 8)
      this.foundY = clamp(rawY, 8, srcH - 8)
      this.misses = Math.max(0, this.misses - 3)
      this.score = clamp01(1 - meanAbs / 42)
    } else {
      this.foundX = clamp(guessX, 8, srcW - 8)
      this.foundY = clamp(guessY, 8, srcH - 8)
      this.misses += 1
      this.score = clamp01(1 - meanAbs / 55)
    }
    this.lost = this.misses >= MISS_LIMIT
    return this.result(good, 'patch')
  }

  private result(visual: boolean, via: 'face' | 'patch'): TrackResult {
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

  private pickFace(): FaceBox | null {
    if (this.faces.length === 0) return null
    let best = this.faces[0]
    let bestD = Infinity
    for (const face of this.faces) {
      const d = Math.hypot(face.cx - this.foundX, face.cy - this.foundY)
      if (d < bestD) {
        best = face
        bestD = d
      }
    }
    return bestD < Math.max(this.srcW, this.srcH) * 0.45 ? best : this.faces[0]
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
    const h = Math.max(72, Math.round((WORK_W * srcH) / srcW))
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
  for (let y = minY; y <= maxY; y += COARSE_STEP) {
    for (let x = minX; x <= maxX; x += COARSE_STEP) {
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
  let by = Math.floor(gw / 2)
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
  ctx.drawImage(source, Math.round(cx - size / 2), Math.round(cy - size / 2), size, size, 0, 0, size, size)
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

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v | 0))
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
