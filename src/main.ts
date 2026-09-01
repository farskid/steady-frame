import './style.css'
import { CameraFeed, drawCover } from './camera.ts'
import { Mat3 } from './mat3.ts'
import { MotionTracker, type MotionMode } from './motion.ts'
import { drawTestScene } from './scene.ts'
import { CROP_ZOOM, rawMatrix, viewMatrix } from './stabilize.ts'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <canvas id="stage" aria-label="Stabilized camera view"></canvas>
  <div class="vignette"></div>
  <div class="crosshair" aria-hidden="true"></div>

  <header class="topbar">
    <div>
      <p class="eyebrow">Canvas EIS</p>
      <h1>Steady Frame</h1>
    </div>
    <span id="source-pill" class="pill">Idle</span>
  </header>

  <aside class="pip" id="pip-wrap" hidden>
    <canvas id="pip" width="160" height="110"></canvas>
    <span>Raw</span>
  </aside>

  <section class="gate" id="gate">
    <p class="eyebrow">Phone camera lock</p>
    <h2>Cancel shake with the inverse motion matrix</h2>
    <p>
      This page reads your camera and IMU. Speed, acceleration, and direction
      are integrated into a pose, inverted, and applied as a matrix transform
      on the pixels — the same idea as electronic image stabilization.
    </p>
    <p class="hint">
      On iPhone, Safari must grant Motion &amp; Orientation access. Nothing is
      uploaded. On desktop, drag to simulate gyro or tap Demo shake.
    </p>
    <button type="button" class="primary" id="start">Enable camera &amp; motion</button>
    <p class="error" id="gate-error" hidden></p>
  </section>

  <section class="hud" id="hud" hidden>
    <div class="metrics">
      <div>
        <span>Speed</span>
        <strong id="m-speed">0.00 m/s</strong>
      </div>
      <div>
        <span>Accel</span>
        <strong id="m-accel">0.00 m/s²</strong>
      </div>
      <div>
        <span>Direction</span>
        <strong id="m-dir">—</strong>
      </div>
    </div>

    <div class="vector-row">
      <div class="compass">
        <canvas id="needle" width="88" height="88"></canvas>
        <span>XY velocity</span>
      </div>
      <pre class="matrix" id="matrix"></pre>
    </div>

    <div class="controls">
      <label class="toggle">
        <input type="checkbox" id="enabled" checked />
        <span>Stabilization</span>
      </label>
      <label class="toggle">
        <input type="checkbox" id="lock" />
        <span>World lock</span>
      </label>
      <label class="strength">
        <span>Strength</span>
        <input type="range" id="strength" min="0" max="100" value="100" />
      </label>
    </div>

    <div class="actions">
      <button type="button" id="demo-shake">Demo shake</button>
      <button type="button" id="reset">Zero pose</button>
    </div>
    <p class="status" id="status"></p>
  </section>
`

const stage = app.querySelector<HTMLCanvasElement>('#stage')!
const pip = app.querySelector<HTMLCanvasElement>('#pip')!
const pipWrap = app.querySelector<HTMLElement>('#pip-wrap')!
const needle = app.querySelector<HTMLCanvasElement>('#needle')!
const gate = app.querySelector<HTMLElement>('#gate')!
const hud = app.querySelector<HTMLElement>('#hud')!
const gateError = app.querySelector<HTMLElement>('#gate-error')!
const sourcePill = app.querySelector<HTMLElement>('#source-pill')!
const statusEl = app.querySelector<HTMLElement>('#status')!
const matrixEl = app.querySelector<HTMLElement>('#matrix')!
const speedEl = app.querySelector<HTMLElement>('#m-speed')!
const accelEl = app.querySelector<HTMLElement>('#m-accel')!
const dirEl = app.querySelector<HTMLElement>('#m-dir')!

const enabledInput = app.querySelector<HTMLInputElement>('#enabled')!
const lockInput = app.querySelector<HTMLInputElement>('#lock')!
const strengthInput = app.querySelector<HTMLInputElement>('#strength')!

const camera = new CameraFeed()
const motion = new MotionTracker()
const ctx = stage.getContext('2d')!
const pipCtx = pip.getContext('2d')!
const needleCtx = needle.getContext('2d')!

let running = false
let demoShakeUntil = 0
let pointerActive = false
let pointerGyro = { x: 0, y: 0, z: 0 }
let lastFrame = performance.now() / 1000
let hudTick = 0

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.floor(window.innerWidth * dpr)
  const h = Math.floor(window.innerHeight * dpr)
  if (stage.width !== w || stage.height !== h) {
    stage.width = w
    stage.height = h
  }
}

function formatMatrix(m: Mat3): string {
  const rows = m.rows()
  const cell = (n: number) => n.toFixed(3).padStart(8)
  return rows.map((row) => row.map(cell).join(' ')).join('\n')
}

function compassLabel(rad: number, speed: number): string {
  if (speed < 0.02) return 'still'
  const deg = ((rad * 180) / Math.PI + 360) % 360
  const dirs = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE']
  const idx = Math.round(deg / 45) % 8
  return `${dirs[idx]} ${deg.toFixed(0)}°`
}

function drawNeedle(): void {
  const { velocity, accel } = motion.state
  const w = needle.width
  const h = needle.height
  const cx = w / 2
  const cy = h / 2
  needleCtx.clearRect(0, 0, w, h)
  needleCtx.strokeStyle = 'rgba(244,247,251,0.18)'
  needleCtx.beginPath()
  needleCtx.arc(cx, cy, 34, 0, Math.PI * 2)
  needleCtx.stroke()

  const drawVec = (x: number, y: number, color: string, scale: number) => {
    const px = cx + x * scale
    const py = cy - y * scale
    needleCtx.strokeStyle = color
    needleCtx.fillStyle = color
    needleCtx.beginPath()
    needleCtx.moveTo(cx, cy)
    needleCtx.lineTo(px, py)
    needleCtx.stroke()
    needleCtx.beginPath()
    needleCtx.arc(px, py, 3, 0, Math.PI * 2)
    needleCtx.fill()
  }

  drawVec(accel.x, accel.y, '#e8c872', 8)
  drawVec(velocity.x, velocity.y, '#7ee0c8', 28)
}

function paintSource(width: number, height: number, time: number): void {
  if (camera.ready) {
    drawCover(
      ctx,
      camera.video,
      camera.video.videoWidth,
      camera.video.videoHeight,
      width,
      height,
    )
    return
  }
  drawTestScene(ctx, width, height, time)
}

function paintPip(time: number, source: 'camera' | 'scene'): void {
  const w = pip.width
  const h = pip.height
  pipCtx.setTransform(1, 0, 0, 1, 0, 0)
  pipCtx.fillStyle = '#07080c'
  pipCtx.fillRect(0, 0, w, h)
  if (source === 'camera' && camera.ready) {
    drawCover(
      pipCtx,
      camera.video,
      camera.video.videoWidth,
      camera.video.videoHeight,
      w,
      h,
    )
    return
  }
  const pose = rawMatrix(motion.state, w, h, 'scene')
  pose.applyTo(pipCtx)
  drawTestScene(pipCtx, w, h, time)
  pipCtx.setTransform(1, 0, 0, 1, 0, 0)
}

function applyDemoShake(dt: number, now: number): void {
  if (now * 1000 > demoShakeUntil) return
  const t = now
  const accel = {
    x: Math.sin(t * 31) * 4.2,
    y: Math.cos(t * 27) * 3.6,
    z: Math.sin(t * 13) * 1.4,
  }
  const gyro = {
    x: Math.sin(t * 18) * 1.1,
    y: Math.cos(t * 21) * 1.3,
    z: Math.sin(t * 9) * 0.45,
  }
  if (motion.state.hasSensor) motion.perturb(dt, accel, gyro)
  else motion.ingestSimulated(dt, accel, gyro)
}

function applyPointer(dt: number): void {
  if (performance.now() < demoShakeUntil) return
  pointerGyro.x *= Math.exp(-dt * 12)
  pointerGyro.y *= Math.exp(-dt * 12)
  pointerGyro.z *= Math.exp(-dt * 12)
  if (Math.hypot(pointerGyro.x, pointerGyro.y, pointerGyro.z) < 1e-4) {
    pointerGyro = { x: 0, y: 0, z: 0 }
    return
  }
  motion.ingestSimulated(
    dt,
    { x: pointerGyro.y * 2.4, y: -pointerGyro.x * 2.4, z: 0 },
    pointerGyro,
  )
}

function frame(rawNow: number): void {
  const now = rawNow / 1000
  const dt = Math.min(0.05, Math.max(0.001, now - lastFrame))
  lastFrame = now
  resize()

  applyDemoShake(dt, now)
  applyPointer(dt)

  const width = stage.width
  const height = stage.height
  const enabled = enabledInput.checked
  const strength = Number(strengthInput.value) / 100
  motion.mode = (lockInput.checked ? 'lock' : 'shake') as MotionMode

  const source = camera.ready ? 'camera' : 'scene'
  const mat = viewMatrix(
    motion.state,
    {
      enabled,
      strength,
      width,
      height,
    },
    source,
  )

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#07080c'
  ctx.fillRect(0, 0, width, height)
  mat.applyTo(ctx)
  paintSource(width, height, now)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  paintPip(now, source)

  hudTick += dt
  if (hudTick >= 1 / 20) {
    hudTick = 0
    const { speed, accel, direction } = motion.state
    const accMag = Math.hypot(accel.x, accel.y, accel.z)
    speedEl.textContent = `${speed.toFixed(2)} m/s`
    accelEl.textContent = `${accMag.toFixed(2)} m/s²`
    dirEl.textContent = compassLabel(direction, speed)
    matrixEl.textContent = formatMatrix(mat)
    drawNeedle()
  }

  if (running) requestAnimationFrame(frame)
}

async function start(): Promise<void> {
  gateError.hidden = true
  const startBtn = app.querySelector<HTMLButtonElement>('#start')!
  startBtn.disabled = true
  startBtn.textContent = 'Requesting…'

  let motionOk = true
  try {
    const [granted] = await Promise.all([
      motion.requestPermission(),
      camera.start(),
    ])
    motionOk = granted
  } catch {
    motionOk = false
    if (camera.status === 'pending' || camera.status === 'idle') {
      await camera.start()
    }
  }
  motion.start()

  running = true
  gate.hidden = true
  hud.hidden = false
  pipWrap.hidden = false
  requestAnimationFrame(frame)

  if (camera.status === 'live') {
    sourcePill.textContent = 'Camera'
    sourcePill.classList.add('live')
  } else {
    sourcePill.textContent = 'Test scene'
    sourcePill.classList.add('fallback')
  }

  const bits: string[] = []
  if (camera.status !== 'live') bits.push(camera.error || 'No camera — test scene is active.')
  if (!motionOk) bits.push('Motion permission denied. Drag on the image to simulate gyro.')
  bits.push(`Crop zoom ${CROP_ZOOM.toFixed(2)}× keeps edges covered while the inverse matrix runs.`)
  statusEl.textContent = bits.join(' ')
}

app.querySelector('#start')!.addEventListener('click', () => {
  void start()
})

app.querySelector('#demo-shake')!.addEventListener('click', () => {
  demoShakeUntil = performance.now() + 2800
})

app.querySelector('#reset')!.addEventListener('click', () => {
  motion.reset()
  pointerGyro = { x: 0, y: 0, z: 0 }
})

stage.addEventListener('pointerdown', (event) => {
  if (gate.hidden === false) return
  pointerActive = true
  stage.setPointerCapture(event.pointerId)
})

stage.addEventListener('pointermove', (event) => {
  if (!pointerActive) return
  pointerGyro.y = event.movementX * 0.08
  pointerGyro.x = event.movementY * 0.08
  pointerGyro.z = event.movementX * 0.015
  pointerGyro.x = Math.max(-2.8, Math.min(2.8, pointerGyro.x))
  pointerGyro.y = Math.max(-2.8, Math.min(2.8, pointerGyro.y))
  pointerGyro.z = Math.max(-1.2, Math.min(1.2, pointerGyro.z))
})

stage.addEventListener('pointerup', () => {
  pointerActive = false
})
stage.addEventListener('pointercancel', () => {
  pointerActive = false
})

resize()
ctx.setTransform(1, 0, 0, 1, 0, 0)
drawTestScene(ctx, stage.width, stage.height, 0)
