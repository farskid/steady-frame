/** Constant-velocity Kalman filter on [x, y, vx, vy] plus a 1D scale smoother. */

const CHI2_95_DF2 = 9.21
const CHI2_RELAX_DF2 = 25
const SCALE_ALPHA = 0.4
const Q_JERK = 2400
/** Extra position noise so a whipping target is not a Mahalanobis outlier. */
const Q_POS = 80

export class KalmanCV {
  x = 0
  y = 0
  vx = 0
  vy = 0
  misses = 0
  /** Trace of the 4×4 covariance (confidence proxy). */
  covTrace = 0

  private readonly P = new Float64Array(16)
  private readonly tmp = new Float64Array(16)
  private readonly tmp2 = new Float64Array(16)

  reset(x: number, y: number): void {
    this.x = x
    this.y = y
    this.vx = 0
    this.vy = 0
    this.misses = 0
    this.P.fill(0)
    this.P[0] = 4
    this.P[5] = 4
    this.P[10] = 400
    this.P[15] = 400
    this.covTrace = 808
  }

  predict(dt: number, controlShift?: { x: number; y: number }): void {
    const t = dt
    this.x += this.vx * t + (controlShift?.x ?? 0)
    this.y += this.vy * t + (controlShift?.y ?? 0)

    // F = [[1,0,dt,0],[0,1,0,dt],[0,0,1,0],[0,0,0,1]]
    // P = F P Fᵀ + Q  (white-jerk / discrete white-noise acceleration, q ≈ 400)
    const P = this.P
    const FPF = this.tmp
    // FP: row-major. First two rows of F mix position with velocity.
    for (let j = 0; j < 4; j++) {
      FPF[0 * 4 + j] = P[0 * 4 + j] + t * P[2 * 4 + j]
      FPF[1 * 4 + j] = P[1 * 4 + j] + t * P[3 * 4 + j]
      FPF[2 * 4 + j] = P[2 * 4 + j]
      FPF[3 * 4 + j] = P[3 * 4 + j]
    }
    // (FP) Fᵀ — Fᵀ adds t * vel-col into pos-col
    const out = this.tmp2
    for (let i = 0; i < 4; i++) {
      const ri = i * 4
      out[ri + 0] = FPF[ri + 0] + t * FPF[ri + 2]
      out[ri + 1] = FPF[ri + 1] + t * FPF[ri + 3]
      out[ri + 2] = FPF[ri + 2]
      out[ri + 3] = FPF[ri + 3]
    }

    const q = Q_JERK
    const dt2 = t * t
    const dt3 = dt2 * t
    const dt4 = dt2 * dt2
    // Q for white acceleration spectral density q (px²/s³):
    // pos-pos dt^4/4, pos-vel dt^3/2, vel-vel dt^2
    out[0] += q * dt4 * 0.25 + Q_POS
    out[1] += 0
    out[2] += q * dt3 * 0.5
    out[3] += 0
    out[4] += 0
    out[5] += q * dt4 * 0.25 + Q_POS
    out[6] += 0
    out[7] += q * dt3 * 0.5
    out[8] += q * dt3 * 0.5
    out[9] += 0
    out[10] += q * dt2
    out[11] += 0
    out[12] += 0
    out[13] += q * dt3 * 0.5
    out[14] += 0
    out[15] += q * dt2

    P.set(out)
    this.covTrace = P[0] + P[5] + P[10] + P[15]
  }

  /**
   * Position update. Returns false if the innovation is a Mahalanobis outlier
   * (d² > 9.21); caller should treat that as a miss.
   */
  update(zx: number, zy: number, r: number, relax = false): boolean {
    const P = this.P
    const innX = zx - this.x
    const innY = zy - this.y
    const s00 = P[0] + r
    const s01 = P[1]
    const s10 = P[4]
    const s11 = P[5] + r
    const det = s00 * s11 - s01 * s10
    if (Math.abs(det) < 1e-12) {
      this.misses += 1
      return false
    }
    const invDet = 1 / det
    const i00 = s11 * invDet
    const i01 = -s01 * invDet
    const i10 = -s10 * invDet
    const i11 = s00 * invDet
    const d2 = innX * (i00 * innX + i01 * innY) + innY * (i10 * innX + i11 * innY)
    const gate = relax ? CHI2_RELAX_DF2 : CHI2_95_DF2
    if (d2 > gate) {
      this.misses += 1
      return false
    }

    // K = P Hᵀ S⁻¹ ; H = [[1,0,0,0],[0,1,0,0]] so Hᵀ S⁻¹ is 4×2 from first two cols of P.
    const k00 = P[0] * i00 + P[1] * i10
    const k01 = P[0] * i01 + P[1] * i11
    const k10 = P[4] * i00 + P[5] * i10
    const k11 = P[4] * i01 + P[5] * i11
    const k20 = P[8] * i00 + P[9] * i10
    const k21 = P[8] * i01 + P[9] * i11
    const k30 = P[12] * i00 + P[13] * i10
    const k31 = P[12] * i01 + P[13] * i11

    this.x += k00 * innX + k01 * innY
    this.y += k10 * innX + k11 * innY
    this.vx += k20 * innX + k21 * innY
    this.vy += k30 * innX + k31 * innY

    // P = (I − K H) P ; KH is 4×4 with only first two columns of K nonzero in H.
    // (I − KH) = I − K[:,0:2] applied to first two rows of anything.
    const NP = this.tmp
    for (let j = 0; j < 4; j++) {
      const p0j = P[j]
      const p1j = P[4 + j]
      NP[0 * 4 + j] = P[0 * 4 + j] - k00 * p0j - k01 * p1j
      NP[1 * 4 + j] = P[1 * 4 + j] - k10 * p0j - k11 * p1j
      NP[2 * 4 + j] = P[2 * 4 + j] - k20 * p0j - k21 * p1j
      NP[3 * 4 + j] = P[3 * 4 + j] - k30 * p0j - k31 * p1j
    }
    // Symmetrize to kill drift.
    for (let i = 0; i < 4; i++) {
      for (let j = i; j < 4; j++) {
        const v = 0.5 * (NP[i * 4 + j] + NP[j * 4 + i])
        NP[i * 4 + j] = v
        NP[j * 4 + i] = v
      }
    }
    P.set(NP)
    this.covTrace = P[0] + P[5] + P[10] + P[15]
    this.misses = 0
    return true
  }
}

export class ScaleSmoother {
  value = 1
  private readonly lo: number
  private readonly hi: number
  private readonly alpha: number

  constructor(alpha = SCALE_ALPHA, lo = 0.5, hi = 2) {
    this.alpha = alpha
    this.lo = lo
    this.hi = hi
  }

  reset(v = 1): void {
    this.value = v
  }

  observe(raw: number): number {
    this.value += this.alpha * (raw - this.value)
    if (this.value < this.lo) this.value = this.lo
    if (this.value > this.hi) this.value = this.hi
    return this.value
  }
}

/** Measurement noise from RANSAC quality: fewer inliers / higher rms → larger r. */
export function measurementR(rms: number, inlierCount: number): number {
  const base = Math.max(0.25, rms * rms)
  return base * (1 + 18 / Math.max(4, inlierCount))
}
