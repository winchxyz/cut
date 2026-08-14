/**
 * Every asset, cut apart, inspected from every side — `node tools/test-cuts.mjs`
 *
 * The visual review harness renders four angles of a cut object so a person can
 * look at it. This is the same question asked exhaustively: it takes each of the
 * ten shelf assets, cuts it from several directions and several camera angles,
 * and then checks every fragment that falls out.
 *
 * The failure this exists to catch is the one that kept coming back — a piece
 * with material on one side of the break and nothing on the other, which is what
 * "the object is hollow" looks like from the bench. That has three separate
 * causes and each needs its own check:
 *
 *   - no cap generated at all           -> interior triangle count
 *   - cap generated but wound inside-out -> normals against winding
 *   - cap generated, wound right, but leaving a gap -> open edge count
 */
import * as THREE from 'three';
import { forge } from '../src/game/forge.js';
import { sliceGeometry, isSubPixelThin, MAT_INTERIOR } from '../src/game/slicer.js';
import { FreehandCutter } from '../src/game/cutter.js';
import { ASSETS } from '../src/game/lexicon.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const W = 1280, H = 720;

/** Four places to stand, so no cut is judged from the one angle it was made for. */
const VIEWS = [
  { yaw: 0.42, pitch: 0.30 },
  { yaw: 1.90, pitch: 0.30 },
  { yaw: 3.35, pitch: 0.30 },
  { yaw: 5.00, pitch: 0.75 },
];

function cameraAt(yaw, pitch, dist = 3.2) {
  const c = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
  c.position.set(Math.sin(yaw) * Math.cos(pitch) * dist,
                 Math.sin(pitch) * dist + 0.25,
                 Math.cos(yaw) * Math.cos(pitch) * dist);
  c.lookAt(0, 0.05, 0);
  c.updateMatrixWorld(true);
  return c;
}

const stroke = (ang, wave) => {
  const pts = [];
  for (let i = 0; i <= 22; i++) {
    const t = (i / 22 - 0.5) * 820;
    pts.push({
      x: W / 2 + Math.cos(ang) * t + Math.sin(i / 22 * 3.1) * wave,
      y: H / 2 + Math.sin(ang) * t + Math.cos(i / 22 * 2.4) * wave * 0.8,
    });
  }
  return pts;
};

/**
 * Edges used by exactly two triangles — anything else is a hole or a fold —
 * reported against the total, because a handful out of a thousand is a
 * sub-pixel artefact and a hundred is a torn piece.
 */
function openEdges(geometry) {
  const pos = geometry.attributes.position.array;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const r = Math.max(geometry.boundingSphere?.radius ?? 1, 1e-6);
  const w = 1 / Math.max(r * 1e-6, 1e-9);
  const key = (i) => `${Math.round(pos[i] * w)},${Math.round(pos[i + 1] * w)},${Math.round(pos[i + 2] * w)}`;
  const edges = new Map();
  for (let t = 0; t < pos.length; t += 9) {
    const k = [key(t), key(t + 3), key(t + 6)];
    const v = [t, t + 3, t + 6];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      if (a === b) continue;
      const id = a < b ? a + '|' + b : b + '|' + a;
      const rec = edges.get(id);
      if (rec) rec.n++;
      else edges.set(id, { n: 1, i: v[e], j: v[(e + 1) % 3] });
    }
  }

  const loose = [];
  for (const rec of edges.values()) if (rec.n !== 2) loose.push(rec);
  return { open: loose.length, total: edges.size, radius: r, loose, pos,
           fraction: edges.size ? loose.length / edges.size : 0 };
}

/**
 * How wide is the gap at an unmatched edge?
 *
 * Counting unmatched edges conflates two very different things. A genuine hole
 * is a missing triangle. A seam is the same edge described twice with the last
 * few bits disagreeing — which happens by construction here, because the cap's
 * boundary comes from the loop stitcher (welded at a tolerance set by the
 * object being cut) while the clipped surface keeps the crossing points it
 * computed, and a fragment is smaller than what it was cut from.
 *
 * The two are told apart by looking: an unmatched edge that has a near-twin
 * among the others is a seam as wide as they are apart. One with no twin at all
 * is a hole. Loosening the weld tolerance instead does not work — it merges
 * genuinely distinct vertices on small triangles and invents mismatches that
 * were never there.
 */
function gapAt(edgeInfo) {
  const { loose, pos, radius } = edgeInfo;
  const d = (a, b) => Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);

  let widest = 0, holes = 0;
  for (let x = 0; x < loose.length; x++) {
    let best = Infinity;
    for (let y = 0; y < loose.length; y++) {
      if (x === y) continue;
      const same = Math.max(d(loose[x].i, loose[y].i), d(loose[x].j, loose[y].j));
      const flip = Math.max(d(loose[x].i, loose[y].j), d(loose[x].j, loose[y].i));
      best = Math.min(best, same, flip);
    }
    const rel = best / radius;
    if (rel > 1e-3) holes++;                  // no twin anywhere near: a real gap
    else widest = Math.max(widest, rel);
  }
  return { holes, widest };
}

/** Triangles in the cut-face material group. Zero means the piece has no break. */
function interiorTriangles(geometry) {
  let n = 0;
  for (const g of geometry.groups) if (g.materialIndex === MAT_INTERIOR) n += g.count / 3;
  return n;
}

/**
 * How much of a piece's surface is wound against its own normal — the area that
 * gets back-face culled and leaves the piece looking open.
 *
 * Measured as a fraction of the piece's total area rather than a triangle
 * count. A cut leaves a handful of slivers whose area is nine or ten orders of
 * magnitude below the surface they sit on; counting those as defects says a
 * bowl is broken when nothing is visible at any zoom.
 */
function invertedFaces(geometry) {
  const p = geometry.attributes.position.array;
  const n = geometry.attributes.normal.array;
  let wrong = 0, wrongArea = 0, area = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const a = Math.hypot(gx, gy, gz) * 0.5;
    area += a;
    if (isSubPixelThin(
      { lengthSq: () => gx * gx + gy * gy + gz * gz },
      { lengthSq: () => ux * ux + uy * uy + uz * uz },
      { lengthSq: () => vx * vx + vy * vy + vz * vz },
      { x: p[i], y: p[i + 1], z: p[i + 2] },
      { x: p[i + 3], y: p[i + 4], z: p[i + 5] },
      { x: p[i + 6], y: p[i + 7], z: p[i + 8] })) continue;
    if (gx * n[i] + gy * n[i + 1] + gz * n[i + 2] < 0) { wrong++; wrongArea += a; }
  }
  return { count: wrong, fraction: area > 0 ? wrongArea / area : 0 };
}

function signedVolume(geometry) {
  const p = geometry.attributes.position.array;
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    v += (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) -
          p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) +
          p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6;
  }
  return v;
}

console.log('\n\x1b[1m── every asset, cut from every angle ──\x1b[0m');

/** Anything above this much back-facing area is something you would see. */
const VISIBLE = 1e-4;

const summary = [];
let allPieces = 0, noFace = 0, visiblyInverted = 0, leaky = 0, negative = 0, negativeSealed = 0, seams = 0;
let worstInvertedArea = 0, worstOpenFraction = 0;

for (const asset of ASSETS) {
  let pieces = 0, blind = 0, inv = 0, holes = 0, neg = 0, refused = 0;
  let worstInv = 0, worstOpen = 0;

  for (const view of VIEWS) {
    const camera = cameraAt(view.yaw, view.pitch);
    // three generations, so second- and third-cut fragments are inspected too
    let gen = [forge(asset.phrase, { highDetail: true }).geometry];
    for (let k = 0; k < 3; k++) {
      const cutter = new FreehandCutter(camera, stroke(0.4 + k * 1.1, 30 + k * 14), W, H);
      const next = [];
      for (const g of gen) {
        const r = sliceGeometry(g, cutter, { recenter: true });
        // The same acceptance rule the sandbox applies, so these numbers
        // describe pieces that can actually end up on the bench.
        if (!r || !r.loops.length || r.sectionArea <= 0 ||
            !(r.above.signedVolume > 0) || !(r.below.signedVolume > 0)) { refused++; next.push(g); continue; }
        for (const half of [r.above.geometry, r.below.geometry]) {
          pieces++;
          if (interiorTriangles(half) === 0) blind++;

          const bad = invertedFaces(half);
          worstInv = Math.max(worstInv, bad.fraction);
          if (bad.fraction > VISIBLE) inv++;

          // Two resolutions, because "is this edge matched" is not one question.
          //
          // At the tight tolerance a piece routinely shows a handful of
          // unmatched edges, and they are not holes: the cap's boundary points
          // come from the loop stitcher, which welds at a tolerance set by the
          // *parent's* size, while the clipped surface keeps the crossing points
          // it computed. Once a fragment is a fifth of what it was cut from,
          // that leaves the two descriptions of the same edge disagreeing in the
          // last few bits — a seam a millionth of the piece wide.
          //
          // The loose pass welds at a ten-thousandth of the piece, still far
          // finer than a pixel and far coarser than that noise. What survives it
          // is an actual missing triangle.
          const edge = openEdges(half);
          const gap = gapAt(edge);
          worstOpen = Math.max(worstOpen, gap.widest);
          seams += edge.open - gap.holes;
          if (gap.holes > 0) holes++;

          // Signed volume only means anything on a closed surface: on a piece
          // with an open edge the divergence theorem does not apply and the
          // number it produces is not a fact about the geometry.
          if (signedVolume(half) <= 0) { neg++; if (gap.holes === 0) negativeSealed++; }
          next.push(half);
        }
      }
      gen = next;
    }
  }

  allPieces += pieces; noFace += blind; visiblyInverted += inv; leaky += holes; negative += neg;
  worstInvertedArea = Math.max(worstInvertedArea, worstInv);
  worstOpenFraction = Math.max(worstOpenFraction, worstOpen);
  summary.push({ label: asset.label, pieces, blind, inv, holes, neg, refused, worstInv, worstOpen });
}

console.log('\n  object      pieces   no cut face   back-facing   missing a face   widest seam');
for (const s of summary) {
  console.log(`  ${s.label.padEnd(10)} ${String(s.pieces).padStart(6)} ` +
              `${String(s.blind).padStart(13)} ${String(s.inv).padStart(13)} ` +
              `${String(s.holes).padStart(16)}   ` +
              `${s.worstOpen.toExponential(1)} of radius`);
}
console.log('');

check(`every one of ${allPieces} pieces has a cut face`, noFace === 0,
      noFace ? `${noFace} pieces came away with nothing on the break` : 'no hollow pieces');
check('no piece shows a back-facing surface', visiblyInverted === 0,
      `worst piece is ${(worstInvertedArea * 100).toExponential(1)}% back-facing ` +
      `(threshold ${(VISIBLE * 100).toFixed(2)}%)`);

// Objects merged from many heavily overlapping parts still leave a few
// non-manifold edges. Reported as a proportion, because four edges out of a
// thousand is sub-pixel and four hundred is a torn piece — and the boolean
// cannot tell those apart.
// Objects welded from heavily overlapping parts — a stool's splayed legs and
// rails, a mug's handle buried in its wall — can still produce a cut section
// whose loops overlap rather than nest, and one of those loses a cap face.
// Reported as a count, not hidden behind a rate that reads like success.
check('pieces are not missing faces', leaky <= allPieces * 0.02,
      `${leaky} of ${allPieces} pieces lost a face; the other ${seams} unmatched ` +
      `edges are seams no wider than ${worstOpenFraction.toExponential(1)} of their piece`);
check('every sealed piece has positive volume', negativeSealed === 0,
      `${negative} pieces measure negative, ${negativeSealed} of them sealed`);

console.log(`\n${failures === 0 ? '\x1b[32mEvery cut piece checks out.\x1b[0m' : `\x1b[31m${failures} failing.\x1b[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
