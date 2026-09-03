import { clamp, Mat3 } from './mat3.ts'
import type { MotionState } from './motion.ts'

/** Extra scale so inverse transforms do not reveal empty canvas at the edges. */
export const CROP_ZOOM = 1.42

const HFOV = (65 * Math.PI) / 180

export function cropOnly(width: number, height: number): Mat3 {
  const cx = width / 2
  const cy = height / 2
  return Mat3.translation(cx, cy)
    .multiply(Mat3.scale(CROP_ZOOM))
    .multiply(Mat3.translation(-cx, -cy))
}

/**
 * Keep the tracked subject at the screen center: rotate opposite yaw,
 * translate opposite the subject's pixel motion, then crop-zoom.
 */
export function lockViewMatrix(
  width: number,
  height: number,
  foundX: number,
  foundY: number,
  yaw: number,
): { matrix: Mat3; clamped: boolean } {
  const cx = width / 2
  const cy = height / 2
  const maxX = ((CROP_ZOOM - 1) / 2) * width * 0.9
  const maxY = ((CROP_ZOOM - 1) / 2) * height * 0.9
  const dx = clamp(cx - foundX, -maxX, maxX)
  const dy = clamp(cy - foundY, -maxY, maxY)
  const clamped = Math.abs(cx - foundX) > maxX || Math.abs(cy - foundY) > maxY
  const matrix = Mat3.translation(cx, cy)
    .multiply(Mat3.scale(CROP_ZOOM))
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
  const focalPx = width / 2 / Math.tan(HFOV / 2)
  const yaw = motion.yaw
  const pitch = clamp(motion.pitch, -1.15, 1.15)
  const roll = clamp(motion.roll, -1.15, 1.15)
  const tx = clamp(focalPx * Math.tan(roll) + motion.position.x * 220, -width * 0.35, width * 0.35)
  const ty = clamp(focalPx * Math.tan(pitch) - motion.position.y * 220, -height * 0.35, height * 0.35)
  const cx = width / 2
  const cy = height / 2
  return Mat3.translation(cx, cy)
    .multiply(Mat3.rotation(yaw))
    .multiply(Mat3.translation(tx, ty))
    .multiply(Mat3.translation(-cx, -cy))
}
