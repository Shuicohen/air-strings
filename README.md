# Air Strings

Draw glowing strings in the air with your hands, then pluck them.

**Live:** https://shuicohen.github.io/air-strings/

- Pinch thumb and index on **both hands** in empty air, pull apart, let go: a string stays on screen.
- **Swipe a fingertip** through a string to pluck it. Faster swipes are louder. Swipes never move a string.
- **Move or retune** a string by pinching **both of its ends at the same time**, one hand on each end. The string follows both hands and its pitch changes live (shorter is higher). A one-hand pinch on an end does nothing, so strumming can't knock strings around.
- A pinch only counts after it is held briefly with a slow hand, so a fast swipe that closes thumb and index for a moment never grabs anything.
- **Pentatonic snap** is on by default (toggle in the top bar or press `S`).
- Up to 8 strings. **Pinch the middle and fling** to delete one, or press `X`/`Delete`. `C` clears everything.
- **Camera picker:** when the camera is on, a dropdown in the top bar lists every camera. The choice is remembered. If a camera is busy or fails (`NotReadableError`), the app tries the other cameras automatically, leaving IR / Windows Hello cameras for last, and lists every attempt if all of them fail.

No camera? Use the **Mouse** mode: click and drag to draw a string, sweep the cursor across (or drag across from a string) to pluck, drag one end dot to retune (mouse mode keeps one-drag stretching for testing), right-click or double-click a string to delete.

## Privacy

Everything runs in the browser. Hand tracking uses MediaPipe's HandLandmarker (WebAssembly, loaded from jsDelivr, model from Google's storage bucket). Camera frames are never uploaded anywhere.

## How it works

- `src/hands.js`: webcam + MediaPipe Tasks Vision HandLandmarker (2 hands, VIDEO mode, GPU with CPU fallback), pinch detection with hysteresis, mirrored coordinates.
- `src/audio.js`: one Karplus-Strong voice per string in an AudioWorklet with a fractional, gliding delay line so pitch can change while a note rings; light convolution reverb and a compressor.
- `src/gestures.js`: the gesture state machine (pure, no DOM), shared by hands, mouse and touch.
- `src/main.js`: wiring, UI and canvas rendering with glowing strings and pluck sparks.

Tests: `npm test` runs `tests/gestures.test.mjs` (Node's built-in test runner) with synthetic hand-landmark sequences.

No build step: it is a static site. Serve the folder with any static server, for example `python3 -m http.server`, and open `http://localhost:8000` (camera and AudioWorklet need `localhost` or HTTPS).

`proof/` holds the test scripts and evidence used to check the live site.

## License

MIT
