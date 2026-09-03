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

  // Calibration target — lock the reticle on this, then move camera or subject.
  const pulse = 1 + Math.sin(time * 2) * 0.04
  ctx.translate(cx + subject.x, cy + subject.y)
  ctx.scale(pulse, pulse)
  ctx.strokeStyle = '#7ee0c8'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(0, 0, 54, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, 18, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(-70, 0)
  ctx.lineTo(-24, 0)
  ctx.moveTo(24, 0)
  ctx.lineTo(70, 0)
  ctx.moveTo(0, -70)
  ctx.lineTo(0, -24)
  ctx.moveTo(0, 24)
  ctx.lineTo(0, 70)
  ctx.stroke()
  ctx.fillStyle = '#f4f7fb'
  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('SUBJECT', 0, 92)

  ctx.restore()
}
