"""In-page audio check: silence baseline -> pluck -> analyser RMS. Usage: python3 audio_check.py <url>"""
import sys, time, json
from playwright.sync_api import sync_playwright
url = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    page = b.new_page(viewport={"width": 1280, "height": 720})
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(url, wait_until="networkidle")
    m = page.mouse
    m.move(300, 360); m.down(); m.move(980, 360, steps=10); m.up()
    page.wait_for_function("airStrings.audio().rms > 0.001", timeout=10000)  # creation pluck is audible
    created_peak = page.evaluate("airStrings.audio().rms")
    t0 = time.time()
    while page.evaluate("airStrings.audio().rms") > 0.0003 and time.time() - t0 < 15: time.sleep(0.2)
    silent = page.evaluate("airStrings.audio()")
    silent["waited_s"] = round(time.time() - t0, 1)
    res = {}
    for label, steps in (("slow_sweep", 30), ("fast_sweep", 2)):
        while page.evaluate("airStrings.audio().rms") > 0.0003: time.sleep(0.2)
        m.move(640, 200)
        m.move(640, 520, steps=steps)
        peak = 0
        for _ in range(10):
            time.sleep(0.03); peak = max(peak, page.evaluate("airStrings.audio().rms"))
        res[label] = round(peak, 5)
    print(json.dumps({"creation_pluck_rms": round(created_peak, 5), "silence_baseline": silent, "peak_rms_after_pluck": res, "strings": page.evaluate("airStrings.strings()"), "console_errors": errs}, indent=1))
    b.close()
