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

## Camera hardening (commit c9b9586, re-tested on the live URL)
Script: `scripts/camera_failures.py`. Outputs go to `proof/camera-hardening/` (git-ignored).
| Scenario | Result |
|---|---|
| Permission denied (`--use-fake-ui-for-media-stream=deny`) | Panel shows step `camera` and `NotAllowedError: Permission denied`. **Use mouse** closes it and drawing works. **Retry** while still denied shows the panel again. |
| Denied once, then allowed, then **Retry** | Camera on: `GPU · 1280×720` |
| First getUserMedia throws OverconstrainedError | Falls back to `{video:true}` and the camera turns on: `GPU · 640×480` |
| Both attempts fail (Overconstrained, then NotReadable) | Panel shows `NotReadableError…`, plus `First attempt: OverconstrainedError…` |
| GPU delegate forced to fail (`?gpu=fail`) | Falls back to CPU tracking: `CPU · 1280×720` |
| jsDelivr blocked | Panel shows step `tracker load` and `TypeError: Failed to fetch dynamically imported module…` |
The normal fake-camera flow still shows 0 console errors, 0 page errors and 0 failed requests. The only failed request was in the deliberately blocked-CDN scenario.

## Camera picker + two-hand move rule (commits bcdb0a1 and bff5ebe, live)
Scripts: `scripts/camera_devices.py` (outputs in `proof/camera-devices/`, git-ignored). Unit tests: `npm test`.
| Scenario (live URL) | Result |
|---|---|
| Normal fake camera | Status `fake_device_0 · GPU · 1280×720`; dropdown lists `fake_device_0`; 0 console errors, 0 page errors, 0 failed requests; Mouse mode afterwards draws and plucks |
| IR + Busy + Good stub | Calls: default → Busy Cam @1280 → Busy Cam @640 → Good Cam @1280 (IR never tried); status `Good Cam · GPU · 640×480` |
| Reload | First call is `Good Cam @1280` (remembered) |
| Dropdown → Busy | Fails at both resolutions; panel lists them; the remembered camera stays Good Cam |
| Panel dropdown → Good | Camera back on, Good Cam |
| Two working cams, dropdown → Second Cam | Status `Second Cam · …`, remembered = second |
| All fail | Panel lists Default, Busy, Good, IR with each error, plus the "Another app or browser tab…" hint |
| Earlier scenarios (denied, retry, Overconstrained, GPU→CPU, CDN blocked) | All still pass; the only failed request is in the deliberately blocked-CDN test |
Gesture unit tests (8/8 pass): a one-hand pinch on an end leaves the string unchanged; one hand on an end plus the other hand in empty air does nothing; a swipe near an end plucks and does not move it; a fast swipe with a brief pinch near an end only plucks; a two-hand pinch on both ends moves the string and raises its pitch; a two-hand pinch in empty air creates a string; pinch the middle and fling deletes; a mouse drag on one end still stretches. Mutation check: putting back single-hand grabbing fails 3 tests; removing the pinch debounce fails 4.

## Clean camera feed + iOS audio unlock (commit 54b620f, live)
Scripts: `scripts/brightness.py`, `scripts/mobile_audio.py`. Outputs go to `proof/mobile-audio/` (git-ignored).
- Video region brightness (Chromium, fake stream, lower-left 300×80 px; canvas vs raw video frame): before 42.0 vs 100.8 (0.42×), after 102.3 vs 102.3 (1.00×).
- Audio (tap on "Tap for sound", draw 2 strings, sweep):

| Browser | Engine | State after tap | Silence → pluck peak RMS | Suspend → button / tap → running |
|---|---|---|---|---|
| WebKit 27.2, iPhone 15 emulation | worklet | running (44.1 kHz) | 0.00044 → 0.076 | yes / yes |
| WebKit, iPhone 15, `?audio=fallback` | fallback | running | 0.00046 → 0.098 | yes / yes |
| Chromium desktop | worklet | running (48 kHz) | 0.00033 → 0.136 | yes / yes |
| Chromium desktop, `?audio=fallback` | fallback | running | 0.00038 → 0.150 | yes / yes |
| Chromium, Pixel 7 emulation | worklet | running | 0.00036 → 0.137 | yes / yes |

Console errors in all runs: 0. Desktop fake-camera flow + controls (`check.py`): 0 errors, 0 page errors, 0 failed requests, all 7 controls pass. `npm test`: 8/8.
Real iPhone audio output can't be verified on this machine. WebKit here is the Linux build with iPhone emulation, not iOS.
