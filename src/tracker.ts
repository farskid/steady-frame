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
import { applySimilarity, SimilarityRansac, type Similarity } from './vision/ransac.ts'

export const WORK_W = 480
const MISS_LIMIT = 12
const MIN_LOCK = 8
const EXPAND_BELOW = 20
const REPLENISH_BELOW = 28
const REPLENISH_INLIERS = 8
const REFRESH_INLIERS = 8
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
  private readonly restStatus = new Uint8Array(MAX_FEATURES)
  private readonly firstInliers = new Uint8Array(MAX_FEATURES)
  private readonly err = new Float32Array(MAX_FEATURES)
  private featCount = 0

  /**
   * IMU → image gain, learned online. Sign and magnitude depend on camera
   * facing, device orientation and FOV, so a hard-coded mapping is wrong for
   * one of front/rear. 1 = trust the nominal mapping until data says otherwise.
   */
  private imuGainX = 1
  private imuGainY = 1
  private lastPriorX = 0
  private lastPriorY = 0

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

  /**
   * @param subjectRadius radius of the subject in SOURCE px (the ring the user
   *   sees). Features are seeded inside it; nothing outside is ever eligible,
   *   which is what keeps a distant rear-camera subject from being outvoted by
   *   the wall behind it.
   */
  lock(
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
    x: number,
    y: number,
    subjectRadius = 0.16 * Math.min(srcW, srcH),
  ): boolean {
    this.grab(source, srcW, srcH)
    this.prevPyr.copyFrom(this.curPyr)

    const wx = x / this.sx
    const wy = y / this.sy
    this.roiWork = subjectRadius / this.sx
    this.lockRoiWork = this.roiWork

    const level = this.curPyr.levels[0]
    // The ring IS the subject: seed right up to it rather than 60 % of it.
    let n = this.features.detect(level, { cx: wx, cy: wy, radius: this.roiWork * 0.95 }, this.pts, MAX_FEATURES)
    if (n < EXPAND_BELOW) {
      this.roiWork *= 1.25
      this.lockRoiWork = this.roiWork
      n = this.features.detect(level, { cx: wx, cy: wy, radius: this.roiWork * 0.95 }, this.pts, MAX_FEATURES)
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
    this.lastPriorX = 0
    this.lastPriorY = 0
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
    // The Kalman velocity already contains last frame's camera flow, so the
    // full IMU shift would double-count. Its frame-to-frame CHANGE is the part
    // constant-velocity cannot know: use that as the control input, scaled by
    // the learned gain. A quick pan onset or reversal shows up here first.
    const ctrl = {
      x: (priorW.x - this.lastPriorX) * this.imuGainX,
      y: (priorW.y - this.lastPriorY) * this.imuGainY,
    }
    this.lastPriorX = priorW.x
    this.lastPriorY = priorW.y
    this.kf.predict(dt, ctrl)
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
      const sim = this.pickSubjectCluster(n, prevCx, prevCy)
      if (!sim || sim.inlierCount < MIN_ACCEPT_INLIERS) {
        this.miss()
        this.keepTrackedFeatures(n)
      } else {
        const meas = this.mapCenter(n, sim.inliers, prevCx, prevCy, sim)
        if (this.inlierCentroidFar(n, sim.inliers)) {
          this.miss()
          this.keepTrackedFeatures(n)
        } else {
          const r = measurementR(sim.rms, sim.inlierCount)
          const accepted = this.kf.update(meas.x, meas.y, r, sim.inlierCount >= 16)
          if (!accepted) {
            this.miss()
            this.keepTrackedFeatures(n)
          } else {
            this.misses = 0
            this.lost = false
            this.lostFrames = 0
            this.learnImuGain(priorW, meas.x - prevCx, meas.y - prevCy)
            if (Math.abs(sim.theta) > 0.008) this.rotation += sim.theta
            else this.rotation *= 0.98
            if (Math.abs(sim.s - 1) > 0.015) {
              this.rawScale *= sim.s
              this.roiWork = clamp(this.roiWork * sim.s, this.lockRoiWork * 0.5, this.lockRoiWork * 2)
            }
            this.rawScale = clamp(this.rawScale, 0.5, 2)
            this.scale = this.scaleSm.observe(this.rawScale)
            inlierCount = sim.inlierCount
            via = 'klt'
            visual = true
            this.compactInliers(n, sim.inliers)
            if (this.featCount < REPLENISH_BELOW && this.misses === 0) {
              this.featCount = this.features.replenish(
                this.curPyr.levels[0],
                this.pts,
                this.featCount,
                { cx: this.kf.x, cy: this.kf.y, radius: this.roiWork * 0.6 },
                MAX_FEATURES,
              )
            }
            if (this.featCount < 12) {
              this.featCount = this.features.detect(
                this.curPyr.levels[0],
                { cx: this.kf.x, cy: this.kf.y, radius: this.roiWork * 0.6 },
                this.pts,
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
    }

    this.centerWorkX = this.kf.x
    this.centerWorkY = this.kf.y
    this.foundX = this.centerWorkX * this.sx
    this.foundY = this.centerWorkY * this.sy
    this.foundSize = this.lockSize * this.scale
    if (this.lost) {
      this.score = 0
    } else if (via === 'pred') {
      this.score = 1 / (1 + this.kf.covTrace / 400)
    } else {
      this.score = clamp((inlierCount / 30) * (1 - this.misses / MISS_LIMIT), 0, 1)
    }

    const tmp = this.prevPyr
    this.prevPyr = this.curPyr
    this.curPyr = tmp

    this.lastMs = performance.now() - t0
    return this.result(visual, via)
  }

  private nccDelta(): { theta: number; scale: number } {
    const scale = this.nccPoseScale > 1e-6 ? this.scale / this.nccPoseScale : 1
    return { theta: this.rotation - this.nccPoseTheta, scale }
  }

  private snapCenter(): number {
    const speed = Math.hypot(this.kf.vx, this.kf.vy)
    // Whip peaks ~350 work-px/s; a rotation-broken NCC peak must not walk the pin.
    if (speed > 80) return -1
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
          { cx: this.kf.x, cy: this.kf.y, radius: this.roiWork * 0.6 },
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

  /**
   * Subject vs background is a spatial question, not a motion one. With a
   * static camera the subject moves and the background does not; with a
   * hand-held rear camera following the subject it is the other way round.
   * So: fit the dominant cluster, then fit the leftovers, and keep whichever
   * cluster sat closer to the pin in the previous frame.
   */
  private pickSubjectCluster(n: number, cx: number, cy: number): Similarity | null {
    const first = this.ransac.estimate(this.pts, this.nextPts, this.status, n)
    if (!first) return null
    let tracked = 0
    for (let i = 0; i < n; i++) if (this.status[i]) tracked += 1
    if (first.inlierCount >= tracked * 0.7) return first

    // RANSAC reuses its inlier buffer; copy before the second fit.
    this.firstInliers.set(first.inliers)
    const firstCopy: Similarity = { ...first, inliers: this.firstInliers.subarray(0, n) }
    for (let i = 0; i < n; i++) {
      this.restStatus[i] = this.status[i] && !this.firstInliers[i] ? 1 : 0
    }
    const second = this.ransac.estimate(this.pts, this.nextPts, this.restStatus, n)
    if (!second || second.inlierCount < MIN_ACCEPT_INLIERS) return firstCopy

    const d1 = this.prevCentroidDist(n, firstCopy.inliers, cx, cy)
    const d2 = this.prevCentroidDist(n, second.inliers, cx, cy)
    return d2 < d1 * 0.8 ? second : firstCopy
  }

  private prevCentroidDist(n: number, inliers: Uint8Array, cx: number, cy: number): number {
    let sx = 0
    let sy = 0
    let c = 0
    for (let i = 0; i < n; i++) {
      if (!inliers[i]) continue
      sx += this.pts[i * 2]
      sy += this.pts[i * 2 + 1]
      c += 1
    }
    if (c === 0) return Infinity
    return Math.hypot(sx / c - cx, sy / c - cy)
  }

  /** Per-axis least-squares gain between the IMU image shift and observed flow. */
  private learnImuGain(prior: { x: number; y: number }, dx: number, dy: number): void {
    const rate = 0.08
    if (Math.abs(prior.x) > 0.75) {
      const g = clamp(dx / prior.x, -1.5, 1.5)
      this.imuGainX += rate * (g - this.imuGainX)
    }
    if (Math.abs(prior.y) > 0.75) {
      const g = clamp(dy / prior.y, -1.5, 1.5)
      this.imuGainY += rate * (g - this.imuGainY)
    }
  }

  /** Keep surviving KLT points instead of teleporting them with a wrong prior. */
  private keepTrackedFeatures(n: number): void {
    let k = 0
    for (let i = 0; i < n; i++) {
      if (!this.status[i]) continue
      this.pts[k * 2] = this.nextPts[i * 2]
      this.pts[k * 2 + 1] = this.nextPts[i * 2 + 1]
      k += 1
    }
    if (k >= MIN_LOCK) this.featCount = k
  }

  /**
   * Move the lock point with the inlier cloud: translate by the centroid
   * and rotate/scale the lock-to-centroid offset (so roll does not walk the pin).
   */
  private mapCenter(
    n: number,
    inliers: Uint8Array,
    prevCx: number,
    prevCy: number,
    sim: { s: number; theta: number; tx: number; ty: number },
  ): { x: number; y: number } {
    let psx = 0
    let psy = 0
    let nsx = 0
    let nsy = 0
    let c = 0
    for (let i = 0; i < n; i++) {
      if (!inliers[i]) continue
      psx += this.pts[i * 2]
      psy += this.pts[i * 2 + 1]
      nsx += this.nextPts[i * 2]
      nsy += this.nextPts[i * 2 + 1]
      c += 1
    }
    if (c < 4) return applySimilarity(sim, prevCx, prevCy)
    const inv = 1 / c
    const c0x = psx * inv
    const c0y = psy * inv
    const c1x = nsx * inv
    const c1y = nsy * inv
    const dx = prevCx - c0x
    const dy = prevCy - c0y
    const th = Math.abs(sim.theta) > 0.008 ? sim.theta : 0
    const sc = Math.abs(sim.s - 1) > 0.015 ? sim.s : 1
    const cs = Math.cos(th)
    const sn = Math.sin(th)
    return {
      x: c1x + sc * (cs * dx - sn * dy),
      y: c1y + sc * (sn * dx + cs * dy),
    }
  }

  private inlierCentroidFar(n: number, inliers: Uint8Array): boolean {
    let sx = 0
    let sy = 0
    let c = 0
    for (let i = 0; i < n; i++) {
      if (!inliers[i]) continue
      sx += this.nextPts[i * 2]
      sy += this.nextPts[i * 2 + 1]
      c += 1
    }
    if (c === 0) return true
    const lim = this.roiWork * 0.5
    const dx = sx / c - this.kf.x
    const dy = sy / c - this.kf.y
    return dx * dx + dy * dy > lim * lim
  }

  private compactInliers(n: number, inliers: Uint8Array): void {
    const cx = this.kf.x
    const cy = this.kf.y
    const r2 = (this.roiWork * 0.75) * (this.roiWork * 0.75)
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
    if (this.lostFrames >= 10) {
      this.kf.vx = 0
      this.kf.vy = 0
    }
    if (this.detector) void this.pollFaces(source)
    const predX = this.kf.x
    const predY = this.kf.y
    const grow = Math.min(
      Math.max(this.curPyr.w, this.curPyr.h),
      this.roiWork * 2 * (1 + this.lostFrames * 0.6),
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
      { cx: hit.x, cy: hit.y, radius: this.roiWork * 0.6 },
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
