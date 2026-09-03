export type CameraStatus = 'idle' | 'pending' | 'live' | 'denied' | 'missing'

export class CameraFeed {
  readonly video = document.createElement('video')
  facing: 'user' | 'environment' = 'user'
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: this.facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })
      this.video.srcObject = this.stream
      await this.video.play()
      this.status = 'live'
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
    this.stop()
    await this.start()
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.video.srcObject = null
    this.status = 'idle'
  }
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
