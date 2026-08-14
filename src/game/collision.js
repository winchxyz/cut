import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  CONVEX COLLISION
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Cut fragments have to stop passing through each other, which means
 *  real shape-against-shape contact rather than the bounding-sphere
 *  repulsion this used to have. (Spheres were worse than nothing: two
 *  halves of a freshly cut object always have overlapping bounding
 *  spheres, so they shoved each other apart forever.)
 *
 *  Each body gets a convex hull built from support points — the extreme
 *  vertex in each of 26 directions. Contacts are found by testing the
 *  vertices of one hull against the face planes of the other, in both
 *  directions. That produces several contact points for a face resting
 *  on a face, which is exactly what a stack needs to stay put; a single
 *  deepest-point contact would let flat pieces rock endlessly.
 *
 *  What this does not catch is a pure edge-against-edge crossing with no
 *  vertex inside either hull. In a pile of sawn fragments that case is
 *  rare and shallow, and the next frame's motion resolves it.
 */

/** 26 directions: 6 faces, 12 edges, 8 corners of a cube. */
export const HULL_DIRS = (() => {
  const d = [];
  for (const v of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) d.push(v);
  for (const v of [[1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
                   [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
                   [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1]]) d.push(v);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) d.push([sx, sy, sz]);
  return d.map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());
})();

/** The same directions, flat, for the support scan's inner loop. */
const HULL_DIRS_FLAT = (() => {
  const f = new Float32Array(HULL_DIRS.length * 3);
  HULL_DIRS.forEach((v, i) => { f[i * 3] = v.x; f[i * 3 + 1] = v.y; f[i * 3 + 2] = v.z; });
  return f;
})();

/**
 * Convex hull of a geometry, as local-space vertices plus face planes.
 * Planes follow three's ConvexHull convention: distance = n·p - c, inside < 0.
 */
export function buildHull(geometry) {
  const pos = geometry.attributes.position.array;
  const n = pos.length / 3;

  // Support points, so the hull is built from the extremes rather than every
  // vertex of a several-thousand-triangle mesh. The directions are read from a
  // flat Float32Array rather than an array of Vector3s: this is 26 property
  // lookups per vertex otherwise, and it runs on every fragment a cut creates.
  const D = HULL_DIRS.length;
  const best = new Float32Array(D).fill(-Infinity);
  const idx = new Int32Array(D).fill(-1);
  const dirs = HULL_DIRS_FLAT;
  for (let i = 0; i < n; i++) {
    const p = i * 3;
    const x = pos[p], y = pos[p + 1], z = pos[p + 2];
    for (let d = 0; d < D; d++) {
      const q = d * 3;
      const dot = x * dirs[q] + y * dirs[q + 1] + z * dirs[q + 2];
      if (dot > best[d]) { best[d] = dot; idx[d] = i; }
    }
  }

  const points = [];
  const seen = new Set();
  for (const i of idx) {
    if (i < 0) continue;
    const key = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
  }

  // a hull needs four non-coplanar points; anything less is a degenerate chip
  if (points.length < 4) return null;

  let hull;
  try {
    hull = new ConvexHull().setFromPoints(points);
  } catch (e) {
    return null;
  }
  if (!hull.faces || hull.faces.length === 0) return null;

  const planes = [];
  const verts = [];
  const vseen = new Set();

  for (const face of hull.faces) {
    // merge faces that lie in the same plane — a hull over 26 support points
    // often produces several coplanar triangles, and every duplicate plane is
    // pure cost in the inner loop
    let dup = false;
    for (let i = 0; i < planes.length; i += 4) {
      if (planes[i] * face.normal.x + planes[i + 1] * face.normal.y + planes[i + 2] * face.normal.z > 0.9995 &&
          Math.abs(planes[i + 3] - face.constant) < 1e-4) { dup = true; break; }
    }
    if (!dup) planes.push(face.normal.x, face.normal.y, face.normal.z, face.constant);

    let edge = face.edge;
    do {
      const p = edge.head().point;
      const key = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
      if (!vseen.has(key)) { vseen.add(key); verts.push(p.x, p.y, p.z); }
      edge = edge.next;
    } while (edge !== face.edge);
  }

  return {
    verts: new Float32Array(verts),
    planes: new Float32Array(planes),
    vertCount: verts.length / 3,
    planeCount: planes.length / 4,
  };
}

/**
 * Transform a body's hull into world space.
 * A plane n·p = c becomes n' = q·n, c' = c + n'·t.
 */
export function transformHull(hull, quaternion, position, out) {
  const vc = hull.vertCount, pc = hull.planeCount;
  if (!out.verts || out.verts.length !== vc * 3) {
    out.verts = new Float32Array(vc * 3);
    out.planes = new Float32Array(pc * 4);
  }

  for (let i = 0; i < vc; i++) {
    _v.set(hull.verts[i * 3], hull.verts[i * 3 + 1], hull.verts[i * 3 + 2])
      .applyQuaternion(quaternion).add(position);
    out.verts[i * 3] = _v.x; out.verts[i * 3 + 1] = _v.y; out.verts[i * 3 + 2] = _v.z;
  }

  for (let i = 0; i < pc; i++) {
    _v.set(hull.planes[i * 4], hull.planes[i * 4 + 1], hull.planes[i * 4 + 2])
      .applyQuaternion(quaternion);
    out.planes[i * 4] = _v.x;
    out.planes[i * 4 + 1] = _v.y;
    out.planes[i * 4 + 2] = _v.z;
    out.planes[i * 4 + 3] = hull.planes[i * 4 + 3] + _v.dot(position);
  }
  out.vertCount = vc;
  out.planeCount = pc;
  return out;
}

/**
 * Best separating axis among `ref`'s face normals.
 *
 * For each face plane, the separation is how far the *nearest* vertex of the
 * other hull sits above it. Positive on any axis means the two are apart. The
 * axis we want is the one with the largest separation — the shallowest way out.
 *
 * @returns {number} index of the best plane, and writes its separation to
 *          `_sep[0]`. Returns -1 as soon as a separating axis is found.
 */
function bestAxis(ref, other, margin) {
  const pc = ref.planeCount, vc = other.vertCount;
  const rp = ref.planes, ov = other.verts;

  let best = -Infinity, bestIdx = -1;
  for (let p = 0; p < pc; p++) {
    const nx = rp[p * 4], ny = rp[p * 4 + 1], nz = rp[p * 4 + 2], c = rp[p * 4 + 3];
    let mn = Infinity;
    for (let i = 0; i < vc; i++) {
      const d = nx * ov[i * 3] + ny * ov[i * 3 + 1] + nz * ov[i * 3 + 2] - c;
      if (d < mn) mn = d;
    }
    if (mn > margin) { _sep[0] = mn; return -1; }   // genuinely apart: stop early
    if (mn > best) { best = mn; bestIdx = p; }
  }
  _sep[0] = best;
  return bestIdx;
}

/**
 * Contacts between two world-space hulls, normals pointing from A to B.
 *
 * The axis is chosen by SAT over both hulls' face normals, and then *every*
 * contact uses that single axis. Picking a separate exit plane per vertex — the
 * obvious way to do it — breaks on the case that matters most here: two flat
 * pieces stacked in line. Their corners sit exactly on each other's side faces,
 * so a per-vertex search finds a zero-depth sideways exit and shoves the top
 * piece off. SAT sees the side axes as merely touching and correctly picks the
 * vertical one.
 */
export function hullContacts(a, b, maxContacts = 6, margin = CONTACT_MARGIN) {
  const ia = bestAxis(a, b, margin);
  if (ia < 0) return EMPTY;
  const sepA = _sep[0];

  const ib = bestAxis(b, a, margin);
  if (ib < 0) return EMPTY;
  const sepB = _sep[0];

  // reference face = the shallower penetration of the two
  let refHull, incHull, planeIdx, sign;
  if (sepA >= sepB) { refHull = a; incHull = b; planeIdx = ia; sign = 1; }
  else { refHull = b; incHull = a; planeIdx = ib; sign = -1; }

  const rp = refHull.planes;
  const nx = rp[planeIdx * 4], ny = rp[planeIdx * 4 + 1], nz = rp[planeIdx * 4 + 2];
  const c = rp[planeIdx * 4 + 3];

  // Everything of the incident hull that has crossed the reference plane.
  // For a face resting on a face this yields the whole footprint, which is
  // what stops a stack from rocking.
  const out = [];
  const iv = incHull.verts;
  for (let i = 0; i < incHull.vertCount; i++) {
    const x = iv[i * 3], y = iv[i * 3 + 1], z = iv[i * 3 + 2];
    const d = nx * x + ny * y + nz * z - c;
    // Points a hair outside still count, with a negative depth. Dropping a
    // contact the instant two pieces stop overlapping lets the upper one
    // free-fall for a step and pick up a full step of gravity, which is
    // enough to keep a perfectly settled stack awake indefinitely.
    if (d > margin) continue;

    const depth = -d;
    if (out.length >= maxContacts) {
      let shallowest = 0;
      for (let k = 1; k < out.length; k++) if (out[k].depth < out[shallowest].depth) shallowest = k;
      if (out[shallowest].depth >= depth) continue;
      out.splice(shallowest, 1);
    }
    out.push({ px: x, py: y, pz: z, nx: nx * sign, ny: ny * sign, nz: nz * sign, depth });
  }
  return out;
}

const _sep = new Float64Array(1);
const EMPTY = [];

/** How close two hulls must be before they are treated as in contact. */
export const CONTACT_MARGIN = 0.012;

const _v = new THREE.Vector3();
