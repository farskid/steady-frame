/**
 * Hard-pin tracker: pyramidal KLT + RANSAC similarity + Kalman.
 * Inverse affine in the view (stabilize.ts) glues the filtered center to the reticle.
 */

import { clamp } from './mat3.ts'
import { FeatureDetector, MAX_FEATURES } from './vision/features.ts'
import { KalmanCV, measurementR, ScaleSmoother } from './vision/kalman.ts'
import { KltTracker } from './vision/klt.ts'
import { NccMatcher, NCC_ACCEPT } from './vision/ncc.ts'
import { Pyramid } from './vision/pyramid.ts'
import { applySimilarity, SimilarityRansac } from './vision/ransac.ts'

export const WORK_W = 480
const MISS_LIMIT = 6
const MIN_LOCK = 8
const EXPAND_BELOW = 12
const REPLENISH_BELOW = 28
const REPLENISH_INLIERS = 15
const REFRESH_INLIERS = 20
const REFRESH_GAP = 6
const SNAP_NCC = 0.6
const MIN_ACCEPT_INLIERS = 8

export type TrackVia = 'klt' | 'pred' | 'ncc' | 'face' | 'patch' | 'color'

export type TrackResult = {
  foundX: number
  foundY: number
  foundSize: number
  score: number
  lost: boolean
  visual: boolean
  via: TrackVia
  rotation: number
  scale: number
  features: number
  lastMs: number
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
  lastMs = 0
  rotation = 0
  scale = 1

  get featureCount(): number {
    return this.featCount
  }

  private readonly work = document.createElement('canvas')
  private readonly workCtx: CanvasRenderingContext2D
  private prevPyr = new Pyramid()
  private curPyr = new Pyramid()
  private readonly features = new FeatureDetector()
  private readonly klt = new KltTracker()
  private readonly ransac = new SimilarityRansac()
  private readonly kf = new KalmanCV()
  private readonly scaleSm = new ScaleSmoother()
  private readonly ncc = new NccMatcher()

  private readonly pts = new Float32Array(MAX_FEATURES * 2)
  private readonly guesses = new Float32Array(MAX_FEATURES * 2)
  private readonly nextPts = new Float32Array(MAX_FEATURES * 2)
  private readonly status = new Uint8Array(MAX_FEATURES)
  private readonly err = new Float32Array(MAX_FEATURES)
  private featCount = 0

  private sx = 1
  private sy = 1
  private centerWorkX = 0
  private centerWorkY = 0
  private roiWork = 40
  private lockRoiWork = 40
  private rawScale = 1
  private misses = 0
  private lostFrames = 0
  private framesSinceRefresh = 0
  private lastT = 0
  private nccPoseTheta = 0
  private nccPoseScale = 1

  private faces: FaceBox[] = []
  private detecting = false
  private readonly detector: FaceDetectorLike | null

  constructor() {
    const wctx = this.work.getContext('2d', { willReadFrequently: true })
    if (!wctx) throw new Error('2D canvas unavailable')
    this.workCtx = wctx
    this.detector = createFaceDetector()
  }

  lock(source: CanvasImageSource, srcW: number, srcH: number, x: number, y: number): boolean {
    this.grab(source, srcW, srcH)
    this.prevPyr.copyFrom(this.curPyr)

    const wx = x / this.sx
    const wy = y / this.sy
    const srcRoi = 0.125 * Math.min(srcW, srcH)
    this.roiWork = srcRoi / this.sx
    this.lockRoiWork = this.roiWork

    const level = this.curPyr.levels[0]
    let n = this.features.detect(level, { cx: wx, cy: wy, radius: this.roiWork }, this.pts, MAX_FEATURES)
    if (n < EXPAND_BELOW) {
      this.roiWork *= 1.5
      this.lockRoiWork = this.roiWork
      n = this.features.detect(level, { cx: wx, cy: wy, radius: this.roiWork }, this.pts, MAX_FEATURES)
    }
    if (n < MIN_LOCK) {
      this.locked = false
      this.featCount = 0
      return false
    }

    this.featCount = n
    this.centerWorkX = wx
    this.centerWorkY = wy
    this.kf.reset(wx, wy)
    this.scaleSm.reset(1)
    this.rawScale = 1
    this.scale = 1
    this.rotation = 0
    this.misses = 0
    this.lostFrames = 0
    this.framesSinceRefresh = 0
    this.lockSize = Math.max(srcW, srcH) * 0.22
    this.foundSize = this.lockSize
    this.foundX = x
    this.foundY = y
    this.locked = true
    this.lost = false
    this.score = 1
    this.lastT = performance.now()
    this.ncc.capture(level, wx, wy)
    this.nccPoseTheta = 0
    this.nccPoseScale = 1
    this.faces = []
    return true
  }

  unlock(): void {
    this.locked = false
    this.lost = false
    this.featCount = 0
    this.misses = 0
    this.faces = []
  }

  update(
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
    priorShift?: { x: number; y: number },
  ): TrackResult {
    const t0 = performance.now()
    if (!this.locked) {
      this.lastMs = performance.now() - t0
      return this.result(false, 'pred')
    }
    const dt = Math.min(0.05, Math.max(0.001, (t0 - this.lastT) / 1000))
    this.lastT = t0

    this.grab(source, srcW, srcH)
    const priorW = {
      x: (priorShift?.x ?? 0) / this.sx,
      y: (priorShift?.y ?? 0) / this.sy,
    }

    const prevCx = this.centerWorkX
    const prevCy = this.centerWorkY
    this.kf.predict(dt, priorW)
    const dCx = this.kf.x - prevCx
    const dCy = this.kf.y - prevCy

    let via: TrackVia = 'pred'
    let visual = false
    let inlierCount = 0

    if (this.lost) {
      this.reacquire(source)
      via = this.lost ? 'pred' : 'ncc'
      visual = !this.lost
      if (!this.lost) inlierCount = Math.max(this.featCount, REPLENISH_INLIERS)
    } else {
      const n = this.featCount
      for (let i = 0; i < n; i++) {
        this.guesses[i * 2] = this.pts[i * 2] + dCx
        this.guesses[i * 2 + 1] = this.pts[i * 2 + 1] + dCy
      }
      this.klt.track(
        this.prevPyr,
        this.curPyr,
        this.pts,
        this.guesses,
        n,
        this.nextPts,
        this.status,
        this.err,
      )
      this.rejectAgainstPrior(n, dCx, dCy)
      const sim = this.ransac.estimate(this.pts, this.nextPts, this.status, n)
      if (!sim || sim.inlierCount < MIN_ACCEPT_INLIERS) {
        this.miss()
        this.coastFeatures(n, dCx, dCy)
      } else {
        const meas = applySimilarity(sim, prevCx, prevCy)
        const r = measurementR(sim.rms, sim.inlierCount)
        const accepted = this.kf.update(meas.x, meas.y, r)
        if (!accepted) {
          this.miss()
          this.coastFeatures(n, dCx, dCy)
        } else {
          this.misses = 0
          this.lost = false
          this.lostFrames = 0
          this.rotation += sim.theta
          this.rawScale *= sim.s
          this.rawScale = clamp(this.rawScale, 0.5, 2)
          this.scale = this.scaleSm.observe(this.rawScale)
          this.roiWork = clamp(this.roiWork * sim.s, this.lockRoiWork * 0.5, this.lockRoiWork * 2)
          inlierCount = sim.inlierCount
          via = 'klt'
          visual = true
          this.compactInliers(n, sim.inliers)
          if (
            this.featCount < REPLENISH_BELOW &&
            this.misses === 0 &&
            inlierCount >= REPLENISH_INLIERS
          ) {
            this.featCount = this.features.replenish(
              this.curPyr.levels[0],
              this.pts,
              this.featCount,
              { cx: this.kf.x, cy: this.kf.y, radius: this.roiWork * 0.82 },
              MAX_FEATURES,
            )
          }
          this.framesSinceRefresh += 1
          if (inlierCount >= REFRESH_INLIERS && this.framesSinceRefresh >= REFRESH_GAP) {
            this.ncc.capture(this.curPyr.levels[0], this.kf.x, this.kf.y)
            this.nccPoseTheta = this.rotation
            this.nccPoseScale = this.scale
            this.framesSinceRefresh = 0
          }
        }
      }
    }

    this.centerWorkX = this.kf.x
    this.centerWorkY = this.kf.y
    this.foundX = this.centerWorkX * this.sx
    this.foundY = this.centerWorkY * this.sy
    this.foundSize = this.lockSize * this.scale
    this.score = clamp((inlierCount / 30) * (1 - this.misses / MISS_LIMIT), 0, 1)
    if (this.lost) this.score = 0

    const tmp = this.prevPyr
    this.prevPyr = this.curPyr
    this.curPyr = tmp

    this.lastMs = performance.now() - t0
    return this.result(visual, via)
  }

  private rejectAgainstPrior(n: number, dCx: number, dCy: number): void {
    const expected = Math.hypot(dCx, dCy)
    if (expected < 1.5) return
    const tol = Math.max(8, expected + 6)
    const tol2 = tol * tol
    for (let i = 0; i < n; i++) {
      if (!this.status[i]) continue
      const fx = this.nextPts[i * 2] - this.pts[i * 2] - dCx
      const fy = this.nextPts[i * 2 + 1] - this.pts[i * 2 + 1] - dCy
      if (fx * fx + fy * fy > tol2) this.status[i] = 0
    }
  }

  private nccDelta(): { theta: number; scale: number } {
    const scale = this.nccPoseScale > 1e-6 ? this.scale / this.nccPoseScale : 1
    return { theta: this.rotation - this.nccPoseTheta, scale }
  }

  private snapCenter(): number {
    const d = this.nccDelta()
    const hit = this.ncc.snap(this.curPyr.levels[0], this.kf.x, this.kf.y, 12, d.theta, d.scale)
    if (!hit || hit.ncc < SNAP_NCC) return hit?.ncc ?? -1
    this.kf.x += (hit.x - this.kf.x) * 0.3
    this.kf.y += (hit.y - this.kf.y) * 0.3
    return hit.ncc
  }

  private miss(): void {
    this.misses += 1
    const appear = this.snapCenter()
    if (appear >= SNAP_NCC) {
      this.misses = Math.min(this.misses, MISS_LIMIT - 1)
      this.lost = false
      if (this.featCount < MIN_LOCK) {
        this.featCount = this.features.detect(
          this.curPyr.levels[0],
          { cx: this.kf.x, cy: this.kf.y, radius: this.roiWork },
          this.pts,
          MAX_FEATURES,
        )
      }
      return
    }
    if (this.misses >= MISS_LIMIT) {
      this.lost = true
      this.lostFrames += 1
    }
  }

  private coastFeatures(n: number, dCx: number, dCy: number): void {
    for (let i = 0; i < n; i++) {
      this.pts[i * 2] += dCx
      this.pts[i * 2 + 1] += dCy
    }
  }

  private compactInliers(n: number, inliers: Uint8Array): void {
    const cx = this.kf.x
    const cy = this.kf.y
    const r2 = this.roiWork * this.roiWork
    let k = 0
    for (let i = 0; i < n; i++) {
      if (!inliers[i]) continue
      const x = this.nextPts[i * 2]
      const y = this.nextPts[i * 2 + 1]
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy > r2) continue
      this.pts[k * 2] = x
      this.pts[k * 2 + 1] = y
      k += 1
    }
    this.featCount = k
  }

  private reacquire(source: CanvasImageSource): void {
    this.lostFrames += 1
    if (this.detector) void this.pollFaces(source)
    const predX = this.kf.x
    const predY = this.kf.y
    const grow = Math.min(
      Math.max(this.curPyr.w, this.curPyr.h),
      this.roiWork * 1.5 * (1 + this.lostFrames * 0.35),
    )
    let hintX: number | undefined
    let hintY: number | undefined
    const face = this.nearFace(predX, predY)
    if (face) {
      hintX = face.cx / this.sx
      hintY = face.cy / this.sy
    }
    const hit = this.ncc.find(
      this.curPyr.levels[0],
      this.curPyr.levels[Math.min(2, this.curPyr.levels.length - 1)],
      predX,
      predY,
      grow,
      hintX,
      hintY,
    )
    if (!hit || hit.ncc < NCC_ACCEPT) return

    this.kf.reset(hit.x, hit.y)
    this.centerWorkX = hit.x
    this.centerWorkY = hit.y
    this.lost = false
    this.misses = 0
    this.lostFrames = 0
    this.featCount = this.features.detect(
      this.curPyr.levels[0],
      { cx: hit.x, cy: hit.y, radius: this.roiWork },
      this.pts,
      MAX_FEATURES,
    )
    this.framesSinceRefresh = 0
  }

  private nearFace(predX: number, predY: number): FaceBox | null {
    if (this.faces.length === 0) return null
    const lim = this.roiWork * 2
    let best: FaceBox | null = null
    let bestD = lim
    for (const face of this.faces) {
      const fx = face.cx / this.sx
      const fy = face.cy / this.sy
      const d = Math.hypot(fx - predX, fy - predY)
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

  private grab(source: CanvasImageSource, srcW: number, srcH: number): void {
    const h = Math.max(1, Math.round((WORK_W * srcH) / srcW))
    if (this.work.width !== WORK_W || this.work.height !== h) {
      this.work.width = WORK_W
      this.work.height = h
    }
    this.sx = srcW / this.work.width
    this.sy = srcH / this.work.height
    this.workCtx.setTransform(1, 0, 0, 1, 0, 0)
    this.workCtx.imageSmoothingEnabled = true
    this.workCtx.drawImage(source, 0, 0, WORK_W, h)
    const img = this.workCtx.getImageData(0, 0, WORK_W, h)
    this.curPyr.build(img)
  }

  private result(visual: boolean, via: TrackVia): TrackResult {
    return {
      foundX: this.foundX,
      foundY: this.foundY,
      foundSize: this.foundSize,
      score: this.score,
      lost: this.lost,
      visual,
      via,
      rotation: this.rotation,
      scale: this.scale,
      features: this.featCount,
      lastMs: this.lastMs,
    }
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
