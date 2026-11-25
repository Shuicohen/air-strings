"""Live-site checks for Air Strings: console during camera flow (fake media stream),
audio signal after a pluck, click-test of every control, screenshots at 1440 and 390.
Usage: python3 check.py <url> <outdir>"""
import json, sys, time
from playwright.sync_api import sync_playwright

url, out = sys.argv[1], sys.argv[2]
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
report = {"url": url}

def attach(page, sink):
    page.on("console", lambda m: sink.append({"type": m.type, "text": m.text}))
    page.on("pageerror", lambda e: sink.append({"type": "pageerror", "text": str(e)}))
    page.on("requestfailed", lambda r: sink.append({"type": "requestfailed", "text": f"{r.url} {r.failure}"}))

with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)

    # 1) camera flow with fake stream
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, permissions=["camera"])
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera")
    t0 = time.time(); status_seen = []
    while time.time() - t0 < 45:
        st = page.evaluate("document.getElementById('status').textContent")
        if st and (not status_seen or status_seen[-1] != st): status_seen.append(st)
        if "hand" in (st or "").lower() and "loading" not in (st or "").lower():
            break
        time.sleep(0.25)
    time.sleep(4)  # let the tracker run on several frames
    report["camera"] = {
        "camera_on": page.evaluate("document.body.classList.contains('camera-on')"),
        "camera_pressed": page.get_attribute("#btn-camera", "aria-pressed"),
        "status_sequence": status_seen,
        "video": page.evaluate("({w: video.videoWidth, h: video.videoHeight, t: video.currentTime})"),
        "toast": page.text_content("#toast"),
    }
    page.screenshot(path=f"{out}/camera-fake-stream-1440.png")
    report["camera_console"] = logs[:]
    ctx.close()

    # 2) audio + controls at 1440
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.screenshot(path=f"{out}/empty-1440.png")
    m = page.mouse
    m.move(420, 300); m.down(); m.move(1000, 360, steps=12); m.up()
    time.sleep(0.6)
    m.move(380, 640); m.down(); m.move(1100, 560, steps=12); m.up()
    m.move(700, 160); m.down(); m.move(760, 780, steps=12); m.up()
    time.sleep(1.5)
    quiet = page.evaluate("airStrings.audio()")
    m.move(700, 200); m.move(700, 500, steps=4)  # sweep across string 1
    rms = []
    for _ in range(8):
        time.sleep(0.05); rms.append(page.evaluate("airStrings.audio().rms"))
    report["audio"] = {"before_sweep": quiet, "after_sweep_rms": rms, "strings": page.evaluate("airStrings.strings()")}
    time.sleep(0.15)
    page.screenshot(path=f"{out}/strings-1440.png")

    ctrl = []
    def rec(name, action, check):
        try:
            action(); time.sleep(0.4); ctrl.append({"control": name, "result": check()})
        except Exception as e:
            ctrl.append({"control": name, "result": f"ERROR {e}"})
    rec("Pentatonic toggle (off)", lambda: page.click("#btn-snap"),
        lambda: f"aria-pressed={page.get_attribute('#btn-snap','aria-pressed')}, label='{page.text_content('#btn-snap').strip()}', airStrings.snap={page.evaluate('airStrings.snap')}")
    rec("Pentatonic toggle (on)", lambda: page.click("#btn-snap"),
        lambda: f"aria-pressed={page.get_attribute('#btn-snap','aria-pressed')}, label='{page.text_content('#btn-snap').strip()}', airStrings.snap={page.evaluate('airStrings.snap')}")
    rec("? help (open)", lambda: page.click("#btn-help"),
        lambda: f"help visible={page.is_visible('#help')}, aria-expanded={page.get_attribute('#btn-help','aria-expanded')}")
    page.screenshot(path=f"{out}/help-1440.png")
    rec("× close help", lambda: page.click("#btn-help-close"), lambda: f"help visible={page.is_visible('#help')}")
    def cam_check():
        page.wait_for_function("airStrings.mode === 'camera' || document.getElementById('toast').textContent.startsWith('Camera')", timeout=45000)
        return f"mode={page.evaluate('airStrings.mode')}, aria-pressed={page.get_attribute('#btn-camera','aria-pressed')}, toast='{page.text_content('#toast')}'"
    rec("Camera (fake media stream)", lambda: page.click("#btn-camera"), cam_check)
    rec("Mouse", lambda: page.click("#btn-mouse"), lambda: f"mode={page.evaluate('airStrings.mode')}, aria-pressed={page.get_attribute('#btn-mouse','aria-pressed')}")
    rec("Clear", lambda: page.click("#btn-clear"), lambda: (time.sleep(0.6), f"strings={page.evaluate('airStrings.count')}, hint visible={page.is_visible('#hint')}")[1])
    report["controls"] = ctrl
    report["controls_console"] = logs[:]
    ctx.close()

    # 3) mobile 390
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.screenshot(path=f"{out}/empty-390.png")
    m = page.mouse
    for (a, c) in [((60, 260), (330, 330)), ((50, 480), (340, 430)), ((120, 600), (300, 760))]:
        m.move(*a); m.down(); m.move(*c, steps=10); m.up(); time.sleep(0.3)
    m.move(190, 200); m.move(190, 800, steps=6); time.sleep(0.12)
    page.screenshot(path=f"{out}/strings-390.png")
    page.click("#btn-help"); time.sleep(0.3)
    page.screenshot(path=f"{out}/help-390.png")
    report["mobile_console"] = logs[:]
    ctx.close()

    b.close()

json.dump(report, open(f"{out}/check-report.json", "w"), indent=2)
print(json.dumps(report, indent=2))
