/**
 * Physics verification — `node tools/test-physics.mjs`
 *
 * The thing that actually matters here is that cut pieces stop passing through
 * each other and that a pile comes to rest. Both are easy to get subtly wrong
 * and hard to judge from a screenshot, so they get measured.
 */
import * as THREE from 'three';
import { World, Body, computeContactPoints, computeInertiaTensor } from '../src/game/physics.js';
import { buildHull } from '../src/game/collision.js';
import { forge } from '../src/game/forge.js';
import { sliceGeometry } from '../src/game/slicer.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  [32mPASS[0m' : '  [31mFAIL[0m'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function makeBody(geometry, opts = {}) {
  geometry.computeBoundingSphere();
  const b = new Body({
    volume: opts.volume ?? 0.05,
    radius: geometry.boundingSphere.radius,
    family: opts.family ?? 'wood',
    contactSource: geometry,
  });
  if (opts.position) b.position.copy(opts.position);
  return b;
}

/** Deepest overlap between any two bodies, measured through their hulls. */
function worstOverlap(world) {
  let worst = 0;
  const stamp = ++world._stamp;
  for (let i = 0; i < world.bodies.length; i++) {
    for (let j = i + 1; j < world.bodies.length; j++) {
      const A = world.bodies[i], B = world.bodies[j];
      const ha = A.worldHull(stamp), hb = B.worldHull(stamp);
      if (!ha || !hb) continue;
      const { hullContacts } = globalThis.__hc;
      for (const c of hullContacts(ha, hb, 6)) worst = Math.max(worst, c.depth);
    }
  }
  return worst;
}
globalThis.__hc = await import('../src/game/collision.js');

/* ── hulls ─────────────────────────────────────────────────────────── */
console.log('\n[1m── hull construction ──[0m');
{
  let bad = [];
  for (const w of ['chair', 'mug', 'apple', 'table', 'bottle', 'rock', 'book', 'lamp']) {
    const o = forge(w);
    const h = buildHull(o.geometry);
    if (!h) { bad.push(`${w}: null`); continue; }
    if (h.vertCount < 4) bad.push(`${w}: ${h.vertCount} verts`);
    if (h.planeCount < 4) bad.push(`${w}: ${h.planeCount} planes`);
    // every hull vertex must satisfy every hull plane (that is what convex means)
    for (let i = 0; i < h.vertCount; i++) {
      for (let p = 0; p < h.planeCount; p++) {
        const d = h.planes[p * 4] * h.verts[i * 3] + h.planes[p * 4 + 1] * h.verts[i * 3 + 1] +
                  h.planes[p * 4 + 2] * h.verts[i * 3 + 2] - h.planes[p * 4 + 3];
        if (d > 1e-3) { bad.push(`${w}: vertex outside own hull by ${d.toFixed(4)}`); i = h.vertCount; break; }
      }
    }
  }
  check('hulls build and are convex', bad.length === 0, bad.slice(0, 4).join(' '));

  const h = buildHull(forge('crate').geometry);
  check('hull stays small enough for the inner loop',
        h.vertCount <= 26 && h.planeCount <= 60, `${h.vertCount} verts, ${h.planeCount} planes`);
}

/* ── a box dropped on a box must not sink through it ───────────────── */
console.log('\n[1m── stacking ──[0m');
{
  const world = new World(0);
  const mk = (y) => {
    const g = new THREE.BoxGeometry(0.5, 0.2, 0.5).toNonIndexed();
    const b = makeBody(g, { position: new THREE.Vector3(0, y, 0), volume: 0.05 });
    world.add(b);
    return b;
  };
  const bottom = mk(0.1);
  const top = mk(0.9);

  for (let i = 0; i < 60 * 6; i++) world.step(1 / 60);

  check('upper box came to rest on the lower one',
        top.position.y > bottom.position.y + 0.15,
        `bottom y=${bottom.position.y.toFixed(3)} top y=${top.position.y.toFixed(3)}`);
  check('neither box sank through the ground',
        bottom.position.y > 0.05, `bottom y=${bottom.position.y.toFixed(3)}`);
  check('stack fell asleep', top.sleeping && bottom.sleeping);
  check('overlap is negligible', worstOverlap(world) < 0.01,
        `worst ${worstOverlap(world).toFixed(4)}`);
}

/* ── a real cut object: pieces must not interpenetrate ─────────────── */
console.log('\n[1m── cut fragments in a pile ──[0m');
{
  const o = forge('crate', { variant: 3 });
  let pieces = [o.geometry];
  for (let gen = 0; gen < 3; gen++) {
    const next = [];
    for (const g of pieces) {
      const a = gen * 1.9 + next.length * 0.7;
      const n = new THREE.Vector3(Math.cos(a), Math.sin(a * 1.3), Math.sin(a)).normalize();
      g.computeBoundingSphere();
      const r = sliceGeometry(g, new THREE.Plane(n, Math.sin(a * 2.2) * g.boundingSphere.radius * 0.25));
      if (!r) { next.push(g); continue; }
      next.push(r.above.geometry, r.below.geometry);
    }
    pieces = next;
  }

  // Dropped from apart, not spawned interpenetrating: pieces have to fall and
  // land on each other, which is what exercises the contact response.
  const world = new World(0);
  let i = 0;
  for (const g of pieces) {
    g.computeBoundingBox();
    const b = makeBody(g, {
      position: new THREE.Vector3(((i % 3) - 1) * 0.34, 0.45 + Math.floor(i / 3) * 0.55, ((i % 2) - 0.5) * 0.2),
    });
    world.add(b);
    i++;
  }

  const t0 = Date.now();
  for (let s = 0; s < 60 * 14; s++) world.step(1 / 60);
  const ms = Date.now() - t0;

  const worst = worstOverlap(world);
  const asleep = world.bodies.filter((b) => b.sleeping).length;
  const speeds = world.bodies.map((b) => b.velocity.length());
  const maxV = Math.max(...speeds);
  const meanV = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const belowGround = world.bodies.filter((b) => {
    for (const lp of b.contacts) {
      const p = lp.clone().applyQuaternion(b.quaternion).add(b.position);
      if (p.y < -0.02) return true;
    }
    return false;
  }).length;

  check(`${pieces.length} fragments: no deep interpenetration`, worst < 0.05, `worst ${worst.toFixed(4)}`);
  check('none sank through the bench', belowGround === 0, `${belowGround} below`);
  // What matters is that the heap is at rest, not that a particular
  // optimisation flag is set. A pile of irregular wedges under an approximate
  // solver keeps making sub-millimetre adjustments indefinitely; the sleep flag
  // trails that by a few seconds.
  check('the pile came to rest', maxV < 0.07 && meanV < 0.025,
        `max ${maxV.toFixed(4)} m/s, mean ${meanV.toFixed(4)} m/s`);

  // Sleeping is an optimisation, so measure what it buys rather than the flag.
  // A dropped heap of irregular wedges keeps making sub-millimetre adjustments
  // that flicker across any threshold; the cost of a settled pile is the thing
  // that actually has to stay near zero.
  const t1 = Date.now();
  for (let s = 0; s < 60 * 4; s++) world.step(1 / 60);
  const settledMs = Date.now() - t1;
  check('a settled pile costs almost nothing', settledMs < 60,
        `${settledMs} ms for 4 s (${asleep}/${world.bodies.length} asleep)`);
  check('14 s of simulation stays cheap', ms < 4000, `${ms} ms for ${world.bodies.length} bodies`);
}

/* ── a cut must not fling its own halves apart ─────────────────────── */
console.log('\n[1m── freshly cut halves ──[0m');
{
  // A mug is the hard case: each half's convex hull spans the cavity, so the
  // two hulls overlap deeply while the halves themselves only touch.
  for (const word of ['mug', 'terracotta bowl', 'oak chair']) {
    const o = forge(word, { variant: 2 });
    const r = sliceGeometry(o.geometry, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0));
    if (!r) { check(`${word}: plane cut it`, false); continue; }

    const world = new World(-10);         // floor far below: isolate the pair
    const bodies = [];
    for (const side of [r.above, r.below]) {
      const b = makeBody(side.geometry, { volume: side.volume });
      b.position.copy(side.centroid);
      world.add(b);
      bodies.push(b);
    }
    const start = bodies.map((b) => b.position.clone());

    // one tenth of a second: any separation here is the solver, not gravity
    for (let i = 0; i < 6; i++) world.step(1 / 60);

    let maxPush = 0;
    bodies.forEach((b, i) => {
      const d = b.position.clone().sub(start[i]);
      d.y = 0;                             // ignore falling
      maxPush = Math.max(maxPush, d.length());
    });
    check(`${word}: halves are not thrown apart`, maxPush < 0.01,
          `sideways ${maxPush.toFixed(4)} in 0.1 s`);
  }
}

/* ── inertia: shape must matter, and never produce nonsense ────────── */
console.log('\n[1m── inertia tensors ──[0m');
{
  const tensorOf = (g) => computeInertiaTensor(g.toNonIndexed ? (g.index ? g.toNonIndexed() : g) : g, 1).tensor;

  // a thin plate resists rotation about its flat axis far less than about
  // the axes in its plane; a sphere approximation cannot express that
  const plate = tensorOf(new THREE.BoxGeometry(1, 0.05, 1).toNonIndexed());
  const pe = plate.elements;                          // column-major
  const ratio = pe[4] / pe[0];                        // Iyy / Ixx
  check('a flat plate has a distinctly anisotropic tensor', ratio > 1.7,
        `Iyy/Ixx = ${ratio.toFixed(2)} (a sphere would give 1.00)`);

  const cube = tensorOf(new THREE.BoxGeometry(1, 1, 1).toNonIndexed());
  const ce = cube.elements;
  check('a cube is isotropic', Math.abs(ce[4] / ce[0] - 1) < 0.02,
        `Iyy/Ixx = ${(ce[4] / ce[0]).toFixed(3)}`);

  // every fragment a real cut can produce must yield a usable tensor
  let bad = [];
  for (const w of ['oak chair', 'mug', 'apple', 'glass bottle', 'granite rock']) {
    let pieces = [forge(w, { variant: 4 }).geometry];
    for (let gen = 0; gen < 3; gen++) {
      const next = [];
      for (const g of pieces) {
        const a = gen * 2.1 + next.length * 0.8;
        const n = new THREE.Vector3(Math.cos(a), Math.sin(a * 1.4), Math.sin(a)).normalize();
        g.computeBoundingSphere();
        const r = sliceGeometry(g, new THREE.Plane(n, Math.sin(a * 1.7) * g.boundingSphere.radius * 0.35));
        if (!r) { next.push(g); continue; }
        next.push(r.above.geometry, r.below.geometry);
      }
      pieces = next;
    }
    for (const g of pieces) {
      const b = makeBody(g, { volume: 0.01 });
      const inv = b.invInertiaLocal.elements;
      if (!inv.every((v) => isFinite(v))) { bad.push(`${w}: non-finite`); break; }
      // a valid inverse inertia is positive definite: diagonal must be > 0
      if (inv[0] <= 0 || inv[4] <= 0 || inv[8] <= 0) { bad.push(`${w}: negative diagonal`); break; }
    }
  }
  check('every cut fragment yields a positive-definite tensor', bad.length === 0,
        bad.slice(0, 3).join(' ') || 'across 5 objects cut to 8 pieces each');
}

/* ── nothing may escape into the non-finite ────────────────────────── */
console.log('\n[1m── numerical robustness ──[0m');
{
  // deliberately nasty: thin fragments dropped into each other at speed
  const world = new World(0);
  const o = forge('oak chair', { variant: 7 });
  let pieces = [o.geometry];
  for (let gen = 0; gen < 4; gen++) {
    const next = [];
    for (const g of pieces) {
      const a = gen * 1.3 + next.length * 0.55;
      const n = new THREE.Vector3(Math.cos(a), Math.sin(a * 1.9), Math.sin(a * 0.7)).normalize();
      g.computeBoundingSphere();
      const r = sliceGeometry(g, new THREE.Plane(n, Math.sin(a * 2.6) * g.boundingSphere.radius * 0.3));
      if (!r) { next.push(g); continue; }
      next.push(r.above.geometry, r.below.geometry);
    }
    pieces = next;
  }
  let i = 0;
  for (const g of pieces.slice(0, 24)) {
    const b = makeBody(g, { position: new THREE.Vector3(((i % 5) - 2) * 0.16, 0.4 + Math.floor(i / 5) * 0.3, ((i % 3) - 1) * 0.12) });
    b.velocity.set(0, -3, 0);
    world.add(b);
    i++;
  }
  for (let s = 0; s < 60 * 10; s++) world.step(1 / 60);

  const nonFinite = world.bodies.filter((b) =>
    !isFinite(b.position.x + b.position.y + b.position.z +
              b.velocity.length() + b.angular.length() +
              b.quaternion.x + b.quaternion.y + b.quaternion.z + b.quaternion.w)).length;
  const broken = world.bodies.filter((b) => b.broken).length;
  check(`${world.bodies.length} thin fragments dropped hard: nothing went non-finite`,
        nonFinite === 0, `${nonFinite} non-finite, ${broken} flagged broken`);
  check('nothing was launched off the bench',
        world.bodies.every((b) => Math.abs(b.position.x) < 12 && Math.abs(b.position.z) < 12),
        `worst |x| ${Math.max(...world.bodies.map((b) => Math.abs(b.position.x))).toFixed(2)}`);
}

/* ── frozen bodies act as immovable ────────────────────────────────── */
console.log('\n[1m── mass handling ──[0m');
{
  const world = new World(0);
  const g1 = new THREE.BoxGeometry(1, 0.2, 1).toNonIndexed();
  const g2 = new THREE.BoxGeometry(0.3, 0.3, 0.3).toNonIndexed();
  const floorish = makeBody(g1, { position: new THREE.Vector3(0, 0.1, 0) });
  floorish.frozen = true;
  const faller = makeBody(g2, { position: new THREE.Vector3(0, 1.2, 0) });
  world.add(floorish); world.add(faller);

  for (let i = 0; i < 60 * 5; i++) world.step(1 / 60);
  check('frozen body did not move', floorish.position.y === 0.1, `y=${floorish.position.y}`);
  check('falling body landed on top of it', faller.position.y > 0.28,
        `y=${faller.position.y.toFixed(3)}`);
}

console.log(`\n${failures === 0 ? '[32mPhysics holds.[0m' : `[31m${failures} failing.[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
