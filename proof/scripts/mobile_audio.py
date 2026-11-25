"""Audio unlock + engine checks in WebKit (iPhone emulation) and Chromium.
Usage: python3 mobile_audio.py <url> <outdir>"""
import json, sys, time
from playwright.sync_api import sync_playwright

url, out = sys.argv[1].rstrip('/') + '/', sys.argv[2]
report = {}

def attach(page, sink):
    page.on("console", lambda m: sink.append({"type": m.type, "text": m.text}))
    page.on("pageerror", lambda e: sink.append({"type": "pageerror", "text": str(e)}))
    page.on("requestfailed", lambda r: sink.append({"type": "requestfailed", "text": f"{r.url} {r.failure}"}))

def run(name, browser, ctx_kwargs, query, shot_prefix):
    ctx = browser.new_context(**ctx_kwargs)
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url + query, wait_until="networkidle")
    vw = page.viewport_size["width"]; vh = page.viewport_size["height"]
    r = {"before_tap": page.evaluate("airStrings.audio()"), "sound_button_visible_before": page.is_visible("#btn-sound")}
    page.screenshot(path=f"{out}/{shot_prefix}-1-before-tap.png")
    if ctx_kwargs.get("has_touch"): page.tap("#btn-sound")
    else: page.click("#btn-sound")
    page.wait_for_function("airStrings.audio().state === 'running' && airStrings.audio().engine", timeout=15000)
    time.sleep(0.3)
    r["after_tap"] = page.evaluate("airStrings.audio()")
    r["sound_button_visible_after"] = page.is_visible("#btn-sound")
    r["engine_label"] = page.text_content("#audio-engine")
    # draw two strings with the mouse, wait for silence, then pluck by sweeping
    m = page.mouse
    for a, c in (((vw * 0.15, vh * 0.35), (vw * 0.85, vh * 0.4)), ((vw * 0.15, vh * 0.6), (vw * 0.85, vh * 0.55))):
        m.move(*a); m.down(); m.move(*c, steps=10); m.up(); time.sleep(0.2)
    t0 = time.time()
    while page.evaluate("airStrings.audio().rms") > 0.0005 and time.time() - t0 < 8: time.sleep(0.2)
    r["silence_rms"] = round(page.evaluate("airStrings.audio().rms"), 5)
    m.move(vw * 0.5, vh * 0.2); m.move(vw * 0.5, vh * 0.75, steps=3)
    peak = 0
    for _ in range(12):
        time.sleep(0.03); peak = max(peak, page.evaluate("airStrings.audio().rms"))
    r["pluck_peak_rms"] = round(peak, 5)
    r["strings"] = page.evaluate("airStrings.count")
    page.screenshot(path=f"{out}/{shot_prefix}-2-plucked.png")
    # simulate iOS suspending the context: button must come back, a tap must resume
    page.evaluate("airStrings.suspendAudio()")
    page.wait_for_function("airStrings.audio().state === 'suspended'", timeout=5000); time.sleep(1.2)
    r["after_suspend"] = {"state": page.evaluate("airStrings.audio().state"), "sound_button_visible": page.is_visible("#btn-sound")}
    page.screenshot(path=f"{out}/{shot_prefix}-3-suspended.png")
    if ctx_kwargs.get("has_touch"): page.tap("#stage", position={"x": vw * 0.5, "y": vh * 0.78})
    else: page.click("#stage", position={"x": vw * 0.5, "y": vh * 0.78})
    page.wait_for_function("airStrings.audio().state === 'running'", timeout=5000); time.sleep(1.2)
    r["after_tap_anywhere"] = {"state": page.evaluate("airStrings.audio().state"), "sound_button_visible": page.is_visible("#btn-sound")}
    r["errors"] = [l for l in logs if l["type"] in ("error", "pageerror", "requestfailed")]
    r["info"] = [l["text"][:200] for l in logs if l["type"] in ("info", "warning")]
    report[name] = r
    ctx.close()

with sync_playwright() as p:
    iphone = p.devices["iPhone 15"]
    wk = p.webkit.launch()
    run("webkit_iphone15_worklet", wk, dict(**iphone), "", "webkit-iphone")
    run("webkit_iphone15_fallback", wk, dict(**iphone), "?audio=fallback", "webkit-iphone-fallback")
    wk.close()
    cr = p.chromium.launch()
    run("chromium_desktop_worklet", cr, dict(viewport={"width": 1440, "height": 900}), "", "chromium-desktop")
    run("chromium_desktop_fallback", cr, dict(viewport={"width": 1440, "height": 900}), "?audio=fallback", "chromium-desktop-fallback")
    pix = p.devices["Pixel 7"]
    run("chromium_pixel7_worklet", cr, dict(**pix), "", "chromium-pixel7")
    cr.close()

json.dump(report, open(f"{out}/mobile-audio.json", "w"), indent=1)
for k, v in report.items():
    print(k, json.dumps({kk: vv for kk, vv in v.items()}, indent=1))
