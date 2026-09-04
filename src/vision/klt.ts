/** Pyramidal Lucas–Kanade (Bouguet) with a forward–backward check. */

import { PYRAMID_LEVELS, type Level, type Pyramid } from './pyramid.ts'

export const WIN_SIZE = 11
export const MAX_ITERS = 20
export const EPS = 0.01
export const FB_THRESH = 1.0
export const MAX_RESIDUAL = 28
export const MIN_EIG = 1e-4

const HALF = (WIN_SIZE - 1) >> 1
const NPIX = WIN_SIZE * WIN_SIZE
const EPS2 = EPS * EPS

export class KltTracker {
  private readonly iWin = new Float32Array(NPIX)
  private readonly gxWin = new Float32Array(NPIX)
  private readonly gyWin = new Float32Array(NPIX)
  private readonly fwdX = new Float32Array(256)
  private readonly fwdY = new Float32Array(256)
  private readonly fwdErr = new Float32Array(256)
  private readonly fwdOk = new Uint8Array(256)
  private readonly hit = { x: 0, y: 0, ok: false, err: 0 }

  /**
   * Track `count` points from prev → cur. `guesses` are already offset
   * (IMU / Kalman prior) in level-0 pixels. Writes sub-pixel `nextPts`,
   * `status` (1 = kept), `error` (mean abs residual). Returns #surviving.
   */
  track(
    prev: Pyramid,
    cur: Pyramid,
    prevPts: Float32Array,
    guesses: Float32Array,
    count: number,
    nextPts: Float32Array,
    status: Uint8Array,
    error: Float32Array,
  ): number {
    const n = Math.min(count, this.fwdX.length)
    for (let i = 0; i < n; i++) {
      const px = prevPts[i * 2]
      const py = prevPts[i * 2 + 1]
      const gx = guesses[i * 2]
      const gy = guesses[i * 2 + 1]
      this.trackOne(prev, cur, px, py, gx, gy)
      this.fwdOk[i] = this.hit.ok ? 1 : 0
      this.fwdX[i] = this.hit.x
      this.fwdY[i] = this.hit.y
      this.fwdErr[i] = this.hit.err
    }

    let surviving = 0
    for (let i = 0; i < n; i++) {
      if (!this.fwdOk[i]) {
        status[i] = 0
        error[i] = this.fwdErr[i]
        nextPts[i * 2] = guesses[i * 2]
        nextPts[i * 2 + 1] = guesses[i * 2 + 1]
        continue
      }
      const nx = this.fwdX[i]
      const ny = this.fwdY[i]
      const ox = prevPts[i * 2]
      const oy = prevPts[i * 2 + 1]
      this.trackOne(cur, prev, nx, ny, ox, oy)
      const fb = Math.hypot(this.hit.x - ox, this.hit.y - oy)
      if (!this.hit.ok || fb > FB_THRESH) {
        status[i] = 0
        error[i] = this.hit.ok ? fb : this.hit.err
        nextPts[i * 2] = nx
        nextPts[i * 2 + 1] = ny
        continue
      }
      nextPts[i * 2] = nx
      nextPts[i * 2 + 1] = ny
      status[i] = 1
      error[i] = this.fwdErr[i]
      surviving += 1
    }
    return surviving
  }

  private trackOne(
    srcPyr: Pyramid,
    dstPyr: Pyramid,
    srcX: number,
    srcY: number,
    guessX: number,
    guessY: number,
  ): void {
    const hit = this.hit
    let cx = 0
    let cy = 0
    const maxL = PYRAMID_LEVELS - 1
    for (let L = maxL; L >= 0; L--) {
      const scale = 1 << L
      const px = srcX / scale
      const py = srcY / scale
      if (L === maxL) {
        cx = guessX / scale
        cy = guessY / scale
      }
      this.iterate(srcPyr.levels[L], dstPyr.levels[L], px, py, cx, cy)
      if (!hit.ok) {
        hit.x = guessX
        hit.y = guessY
        return
      }
      if (L > 0) {
        cx = hit.x * 2
        cy = hit.y * 2
      }
    }
  }

  private iterate(
    src: Level,
    dst: Level,
    px: number,
    py: number,
    gx: number,
    gy: number,
  ): void {
    const hit = this.hit
    const sw = src.w
    const sh = src.h
    const dw = dst.w
    const dh = dst.h
    if (
      px < HALF + 1 ||
      py < HALF + 1 ||
      px > sw - HALF - 2 ||
      py > sh - HALF - 2
    ) {
      hit.x = gx
      hit.y = gy
      hit.ok = false
      hit.err = 1e6
      return
    }

    const iWin = this.iWin
    const gxWin = this.gxWin
    const gyWin = this.gyWin
    let ixx = 0
    let iyy = 0
    let ixy = 0
    let k = 0
    for (let j = -HALF; j <= HALF; j++) {
      for (let i = -HALF; i <= HALF; i++) {
        const x = px + i
        const y = py + j
        const gxv = bilin(src.gx, sw, sh, x, y)
        const gyv = bilin(src.gy, sw, sh, x, y)
        iWin[k] = bilin(src.gray, sw, sh, x, y)
        gxWin[k] = gxv
        gyWin[k] = gyv
        ixx += gxv * gxv
        iyy += gyv * gyv
        ixy += gxv * gyv
        k += 1
      }
    }
    const det = ixx * iyy - ixy * ixy
    const trace = ixx + iyy
    const disc = trace * trace * 0.25 - det
    const lambda = trace * 0.5 - Math.sqrt(disc > 0 ? disc : 0)
    if (det < 1e-8 || lambda < MIN_EIG * NPIX) {
      hit.x = gx
      hit.y = gy
      hit.ok = false
      hit.err = 1e6
      return
    }
    const invDet = 1 / det

    let cx = gx
    let cy = gy
    let converged = false
    let lastErr = 1e6
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      if (
        cx < HALF + 1 ||
        cy < HALF + 1 ||
        cx > dw - HALF - 2 ||
        cy > dh - HALF - 2
      ) {
        hit.x = cx
        hit.y = cy
        hit.ok = false
        hit.err = lastErr
        return
      }
      let bx = 0
      let by = 0
      let abs = 0
      k = 0
      for (let j = -HALF; j <= HALF; j++) {
        for (let i = -HALF; i <= HALF; i++) {
          const d = iWin[k] - bilin(dst.gray, dw, dh, cx + i, cy + j)
          bx += gxWin[k] * d
          by += gyWin[k] * d
          abs += d < 0 ? -d : d
          k += 1
        }
      }
      lastErr = abs / NPIX
      const dx = (iyy * bx - ixy * by) * invDet
      const dy = (ixx * by - ixy * bx) * invDet
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        hit.x = cx
        hit.y = cy
        hit.ok = false
        hit.err = lastErr
        return
      }
      if (dx > WIN_SIZE || dx < -WIN_SIZE || dy > WIN_SIZE || dy < -WIN_SIZE) {
        hit.x = cx
        hit.y = cy
        hit.ok = false
        hit.err = lastErr
        return
      }
      cx += dx
      cy += dy
      if (dx * dx + dy * dy < EPS2) {
        converged = true
        break
      }
    }
    hit.x = cx
    hit.y = cy
    hit.err = lastErr
    hit.ok = converged && lastErr <= MAX_RESIDUAL
  }
}

function bilin(buf: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0
  else if (x > w - 1) x = w - 1
  if (y < 0) y = 0
  else if (y > h - 1) y = h - 1
  const x0 = x | 0
  const y0 = y | 0
  const x1 = x0 + 1 < w ? x0 + 1 : x0
  const y1 = y0 + 1 < h ? y0 + 1 : y0
  const fx = x - x0
  const fy = y - y0
  const a = buf[y0 * w + x0]
  const b = buf[y0 * w + x1]
  const c = buf[y1 * w + x0]
  const d = buf[y1 * w + x1]
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}
