/** 2-point RANSAC + Umeyama least-squares similarity (scale, rotation, translation). */

export type Similarity = {
  s: number
  theta: number
  tx: number
  ty: number
  inliers: Uint8Array
  inlierCount: number
  rms: number
}

const MIN_INLIERS = 6
const MAX_ITERS = 60
const CONFIDENCE = 0.99
const DEFAULT_THRESH = 2.0

export class SimilarityRansac {
  private readonly inliers = new Uint8Array(256)
  private readonly bestInliers = new Uint8Array(256)
  private readonly refitInliers = new Uint8Array(256)
  private readonly idx = new Uint16Array(256)
  private readonly outInliers = new Uint8Array(256)

  estimate(
    prev: Float32Array,
    next: Float32Array,
    status: Uint8Array,
    count: number,
    thresh = DEFAULT_THRESH,
  ): Similarity | null {
    let n = 0
    const idx = this.idx
    for (let i = 0; i < count; i++) {
      if (status[i]) idx[n++] = i
    }
    if (n < MIN_INLIERS) return null

    const thresh2 = thresh * thresh
    let bestCount = 0
    let iters = MAX_ITERS
    const maxIters = MAX_ITERS

    for (let it = 0; it < iters; it++) {
      let ia = (Math.random() * n) | 0
      let ib = (Math.random() * n) | 0
      if (ib === ia) ib = (ia + 1) % n
      const a = idx[ia]
      const b = idx[ib]
      const model = similarityFromTwo(
        prev[a * 2],
        prev[a * 2 + 1],
        next[a * 2],
        next[a * 2 + 1],
        prev[b * 2],
        prev[b * 2 + 1],
        next[b * 2],
        next[b * 2 + 1],
      )
      if (!model) continue
      let inl = 0
      this.inliers.fill(0, 0, count)
      for (let k = 0; k < n; k++) {
        const i = idx[k]
        const e2 = reproj2(model, prev[i * 2], prev[i * 2 + 1], next[i * 2], next[i * 2 + 1])
        if (e2 <= thresh2) {
          this.inliers[i] = 1
          inl += 1
        }
      }
      if (inl > bestCount) {
        bestCount = inl
        this.bestInliers.set(this.inliers.subarray(0, count))
        const w = inl / n
        const p = w * w
        if (p > 1e-6 && p < 1) {
          const adaptive = Math.log(1 - CONFIDENCE) / Math.log(1 - p)
          iters = Math.min(maxIters, Math.max(it + 1, Math.ceil(adaptive)))
        } else if (p >= 1) {
          iters = it + 1
        }
      }
    }

    if (bestCount < MIN_INLIERS) return null

    const fit = umeyama(prev, next, this.bestInliers, count)
    if (!fit) return null

    let inl = 0
    let ss = 0
    this.refitInliers.fill(0, 0, count)
    for (let k = 0; k < n; k++) {
      const i = idx[k]
      const e2 = reproj2(fit, prev[i * 2], prev[i * 2 + 1], next[i * 2], next[i * 2 + 1])
      if (e2 <= thresh2) {
        this.refitInliers[i] = 1
        inl += 1
        ss += e2
      }
    }
    if (inl < MIN_INLIERS) return null

    const refined = umeyama(prev, next, this.refitInliers, count)
    const model = refined ?? fit
    let rmsN = 0
    let rmsSs = 0
    if (refined) {
      this.refitInliers.fill(0, 0, count)
      inl = 0
      for (let k = 0; k < n; k++) {
        const i = idx[k]
        const e2 = reproj2(model, prev[i * 2], prev[i * 2 + 1], next[i * 2], next[i * 2 + 1])
        if (e2 <= thresh2) {
          this.refitInliers[i] = 1
          inl += 1
          rmsSs += e2
          rmsN += 1
        }
      }
      if (inl < MIN_INLIERS) return null
    } else {
      rmsN = inl
      rmsSs = ss
    }

    const out = this.outInliers
    out.fill(0)
    out.set(this.refitInliers.subarray(0, count))
    return {
      s: model.s,
      theta: model.theta,
      tx: model.tx,
      ty: model.ty,
      inliers: out.subarray(0, count),
      inlierCount: rmsN,
      rms: Math.sqrt(rmsSs / Math.max(1, rmsN)),
    }
  }
}

export function applySimilarity(
  model: { s: number; theta: number; tx: number; ty: number },
  x: number,
  y: number,
): { x: number; y: number } {
  const c = Math.cos(model.theta)
  const sn = Math.sin(model.theta)
  return {
    x: model.s * (c * x - sn * y) + model.tx,
    y: model.s * (sn * x + c * y) + model.ty,
  }
}

type Model = { s: number; theta: number; tx: number; ty: number }

function similarityFromTwo(
  ax: number,
  ay: number,
  aX: number,
  aY: number,
  bx: number,
  by: number,
  bX: number,
  bY: number,
): Model | null {
  const dx = bx - ax
  const dy = by - ay
  const dX = bX - aX
  const dY = bY - aY
  const src2 = dx * dx + dy * dy
  if (src2 < 1e-4) return null
  const s = Math.sqrt((dX * dX + dY * dY) / src2)
  if (s < 0.2 || s > 5) return null
  const theta = Math.atan2(dY, dX) - Math.atan2(dy, dx)
  const c = Math.cos(theta)
  const sn = Math.sin(theta)
  const tx = aX - s * (c * ax - sn * ay)
  const ty = aY - s * (sn * ax + c * ay)
  return { s, theta, tx, ty }
}

function reproj2(model: Model, x: number, y: number, X: number, Y: number): number {
  const c = Math.cos(model.theta)
  const sn = Math.sin(model.theta)
  const px = model.s * (c * x - sn * y) + model.tx
  const py = model.s * (sn * x + c * y) + model.ty
  const ex = px - X
  const ey = py - Y
  return ex * ex + ey * ey
}

function umeyama(
  prev: Float32Array,
  next: Float32Array,
  mask: Uint8Array,
  count: number,
): Model | null {
  let n = 0
  let mx = 0
  let my = 0
  let mX = 0
  let mY = 0
  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue
    mx += prev[i * 2]
    my += prev[i * 2 + 1]
    mX += next[i * 2]
    mY += next[i * 2 + 1]
    n += 1
  }
  if (n < 2) return null
  const inv = 1 / n
  mx *= inv
  my *= inv
  mX *= inv
  mY *= inv

  let sxx = 0
  let sxy = 0
  let syx = 0
  let syy = 0
  let varSrc = 0
  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue
    const px = prev[i * 2] - mx
    const py = prev[i * 2 + 1] - my
    const qx = next[i * 2] - mX
    const qy = next[i * 2 + 1] - mY
    sxx += px * qx
    sxy += px * qy
    syx += py * qx
    syy += py * qy
    varSrc += px * px + py * py
  }
  if (varSrc < 1e-6) return null
  const theta = Math.atan2(sxy - syx, sxx + syy)
  const c = Math.cos(theta)
  const sn = Math.sin(theta)
  const s = (c * (sxx + syy) + sn * (sxy - syx)) / varSrc
  if (s < 0.2 || s > 5) return null
  const tx = mX - s * (c * mx - sn * my)
  const ty = mY - s * (sn * mx + c * my)
  return { s, theta, tx, ty }
}
