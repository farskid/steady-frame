/** Procedural “world” used when no camera is available. */

export type SubjectOffset = { x: number; y: number }

export function drawTestScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  subject: SubjectOffset = { x: 0, y: 0 },
): void {
  const cx = width / 2
  const cy = height / 2
  ctx.save()

  const sky = ctx.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, '#1a2744')
  sky.addColorStop(0.45, '#2c3e5a')
  sky.addColorStop(0.451, '#3d4a38')
  sky.addColorStop(1, '#1c2118')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, width, height)

  // Horizon buildings — a fixed subject to lock onto.
  ctx.fillStyle = '#12161c'
  const buildings = 14
  for (let i = 0; i < buildings; i++) {
    const x = (i / buildings) * width
    const bw = width / buildings + 8
    const h = 80 + ((i * 67) % 180)
    ctx.fillRect(x, cy - 20 - h, bw - 6, h)
    ctx.fillStyle = i % 2 === 0 ? '#e8c872' : '#7ee0c8'
    const windows = Math.floor(h / 18)
    for (let w = 0; w < windows; w++) {
      if ((i + w) % 3 === 0) continue
      ctx.fillRect(x + 10, cy - 28 - h + w * 18, 6, 8)
      ctx.fillRect(x + 22, cy - 28 - h + w * 18, 6, 8)
    }
    ctx.fillStyle = '#12161c'
  }

  // Perspective floor grid.
  ctx.strokeStyle = 'rgba(126, 224, 200, 0.35)'
  ctx.lineWidth = 1.2
  const horizon = cy - 18
  for (let i = 1; i <= 18; i++) {
    const t = i / 18
    const y = horizon + t * t * (height - horizon)
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  ctx.beginPath()
  for (let i = -12; i <= 12; i++) {
    ctx.moveTo(cx + i * 28, height)
    ctx.lineTo(cx + i * 90, horizon)
  }
  ctx.stroke()

  // High-contrast lock target — distinct from the HUD reticle.
  // Size scales with the frame so downscale-to-480 still has Shi-Tomasi corners.
  const R = Math.max(56, Math.min(width, height) * 0.1)
  ctx.translate(cx + subject.x, cy + subject.y)
  ctx.fillStyle = '#f4f7fb'
  ctx.beginPath()
  ctx.arc(0, 0, R, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#e85d4c'
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.7, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#f4f7fb'
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.38, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#14161c'
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.14, 0, Math.PI * 2)
  ctx.fill()

  // Irregular interior marks — concentric rings alone are corner-poor.
  const marks: [number, number, number][] = [
    [-0.46, -0.22, 0.16],
    [0.38, -0.4, 0.14],
    [-0.18, 0.42, 0.15],
    [0.44, 0.28, 0.13],
    [-0.4, 0.18, 0.12],
    [0.2, -0.08, 0.11],
    [0.06, 0.5, 0.12],
    [-0.28, -0.48, 0.13],
  ]
  for (const [mx, my, ms] of marks) {
    const s = R * ms
    ctx.fillStyle = '#14161c'
    ctx.fillRect(mx * R - s / 2, my * R - s / 2, s, s)
    ctx.fillStyle = '#f4f7fb'
    ctx.fillRect(mx * R - s / 4, my * R - s / 4, s / 2, s / 2)
  }

  ctx.strokeStyle = `rgba(244, 247, 251, ${0.4 + Math.sin(time * 3) * 0.2})`
  ctx.lineWidth = Math.max(2, R * 0.04)
  ctx.beginPath()
  ctx.arc(0, 0, R * 1.16, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = '#f4f7fb'
  ctx.font = `700 ${Math.round(R * 0.28)}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText('SUBJECT', 0, R * 1.42)

  ctx.restore()
}
