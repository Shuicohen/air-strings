"""Simulated camera/tracker failures for Air Strings. Usage: python3 camera_failures.py <url> <outdir>"""
import json, sys, time
from playwright.sync_api import sync_playwright

url, out = sys.argv[1].rstrip('/') + '/', sys.argv[2]
report = {}

def attach(page, sink):
    page.on("console", lambda m: sink.append({"type": m.type, "text": m.text}))
    page.on("pageerror", lambda e: sink.append({"type": "pageerror", "text": str(e)}))
    page.on("requestfailed", lambda r: sink.append({"type": "requestfailed", "text": f"{r.url} {r.failure}"}))

def panel(page):
    if not page.is_visible("#cam-error"):
        return {"visible": False}
    return {"visible": True, "step": page.text_content("#cam-error-step"), "message": page.text_content("#cam-error-msg"),
            "extra": page.text_content("#cam-error-extra") if page.is_visible("#cam-error-extra") else "",
            "hint": page.text_content("#cam-error-hint")}

def wait_settled(page, timeout=60):
    page.wait_for_function("document.body.classList.contains('camera-on') || !document.getElementById('cam-error').hidden", timeout=timeout * 1000)
    time.sleep(2.5)

def state(page):
    return {"mode": page.evaluate("airStrings.mode"), "camera": page.evaluate("airStrings.camera"), "status": page.text_content("#status"), "panel": panel(page)}

FAKE_DEV = "--use-fake-device-for-media-stream"
FAKE_UI = "--use-fake-ui-for-media-stream"

with sync_playwright() as p:
    # A) permission denied (Chrome's fake UI set to deny), "Use mouse", then Retry (still denied)
    b = p.chromium.launch(args=[FAKE_DEV, FAKE_UI + "=deny"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); wait_settled(page)
    r = {"after_click": state(page)}
    page.screenshot(path=f"{out}/err-permission-denied.png")
    page.click("#btn-use-mouse"); time.sleep(0.4)
    m = page.mouse; m.move(400, 400); m.down(); m.move(1000, 420, steps=10); m.up(); time.sleep(0.3)
    r["after_use_mouse"] = {"panel_visible": page.is_visible("#cam-error"), "mode": page.evaluate("airStrings.mode"), "strings": page.evaluate("airStrings.count")}
    page.click("#btn-camera"); wait_settled(page)
    page.click("#btn-retry"); time.sleep(0.3); wait_settled(page)
    r["after_retry_still_denied"] = state(page)
    r["console"] = logs; report["A_permission_denied"] = r
    ctx.close(); b.close()

    # A2) denied once, user allows in site settings, Retry succeeds (first call stubbed to NotAllowedError)
    b = p.chromium.launch(args=[FAKE_DEV, FAKE_UI])
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script("""(() => { const md = navigator.mediaDevices, real = md.getUserMedia.bind(md); let n = 0;
      md.getUserMedia = (c) => (++n === 1 ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : real(c)); })();""")
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); wait_settled(page)
    r = {"after_click": state(page)}
    page.click("#btn-retry"); time.sleep(0.3); wait_settled(page)
    r["after_retry"] = state(page)
    page.screenshot(path=f"{out}/retry-after-allow-ok.png")
    r["console"] = logs; report["A2_denied_then_retry_ok"] = r
    ctx.close(); b.close()

    # B) first getUserMedia throws OverconstrainedError, fallback {video:true} succeeds
    b = p.chromium.launch(args=[FAKE_DEV, FAKE_UI])
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script("""(() => {
      const md = navigator.mediaDevices, real = md.getUserMedia.bind(md);
      window.__gumCalls = [];
      md.getUserMedia = (c) => {
        window.__gumCalls.push(JSON.stringify(c));
        if (window.__gumCalls.length === 1) return Promise.reject(new OverconstrainedError('width', 'Stubbed: constraints not satisfiable'));
        return real(c);
      };
    })();""")
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); wait_settled(page)
    r = state(page); r["getUserMedia_calls"] = page.evaluate("window.__gumCalls")
    page.screenshot(path=f"{out}/fallback-overconstrained-ok.png")
    r["console"] = logs; report["B_overconstrained_fallback"] = r
    ctx.close()

    # B2) every getUserMedia call fails -> panel shows both errors
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script("""(() => { let n = 0; navigator.mediaDevices.getUserMedia = () => { n++;
      return Promise.reject(n === 1 ? new OverconstrainedError('width', 'Stubbed: constraints not satisfiable')
        : new DOMException('Stubbed: Could not start video source', 'NotReadableError')); }; })();""")
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); wait_settled(page)
    r = state(page)
    page.screenshot(path=f"{out}/err-camera-busy-after-fallback.png")
    r["console"] = logs; report["B2_both_attempts_fail"] = r
    ctx.close()

    # C) GPU delegate forced to fail -> CPU
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url + "?gpu=fail", wait_until="networkidle")
    page.click("#btn-camera"); wait_settled(page)
    r = state(page)
    page.screenshot(path=f"{out}/fallback-gpu-to-cpu.png")
    r["console"] = logs; report["C_gpu_forced_fail"] = r
    ctx.close(); b.close()

    b = p.chromium.launch(args=[FAKE_DEV, FAKE_UI])
    # D) tracker download blocked -> tracker load panel
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    ctx.route("**/cdn.jsdelivr.net/**", lambda route: route.abort("blockedbyclient"))
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); wait_settled(page)
    r = state(page)
    page.screenshot(path=f"{out}/err-tracker-blocked.png")
    r["console"] = logs; report["D_tracker_cdn_blocked"] = r
    ctx.close(); b.close()

    # E) mobile layout of the panel
    b = p.chromium.launch(args=[FAKE_DEV, FAKE_UI + "=deny"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page(); page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); wait_settled(page)
    page.screenshot(path=f"{out}/err-permission-denied-390.png")
    report["E_mobile_panel"] = panel(page)
    ctx.close(); b.close()

json.dump(report, open(f"{out}/camera-failures.json", "w"), indent=1)
for k, v in report.items():
    vv = {kk: vvv for kk, vvv in v.items() if kk != "console"} if isinstance(v, dict) else v
    errs = [l for l in v.get("console", []) if l["type"] in ("error", "pageerror", "requestfailed")] if isinstance(v, dict) else []
    print(k, json.dumps(vv, indent=1)); print("  console errors/failed:", json.dumps(errs, indent=1))
