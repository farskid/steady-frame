import { clamp, Mat3 } from './mat3.ts'
import type { MotionState } from './motion.ts'

/** Heavy crop so a moving subject can be panned back onto the reticle. */
export const CROP_ZOOM = 2.2

const HFOV = (65 * Math.PI) / 180

export function cropOnly(width: number, height: number): Mat3 {
  const cx = width / 2
  const cy = height / 2
  return Mat3.translation(cx, cy)
    .multiply(Mat3.scale(CROP_ZOOM))
    .multiply(Mat3.translation(-cx, -cy))
}

export function imageShiftFromImu(
  motion: MotionState,
  width: number,
  _height: number,
): { x: number; y: number; yaw: number } {
  const focalPx = width / 2 / Math.tan(HFOV / 2)
  const pitch = clamp(motion.pitch, -1.2, 1.2)
  const roll = clamp(motion.roll, -1.2, 1.2)
  return {
    x: focalPx * Math.tan(roll) + motion.position.x * 220,
    y: focalPx * Math.tan(pitch) - motion.position.y * 220,
    yaw: motion.yaw,
  }
}

/**
 * Hard pin: the tracked point is always mapped to the reticle.
 * Zoom grows with travel so we don't "let them escape" by clamping.
 * Black edges mean the subject is near the lens FOV limit — not unlock.
 */
export function lockViewMatrix(
  width: number,
  height: number,
  foundX: number,
  foundY: number,
  yaw: number,
  scale = 1,
): { matrix: Mat3; clamped: boolean } {
  const cx = width / 2
  const cy = height / 2
  const distX = Math.abs(cx - foundX)
  const distY = Math.abs(cy - foundY)
  const need = Math.max(
    CROP_ZOOM,
    distX > 1 ? 1.1 * (1 + (2 * distX) / width) : 1,
    distY > 1 ? 1.1 * (1 + (2 * distY) / height) : 1,
  )
  const zoom = clamp(need * clamp(scale, 0.7, 1.9), CROP_ZOOM, 6)
  const atEdge =
    foundX < width * 0.04 ||
    foundX > width * 0.96 ||
    foundY < height * 0.04 ||
    foundY > height * 0.96
  const matrix = Mat3.translation(cx, cy)
    .multiply(Mat3.scale(zoom))
    .multiply(Mat3.rotation(-yaw))
    .multiply(Mat3.translation(-foundX, -foundY))
  return { matrix, clamped: atEdge }
}

/** Forward camera pose for the test-scene “camera shake”. */
export function sceneCameraMatrix(
  motion: MotionState,
  width: number,
  height: number,
): Mat3 {
  const shift = imageShiftFromImu(motion, width, height)
  const cx = width / 2
  const cy = height / 2
  return Mat3.translation(cx, cy)
    .multiply(Mat3.rotation(shift.yaw))
    .multiply(Mat3.translation(shift.x, shift.y))
    .multiply(Mat3.translation(-cx, -cy))
}
