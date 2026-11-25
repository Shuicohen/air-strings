"""Camera-mode screenshot with the fake stream + mean luminance of the video region.
Usage: python3 brightness.py <url> <out.png>"""
import sys, time, json, subprocess
from playwright.sync_api import sync_playwright
url, out = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
    page = b.new_page(viewport={"width": 1280, "height": 720})
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera")
    page.wait_for_function("document.body.classList.contains('camera-on') && /×/.test(document.getElementById('status').textContent)", timeout=60000)
    time.sleep(1.5)
    m = page.mouse  # draw two strings with the mouse so readability is visible
    for a, c in (((260, 260), (1000, 300)), ((300, 520), (980, 470))):
        m.move(*a); m.down(); m.move(*c, steps=12); m.up(); time.sleep(0.3)
    m.move(640, 200); m.move(640, 600, steps=3); time.sleep(0.12)
    page.screenshot(path=out)
    # luminance of the video drawn on the canvas: compare canvas pixels to the raw video frame in a region without strings
    stats = page.evaluate("""() => {
      const c = document.getElementById('stage'), v = document.getElementById('video');
      const g = c.getContext('2d'); const dpr = c.width / c.clientWidth;
      const R = { x: 40, y: 600, w: 300, h: 80 };  // lower-left, away from strings and UI
      const d = g.getImageData(R.x * dpr, R.y * dpr, R.w * dpr, R.h * dpr).data;
      let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2];
      const canvasLum = s / (d.length / 4);
      // raw video frame, same mirrored/cover mapping, same region
      const o = document.createElement('canvas'); o.width = c.width; o.height = c.height;
      const og = o.getContext('2d');
      const vw = v.videoWidth, vh = v.videoHeight, W = c.clientWidth, H = c.clientHeight;
      const sc = Math.max(W / vw, H / vh), dw = vw * sc, dh = vh * sc, ox = (W - dw) / 2, oy = (H - dh) / 2;
      og.setTransform(-dpr, 0, 0, dpr, W * dpr, 0); og.drawImage(v, W - ox - dw, oy, dw, dh);
      const e = og.getImageData(R.x * dpr, R.y * dpr, R.w * dpr, R.h * dpr).data;
      let t = 0; for (let i = 0; i < e.length; i += 4) t += 0.2126 * e[i] + 0.7152 * e[i+1] + 0.0722 * e[i+2];
      return { region: R, canvas_luma: +canvasLum.toFixed(1), raw_video_luma: +(t / (e.length / 4)).toFixed(1) };
    }""")
    stats["ratio"] = round(stats["canvas_luma"] / max(stats["raw_video_luma"], 0.01), 3)
    print(json.dumps(stats))
    b.close()
