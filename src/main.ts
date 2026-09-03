import './style.css'
import { CameraFeed, drawCover } from './camera.ts'
import { MotionTracker } from './motion.ts'
import { drawTestScene } from './scene.ts'
import { cropOnly, lockViewMatrix, sceneCameraMatrix } from './stabilize.ts'
import { SubjectTracker } from './tracker.ts'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <canvas id="stage" aria-label="Camera view"></canvas>
  <div class="vignette"></div>
  <div class="reticle" id="reticle" aria-hidden="true">
    <span class="reticle-ring"></span>
    <span class="reticle-label" id="reticle-label">Aim here</span>
  </div>

  <header class="topbar">
    <ol class="steps" id="steps">
      <li class="on">1 Aim</li>
      <li>2 Lock</li>
      <li>3 Move</li>
    </ol>
    <span id="source-pill" class="pill">Idle</span>
  </header>

  <aside class="pip" id="pip-wrap" hidden>
    <canvas id="pip" width="160" height="110"></canvas>
    <span>Live — still shaking</span>
  </aside>

  <section class="panel" id="gate">
    <p class="eyebrow">Subject lock</p>
    <h1>Freeze the view on one subject</h1>
    <ol class="howto">
      <li>Turn on the camera and put the reticle on a subject.</li>
      <li>Tap <strong>Lock subject</strong>.</li>
      <li>Move the phone — or move the subject. The main view should hold still. The small Live inset keeps shaking so you can compare.</li>
    </ol>
    <p class="hint">
      Phone: allow camera + motion. Desktop: lock, then use Shake camera / Move subject.
    </p>
    <button type="button" class="primary" id="start">Enable camera</button>
    <p class="error" id="gate-error" hidden></p>
  </section>

  <section class="panel hud" id="hud" hidden>
    <p class="coach" id="coach"></p>
    <div class="actions">
      <button type="button" class="primary" id="lock-btn">Lock subject</button>
      <button type="button" id="shake-btn" hidden>Shake camera</button>
      <button type="button" id="nudge-btn" hidden>Move subject</button>
    </div>
    <p class="status" id="status"></p>
  </section>
`

const stage = app.querySelector<HTMLCanvasElement>('#stage')!
const pip = app.querySelector<HTMLCanvasElement>('#pip')!
const pipWrap = app.querySelector<HTMLElement>('#pip-wrap')!
const gate = app.querySelector<HTMLElement>('#gate')!
const hud = app.querySelector<HTMLElement>('#hud')!
const gateError = app.querySelector<HTMLElement>('#gate-error')!
const sourcePill = app.querySelector<HTMLElement>('#source-pill')!
const statusEl = app.querySelector<HTMLElement>('#status')!
const coachEl = app.querySelector<HTMLElement>('#coach')!
const reticle = app.querySelector<HTMLElement>('#reticle')!
const reticleLabel = app.querySelector<HTMLElement>('#reticle-label')!
const stepsEl = app.querySelector<HTMLElement>('#steps')!
const lockBtn = app.querySelector<HTMLButtonElement>('#lock-btn')!
const shakeBtn = app.querySelector<HTMLButtonElement>('#shake-btn')!
const nudgeBtn = app.querySelector<HTMLButtonElement>('#nudge-btn')!

const camera = new CameraFeed()
const motion = new MotionTracker()
const tracker = new SubjectTracker()
const ctx = stage.getContext('2d')!
const pipCtx = pip.getContext('2d')!
const source = document.createElement('canvas')
const sourceCtx = source.getContext('2d')!

let running = false
let locked = false
let demoShakeUntil = 0
let subjectMoveStart = 0
let subjectMoveEnd = 0
let pointerActive = false
let pointerGyro = { x: 0, y: 0, z: 0 }
let lastFrame = performance.now() / 1000
let hudTick = 0
let lastTrack = { foundX: 0, foundY: 0, score: 1, lost: false, clamped: false }

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.floor(window.innerWidth * dpr)
  const h = Math.floor(window.innerHeight * dpr)
  if (stage.width !== w || stage.height !== h) {
    stage.width = w
    stage.height = h
  }
  if (source.width !== w || source.height !== h) {
    source.width = w
    source.height = h
  }
}

function setStep(step: 1 | 2 | 3): void {
  const items = [...stepsEl.querySelectorAll('li')]
  items.forEach((el, i) => el.classList.toggle('on', i < step))
}

function subjectOffset(now: number): { x: number; y: number } {
  if (subjectMoveStart <= 0) return { x: 0, y: 0 }
  const t = now - subjectMoveStart
  const hold = Math.max(0.01, subjectMoveEnd - subjectMoveStart)
  const fade = 0.5
  let env = 1
  if (t > hold) {
    const u = (t - hold) / fade
    if (u >= 1) {
      subjectMoveStart = 0
      return { x: 0, y: 0 }
    }
    env = 1 - u * u
  }
  // Starts at 0,0 so the tracker can follow instead of teleporting.
  return {
    x: Math.sin(t * 1.35) * source.width * 0.13 * env,
    y: (1 - Math.cos(t * 1.05)) * source.height * 0.055 * env,
  }
}

function paintSource(time: number): void {
  const width = source.width
  const height = source.height
  sourceCtx.setTransform(1, 0, 0, 1, 0, 0)
  sourceCtx.fillStyle = '#07080c'
  sourceCtx.fillRect(0, 0, width, height)
  if (camera.ready) {
    drawCover(
      sourceCtx,
      camera.video,
      camera.video.videoWidth,
      camera.video.videoHeight,
      width,
      height,
    )
    return
  }
  sceneCameraMatrix(motion.state, width, height).applyTo(sourceCtx)
  drawTestScene(sourceCtx, width, height, time, subjectOffset(time))
  sourceCtx.setTransform(1, 0, 0, 1, 0, 0)
}

function paintPip(): void {
  const w = pip.width
  const h = pip.height
  pipCtx.setTransform(1, 0, 0, 1, 0, 0)
  pipCtx.fillStyle = '#07080c'
  pipCtx.fillRect(0, 0, w, h)
  const scale = Math.max(w / source.width, h / source.height)
  const dw = source.width * scale
  const dh = source.height * scale
  pipCtx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh)
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
    x: Math.sin(t * 18) * 0.9,
    y: Math.cos(t * 21) * 1.05,
    z: Math.sin(t * 9) * 0.35,
  }
  if (motion.state.hasSensor) motion.perturb(dt, accel, gyro)
  else motion.ingestSimulated(dt, accel, gyro)
}

function applyPointer(dt: number): void {
  if (!locked || performance.now() < demoShakeUntil) return
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

function refreshChrome(): void {
  reticle.classList.toggle('locked', locked)
  reticle.classList.toggle('lost', locked && lastTrack.lost)
  reticleLabel.textContent = !locked
    ? 'Aim here'
    : lastTrack.lost
      ? 'Subject lost'
      : 'Locked'
  lockBtn.textContent = locked ? 'Unlock' : 'Lock subject'
  lockBtn.classList.toggle('danger', locked)
  shakeBtn.hidden = !locked
  nudgeBtn.hidden = !locked || camera.ready
  pipWrap.hidden = !locked
  setStep(locked ? 3 : 2)

  if (!locked) {
    coachEl.textContent =
      'Put the reticle on a subject, then tap Lock. After that, move the camera — the main view should freeze.'
    statusEl.textContent = camera.ready
      ? 'Live camera. Lock is visual + IMU: it pins whatever is under the reticle.'
      : 'No camera here, so this is a test scene. Lock, then Shake camera or Move subject.'
    return
  }
  if (lastTrack.lost) {
    coachEl.textContent =
      'Tracking lost. Unlock, aim again, and lock on a high-contrast subject.'
  } else if (lastTrack.clamped) {
    coachEl.textContent =
      'At the crop limit. Move back toward the lock pose — big pans will hit the edge of the zoomed frame.'
  } else {
    coachEl.textContent =
      'Locked. Move the phone, or Move subject. Main view holds; Live inset still shakes.'
  }
  const pct = Math.round(lastTrack.score * 100)
  statusEl.textContent = `Tracking ${pct}% · inverse matrix on pixels`
}

function lockSubject(): void {
  resize()
  paintSource(performance.now() / 1000)
  motion.reset()
  motion.mode = 'lock'
  pointerGyro = { x: 0, y: 0, z: 0 }
  tracker.lock(source, source.width, source.height, source.width / 2, source.height / 2)
  locked = true
  lastTrack = {
    foundX: source.width / 2,
    foundY: source.height / 2,
    score: 1,
    lost: false,
    clamped: false,
  }
  refreshChrome()
}

function unlockSubject(): void {
  locked = false
  tracker.unlock()
  motion.reset()
  motion.mode = 'shake'
  pointerGyro = { x: 0, y: 0, z: 0 }
  demoShakeUntil = 0
  subjectMoveStart = 0
  subjectMoveEnd = 0
  refreshChrome()
}

function frame(rawNow: number): void {
  const now = rawNow / 1000
  const dt = Math.min(0.05, Math.max(0.001, now - lastFrame))
  lastFrame = now
  resize()
  motion.mode = locked ? 'lock' : 'shake'

  applyDemoShake(dt, now)
  applyPointer(dt)
  paintSource(now)

  const width = stage.width
  const height = stage.height
  let mat = cropOnly(width, height)

  if (locked) {
    const track = tracker.update(source, width, height)
    const view = lockViewMatrix(
      width,
      height,
      track.foundX,
      track.foundY,
      motion.state.yaw,
    )
    mat = view.matrix
    lastTrack = { ...track, clamped: view.clamped }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#07080c'
  ctx.fillRect(0, 0, width, height)
  mat.applyTo(ctx)
  ctx.drawImage(source, 0, 0, width, height)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (locked) paintPip()

  hudTick += dt
  if (hudTick >= 1 / 12) {
    hudTick = 0
    refreshChrome()
  }

  if (running) requestAnimationFrame(frame)
}

async function start(): Promise<void> {
  gateError.hidden = true
  const startBtn = app.querySelector<HTMLButtonElement>('#start')!
  startBtn.disabled = true
  startBtn.textContent = 'Requesting…'

  try {
    await Promise.all([motion.requestPermission(), camera.start()])
  } catch {
    if (camera.status === 'pending' || camera.status === 'idle') {
      await camera.start()
    }
  }
  motion.start()
  motion.mode = 'shake'

  running = true
  gate.hidden = true
  hud.hidden = false
  requestAnimationFrame(frame)

  if (camera.status === 'live') {
    sourcePill.textContent = 'Camera'
    sourcePill.classList.add('live')
  } else {
    sourcePill.textContent = 'Test scene'
    sourcePill.classList.add('fallback')
  }
  refreshChrome()
}

app.querySelector('#start')!.addEventListener('click', () => {
  void start()
})

lockBtn.addEventListener('click', () => {
  if (locked) unlockSubject()
  else lockSubject()
})

shakeBtn.addEventListener('click', () => {
  demoShakeUntil = performance.now() + 3200
})

nudgeBtn.addEventListener('click', () => {
  const now = performance.now() / 1000
  subjectMoveStart = now
  subjectMoveEnd = now + 3.2
})

stage.addEventListener('pointerdown', (event) => {
  if (!locked) return
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
