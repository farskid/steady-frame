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
 * Hard pin: map the tracked subject onto the reticle.
 * scale keeps apparent size (face moving toward/away from the lens).
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
  const zoom = CROP_ZOOM * clamp(scale, 0.72, 1.85)
  const maxX = ((zoom - 1) / 2) * width * 0.98
  const maxY = ((zoom - 1) / 2) * height * 0.98
  const wantX = cx - foundX
  const wantY = cy - foundY
  const dx = clamp(wantX, -maxX, maxX)
  const dy = clamp(wantY, -maxY, maxY)
  const clamped = Math.abs(wantX) > maxX || Math.abs(wantY) > maxY
  const matrix = Mat3.translation(cx, cy)
    .multiply(Mat3.scale(zoom))
    .multiply(Mat3.rotation(-yaw))
    .multiply(Mat3.translation(-(cx - dx), -(cy - dy)))
  return { matrix, clamped }
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
