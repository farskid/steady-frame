import { clamp, Mat3 } from './mat3.ts'
import type { MotionState } from './motion.ts'

/** Assumed horizontal field of view for a typical rear phone camera. */
const HFOV = (65 * Math.PI) / 180
/** Subject distance used to convert meters of translation into pixels. */
const SUBJECT_DISTANCE_M = 1.4
/** Extra scale so inverse transforms do not reveal empty canvas at the edges. */
export const CROP_ZOOM = 1.38

export type StabilizeOptions = {
  enabled: boolean
  strength: number
  width: number
  height: number
}

export type FrameSource = 'camera' | 'scene'

/**
 * Pixel-space pose of the camera from integrated IMU state.
 * Rotation from yaw; translation from pitch/roll (pinhole) plus linear shift.
 */
export function cameraPoseMatrix(
  motion: MotionState,
  width: number,
  height: number,
  amount: number,
): Mat3 {
  const k = clamp(amount, 0, 1)
  if (k <= 0) return Mat3.identity()

  const focalPx = width / 2 / Math.tan(HFOV / 2)
  const ppm = focalPx / SUBJECT_DISTANCE_M
  const yaw = motion.yaw * k
  const pitch = clamp(motion.pitch * k, -1.15, 1.15)
  const roll = clamp(motion.roll * k, -1.15, 1.15)
  const txRot = focalPx * Math.tan(roll)
  const tyRot = focalPx * Math.tan(pitch)
  const txPos = motion.position.x * ppm * k
  const tyPos = -motion.position.y * ppm * k

  const zoom = CROP_ZOOM
  const maxShiftX = ((zoom - 1) / 2) * width * 0.92
  const maxShiftY = ((zoom - 1) / 2) * height * 0.92
  const tx = clamp(txRot + txPos, -maxShiftX, maxShiftX)
  const ty = clamp(tyRot + tyPos, -maxShiftY, maxShiftY)

  const cx = width / 2
  const cy = height / 2
  return Mat3.translation(cx, cy)
    .multiply(Mat3.rotation(yaw))
    .multiply(Mat3.translation(tx, ty))
    .multiply(Mat3.translation(-cx, -cy))
}

function withCrop(width: number, height: number, inner: Mat3): Mat3 {
  const cx = width / 2
  const cy = height / 2
  return Mat3.translation(cx, cy)
    .multiply(Mat3.scale(CROP_ZOOM))
    .multiply(Mat3.translation(-cx, -cy))
    .multiply(inner)
}

/**
 * Matrix applied to the main canvas.
 * Live camera pixels already contain the shake, so we apply the inverse pose.
 * The test scene is a still world, so we apply the residual forward pose.
 */
export function viewMatrix(
  motion: MotionState,
  options: StabilizeOptions,
  source: FrameSource,
): Mat3 {
  const { width, height, enabled, strength } = options
  const k = enabled ? clamp(strength, 0, 1) : 0

  if (source === 'camera') {
    const pose = cameraPoseMatrix(motion, width, height, k)
    return withCrop(width, height, pose.inverse())
  }

  const residual = cameraPoseMatrix(motion, width, height, 1 - k)
  return withCrop(width, height, residual)
}

/** Unstabilized PIP: real video as-is, or the fully shaken test scene. */
export function rawMatrix(
  motion: MotionState,
  width: number,
  height: number,
  source: FrameSource,
): Mat3 {
  if (source === 'camera') return Mat3.identity()
  return cameraPoseMatrix(motion, width, height, 1)
}
