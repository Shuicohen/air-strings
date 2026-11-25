// Gesture state machine shared by hands, mouse and touch. Pure logic: no DOM, no audio,
// so it can be unit-tested with synthetic landmark sequences (see tests/gestures.test.mjs).
//
// Hand rules
//  - Pinch both hands on empty air, pull apart, release: create a string.
//  - Swipe an open fingertip through a string: pluck (speed = volume). Swipes never move strings.
//  - Move/retune a string only by pinching BOTH of its ends at once, one hand per end.
//    Each pinch must start near its end. A single-hand pinch on an end does nothing.
//  - Pinch the middle of a string and fling: delete (the string does not move while held).
//  - A pinch only counts once it has been held for PINCH_CONFIRM_MS while the hand is
//    moving slower than GRAB_MAX_SPEED, so a fast swipe that briefly closes thumb and index
//    never grabs anything.
// Mouse/touch (testing fallback): drag empty space = create, drag one end dot = stretch,
// press on a string body then drag across = pluck, hover sweep = pluck.

export const HAND = {
  END_RADIUS: 60,        // pinch must start this close to an end (px)
  BODY_RADIUS: 40,
  PINCH_CONFIRM_MS: 90,
  GRAB_MAX_SPEED: 900,   // px/s; faster than this a pinch is treated as part of a swipe
  FLING_SPEED: 2600,
  FLING_RELEASE_SPEED: 1600,
};
export const POINTER = { END_RADIUS: 26, BODY_RADIUS: 16 };

// ---------- geometry ----------
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function segIntersect(p, q, a, b) {
  const r = { x: q.x - p.x, y: q.y - p.y };
  const s = { x: b.x - a.x, y: b.y - a.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x - p.x) * s.y - (a.y - p.y) * s.x) / den;
  const u = ((a.x - p.x) * r.y - (a.y - p.y) * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p.x + r.x * t, y: p.y + r.y * t, u };
}
export function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return { d: Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u)), u };
}

// ---------- landmarks -> hand ----------
// lm: 21 MediaPipe landmarks (normalized). map: (nx, ny) -> canvas px. prev: last hand state.
export function handFromLandmarks(id, lm, map, prev) {
  const pts = lm.map((p) => map(p.x, p.y));
  const smooth = (a, b, k) => (b ? { x: b.x + (a.x - b.x) * k, y: b.y + (a.y - b.y) * k } : a);
  const tip = smooth(pts[8], prev?.tip, 0.65);
  const thumb = smooth(pts[4], prev?.thumb, 0.65);
  const scale = Math.hypot(pts[0].x - pts[5].x, pts[0].y - pts[5].y) || 1;
  const ratio = Math.hypot(tip.x - thumb.x, tip.y - thumb.y) / scale;
  const pinch = prev?.pinch ? ratio < 0.5 : ratio < 0.32; // hysteresis
  return { id, tip, thumb, pinch, pinchPt: { x: (tip.x + thumb.x) / 2, y: (tip.y + thumb.y) / 2 }, pts };
}

// ---------- engine ----------
export function createGestures(o) {
  const cfg = { minLen: 48, cooldown: 110, ...o };
  const cursors = new Map();
  const cooldown = new Map();
  const live = () => cfg.getStrings().filter((s) => !s.dying);

  function cursorFor(id, kind) {
    let c = cursors.get(id);
    if (!c) {
      c = { id, kind, pos: null, prev: null, vel: { x: 0, y: 0 }, down: false, mode: null, target: null, start: null,
        pluckPos: null, pluckPrev: null, t: cfg.now(), dt: 0.016, pinchSince: null };
      cursors.set(id, c);
    }
    return c;
  }
  const speed = (c) => Math.hypot(c.vel.x, c.vel.y);

  function hitEndpoint(p, r) {
    let best = null, bd = r;
    for (const s of live()) for (const end of ['a', 'b']) {
      const d = dist(p, s[end]);
      if (d < bd) { bd = d; best = { s, end }; }
    }
    return best;
  }
  function hitBody(p, r) {
    let best = null, bd = r;
    for (const s of live()) {
      const h = distToSeg(p, s.a, s.b);
      if (h.d < bd && h.u > 0.12 && h.u < 0.88) { bd = h.d; best = { s, u: h.u }; }
    }
    return best;
  }

  function move(c, pos, pluckPos, t = cfg.now()) {
    // clamp so a move after a pause (or a burst of coalesced events) still gives a sane speed
    const dt = Math.min(0.05, Math.max(0.008, (t - c.t) / 1000));
    c.prev = c.pos;
    c.pos = { ...pos };
    if (c.prev) {
      const k = 0.5;
      c.vel = { x: c.vel.x * (1 - k) + ((pos.x - c.prev.x) / dt) * k, y: c.vel.y * (1 - k) + ((pos.y - c.prev.y) / dt) * k };
    }
    c.pluckPrev = c.pluckPos;
    c.pluckPos = pluckPos ? { ...pluckPos } : { ...pos };
    c.t = t;
    c.dt = dt;
  }

  function tryPluck(c, p, q) {
    if (!p || !q || (p.x === q.x && p.y === q.y)) return;
    const sp = dist(p, q) / (c.dt || 0.016);
    for (const s of live()) {
      if (c.target?.s === s) continue;
      const hit = segIntersect(p, q, s.a, s.b);
      if (!hit) continue;
      const key = `${c.id}:${s.id}`;
      if (cfg.now() - (cooldown.get(key) || 0) < cfg.cooldown) continue;
      cooldown.set(key, cfg.now());
      cfg.onPluck(s, sp / 3000, hit, hit.u);
    }
  }

  // ----- hands -----
  const handCursors = () => [...cursors.values()].filter((c) => c.kind === 'hand');

  function handDown(c) {
    c.down = true;
    c.start = { ...c.pos };
    const ep = hitEndpoint(c.pos, HAND.END_RADIUS);
    if (ep) {
      c.mode = 'end';
      c.target = { s: ep.s, end: ep.end, offset: { x: ep.s[ep.end].x - c.pos.x, y: ep.s[ep.end].y - c.pos.y } };
      cfg.onSelect?.(ep.s);
      // the other hand already holding the opposite end of the same string -> paired
      const other = handCursors().find((o) => o !== c && o.down && o.mode === 'end' && o.target.s === ep.s && o.target.end !== ep.end);
      if (other) { c.mode = other.mode = 'pair'; c.partner = other; other.partner = c; }
      return;
    }
    const body = hitBody(c.pos, HAND.BODY_RADIUS);
    if (body) { c.mode = 'hold'; c.target = { s: body.s }; cfg.onSelect?.(body.s); return; }
    c.mode = 'free';
  }

  function handDrag(c) {
    if (c.mode === 'pair' && c.target && !c.target.s.dying) {
      const s = c.target.s;
      s[c.target.end] = { x: c.pos.x + c.target.offset.x, y: c.pos.y + c.target.offset.y };
      cfg.onChange(s);
    } else if (c.mode === 'hold' && c.target) {
      if (speed(c) > HAND.FLING_SPEED) { cfg.onDelete(c.target.s); c.target = null; c.mode = 'spent'; }
    }
  }

  function handUp(c) {
    if (!c.down) return;
    c.down = false;
    if (c.mode === 'free') {
      const other = handCursors().find((o) => o !== c && o.down && o.mode === 'free');
      const here = c.pinchPos || c.pos;
      if (other && dist(here, other.pos) >= cfg.minLen) {
        cfg.onCreate(here, other.pos);
        other.mode = 'spent'; // the other hand has to release before it can start something new
      }
    } else if (c.mode === 'hold' && c.target) {
      if (speed(c) > HAND.FLING_RELEASE_SPEED) cfg.onDelete(c.target.s);
    } else if (c.mode === 'pair' && c.partner) {
      // releasing either end ends the move; the other hand keeps its pinch but does nothing
      const p = c.partner;
      if (p.down && p.mode === 'pair') { p.mode = 'spent'; p.target = null; }
      p.partner = null;
    }
    c.mode = null; c.target = null; c.partner = null;
  }

  // hands: [{ id, tip, pinch, pinchPt, ... }] in canvas px, for one video frame at time t
  function handsFrame(hands, t = cfg.now()) {
    const seen = new Set();
    for (const h of hands) {
      const id = `hand-${h.id}`;
      seen.add(id);
      const c = cursorFor(id, 'hand');
      c.hand = h;
      move(c, h.pinchPt, h.tip, t);
      if (h.pinch) {
        c.pinchPos = { ...c.pos }; // where the pinch was while closed (opening the fingers shifts the midpoint)
        if (c.pinchSince == null) c.pinchSince = t;
        if (!c.down) {
          // confirm only a held, slow pinch; a fast swipe never grabs
          if (t - c.pinchSince >= HAND.PINCH_CONFIRM_MS && speed(c) < HAND.GRAB_MAX_SPEED) handDown(c);
        } else handDrag(c);
      } else {
        c.pinchSince = null;
        if (c.down) handUp(c);
      }
      if (!c.down) tryPluck(c, c.pluckPrev, c.pluckPos);
    }
    for (const [id, c] of cursors) {
      if (c.kind === 'hand' && !seen.has(id)) { if (c.down) handUp(c); cursors.delete(id); }
    }
  }

  // ----- mouse / touch -----
  function pointerDown(id, kind, pos, t) {
    const c = cursorFor(id, kind);
    move(c, pos, null, t);
    c.down = true;
    c.start = { ...c.pos };
    const ep = hitEndpoint(c.pos, POINTER.END_RADIUS);
    if (ep) { c.mode = 'stretch'; c.target = ep; cfg.onSelect?.(ep.s); return; }
    const body = hitBody(c.pos, POINTER.BODY_RADIUS);
    if (body) {
      c.mode = 'strum';
      cfg.onPluck(body.s, 0.55, c.pos, body.u);
      cooldown.set(`${c.id}:${body.s.id}`, cfg.now());
      return;
    }
    c.mode = 'free';
  }
  function pointerMove(id, kind, pos, t) {
    const c = cursorFor(id, kind);
    move(c, pos, null, t);
    if (!c.down) { if (kind === 'mouse') tryPluck(c, c.pluckPrev, c.pluckPos); return; }
    if (c.mode === 'stretch' && c.target && !c.target.s.dying) {
      c.target.s[c.target.end] = { ...c.pos };
      cfg.onChange(c.target.s);
    } else if (c.mode === 'strum') tryPluck(c, c.prev, c.pos);
  }
  function pointerUp(id, pos, t) {
    const c = cursors.get(id);
    if (!c) return;
    if (pos) move(c, pos, null, t);
    if (c.down && c.mode === 'free' && dist(c.start, c.pos) >= cfg.minLen) cfg.onCreate(c.start, c.pos);
    c.down = false; c.mode = null; c.target = null;
    if (c.kind === 'touch') cursors.delete(id);
  }
  function pointerLeave(id) {
    const c = cursors.get(id);
    if (c && !c.down) { c.pos = c.prev = c.pluckPos = c.pluckPrev = null; }
  }

  function forget(s) { for (const c of cursors.values()) if (c.target?.s === s) { c.target = null; if (c.down) c.mode = 'spent'; } }
  function clearHands() { for (const [id, c] of cursors) if (c.kind === 'hand') cursors.delete(id); }
  // which ends are currently held (for drawing): 'move' when moving, 'wait' when one hand holds an end alone
  function endState(s, end) {
    for (const c of cursors.values()) {
      if (c.target?.s !== s || c.target.end !== end) continue;
      if (c.mode === 'pair' || c.mode === 'stretch') return 'move';
      if (c.mode === 'end') return 'wait';
    }
    return null;
  }
  const isMoving = (s) => [...cursors.values()].some((c) => (c.mode === 'pair' || c.mode === 'stretch') && c.target?.s === s);
  function previews() {
    const segs = [];
    for (const c of cursors.values()) if (c.kind !== 'hand' && c.down && c.mode === 'free' && c.start && c.pos) segs.push([c.start, c.pos]);
    const hs = handCursors().filter((c) => c.down && c.mode === 'free');
    if (hs.length >= 2) segs.push([hs[0].pos, hs[1].pos]);
    return segs;
  }

  return { cursors, handsFrame, pointerDown, pointerMove, pointerUp, pointerLeave, forget, clearHands, endState, isMoving, previews, hitBody, hitEndpoint };
}
