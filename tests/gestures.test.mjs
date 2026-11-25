// Unit tests for the hand-gesture state machine, driven by synthetic MediaPipe landmark sequences.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGestures, handFromLandmarks, dist } from '../src/gestures.js';
import { freqForLength } from '../src/audio.js';

const W = 1000, H = 1000;
const map = (nx, ny) => ({ x: nx * W, y: ny * H });
const FRAME = 33; // ms, ~30 fps camera

// 21 landmarks for a hand whose index fingertip is at canvas (x, y).
// Pinched: thumb tip touches the index tip. Open: thumb is far from it.
// Wrist -> index MCP distance is 100 px (the hand-size scale used for pinch detection).
function landmarks(x, y, pinched) {
  const tx = x / W, ty = y / H;
  const lm = Array.from({ length: 21 }, () => ({ x: tx, y: ty + 0.1, z: 0 }));
  lm[0] = { x: tx, y: ty + 0.18, z: 0 };         // wrist
  lm[5] = { x: tx, y: ty + 0.08, z: 0 };         // index MCP
  lm[8] = { x: tx, y: ty, z: 0 };                // index tip
  lm[4] = pinched ? { x: tx + 0.004, y: ty + 0.004, z: 0 } : { x: tx - 0.07, y: ty + 0.06, z: 0 }; // thumb tip
  return lm;
}

function rig(strings = []) {
  let t = 1000;
  const log = { created: [], plucks: [], changes: 0, deleted: [] };
  let nextId = 100;
  const g = createGestures({
    now: () => t,
    minLen: 48,
    getStrings: () => strings,
    onCreate: (a, b) => { const s = { id: nextId++, a: { ...a }, b: { ...b } }; strings.push(s); log.created.push(s); },
    onPluck: (s, v) => log.plucks.push({ id: s.id, v }),
    onChange: () => { log.changes++; },
    onDelete: (s) => { s.dying = 1; log.deleted.push(s.id); },
  });
  const prev = {};
  // frame({ L: [x, y, pinched], R: [...] }) feeds one video frame through landmark -> hand -> gestures
  function frame(hands) {
    t += FRAME;
    const list = Object.entries(hands).map(([id, [x, y, p]]) => (prev[id] = handFromLandmarks(id, landmarks(x, y, p), map, prev[id])));
    for (const id of Object.keys(prev)) if (!(id in hands)) delete prev[id];
    g.handsFrame(list, t);
  }
  // move hands linearly over n frames: spec { id: [x0, y0, x1, y1, pinched] }
  function glide(spec, n) {
    for (let i = 1; i <= n; i++) {
      const f = {};
      for (const [id, [x0, y0, x1, y1, p]] of Object.entries(spec)) f[id] = [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, p];
      frame(f);
    }
  }
  const hold = (f, n) => { for (let i = 0; i < n; i++) frame(f); };
  return { g, log, frame, glide, hold, strings };
}
const str = () => ({ id: 1, a: { x: 300, y: 500 }, b: { x: 700, y: 500 } });
const near = (p, q, tol = 6) => dist(p, q) <= tol;

test('one-hand pinch on an end leaves the string unchanged', () => {
  const s = str();
  const r = rig([s]);
  r.hold({ R: [300, 500, false] }, 6);               // hand rests on end a, open
  r.hold({ R: [300, 500, true] }, 8);                // pinch and hold there
  r.glide({ R: [300, 500, 180, 380, true] }, 15);    // drag slowly while pinched
  r.hold({ R: [180, 380, false] }, 3);               // release
  assert.deepEqual(s.a, { x: 300, y: 500 });
  assert.deepEqual(s.b, { x: 700, y: 500 });
  assert.equal(r.log.changes, 0);
  assert.equal(r.log.created.length, 0);
});

test('one hand on an end + other hand pinching empty air: no move, no new string', () => {
  const s = str();
  const r = rig([s]);
  r.hold({ L: [300, 500, false], R: [800, 200, false] }, 5);
  r.hold({ L: [300, 500, true], R: [800, 200, true] }, 6);
  r.glide({ L: [300, 500, 250, 450, true], R: [800, 200, 900, 300, true] }, 10);
  r.hold({ L: [250, 450, false], R: [900, 300, false] }, 3);
  assert.deepEqual(s.a, { x: 300, y: 500 });
  assert.equal(r.log.changes, 0);
  assert.equal(r.log.created.length, 0);
});

test('fingertip swipe near an end plucks without moving it', () => {
  const s = str();
  const r = rig([s]);
  r.hold({ R: [320, 380, false] }, 4);
  r.glide({ R: [320, 380, 320, 620, false] }, 3);    // fast swipe 20 px from end a
  assert.ok(r.log.plucks.length >= 1, 'plucked');
  assert.ok(r.log.plucks[0].v > 0.5, `fast swipe is loud (v=${r.log.plucks[0].v.toFixed(2)})`);
  assert.deepEqual(s.a, { x: 300, y: 500 });
  assert.equal(r.log.changes, 0);
});

test('fast swipe with thumb and index briefly closed over an end still only plucks', () => {
  const s = str();
  const r = rig([s]);
  r.hold({ R: [305, 400, false] }, 4);
  r.glide({ R: [305, 400, 305, 480, true] }, 2);     // pinch closes mid-swipe right next to end a
  r.glide({ R: [305, 480, 305, 640, true] }, 2);
  r.hold({ R: [305, 640, false] }, 2);
  assert.ok(r.log.plucks.length >= 1, 'plucked');
  assert.deepEqual(s.a, { x: 300, y: 500 });
  assert.equal(r.log.changes, 0);
});

test('two-hand pinch on both ends moves the string and retunes it (shorter = higher)', () => {
  const s = str();
  const r = rig([s]);
  const ref = 500;
  const f0 = freqForLength(dist(s.a, s.b), ref, false);
  r.hold({ L: [300, 500, false], R: [700, 500, false] }, 5);
  r.hold({ L: [300, 500, true], R: [700, 500, true] }, 6);
  r.glide({ L: [300, 500, 420, 420, true], R: [700, 500, 600, 420, true] }, 20);
  r.hold({ L: [420, 420, true], R: [600, 420, true] }, 6);
  assert.ok(near(s.a, { x: 420, y: 420 }), `a followed left hand: ${JSON.stringify(s.a)}`);
  assert.ok(near(s.b, { x: 600, y: 420 }), `b followed right hand: ${JSON.stringify(s.b)}`);
  assert.ok(r.log.changes > 10, 'retuned live while moving');
  const f1 = freqForLength(dist(s.a, s.b), ref, false);
  assert.ok(f1 > f0 * 1.9, `pitch went up: ${f0.toFixed(1)} -> ${f1.toFixed(1)} Hz`);
  // release one hand: the move stops even though the other hand stays pinched
  r.hold({ L: [420, 420, false], R: [600, 420, true] }, 3);
  r.glide({ R: [600, 420, 700, 300, true] }, 8);
  assert.ok(near(s.b, { x: 600, y: 420 }), 'b stays after the pair breaks');
  assert.equal(r.log.created.length, 0);
});

test('two-hand pinch in empty air creates a new string', () => {
  const s = str();
  const r = rig([s]);
  r.hold({ L: [200, 200, false], R: [260, 200, false] }, 5);
  r.hold({ L: [200, 200, true], R: [260, 200, true] }, 6);
  r.glide({ R: [260, 200, 650, 240, true], L: [200, 200, 200, 200, true] }, 15);
  r.hold({ L: [200, 200, true], R: [650, 240, true] }, 4);
  r.frame({ L: [200, 200, true], R: [650, 240, false] }); // release
  assert.equal(r.log.created.length, 1);
  const n = r.log.created[0];
  assert.ok(near(n.a, { x: 650, y: 240 }, 12) || near(n.b, { x: 650, y: 240 }, 12));
  assert.ok(near(n.a, { x: 200, y: 200 }, 12) || near(n.b, { x: 200, y: 200 }, 12));
  assert.deepEqual(s.a, { x: 300, y: 500 }, 'existing string untouched');
});

test('pinch the middle and fling deletes without dragging the string first', () => {
  const s = str();
  const r = rig([s]);
  r.hold({ R: [500, 500, false] }, 4);
  r.hold({ R: [500, 500, true] }, 6);
  r.glide({ R: [500, 500, 520, 510, true] }, 4);     // slow: nothing happens
  assert.deepEqual(s.a, { x: 300, y: 500 });
  assert.equal(r.log.deleted.length, 0);
  r.glide({ R: [520, 510, 900, 300, true] }, 3);     // fling
  assert.deepEqual(r.log.deleted, [1]);
});

test('mouse fallback: dragging one end dot still stretches (testing mode)', () => {
  const s = str();
  const r = rig([s]);
  r.g.pointerDown('p1', 'mouse', { x: 702, y: 501 }, 2000);
  r.g.pointerMove('p1', 'mouse', { x: 600, y: 500 }, 2016);
  r.g.pointerUp('p1', { x: 550, y: 500 }, 2032);
  assert.deepEqual(s.b, { x: 600, y: 500 });
  assert.ok(r.log.changes >= 1);
});
