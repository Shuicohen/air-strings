# Air Strings

Draw glowing strings in the air with your hands, then pluck them.

**Live:** https://shuicohen.github.io/air-strings/

- Pinch thumb and index on **both hands**, pull apart, let go: a string stays on screen.
- **Swipe a fingertip** through a string to pluck it. Faster swipes are louder.
- **Pinch an end and drag** to stretch it. Shorter strings are higher, and the pitch bends live while the string rings.
- **Pentatonic snap** is on by default (toggle in the top bar or press `S`).
- Up to 8 strings. **Pinch the middle and fling** to delete one, or press `X`/`Delete`. `C` clears everything.

No camera? Use the **Mouse** mode: click and drag to draw a string, sweep the cursor across (or drag across from a string) to pluck, drag an end dot to retune, right-click or double-click a string to delete.

## Privacy

Everything runs in the browser. Hand tracking uses MediaPipe's HandLandmarker (WebAssembly, loaded from jsDelivr, model from Google's storage bucket). Camera frames are never uploaded anywhere.

## How it works

- `src/hands.js`: webcam + MediaPipe Tasks Vision HandLandmarker (2 hands, VIDEO mode, GPU with CPU fallback), pinch detection with hysteresis, mirrored coordinates.
- `src/audio.js`: one Karplus-Strong voice per string in an AudioWorklet with a fractional, gliding delay line so pitch can change while a note rings; light convolution reverb and a compressor.
- `src/main.js`: one gesture model shared by hands, mouse and touch (create / pluck / stretch / delete), canvas rendering with glowing strings and pluck sparks.

No build step: it is a static site. Serve the folder with any static server, for example `python3 -m http.server`, and open `http://localhost:8000` (camera and AudioWorklet need `localhost` or HTTPS).

`proof/` holds the test scripts and evidence used to check the live site.

## License

MIT
