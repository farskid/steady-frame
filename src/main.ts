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
    <p class="eyebrow">Subject pin</p>
    <h1>Hard-lock a subject like extreme IS</h1>
    <ol class="howto">
      <li>Canon IS II cancels <em>camera</em> shake. This pins the <em>subject</em> — your head stays in the reticle while you or the phone move.</li>
      <li>Use the front camera, put your face on the reticle, tap <strong>Lock</strong>.</li>
      <li>Whip your head around. The main view should keep you glued. The Live inset is the unstabilized truth. If you leave the lens, the pin cannot invent pixels.</li>
    </ol>
    <p class="hint">
      Phone: allow camera + motion. Front camera is default. Desktop: Lock, then Whip subject.
    </p>
    <button type="button" class="primary" id="start">Enable camera</button>
    <p class="error" id="gate-error" hidden></p>
  </section>

  <section class="panel hud" id="hud" hidden>
    <p class="coach" id="coach"></p>
    <div class="actions">
      <button type="button" class="primary" id="lock-btn">Lock</button>
      <button type="button" id="shake-btn" hidden>Shake camera</button>
      <button type="button" id="nudge-btn" hidden>Whip subject</button>
      <button type="button" id="flip-btn" hidden>Flip camera</button>
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
const flipBtn = app.querySelector<HTMLButtonElement>('#flip-btn')!

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
let lastTrack = {
  foundX: 0,
  foundY: 0,
  foundSize: 0,
  score: 1,
  lost: false,
  clamped: false,
  visual: true,
  via: 'patch' as 'face' | 'patch' | 'color',
}

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
    x: Math.sin(t * 5.4) * source.width * 0.32 * env,
    y: Math.sin(t * 4.1) * source.height * 0.22 * env,
  }
}

function paintSource(time: number): void {
  const width = source.width
  const height = source.height
  sourceCtx.setTransform(1, 0, 0, 1, 0, 0)
  sourceCtx.fillStyle = '#07080c'
  sourceCtx.fillRect(0, 0, width, height)
  if (camera.ready) {
    if (camera.facing === 'user') {
      sourceCtx.translate(width, 0)
      sourceCtx.scale(-1, 1)
    }
    drawCover(
      sourceCtx,
      camera.video,
      camera.video.videoWidth,
      camera.video.videoHeight,
      width,
      height,
    )
    sourceCtx.setTransform(1, 0, 0, 1, 0, 0)
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
  lockBtn.textContent = locked ? 'Unlock' : 'Lock'
  lockBtn.classList.toggle('danger', locked)
  shakeBtn.hidden = !locked
  nudgeBtn.hidden = !locked || camera.ready
  flipBtn.hidden = camera.status !== 'live'
  pipWrap.hidden = !locked
  setStep(locked ? 3 : 2)

  if (!locked) {
    coachEl.textContent =
      'Front camera on. Put your face on the reticle, tap Lock, then move your head. It should stay glued.'
    statusEl.textContent = camera.ready
      ? 'Hard pin: the patch (or face) under the reticle is translated back to center every frame.'
      : 'No camera — test scene. Lock, then Whip subject. The bullseye should stay on the reticle.'
    return
  }
  if (lastTrack.clamped) {
    coachEl.textContent =
      'Pinned at the lens edge — black around the reticle is FOV, not a failed lock. Step back into frame.'
  } else if (lastTrack.lost) {
    coachEl.textContent =
      'Lost the texture. Unlock and lock again on your face.'
  } else {
    coachEl.textContent =
      'Pinned to the reticle. Move your head. You should not be able to walk off-center until you leave the camera.'
  }
  const how = lastTrack.via
  statusEl.textContent = `${how} ${Math.round(lastTrack.score * 100)}% · pin is unclamped`
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
    foundSize: tracker.lockSize,
    score: 1,
    lost: false,
    clamped: false,
    visual: true,
    via: 'patch',
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
    const sizeScale =
      track.via === 'face' && track.foundSize > 1
        ? tracker.lockSize / track.foundSize
        : 1
    const view = lockViewMatrix(
      width,
      height,
      track.foundX,
      track.foundY,
      0,
      sizeScale,
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
  subjectMoveEnd = now + 4
})

flipBtn.addEventListener('click', () => {
  void camera.flip().then(() => {
    if (locked) unlockSubject()
    refreshChrome()
  })
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
