/** Image pyramid: grayscale + Scharr gradients, 3 levels, Gaussian decimation. */

export const PYRAMID_LEVELS = 3
const GAUSS = 16

export type Level = {
  w: number
  h: number
  gray: Float32Array
  gx: Float32Array
  gy: Float32Array
}

export class Pyramid {
  levels: Level[] = []
  w = 0
  h = 0
  private blur = new Float32Array(0)

  ensure(w: number, h: number): void {
    if (this.w === w && this.h === h && this.levels.length === PYRAMID_LEVELS) return
    this.w = w
    this.h = h
    this.levels = []
    let lw = w
    let lh = h
    let maxPix = 0
    for (let i = 0; i < PYRAMID_LEVELS; i++) {
      const n = lw * lh
      this.levels.push({
        w: lw,
        h: lh,
        gray: new Float32Array(n),
        gx: new Float32Array(n),
        gy: new Float32Array(n),
      })
      if (n > maxPix) maxPix = n
      lw = Math.max(1, lw >> 1)
      lh = Math.max(1, lh >> 1)
    }
    this.blur = new Float32Array(maxPix)
  }

  build(imageData: ImageData): void {
    this.ensure(imageData.width, imageData.height)
    fillGray(this.levels[0], imageData.data)
    for (let i = 1; i < PYRAMID_LEVELS; i++) {
      downsample(this.levels[i - 1].gray, this.levels[i - 1].w, this.levels[i - 1].h, this.levels[i], this.blur)
    }
    for (let i = 0; i < PYRAMID_LEVELS; i++) scharr(this.levels[i])
  }

  copyFrom(src: Pyramid): void {
    this.ensure(src.w, src.h)
    for (let i = 0; i < PYRAMID_LEVELS; i++) {
      const a = this.levels[i]
      const b = src.levels[i]
      a.gray.set(b.gray)
      a.gx.set(b.gx)
      a.gy.set(b.gy)
    }
  }
}

export function sample(level: Level, x: number, y: number): number {
  return sampleBuf(level.gray, level.w, level.h, x, y)
}

export function sampleGx(level: Level, x: number, y: number): number {
  return sampleBuf(level.gx, level.w, level.h, x, y)
}

export function sampleGy(level: Level, x: number, y: number): number {
  return sampleBuf(level.gy, level.w, level.h, x, y)
}

export function sampleBuf(buf: Float32Array, w: number, h: number, x: number, y: number): number {
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
  const i00 = y0 * w + x0
  const i10 = y0 * w + x1
  const i01 = y1 * w + x0
  const i11 = y1 * w + x1
  const a = buf[i00]
  const b = buf[i10]
  const c = buf[i01]
  const d = buf[i11]
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}

function fillGray(level: Level, data: Uint8ClampedArray): void {
  const n = level.w * level.h
  const gray = level.gray
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
  }
}

/** 5-tap [1 4 6 4 1]/16, then take even pixels. */
function downsample(
  src: Float32Array,
  sw: number,
  sh: number,
  dst: Level,
  tmp: Float32Array,
): void {
  const dw = dst.w
  const dh = dst.h
  const gray = dst.gray
  // Horizontal blur into tmp (src resolution).
  for (let y = 0; y < sh; y++) {
    const row = y * sw
    for (let x = 0; x < sw; x++) {
      const xm2 = row + (x < 2 ? 0 : x - 2)
      const xm1 = row + (x < 1 ? 0 : x - 1)
      const x0 = row + x
      const xp1 = row + (x + 1 >= sw ? sw - 1 : x + 1)
      const xp2 = row + (x + 2 >= sw ? sw - 1 : x + 2)
      tmp[row + x] = (src[xm2] + src[xm1] * 4 + src[x0] * 6 + src[xp1] * 4 + src[xp2]) / GAUSS
    }
  }
  // Vertical blur at even pixels only.
  for (let y = 0; y < dh; y++) {
    const sy = y * 2
    const ym2 = (sy < 2 ? 0 : sy - 2) * sw
    const ym1 = (sy < 1 ? 0 : sy - 1) * sw
    const y0 = sy * sw
    const yp1 = (sy + 1 >= sh ? sh - 1 : sy + 1) * sw
    const yp2 = (sy + 2 >= sh ? sh - 1 : sy + 2) * sw
    const drow = y * dw
    for (let x = 0; x < dw; x++) {
      const sx = x * 2
      gray[drow + x] =
        (tmp[ym2 + sx] + tmp[ym1 + sx] * 4 + tmp[y0 + sx] * 6 + tmp[yp1 + sx] * 4 + tmp[yp2 + sx]) / GAUSS
    }
  }
}

/** Scharr 3×3, divided by 32, replicate borders. */
function scharr(level: Level): void {
  const { w, h, gray, gx, gy } = level
  for (let y = 0; y < h; y++) {
    const ym = y === 0 ? 0 : y - 1
    const yp = y === h - 1 ? h - 1 : y + 1
    const row = y * w
    const rm = ym * w
    const rp = yp * w
    for (let x = 0; x < w; x++) {
      const xm = x === 0 ? 0 : x - 1
      const xp = x === w - 1 ? w - 1 : x + 1
      const tl = gray[rm + xm]
      const tc = gray[rm + x]
      const tr = gray[rm + xp]
      const ml = gray[row + xm]
      const mr = gray[row + xp]
      const bl = gray[rp + xm]
      const bc = gray[rp + x]
      const br = gray[rp + xp]
      gx[row + x] = (-3 * tl - 10 * ml - 3 * bl + 3 * tr + 10 * mr + 3 * br) * (1 / 32)
      gy[row + x] = (-3 * tl - 10 * tc - 3 * tr + 3 * bl + 10 * bc + 3 * br) * (1 / 32)
    }
  }
}
