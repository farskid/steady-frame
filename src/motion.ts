import { clamp, hypot3 } from './mat3.ts'

export type Vec3 = { x: number; y: number; z: number }

export type MotionMode = 'shake' | 'lock'

export type MotionState = {
  accel: Vec3
  gyro: Vec3
  velocity: Vec3
  position: Vec3
  pitch: number
  roll: number
  yaw: number
  speed: number
  direction: number
  hasSensor: boolean
  sampleHz: number
}

type Orient = { alpha: number; beta: number; gamma: number }

type DeviceMotionPermission = {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

function vec(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z }
}

function leakTowardZero(value: number, rate: number, dt: number): number {
  return value * Math.exp(-rate * dt)
}

export class MotionTracker {
  readonly state: MotionState = {
    accel: vec(),
    gyro: vec(),
    velocity: vec(),
    position: vec(),
    pitch: 0,
    roll: 0,
    yaw: 0,
    speed: 0,
    direction: 0,
    hasSensor: false,
    sampleHz: 0,
  }

  mode: MotionMode = 'shake'

  private lastT = 0
  private samples = 0
  private sampleWindowT = 0
  private listening = false
  private simulated = false
  private orientationLive = false
  private lastOrient: Orient | null = null
  private baseOrient: Orient | null = null
  private gravity = vec()

  private readonly onMotion = (event: DeviceMotionEvent) => {
    const now = performance.now() / 1000
    const dt = this.stepDt(now, event.interval ? event.interval / 1000 : undefined)
    const accel = event.acceleration
    const ag = event.accelerationIncludingGravity
    const rate = event.rotationRate
    let ax = accel?.x
    let ay = accel?.y
    let az = accel?.z
    if (ax == null && ag?.x != null) {
      this.gravity.x = this.gravity.x * 0.9 + ag.x * 0.1
      this.gravity.y = this.gravity.y * 0.9 + (ag.y ?? 0) * 0.1
      this.gravity.z = this.gravity.z * 0.9 + (ag.z ?? 0) * 0.1
      ax = ag.x - this.gravity.x
      ay = (ag.y ?? 0) - this.gravity.y
      az = (ag.z ?? 0) - this.gravity.z
    }
    const rb = rate?.beta
    const rg = rate?.gamma
    const ra = rate?.alpha
    const has =
      (ax != null && Number.isFinite(ax)) ||
      (ay != null && Number.isFinite(ay)) ||
      (rb != null && Number.isFinite(rb)) ||
      (rg != null && Number.isFinite(rg)) ||
      (ra != null && Number.isFinite(ra))
    if (!has) return

    this.state.hasSensor = true
    this.simulated = false

    const skipAngles = this.orientationLive && this.mode === 'lock'
    this.integrate(
      dt,
      ax ?? 0,
      ay ?? 0,
      az ?? 0,
      skipAngles ? 0 : degToRad(rb ?? 0),
      skipAngles ? 0 : degToRad(rg ?? 0),
      skipAngles ? 0 : degToRad(ra ?? 0),
    )
  }

  private readonly onOrientation = (event: DeviceOrientationEvent) => {
    if (event.beta == null || event.gamma == null) return
    this.lastOrient = {
      alpha: event.alpha ?? 0,
      beta: event.beta,
      gamma: event.gamma,
    }
    this.state.hasSensor = true
    this.orientationLive = true
    this.simulated = false
    if (!this.baseOrient || this.mode !== 'lock') return
    this.state.pitch = degToRad(event.beta - this.baseOrient.beta)
    this.state.roll = degToRad(event.gamma - this.baseOrient.gamma)
    this.state.yaw = degToRad(deltaDeg(event.alpha ?? 0, this.baseOrient.alpha))
  }

  async requestPermission(): Promise<boolean> {
    const Motion = DeviceMotionEvent as unknown as DeviceMotionPermission
    if (typeof Motion.requestPermission === 'function') {
      const result = await Motion.requestPermission()
      if (result !== 'granted') return false
    }
    const Orientation = DeviceOrientationEvent as unknown as DeviceMotionPermission
    if (typeof Orientation.requestPermission === 'function') {
      try {
        await Orientation.requestPermission()
      } catch {
        // Orientation is optional; gyro on DeviceMotion is enough.
      }
    }
    return true
  }

  start(): void {
    if (this.listening) return
    this.listening = true
    this.lastT = performance.now() / 1000
    window.addEventListener('devicemotion', this.onMotion)
    window.addEventListener('deviceorientation', this.onOrientation)
  }

  stop(): void {
    if (!this.listening) return
    this.listening = false
    window.removeEventListener('devicemotion', this.onMotion)
    window.removeEventListener('deviceorientation', this.onOrientation)
  }

  reset(): void {
    this.state.accel = vec()
    this.state.gyro = vec()
    this.state.velocity = vec()
    this.state.position = vec()
    this.state.pitch = 0
    this.state.roll = 0
    this.state.yaw = 0
    this.state.speed = 0
    this.state.direction = 0
    this.baseOrient = this.lastOrient ? { ...this.lastOrient } : null
  }

  /**
   * Inject motion in rad/s and m/s². Used for desktop drag and the shake demo.
   * Call from the animation frame with the real dt.
   */
  ingestSimulated(
    dt: number,
    accel: Vec3 = ZERO,
    gyro: Vec3 = ZERO,
  ): void {
    if (this.state.hasSensor && !this.simulated) return
    this.simulated = true
    this.integrate(dt, accel.x, accel.y, accel.z, gyro.x, gyro.y, gyro.z)
  }

  /** Add extra kinematics on top of live sensor pose (used by Demo shake). */
  perturb(dt: number, accel: Vec3, gyro: Vec3): void {
    this.state.pitch += gyro.x * dt
    this.state.roll += gyro.y * dt
    this.state.yaw += gyro.z * dt
    this.state.velocity.x += accel.x * dt
    this.state.velocity.y += accel.y * dt
    this.state.velocity.z += accel.z * dt
    this.state.position.x += accel.x * dt * dt
    this.state.position.y += accel.y * dt * dt
    this.state.position.z += accel.z * dt * dt
    this.state.speed = hypot3(
      this.state.velocity.x,
      this.state.velocity.y,
      this.state.velocity.z,
    )
    this.state.direction = Math.atan2(this.state.velocity.y, this.state.velocity.x)
  }

  private stepDt(now: number, reported?: number): number {
    const raw = now - this.lastT
    this.lastT = now
    this.samples += 1
    if (now - this.sampleWindowT >= 0.5) {
      this.state.sampleHz = this.samples / (now - this.sampleWindowT)
      this.samples = 0
      this.sampleWindowT = now
    }
    const dt = reported && reported > 0 && reported < 0.1 ? reported : raw
    return clamp(dt, 1 / 240, 1 / 20)
  }

  private integrate(
    dt: number,
    ax: number,
    ay: number,
    az: number,
    gx: number,
    gy: number,
    gz: number,
  ): void {
    const accelAlpha = 1 - Math.exp(-dt / 0.03)
    this.state.accel.x = lerpExp(this.state.accel.x, ax, accelAlpha)
    this.state.accel.y = lerpExp(this.state.accel.y, ay, accelAlpha)
    this.state.accel.z = lerpExp(this.state.accel.z, az, accelAlpha)
    this.state.gyro.x = lerpExp(this.state.gyro.x, gx, accelAlpha)
    this.state.gyro.y = lerpExp(this.state.gyro.y, gy, accelAlpha)
    this.state.gyro.z = lerpExp(this.state.gyro.z, gz, accelAlpha)

    // Integrate gyroscope → orientation residual.
    this.state.pitch += this.state.gyro.x * dt
    this.state.roll += this.state.gyro.y * dt
    this.state.yaw += this.state.gyro.z * dt

    // High-pass leak: shake mode forgets quickly, lock mode holds pose.
    const angleLeak = this.mode === 'shake' ? 6.5 : this.orientationLive ? 0 : 0.02
    this.state.pitch = leakTowardZero(this.state.pitch, angleLeak, dt)
    this.state.roll = leakTowardZero(this.state.roll, angleLeak, dt)
    this.state.yaw = leakTowardZero(this.state.yaw, angleLeak, dt)

    // Double-integrate linear acceleration → velocity → position (meters).
    const velDamp = this.mode === 'shake' ? 8 : 0.35
    const posDamp = this.mode === 'shake' ? 7 : 0.25
    this.state.velocity.x += this.state.accel.x * dt
    this.state.velocity.y += this.state.accel.y * dt
    this.state.velocity.z += this.state.accel.z * dt
    this.state.velocity.x = leakTowardZero(this.state.velocity.x, velDamp, dt)
    this.state.velocity.y = leakTowardZero(this.state.velocity.y, velDamp, dt)
    this.state.velocity.z = leakTowardZero(this.state.velocity.z, velDamp, dt)

    this.state.position.x += this.state.velocity.x * dt
    this.state.position.y += this.state.velocity.y * dt
    this.state.position.z += this.state.velocity.z * dt
    this.state.position.x = leakTowardZero(this.state.position.x, posDamp, dt)
    this.state.position.y = leakTowardZero(this.state.position.y, posDamp, dt)
    this.state.position.z = leakTowardZero(this.state.position.z, posDamp, dt)

    this.state.speed = hypot3(
      this.state.velocity.x,
      this.state.velocity.y,
      this.state.velocity.z,
    )
    this.state.direction = Math.atan2(this.state.velocity.y, this.state.velocity.x)
  }
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function deltaDeg(now: number, base: number): number {
  let d = now - base
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

function lerpExp(current: number, target: number, alpha: number): number {
  return current + (target - current) * alpha
}
