# Steady Frame

Lock a subject in the camera view, then move the phone (or the subject). The main canvas holds still; a small Live inset keeps shaking so you can compare.

## How to use it

1. Tap **Enable camera** (allow camera + motion on iPhone).
2. Put the reticle on a subject. Tap **Lock subject**.
3. Move the camera. The locked view should freeze. **Shake camera** / **Move subject** are for desktop when there is no IMU / no camera.

Unlock to aim again. Large pans hit the 1.42× crop limit — move back toward the lock pose.

Lock is a visual template match on the pixels under the reticle, fused with IMU yaw. Inverse affine transform is applied with `canvas.setTransform`. Nothing is uploaded.

## Run

```bash
npm install
npm run dev
```

Needs HTTPS or `localhost`.
