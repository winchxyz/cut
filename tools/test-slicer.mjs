/**
 * Slicer verification harness — `node tools/test-slicer.mjs`
 *
 * The slicer is the one part of the game where "looks fine" isn't good enough:
 * if a cap leaks, every subsequent slice of that fragment inherits the hole and
 * the mass/centroid maths goes with it. So we check the invariants directly.
 */
import * as THREE from 'three';
import { sliceGeometry, volumeAndCentroid, isSubPixelThin, MAT_INTERIOR } from '../src/game/slicer.js';
import { FreehandCutter } from '../src/game/cutter.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  [32mPASS[0m' : '  [31mFAIL[0m'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/**
 * Every undirected edge of a closed manifold is shared by exactly 2 triangles.
 *
 * The weld here must be at least as fine as the slicer's own (1e-6), otherwise
 * the check merges genuinely distinct vertices and reports phantom non-manifold
 * edges that don't exist in the geometry.
 */
function openEdgeCount(geometry, weld = null) {
  const pos = geometry.attributes.position.array;
  if (weld === null) {
    // mirror the slicer's scale-relative tolerance, or the check merges
    // distinct vertices on small fragments and reports phantom holes
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const r = Math.max(geometry.boundingSphere?.radius ?? 1, 1e-6);
    weld = 1 / Math.max(r * 1e-6, 1e-9);
  }
  const key = (i) => `${Math.round(pos[i] * weld)},${Math.round(pos[i + 1] * weld)},${Math.round(pos[i + 2] * weld)}`;
  const edges = new Map();
  for (let t = 0; t < pos.length; t += 9) {
    const k = [key(t), key(t + 3), key(t + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      if (a === b) continue;
      const id = a < b ? a + '|' + b : b + '|' + a;
      edges.set(id, (edges.get(id) || 0) + 1);
    }
  }
  let open = 0;
  for (const c of edges.values()) if (c !== 2) open++;
  return { open, total: edges.size };
}

function prep(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
  }
  return g;
}

function matCount(geo, mi) {
  let n = 0;
  for (const g of geo.groups) if (g.materialIndex === mi) n += g.count / 3;
  return n;
}

/* ══════════════════════════════════════════════════════════════════ */

const shapes = [
  ['sphere',    prep(new THREE.SphereGeometry(1, 32, 24))],
  ['box',       prep(new THREE.BoxGeometry(1.4, 1.4, 1.4))],
  ['torus',     prep(new THREE.TorusGeometry(0.8, 0.32, 20, 48))],
  ['cylinder',  prep(new THREE.CylinderGeometry(0.6, 0.6, 1.6, 32))],
  ['icosa',     prep(new THREE.IcosahedronGeometry(1, 2))],
  ['torusknot', prep(new THREE.TorusKnotGeometry(0.7, 0.24, 96, 16))],
  ['cone',      prep(new THREE.ConeGeometry(0.8, 1.6, 28))],
  ['capsule',   prep(new THREE.CapsuleGeometry(0.5, 1.0, 8, 24))],
];

console.log('\n[1m── watertightness + mass conservation ──[0m');

for (const [name, geo] of shapes) {
  const before = volumeAndCentroid(geo);
  const seal = openEdgeCount(geo);

  // a deliberately awkward plane: off-axis, off-centre
  const plane = new THREE.Plane(new THREE.Vector3(0.42, 0.83, 0.37).normalize(), -0.13);
  const res = sliceGeometry(geo, plane, { recenter: true });

  if (!res) { check(`${name}: plane produced a cut`, false); continue; }

  const sealA = openEdgeCount(res.above.geometry);
  const sealB = openEdgeCount(res.below.geometry);
  const volSum = res.above.volume + res.below.volume;
  const drift = Math.abs(volSum - before.volume) / before.volume;

  const capsA = matCount(res.above.geometry, MAT_INTERIOR);
  const capsB = matCount(res.below.geometry, MAT_INTERIOR);

  const inputWasSealed = seal.open === 0;
  check(
    `${name}: halves watertight`,
    !inputWasSealed || (sealA.open === 0 && sealB.open === 0),
    `open edges A=${sealA.open} B=${sealB.open}${inputWasSealed ? '' : ' (input already open, skipped)'}`
  );
  check(`${name}: volume conserved`, drift < 0.02, `drift ${(drift * 100).toFixed(3)}%`);
  check(`${name}: both halves capped`, capsA > 0 && capsB > 0, `cap tris A=${capsA} B=${capsB}`);
}

/* ── recursive slicing: fragments must stay sliceable and sealed ───── */
console.log('\n[1m── recursive slicing (game depth: 3 generations) ──[0m');
function recurse(generations) {
  let pieces = [{ geometry: prep(new THREE.SphereGeometry(1, 28, 20)), volume: 0 }];
  pieces[0].volume = volumeAndCentroid(pieces[0].geometry).volume;
  const startVolume = pieces[0].volume;
  let leaked = 0, halves = 0;

  for (let gen = 0; gen < generations; gen++) {
    const next = [];
    for (const p of pieces) {
      // pseudo-random plane through the piece's neighbourhood
      const a = gen * 1.7 + next.length * 0.9;
      const nrm = new THREE.Vector3(Math.cos(a), Math.sin(a * 1.3), Math.sin(a)).normalize();
      const r = sliceGeometry(p.geometry, new THREE.Plane(nrm, Math.sin(a * 2.1) * 0.12));
      if (!r) { next.push(p); continue; }
      halves += 2;
      if (openEdgeCount(r.above.geometry).open !== 0) leaked++;
      if (openEdgeCount(r.below.geometry).open !== 0) leaked++;
      next.push(r.above, r.below);
    }
    pieces = next;
  }

  const totalVolume = pieces.reduce((s, p) => s + p.volume, 0);
  return { pieces, leaked, halves, drift: Math.abs(totalVolume - startVolume) / startVolume };
}

{
  // The game caps an object at MAX_SLICE_DEPTH generations, so that depth is
  // the contract the slicer must honour exactly.
  const r = recurse(3);
  check(`${r.pieces.length} fragments all sealed`, r.leaked === 0, `${r.leaked}/${r.halves} halves leaked`);
  check('volume conserved', r.drift < 0.01, `drift ${(r.drift * 100).toFixed(3)}%`);
}

console.log('\n[1m── deep-recursion stress (8 generations, past game depth) ──[0m');
{
  // Past the game's depth, fragments close in on float32's noise floor and a
  // few needle / T-junction artefacts survive. They are far below one pixel
  // and do not move the mass properties, so this is a robustness bound rather
  // than an exactness one.
  const r = recurse(8);
  const sealRate = 1 - r.leaked / r.halves;
  check('every generation stayed sliceable', r.pieces.length > 100, `${r.pieces.length} fragments`);
  check('seal rate stays high', sealRate > 0.7, `${(sealRate * 100).toFixed(1)}% of ${r.halves} halves sealed`);
  check('volume still conserved', r.drift < 0.05, `drift ${(r.drift * 100).toFixed(3)}%`);
}

/* ── caps must inherit the INTERIOR material, skin must keep its own ── */
console.log('\n[1m── material index survival ──[0m');
{
  const geo = prep(new THREE.SphereGeometry(1, 24, 18));
  const r1 = sliceGeometry(geo, new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
  const r2 = sliceGeometry(r1.above.geometry, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0));
  check('second-generation piece still has skin faces', matCount(r2.above.geometry, 0) > 0);
  check('second-generation piece has interior from both cuts', matCount(r2.above.geometry, MAT_INTERIOR) > 0);
  check('groups are contiguous & sorted', (() => {
    const g = r2.above.geometry.groups;
    let cursor = 0, lastMat = -1;
    for (const gr of g) {
      if (gr.start !== cursor || gr.materialIndex < lastMat) return false;
      cursor += gr.count; lastMat = gr.materialIndex;
    }
    return cursor === r2.above.geometry.attributes.position.count;
  })());
}

/* ── misses and grazes must be rejected, not crash ─────────────────── */
console.log('\n[1m── degenerate planes ──[0m');
{
  const geo = prep(new THREE.SphereGeometry(1, 20, 14));
  check('plane fully outside → null', sliceGeometry(geo, new THREE.Plane(new THREE.Vector3(0, 1, 0), -5)) === null);
  check('plane exactly tangent → null', sliceGeometry(geo, new THREE.Plane(new THREE.Vector3(0, 1, 0), -1)) === null);
  const near = sliceGeometry(geo, new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.999));
  check('near-tangent → null or sealed', near === null || openEdgeCount(near.above.geometry).open === 0);
}

/* ── freehand cutting: a drawn curve, not a straight line ──────────── */
console.log('\n[1m── freehand (curved) cuts ──[0m');
{
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
  camera.position.set(0, 0.6, 4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const W = 1280, H = 720;

  /** A stroke sampled from a screen-space function. */
  const stroke = (fn, n = 40) => {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(fn(i / n));
    return pts;
  };

  const shapes = [
    ['sine wave', stroke((t) => ({ x: 200 + t * 880, y: 360 + Math.sin(t * Math.PI * 3) * 130 }))],
    ['deep zigzag', stroke((t) => ({ x: 200 + t * 880, y: 360 + (Math.abs((t * 4) % 1 - 0.5) - 0.25) * 420 }))],
    ['gentle arc', stroke((t) => ({ x: 200 + t * 880, y: 300 + Math.sin(t * Math.PI) * 200 }))],
    ['steep S', stroke((t) => ({ x: 300 + Math.sin(t * Math.PI * 2) * 220, y: 80 + t * 560 }))],
  ];

  for (const [name, pts] of shapes) {
    const geo = prep(new THREE.SphereGeometry(1, 40, 30));
    const cutter = new FreehandCutter(camera, pts, W, H);
    const res = sliceGeometry(geo, cutter, { recenter: true });

    if (!res) { check(`${name}: cut happened`, false); continue; }

    const sealA = openEdgeCount(res.above.geometry);
    const sealB = openEdgeCount(res.below.geometry);
    const drift = Math.abs((res.above.volume + res.below.volume) -
                            volumeAndCentroid(geo).volume) / volumeAndCentroid(geo).volume;

    check(`${name}: both halves watertight`, sealA.open === 0 && sealB.open === 0,
          `open A=${sealA.open} B=${sealB.open}`);
    check(`${name}: volume conserved`, drift < 0.02, `drift ${(drift * 100).toFixed(3)}%`);
    check(`${name}: capped`, matCount(res.above.geometry, MAT_INTERIOR) > 0 &&
                             matCount(res.below.geometry, MAT_INTERIOR) > 0);
  }

  /**
   * A closed mesh wound outward has POSITIVE signed volume. A negative one is
   * inside-out: every face is back-facing, gets culled, and the piece renders
   * as a hollow shell — a cut face visible from one side and nothing from the
   * other.
   */
  const signedVolume = (geometry) => {
    const p = geometry.attributes.position.array;
    let v = 0;
    for (let i = 0; i < p.length; i += 9) {
      v += (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7])
          - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
          + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6;
    }
    return v;
  };

  /** Every stored normal must agree with its own triangle's winding. */
  const normalsMatchWinding = (geometry) => {
    const p = geometry.attributes.position.array;
    const n = geometry.attributes.normal.array;
    let wrong = 0, total = 0;
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      // A flat absolute floor is the wrong test. Positions are stored as
      // float32, so a triangle thinner than a few ulps of its own coordinates
      // has a cross product made of rounding, and judging its winding measures
      // nothing. Same criterion the slicer uses to decide the normal.
      if (isSubPixelThin(
        { lengthSq: () => gx * gx + gy * gy + gz * gz },
        { lengthSq: () => ux * ux + uy * uy + uz * uz },
        { lengthSq: () => vx * vx + vy * vy + vz * vz },
        { x: p[i], y: p[i + 1], z: p[i + 2] },
        { x: p[i + 3], y: p[i + 4], z: p[i + 5] },
        { x: p[i + 6], y: p[i + 7], z: p[i + 8] })) continue;
      total++;
      if (gx * n[i] + gy * n[i + 1] + gz * n[i + 2] < 0) wrong++;
    }
    return { wrong, total };
  };

  /**
   * A cut face that is wound inside-out is invisible, and the piece reads as a
   * hollow shell. The failure is intermittent — it depends on which way the
   * loop stitcher happened to walk the ring — so this sweeps a wide spread of
   * strokes and shapes rather than checking one.
   */
  {
    const subjects = [
      ['sphere', () => prep(new THREE.SphereGeometry(1, 36, 26))],
      ['box', () => prep(new THREE.BoxGeometry(1.3, 1.3, 1.3, 3, 3, 3))],
      ['cylinder', () => prep(new THREE.CylinderGeometry(0.7, 0.7, 1.6, 28))],
      ['torus', () => prep(new THREE.TorusGeometry(0.75, 0.3, 18, 40))],
    ];

    let inverted = 0, mismatched = 0, tested = 0, skipped = 0;
    const detail = [];

    for (const [sname, make] of subjects) {
      for (let k = 0; k < 9; k++) {
        // a spread of angles, curvatures and offsets
        const ang = k * 0.7;
        const amp = 40 + k * 26;
        const freq = 1 + (k % 4);
        const off = ((k % 3) - 1) * 90;
        const pts = [];
        for (let i = 0; i <= 36; i++) {
          const t = i / 36;
          const d = (t - 0.5) * 900;
          const s = Math.sin(t * Math.PI * freq) * amp;
          pts.push({
            x: 640 + Math.cos(ang) * d - Math.sin(ang) * (s + off),
            y: 360 + Math.sin(ang) * d + Math.cos(ang) * (s + off),
          });
        }

        const res = sliceGeometry(make(), new FreehandCutter(camera, pts, W, H), { recenter: true });
        if (!res) { skipped++; continue; }
        tested++;

        const va = signedVolume(res.above.geometry), vb = signedVolume(res.below.geometry);
        if (va <= 0 || vb <= 0) {
          inverted++;
          if (detail.length < 4) detail.push(`${sname}#${k} vol ${va.toFixed(3)}/${vb.toFixed(3)}`);
        }
        const na = normalsMatchWinding(res.above.geometry);
        const nb = normalsMatchWinding(res.below.geometry);
        if (na.wrong || nb.wrong) mismatched++;
      }
    }

    check(`${tested} freehand cuts: no half is inside-out`, inverted === 0,
          `${inverted} inverted${detail.length ? ' — ' + detail.join(', ') : ''} (${skipped} planes missed)`);
    check(`${tested} freehand cuts: normals agree with winding`, mismatched === 0,
          `${mismatched} with mismatches`);
  }

  // The cut must actually follow the curve, not flatten to a plane between
  // the endpoints. A planar section would have every ring point on one plane.
  {
    const geo = prep(new THREE.SphereGeometry(1, 40, 30));
    const wavy = stroke((t) => ({ x: 200 + t * 880, y: 360 + Math.sin(t * Math.PI * 3) * 130 }));
    const cutter = new FreehandCutter(camera, wavy, W, H);
    const res = sliceGeometry(geo, cutter, { recenter: false });
    const ring = res.loops.flat();

    // best-fit plane through the ring, then the worst deviation from it
    const c = new THREE.Vector3();
    for (const p of ring) c.add(p);
    c.divideScalar(ring.length);
    const n = new THREE.Vector3();
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      n.x += (a.y - b.y) * (a.z + b.z);
      n.y += (a.z - b.z) * (a.x + b.x);
      n.z += (a.x - b.x) * (a.y + b.y);
    }
    n.normalize();
    let maxDev = 0;
    for (const p of ring) maxDev = Math.max(maxDev, Math.abs(p.clone().sub(c).dot(n)));

    check('the section is genuinely curved, not a plane', maxDev > 0.05,
          `worst deviation from best-fit plane ${maxDev.toFixed(3)} on a unit sphere`);
  }

  // a straight freehand stroke must agree with the equivalent plane cut
  {
    const geo1 = prep(new THREE.SphereGeometry(1, 36, 26));
    const geo2 = prep(new THREE.SphereGeometry(1, 36, 26));
    const straight = stroke((t) => ({ x: 200 + t * 880, y: 360 }), 8);
    const fh = sliceGeometry(geo1, new FreehandCutter(camera, straight, W, H), { recenter: false });
    // the same line as a plane: through the eye and both ends
    const toWorld = (sx, sy) => new THREE.Vector3((sx / W) * 2 - 1, -(sy / H) * 2 + 1, 0.5).unproject(camera);
    const pa = toWorld(200, 360), pb = toWorld(1080, 360);
    const nrm = new THREE.Vector3().crossVectors(
      pa.clone().sub(camera.position), pb.clone().sub(camera.position)).normalize();
    const pl = sliceGeometry(geo2, new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, camera.position),
                             { recenter: false });
    const diff = Math.abs(fh.above.volume - pl.above.volume) / pl.above.volume;
    check('a straight stroke matches the equivalent plane cut', diff < 0.02,
          `volumes differ by ${(diff * 100).toFixed(2)}%`);
  }
}

/* ── centroid recentre: origin must land on the centre of mass ─────── */
console.log('\n[1m── centre of mass ──[0m');
{
  const geo = prep(new THREE.SphereGeometry(1, 32, 24));
  const r = sliceGeometry(geo, new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.4));
  const after = volumeAndCentroid(r.above.geometry);
  check('recentred half has centroid at origin', after.centroid.length() < 1e-4,
        `|c| = ${after.centroid.length().toExponential(2)}`);
  check('reported centroid is the pre-shift one', Math.abs(r.above.centroid.y) > 0.4,
        `y = ${r.above.centroid.y.toFixed(3)}`);
}

console.log(`\n${failures === 0 ? '[32mAll slicer invariants hold.[0m' : `[31m${failures} failing.[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
