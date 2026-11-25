# Proof: Air Strings live-site checks (2026-11-25, Asia/Jerusalem)

Live URL tested: https://shuicohen.github.io/air-strings/ (GitHub Pages, code commit 30015c9).
Browser: Playwright 1.65.2, Chromium headless shell 159. Media files and JSON outputs sit next to this file on the build box (git-ignored); the scripts live in `proof/scripts/`.

## 1. Camera permission flow (fake media stream)
`scripts/check.py`, Chromium flags `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.
- Clicked **Camera**. Status went `Asking for camera…` → `Loading hand tracker…` → `Show your hands to the camera`; `body.camera-on` = true; video 1280×720 playing; toast `Camera on: frames stay on this device`.
- Console **errors: 0**, page errors: 0, failed requests: 0.
- Warnings, verbatim, all from MediaPipe's WASM/WebGL internals (none from app code):
  - `W… gl_context.cc:1136] OpenGL error checking is disabled`
  - `W… landmark_projection_calculator.cc:81] Using NORM_RECT without IMAGE_DIMENSIONS is only supported for the square ROI. Provide IMAGE_DIMENSIONS or use PROJECTION_MATRIX.`
  - `[.WebGL-…]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels` (×4, then "will no longer repeat"; headless software GL)
- The fake device shows Chrome's green test pattern, which has no hands, so pinch, pluck and stretch by hand are **not** exercised here.

## 2. Audio (in-page check)
`scripts/audio_check.py` reads `airStrings.audio()`, the RMS of an AnalyserNode placed after the compressor, just before `destination`.
- AudioContext `running`, 48000 Hz.
- RMS from the pluck when the string is created: 0.00983. After the ring-out it drops to a silence baseline of 0.00020.
- Peak RMS after a slow mouse sweep: **0.0246**. After a fast sweep: **0.0832**. So faster sweeps really are louder.
- Console errors: 0.

## 3. Recording (mouse fallback)
`scripts/record.py` writes `proof/recording.mp4` (1280×720 H.264, about 59 s). The caption bar in the video is injected by the script and is not part of the site.
- Draws 4 strings, then plucks them by sweeping, with sparks visible.
- Stretch: string 1 goes from C3 (130.81 Hz, 681 px) to **A4 (440 Hz, 204 px)** while dragging its end, then back to D3. The label shows note and Hz live.
- With snap off, string 2 glides continuously while dragging: 137.04 → 153.04 → 173.27 → 199.65 → 235.51 → 287.03 Hz.
- Right-click deletes one string (4 → 3). **C** clears everything (3 → 0).
- Console warnings/errors during the recording: none.

## 4. Control click test (1440×900)
| Control | Result |
|---|---|
| Pentatonic toggle → off | aria-pressed=false, label "off", `snap=false` |
| Pentatonic toggle → on | aria-pressed=true, label "on", `snap=true` |
| ? (help) | panel visible, aria-expanded=true |
| × (close help) | panel hidden |
| Camera | mode=camera, aria-pressed=true, toast "Camera on: frames stay on this device" |
| Mouse | mode=mouse, aria-pressed=true, camera stopped |
| Clear | strings=0, empty-state hint shown |

## 5. Screenshots
`empty-1440.png`, `strings-1440.png`, `help-1440.png`, `camera-fake-stream-1440.png`, `empty-390.png`, `strings-390.png`, `help-390.png`. The mobile (390 px) run logged no console messages.
