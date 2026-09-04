export type CameraStatus = 'idle' | 'pending' | 'live' | 'denied' | 'missing'

export type CameraOption = { deviceId: string; label: string; facing: 'user' | 'environment' | 'unknown' }

export class CameraFeed {
  readonly video = document.createElement('video')
  facing: 'user' | 'environment' = 'user'
  deviceId: string | null = null
  options: CameraOption[] = []
  status: CameraStatus = 'idle'
  error = ''
  private stream: MediaStream | null = null

  constructor() {
    this.video.setAttribute('playsinline', 'true')
    this.video.setAttribute('webkit-playsinline', 'true')
    this.video.muted = true
    this.video.autoplay = true
    this.video.playsInline = true
  }

  get ready(): boolean {
    return this.status === 'live' && this.video.readyState >= 2 && this.video.videoWidth > 0
  }

  async start(): Promise<void> {
    this.status = 'pending'
    this.error = ''
    try {
      const video: MediaTrackConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        // 60 fps halves per-frame displacement, which is what KLT range is about.
        frameRate: { ideal: 60 },
      }
      if (this.deviceId) video.deviceId = { exact: this.deviceId }
      else video.facingMode = { ideal: this.facing }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video })
      this.video.srcObject = this.stream
      await this.video.play()
      this.status = 'live'
      this.syncFacingFromTrack()
      await this.refreshOptions()
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        this.status = 'denied'
        this.error = 'Camera permission was blocked.'
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        this.status = 'missing'
        this.error = 'No camera found. Using the test scene.'
      } else {
        this.status = 'missing'
        this.error = err instanceof Error ? err.message : 'Camera unavailable.'
      }
    }
  }

  async flip(): Promise<void> {
    this.facing = this.facing === 'user' ? 'environment' : 'user'
    this.deviceId = null
    this.stop()
    await this.start()
  }

  async select(deviceId: string): Promise<void> {
    this.deviceId = deviceId
    const opt = this.options.find((o) => o.deviceId === deviceId)
    if (opt && opt.facing !== 'unknown') this.facing = opt.facing
    this.stop()
    await this.start()
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.video.srcObject = null
    this.status = 'idle'
  }

  private syncFacingFromTrack(): void {
    const track = this.stream?.getVideoTracks()[0]
    const settings = track?.getSettings()
    if (settings?.facingMode === 'user' || settings?.facingMode === 'environment') {
      this.facing = settings.facingMode
    }
    if (settings?.deviceId) this.deviceId = settings.deviceId
  }

  /** Labels are only populated after permission, so call this post-start. */
  private async refreshOptions(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      this.options = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
          facing: guessFacing(d.label),
        }))
    } catch {
      this.options = []
    }
  }
}

function guessFacing(label: string): CameraOption['facing'] {
  const l = label.toLowerCase()
  if (/front|user|selfie|facetime/.test(l)) return 'user'
  if (/back|rear|environment|world/.test(l)) return 'environment'
  return 'unknown'
}

export function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
): void {
  if (sourceWidth <= 0 || sourceHeight <= 0) return
  const scale = Math.max(destWidth / sourceWidth, destHeight / sourceHeight)
  const dw = sourceWidth * scale
  const dh = sourceHeight * scale
  const dx = (destWidth - dw) / 2
  const dy = (destHeight - dh) / 2
  ctx.drawImage(source, dx, dy, dw, dh)
}
