/**
 * Where a cut's time actually goes — `node tools/bench-cut.mjs`
 *
 * A cut has to land inside one frame or it reads as a stall, and the only way
 * to know what to make faster is to measure rather than guess.
 *
 * Everything is warmed first and reported as a median. Timing a cold call
 * measures V8 deciding how to compile the slicer, which is a real cost exactly
 * once per session and tells you nothing about the tenth cut.
 */
import * as THREE from 'three';
import { forge } from '../src/game/forge.js';
import { sliceGeometry } from '../src/game/slicer.js';
import { FreehandCutter } from '../src/game/cutter.js';
import { buildHull } from '../src/game/collision.js';
import { computeContactPoints, computeInertiaTensor } from '../src/game/physics.js';

const W = 1280, H = 720;
const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
camera.position.set(0, 0.75, 3.2);
camera.lookAt(0, 0.1, 0);
camera.updateMatrixWorld(true);

/** A stroke right across the object, curved so the cap path is exercised. */
const strokeAt = (ang) => {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24 - 0.5) * 900;
    pts.push({
      x: W / 2 + Math.cos(ang) * t + Math.sin(i / 24 * 3) * 40,
      y: H / 2 + Math.sin(ang) * t + Math.sin(i / 24 * 3) * 30,
    });
  }
  return pts;
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/** Cut one object three generations deep; returns ms for the whole cascade. */
function cascade(word) {
  const t0 = performance.now();
  let pieces = [forge(word, { highDetail: true }).geometry];
  for (let k = 0; k < 3; k++) {
    const next = [];
    const cutter = new FreehandCutter(camera, strokeAt(0.3 + k * 0.8), W, H);
    for (const g of pieces) {
      const r = sliceGeometry(g, cutter, { recenter: true });
      if (r) next.push(r.above.geometry, r.below.geometry); else next.push(g);
    }
    pieces = next;
  }
  return { ms: performance.now() - t0, pieces: pieces.length };
}

/**
 * One cut of an untouched object, all the way through to two simulated bodies.
 *
 * The slice is only half of what a cut costs. Each new fragment also needs a
 * collision hull, a set of ground contact points and an inertia tensor, and
 * those land on the frame right after — so they are part of the same hitch and
 * are timed together here.
 */
function single(word) {
  const g = forge(word, { highDetail: true }).geometry;
  const cutter = new FreehandCutter(camera, strokeAt(0.3), W, H);
  const t = performance.now();
  const r = sliceGeometry(g, cutter, { recenter: true });
  if (r) {
    for (const half of [r.above.geometry, r.below.geometry]) {
      buildHull(half);
      computeContactPoints(half);
      computeInertiaTensor(half, 1);
    }
  }
  return performance.now() - t;
}

const words = process.argv.slice(2).length ? process.argv.slice(2)
  : ['oak chair', 'walnut table', 'pine shelf', 'stool', 'brass lamp',
     'mug', 'terracotta bowl', 'bottle', 'apple', 'granite rock'];

for (const w of words) { cascade(w); single(w); }   // warm

console.log('object            tris   cut+bodies   3 generations  pieces   us/tri');
let worstFirst = 0, worstCascade = 0;
for (const w of words) {
  const tris = forge(w, { highDetail: true }).geometry.attributes.position.count / 3;
  const firsts = [], casc = [];
  for (let i = 0; i < 7; i++) { firsts.push(single(w)); casc.push(cascade(w)); }
  const f = median(firsts), c = median(casc.map((x) => x.ms));
  worstFirst = Math.max(worstFirst, f);
  worstCascade = Math.max(worstCascade, c);
  console.log(`${w.padEnd(16)} ${String(tris).padStart(5)}  ${f.toFixed(2).padStart(8)}ms  ` +
              `${c.toFixed(2).padStart(11)}ms  ${String(casc[0].pieces).padStart(6)}   ` +
              `${(f * 1000 / tris).toFixed(2)}`);
}
console.log(`\nworst first cut ${worstFirst.toFixed(2)} ms · worst 3-generation cascade ${worstCascade.toFixed(2)} ms`);
console.log('(a 60 fps frame is 16.7 ms; the cascade is 7 cuts of one stroke, far past normal use)');
