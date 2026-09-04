/** Shi-Tomasi corners on level-0 gradients, ROI-limited. */

import type { Level } from './pyramid.ts'

export const MAX_FEATURES = 80
export const MIN_DISTANCE = 6
export const QUALITY_RATIO = 0.02
const WIN = 1 // 3×3 → radius 1
const BORDER = 8

export type Roi = { cx: number; cy: number; radius: number }

export class FeatureDetector {
  private ixx = new Float32Array(0)
  private iyy = new Float32Array(0)
  private ixy = new Float32Array(0)
  private response = new Float32Array(0)
  private candX = new Float32Array(0)
  private candY = new Float32Array(0)
  private candS = new Float32Array(0)
  private candOrder = new Uint32Array(0)
  private w = 0
  private h = 0

  ensure(w: number, h: number): void {
    if (this.w === w && this.h === h) return
    this.w = w
    this.h = h
    const n = w * h
    this.ixx = new Float32Array(n)
    this.iyy = new Float32Array(n)
    this.ixy = new Float32Array(n)
    this.response = new Float32Array(n)
    this.candX = new Float32Array(n)
    this.candY = new Float32Array(n)
    this.candS = new Float32Array(n)
    this.candOrder = new Uint32Array(n)
  }

  detect(level: Level, roi: Roi, out: Float32Array, maxCount = MAX_FEATURES): number {
    return this.collect(level, roi, out, maxCount, 0)
  }

  replenish(
    level: Level,
    existing: Float32Array,
    existingCount: number,
    roi: Roi,
    wanted: number,
  ): number {
    if (existingCount >= wanted) return existingCount
    return this.collect(level, roi, existing, wanted, existingCount)
  }

  private collect(
    level: Level,
    roi: Roi,
    out: Float32Array,
    maxCount: number,
    existingCount: number,
  ): number {
    const w = level.w
    const h = level.h
    this.ensure(w, h)
    const { gx, gy } = level
    const n = w * h
    const ixx = this.ixx
    const iyy = this.iyy
    const ixy = this.ixy
    for (let i = 0; i < n; i++) {
      const gxv = gx[i]
      const gyv = gy[i]
      ixx[i] = gxv * gxv
      iyy[i] = gyv * gyv
      ixy[i] = gxv * gyv
    }

    const r = roi.radius
    const r2 = r * r
    const x0 = Math.max(BORDER, Math.floor(roi.cx - r))
    const x1 = Math.min(w - 1 - BORDER, Math.ceil(roi.cx + r))
    const y0 = Math.max(BORDER, Math.floor(roi.cy - r))
    const y1 = Math.min(h - 1 - BORDER, Math.ceil(roi.cy + r))
    if (x1 <= x0 || y1 <= y0) return existingCount

    const response = this.response
    response.fill(0, 0, n)
    let maxResp = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - roi.cx
        const dy = y - roi.cy
        if (dx * dx + dy * dy > r2) continue
        let sxx = 0
        let syy = 0
        let sxy = 0
        for (let yy = y - WIN; yy <= y + WIN; yy++) {
          const row = yy * w
          for (let xx = x - WIN; xx <= x + WIN; xx++) {
            const i = row + xx
            sxx += ixx[i]
            syy += iyy[i]
            sxy += ixy[i]
          }
        }
        const trace = sxx + syy
        const det = sxx * syy - sxy * sxy
        const disc = trace * trace * 0.25 - det
        const lambda = trace * 0.5 - Math.sqrt(disc > 0 ? disc : 0)
        response[y * w + x] = lambda
        if (lambda > maxResp) maxResp = lambda
      }
    }

    const quality = maxResp * QUALITY_RATIO
    if (maxResp < 1e-8) return existingCount

    const candX = this.candX
    const candY = this.candY
    const candS = this.candS
    const candOrder = this.candOrder
    let nCand = 0
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x
        const v = response[i]
        if (v < quality) continue
        if (v < response[i - 1] || v < response[i + 1]) continue
        if (v < response[i - w] || v < response[i + w]) continue
        if (v < response[i - w - 1] || v < response[i - w + 1]) continue
        if (v < response[i + w - 1] || v < response[i + w + 1]) continue
        candX[nCand] = x
        candY[nCand] = y
        candS[nCand] = v
        candOrder[nCand] = nCand
        nCand += 1
      }
    }
    if (nCand === 0) return existingCount

    const order = candOrder.subarray(0, nCand)
    order.sort((a, b) => candS[b] - candS[a])

    let count = existingCount
    const minD2 = MIN_DISTANCE * MIN_DISTANCE
    for (let k = 0; k < nCand && count < maxCount; k++) {
      const c = order[k]
      const x = candX[c]
      const y = candY[c]
      let ok = true
      for (let p = 0; p < count; p++) {
        const px = out[p * 2] - x
        const py = out[p * 2 + 1] - y
        if (px * px + py * py < minD2) {
          ok = false
          break
        }
      }
      if (!ok) continue
      out[count * 2] = x
      out[count * 2 + 1] = y
      count += 1
    }
    return count
  }
}
