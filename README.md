# Steady Frame

Phone camera demo that cancels motion the same way electronic image stabilization does: read the IMU, integrate speed / acceleration / rotation, invert that pose, and apply the inverse as a matrix transform on the canvas pixels.

## What it does

1. Renders the rear camera into a full-viewport `<canvas>` (or a calibration scene if no camera is available).
2. Listens to `DeviceMotionEvent` for linear acceleration (m/s²) and rotation rate (converted to rad/s).
3. Integrates gyro → orientation and double-integrates acceleration → velocity → position, with a high-pass leak so slow pans are not locked forever.
4. Builds the opposite affine matrix (rotation + translation, plus a 1.38× crop so edges stay covered) and applies it with `CanvasRenderingContext2D.setTransform`.

Modes:

- **Stabilization** — high-pass “shake cancel.” Fast jitter is inverted; intentional aiming leaks back to identity.
- **World lock** — much slower leak, so the frame tries to stay put while you move the phone.
- **Strength** — scales the inverse matrix from 0 to 100%.
- **Raw PIP** — unstabilized view so you can compare.

Desktop: no IMU required. Drag on the canvas to inject gyro, or press **Demo shake**.

## Run locally

Needs a secure context (HTTPS or `localhost`) for camera + motion sensors.

```bash
npm install
npm run dev
```

Open the printed URL on your phone (same Wi-Fi) or on the desktop. Tap **Enable camera & motion**. iOS Safari will ask for Motion & Orientation access — that prompt only appears from a tap.

## Stack

Vite, TypeScript, Canvas 2D. No backend, no uploads.
