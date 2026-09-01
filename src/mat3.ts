/** Canvas 2D affine matrix: x' = a x + c y + e, y' = b x + d y + f */
export class Mat3 {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number

  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    this.a = a
    this.b = b
    this.c = c
    this.d = d
    this.e = e
    this.f = f
  }

  static identity(): Mat3 {
    return new Mat3()
  }

  static translation(tx: number, ty: number): Mat3 {
    return new Mat3(1, 0, 0, 1, tx, ty)
  }

  static rotation(rad: number): Mat3 {
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    return new Mat3(cos, sin, -sin, cos, 0, 0)
  }

  static scale(sx: number, sy = sx): Mat3 {
    return new Mat3(sx, 0, 0, sy, 0, 0)
  }

  multiply(m: Mat3): Mat3 {
    return new Mat3(
      this.a * m.a + this.c * m.b,
      this.b * m.a + this.d * m.b,
      this.a * m.c + this.c * m.d,
      this.b * m.c + this.d * m.d,
      this.a * m.e + this.c * m.f + this.e,
      this.b * m.e + this.d * m.f + this.f,
    )
  }

  inverse(): Mat3 {
    const det = this.a * this.d - this.b * this.c
    if (Math.abs(det) < 1e-12) return Mat3.identity()
    const invDet = 1 / det
    const a = this.d * invDet
    const b = -this.b * invDet
    const c = -this.c * invDet
    const d = this.a * invDet
    const e = -(a * this.e + c * this.f)
    const f = -(b * this.e + d * this.f)
    return new Mat3(a, b, c, d, e, f)
  }

  applyTo(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.a, this.b, this.c, this.d, this.e, this.f)
  }

  rows(): [number, number, number][] {
    return [
      [this.a, this.c, this.e],
      [this.b, this.d, this.f],
      [0, 0, 1],
    ]
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function hypot3(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z)
}
