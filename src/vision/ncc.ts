/** Normalized cross-correlation for re-acquisition. Template is 48×48 at work res. */

import { sampleBuf, type Level } from './pyramid.ts'

export const TEMPLATE = 48
export const NCC_ACCEPT = 0.6
const COARSE = TEMPLATE >> 2
const HALF = TEMPLATE >> 1
const HALF_C = COARSE >> 1

export class NccMatcher {
  readonly templ = new Float32Array(TEMPLATE * TEMPLATE)
  readonly coarse = new Float32Array(COARSE * COARSE)
  sumT = 0
  sumT2 = 0
  cSumT = 0
  cSumT2 = 0
  lastScore = 0

  capture(level: Level, cx: number, cy: number): void {
    const { gray, w, h } = level
    const templ = this.templ
    let sum = 0
    let sum2 = 0
    let i = 0
    for (let y = 0; y < TEMPLATE; y++) {
      for (let x = 0; x < TEMPLATE; x++) {
        const v = sampleBuf(gray, w, h, cx - HALF + x + 0.5, cy - HALF + y + 0.5)
        templ[i++] = v
        sum += v
        sum2 += v * v
      }
    }
    this.sumT = sum
    this.sumT2 = sum2
    const coarse = this.coarse
    let cs = 0
    let cs2 = 0
    let k = 0
    for (let y = 0; y < COARSE; y++) {
      for (let x = 0; x < COARSE; x++) {
        let acc = 0
        const y0 = y * 4
        const x0 = x * 4
        for (let yy = 0; yy < 4; yy++) {
          const row = (y0 + yy) * TEMPLATE + x0
          acc += templ[row] + templ[row + 1] + templ[row + 2] + templ[row + 3]
        }
        const v = acc * (1 / 16)
        coarse[k++] = v
        cs += v
        cs2 += v * v
      }
    }
    this.cSumT = cs
    this.cSumT2 = cs2
    this.lastScore = 1
  }

  /**
   * Search around `pred` with `radius` (level-0 px). Optional `hint` is tried
   * first in a tight window. Returns center in level-0 pixels, or null.
   */
  find(
    fine: Level,
    coarseLevel: Level,
    predX: number,
    predY: number,
    radius: number,
    hintX?: number,
    hintY?: number,
  ): { x: number; y: number; ncc: number } | null {
    if (hintX != null && hintY != null) {
      const hit = this.refine(fine, hintX, hintY, HALF)
      if (hit && hit.ncc >= NCC_ACCEPT) {
        this.lastScore = hit.ncc
        return hit
      }
    }
    const scale = fine.w / coarseLevel.w
    const cr = Math.max(2, Math.round(radius / scale))
    const cpx = predX / scale
    const cpy = predY / scale
    const coarseHit = this.searchCoarse(coarseLevel, cpx, cpy, cr)
    if (!coarseHit) return null
    const hit = this.refine(fine, coarseHit.x * scale, coarseHit.y * scale, 8)
    if (!hit || hit.ncc < NCC_ACCEPT) return null
    this.lastScore = hit.ncc
    return hit
  }

  private searchCoarse(
    level: Level,
    cx: number,
    cy: number,
    radius: number,
  ): { x: number; y: number; ncc: number } | null {
    const { gray, w, h } = level
    const x0 = Math.max(HALF_C, Math.floor(cx - radius))
    const x1 = Math.min(w - 1 - HALF_C, Math.ceil(cx + radius))
    const y0 = Math.max(HALF_C, Math.floor(cy - radius))
    const y1 = Math.min(h - 1 - HALF_C, Math.ceil(cy + radius))
    if (x1 <= x0 || y1 <= y0) return null
    let best = -1
    let bx = cx
    let by = cy
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const s = nccAt(gray, w, h, x, y, this.coarse, COARSE, this.cSumT, this.cSumT2)
        if (s > best) {
          best = s
          bx = x
          by = y
        }
      }
    }
    if (best < 0) return null
    return { x: bx, y: by, ncc: best }
  }

  private refine(
    level: Level,
    cx: number,
    cy: number,
    radius: number,
  ): { x: number; y: number; ncc: number } | null {
    const { gray, w, h } = level
    const x0 = Math.max(HALF, Math.floor(cx - radius))
    const x1 = Math.min(w - 1 - HALF, Math.ceil(cx + radius))
    const y0 = Math.max(HALF, Math.floor(cy - radius))
    const y1 = Math.min(h - 1 - HALF, Math.ceil(cy + radius))
    if (x1 <= x0 || y1 <= y0) return null
    let best = -1
    let bx = cx
    let by = cy
    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const s = nccAt(gray, w, h, x, y, this.templ, TEMPLATE, this.sumT, this.sumT2)
        if (s > best) {
          best = s
          bx = x
          by = y
        }
      }
    }
    const rx0 = Math.max(HALF, Math.floor(bx) - 2)
    const rx1 = Math.min(w - 1 - HALF, Math.ceil(bx) + 2)
    const ry0 = Math.max(HALF, Math.floor(by) - 2)
    const ry1 = Math.min(h - 1 - HALF, Math.ceil(by) + 2)
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const s = nccAt(gray, w, h, x, y, this.templ, TEMPLATE, this.sumT, this.sumT2)
        if (s > best) {
          best = s
          bx = x
          by = y
        }
      }
    }
    return { x: bx, y: by, ncc: best }
  }
}

function nccAt(
  gray: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  templ: Float32Array,
  size: number,
  sumT: number,
  sumT2: number,
): number {
  const half = size >> 1
  const x0 = (cx - half) | 0
  const y0 = (cy - half) | 0
  if (x0 < 0 || y0 < 0 || x0 + size > w || y0 + size > h) return -1
  const n = size * size
  let sumI = 0
  let sumI2 = 0
  let sumIT = 0
  let t = 0
  for (let y = 0; y < size; y++) {
    let i = (y0 + y) * w + x0
    for (let x = 0; x < size; x++) {
      const g = gray[i++]
      const tv = templ[t++]
      sumI += g
      sumI2 += g * g
      sumIT += g * tv
    }
  }
  const num = n * sumIT - sumI * sumT
  const denI = n * sumI2 - sumI * sumI
  const denT = n * sumT2 - sumT * sumT
  if (denI <= 1e-6 || denT <= 1e-6) return -1
  const ncc = num / Math.sqrt(denI * denT)
  if (!Number.isFinite(ncc)) return -1
  return ncc
}
