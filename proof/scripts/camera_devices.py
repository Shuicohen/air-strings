"""Camera device selection / fallback checks. Usage: python3 camera_devices.py <url> <outdir>"""
import json, sys, time
from playwright.sync_api import sync_playwright

url, out = sys.argv[1].rstrip('/') + '/', sys.argv[2]
ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
report = {}

def attach(page, sink):
    page.on("console", lambda m: sink.append({"type": m.type, "text": m.text}))
    page.on("pageerror", lambda e: sink.append({"type": "pageerror", "text": str(e)}))
    page.on("requestfailed", lambda r: sink.append({"type": "requestfailed", "text": f"{r.url} {r.failure}"}))

def settled(page, timeout=60):
    page.wait_for_function("(document.body.classList.contains('camera-on') && /×/.test(document.getElementById('status').textContent)) || !document.getElementById('cam-error').hidden", timeout=timeout * 1000)
    time.sleep(1.5)

def panel(page):
    if not page.is_visible("#cam-error"): return {"visible": False}
    return {"visible": True, "step": page.text_content("#cam-error-step"), "message": page.text_content("#cam-error-msg"),
            "attempts": page.eval_on_selector_all("#cam-error-attempts li", "els => els.map(e => e.innerText.replace(/\\n+/g, ' | '))"),
            "hint": page.text_content("#cam-error-hint"),
            "select_options": page.eval_on_selector_all("#cam-error-select option", "els => els.map(e => e.textContent)") if page.is_visible("#cam-error-select") else None}

def state(page):
    return {"mode": page.evaluate("airStrings.mode"), "status": page.text_content("#status"),
            "toolbar_select_visible": page.is_visible("#cam-select"),
            "toolbar_select_options": page.eval_on_selector_all("#cam-select option", "els => els.map(e => e.textContent + (e.selected ? ' [selected]' : ''))"),
            "remembered": page.evaluate("localStorage.getItem('airStrings.camera')"),
            "panel": panel(page)}

def errors(logs): return [l for l in logs if l["type"] in ("error", "pageerror", "requestfailed")]

STUB = """(() => {
  const DEVICES = %s;
  const md = navigator.mediaDevices, real = md.getUserMedia.bind(md);
  window.__gum = [];
  md.enumerateDevices = async () => DEVICES.map(d => ({ kind: 'videoinput', deviceId: d.id, label: d.label, groupId: 'g-' + d.id, toJSON() { return this; } }));
  md.getUserMedia = (c) => {
    const id = c && c.video && c.video.deviceId && c.video.deviceId.exact;
    const w = c && c.video && c.video.width ? (c.video.width.ideal || c.video.width) : 'any';
    const dev = DEVICES.find(d => d.id === id);
    window.__gum.push((dev ? dev.label : (c.video === true ? 'video:true' : 'default(facingMode)')) + ' @' + w);
    if (dev && dev.works) return real({ video: true, audio: false });
    return Promise.reject(new DOMException('Could not start video source', 'NotReadableError'));
  };
})();"""
THREE = json.dumps([{"id": "ir", "label": "Integrated IR Camera", "works": False}, {"id": "busy", "label": "Busy Cam", "works": False}, {"id": "good", "label": "Good Cam", "works": True}])
ALLFAIL = json.dumps([{"id": "ir", "label": "Integrated IR Camera", "works": False}, {"id": "busy", "label": "Busy Cam", "works": False}, {"id": "good", "label": "Good Cam", "works": False}])

with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)

    # 1) normal fake camera
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); settled(page); time.sleep(2)
    r = state(page); r["camera"] = page.evaluate("airStrings.camera")
    page.screenshot(path=f"{out}/1-fake-camera-1440.png")
    r["camera_hint"] = page.text_content("#hint"); r["mini_help_camera"] = page.inner_text("#mini-help")
    page.click("#btn-help"); time.sleep(0.3)
    r["help_text"] = page.inner_text("#help")
    page.screenshot(path=f"{out}/5-help-camera-mode-1440.png")
    page.click("#btn-help-close"); time.sleep(0.2)
    page.click("#btn-mouse"); time.sleep(0.3)
    m = page.mouse; m.move(400, 500); m.down(); m.move(1000, 520, steps=10); m.up(); time.sleep(0.3)
    m.move(700, 300); m.move(700, 700, steps=3); time.sleep(0.1)
    r["mouse_after"] = {"mode": page.evaluate("airStrings.mode"), "strings": page.evaluate("airStrings.count"), "rms": page.evaluate("airStrings.audio().rms"), "toolbar_select_visible": page.is_visible("#cam-select")}
    r["errors"] = errors(logs); r["warnings"] = [l["text"][:140] for l in logs if l["type"] == "warning"]
    report["1_normal_fake_camera"] = r
    ctx.close()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page(); page.goto(url, wait_until="networkidle"); page.click("#btn-camera"); settled(page); time.sleep(1)
    page.screenshot(path=f"{out}/1-fake-camera-390.png")
    page.click("#btn-help"); time.sleep(0.3)
    page.screenshot(path=f"{out}/5-help-390.png")
    ctx.close()

    # 2) IR + Busy + Good, then reload (remembered), then dropdown switching
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(STUB % THREE)
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); settled(page)
    r = {"first_start": state(page), "getUserMedia_calls": page.evaluate("window.__gum")}
    page.screenshot(path=f"{out}/2-skips-ir-lands-on-good-cam.png")
    page.reload(wait_until="networkidle")
    page.click("#btn-camera"); settled(page)
    r["after_reload"] = state(page); r["after_reload_calls"] = page.evaluate("window.__gum")
    page.screenshot(path=f"{out}/2b-remembered-after-reload.png")
    # 4) switch via toolbar dropdown to Busy (fails -> panel), then via panel dropdown back to Good
    page.select_option("#cam-select", "busy"); settled(page)
    r["switch_to_busy"] = state(page); r["switch_to_busy_calls"] = page.evaluate("window.__gum")
    page.screenshot(path=f"{out}/4a-switch-to-busy-fails.png")
    page.select_option("#cam-error-select", "good"); settled(page)
    r["switch_back_to_good_from_panel"] = state(page)
    page.screenshot(path=f"{out}/4b-panel-dropdown-back-to-good.png")
    r["errors"] = errors(logs); report["2_ir_busy_good"] = r
    ctx.close()

    # 3) everything fails
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(STUB % ALLFAIL)
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); settled(page)
    r = state(page); r["getUserMedia_calls"] = page.evaluate("window.__gum")
    page.screenshot(path=f"{out}/3-all-cameras-fail.png")
    page.click("#btn-use-mouse"); time.sleep(0.3)
    r["after_use_mouse"] = {"panel_visible": page.is_visible("#cam-error"), "mode": page.evaluate("airStrings.mode")}
    r["errors"] = errors(logs); report["3_all_fail"] = r
    ctx.close()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.add_init_script(STUB % ALLFAIL)
    page = ctx.new_page(); page.goto(url, wait_until="networkidle"); page.click("#btn-camera"); settled(page)
    page.screenshot(path=f"{out}/3-all-cameras-fail-390.png")
    ctx.close()

    # 4c) two working cameras: switch with the toolbar dropdown
    TWO = json.dumps([{"id": "good", "label": "Good Cam", "works": True}, {"id": "second", "label": "Second Cam", "works": True}])
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(STUB % TWO)
    page = ctx.new_page(); logs = []; attach(page, logs)
    page.goto(url, wait_until="networkidle")
    page.click("#btn-camera"); settled(page)
    r = {"start": state(page)}
    page.select_option("#cam-select", "second"); time.sleep(0.5); settled(page)
    r["after_switch"] = state(page); r["calls"] = page.evaluate("window.__gum")
    page.screenshot(path=f"{out}/4c-switched-to-second-cam.png")
    r["errors"] = errors(logs); report["4_dropdown_switch_two_cams"] = r
    ctx.close()
    b.close()

json.dump(report, open(f"{out}/camera-devices.json", "w"), indent=1)
print(json.dumps(report, indent=1))
