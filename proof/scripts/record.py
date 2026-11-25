"""Screen recording of Air Strings in mouse-fallback mode.
Usage: python3 record.py <url> <out.mp4>
A caption bar is injected by this script (not part of the site) to label each step."""
import sys, time, subprocess, os, glob, json, tempfile
from playwright.sync_api import sync_playwright

url, out_mp4 = sys.argv[1], sys.argv[2]
W, H = 1280, 720
tmp = tempfile.mkdtemp()
log = []

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": W, "height": H}, record_video_dir=tmp, record_video_size={"width": W, "height": H})
    page = ctx.new_page()
    page.on("console", lambda m: log.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: log.append(f"pageerror: {e}"))
    page.goto(url, wait_until="networkidle")
    page.evaluate("""() => { const d = document.createElement('div'); d.id = '__cap';
      d.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);font:600 16px system-ui;color:#fff;background:rgba(0,0,0,.55);padding:8px 16px;border-radius:10px;z-index:99;pointer-events:none';
      document.body.appendChild(d); }""")
    cap = lambda t: page.evaluate("t => document.getElementById('__cap').textContent = t", t)
    m = page.mouse
    def drag(a, c, steps=40, hold=0.0):
        m.move(*a, steps=8); m.down(); time.sleep(hold); m.move(*c, steps=steps); m.up()
    def sweep(a, c, steps=5):
        m.move(*a, steps=10); m.move(*c, steps=steps)

    cap("Mouse fallback: click and drag to draw strings"); time.sleep(1.2)
    drag((300, 210), (980, 250)); time.sleep(0.5)
    drag((260, 360), (1020, 340)); time.sleep(0.5)
    drag((380, 500), (880, 520)); time.sleep(0.5)
    drag((560, 120), (600, 640)); time.sleep(0.8)
    cap(f"{page.evaluate('airStrings.count')} strings. Sweep across to pluck (faster = louder)")
    for x in (420, 700, 860):
        sweep((x, 140), (x + 30, 600), steps=4); time.sleep(0.45)
    sweep((200, 560), (1100, 160), steps=6); time.sleep(0.5)
    sweep((450, 600), (470, 150), steps=18); time.sleep(0.8)
    cap("Stretch: drag an end dot. Shorter = higher (pentatonic snap on)")
    sweep((640, 170), (650, 300), steps=3)
    m.move(980, 250, steps=10); m.down()
    before_stretch = page.evaluate("airStrings.strings()[0]")
    for i in range(1, 46):
        m.move(980 - i * 11, 250 + i * 1.0); time.sleep(0.03)
    mid_stretch = page.evaluate("airStrings.strings()[0]")
    for i in range(1, 30):
        m.move(485 + i * 16, 295 - i * 1.2); time.sleep(0.03)
    m.up(); time.sleep(0.3)
    sweep((700, 140), (720, 330), steps=3); time.sleep(0.6)
    retuned = page.evaluate("airStrings.strings()")
    cap("Snap off: free tuning, the pitch bends continuously")
    page.click("#btn-snap"); time.sleep(0.4)
    sweep((360, 300), (380, 420), steps=3)
    m.move(1020, 340, steps=10); m.down()
    free_samples = []
    for i in range(1, 50):
        m.move(1020 - i * 9, 340); time.sleep(0.03)
        if i % 8 == 0: free_samples.append(page.evaluate("airStrings.strings()[1].freq"))
    m.up(); time.sleep(0.4)
    page.click("#btn-snap"); time.sleep(0.3)
    cap("Delete: right-click a string (or X / Delete key)")
    m.move(630, 510, steps=12); time.sleep(0.3)
    m.click(630, 510, button="right"); time.sleep(1.0)
    after_delete = page.evaluate("airStrings.count")
    cap(f"{after_delete} strings left. Pluck them again")
    sweep((300, 150), (1100, 600), steps=8); time.sleep(0.9)
    cap("Press C to clear"); time.sleep(0.8)
    page.keyboard.press("c"); time.sleep(1.2)
    cleared = page.evaluate("airStrings.count")
    cap("Cleared"); time.sleep(1.0)
    video_path = page.video.path()
    ctx.close(); b.close()

subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video_path, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", out_mp4], check=True)
print(json.dumps({"mp4": out_mp4, "string1_before_stretch": before_stretch, "string1_mid_stretch": mid_stretch, "string1_after": retuned[0], "string2_freq_while_dragging_snap_off": free_samples, "after_delete": after_delete, "cleared": cleared, "console_warn_err": log}, indent=1))
