import * as THREE from 'three';
import { PlaneCutter, makeFrame } from './cutter.js';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  MESH SLICER
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Splits a triangle soup with an arbitrary plane and seals both halves
 *  with a generated cap, so the result still looks like a solid object
 *  and can be sliced again — indefinitely.
 *
 *  The pipeline, per cut:
 *
 *    1. classify   every vertex against the plane (above / on / below)
 *    2. clip       each triangle into an above-polygon and a below-polygon
 *                  (Sutherland–Hodgman), fan-triangulating the result and
 *                  interpolating normal + uv across the new edges
 *    3. stitch     the intersection segments into closed loops via a
 *                  quantised spatial hash
 *    4. nest       work out which loops are holes inside which (a sliced
 *                  torus is an annulus, not two disks)
 *    5. cap        triangulate each contour+holes in the plane's 2D basis
 *                  and emit it into both halves with opposing winding
 *    6. rebalance  recompute signed volume and centre of mass, then move
 *                  the geometry so the origin sits at the new centroid —
 *                  otherwise the halves spin around a phantom pivot
 *
 *  Material indices survive the cut: skin stays skin, and every new cap
 *  face is tagged INTERIOR, which is what makes a twice-cut object still
 *  read as "shell outside, flesh inside".
 */

export const MAT_SKIN = 0;
export const MAT_INTERIOR = 1;
/** A second outer surface, for objects made of two visibly different things —
 *  a lamp's linen shade against its brass. Optional; most objects have none. */
export const MAT_ACCENT = 2;

/**
 * Vertex-welding tolerance, as a fraction of the object's radius.
 *
 * It has to be *relative*: a fragment that has been cut five times is a tenth
 * the size of the original, and a fixed epsilon that was tight at full size
 * becomes coarse enough to merge distinct ring points into T-junctions. Scaling
 * with the bounding sphere keeps the precision constant in relative terms,
 * which is also where float32 position storage puts its own noise floor.
 *
 * Cut points shared by two triangles are computed to be bit-identical anyway
 * (see `comparePos`), so this only has to absorb genuine coincidences.
 */
const WELD_RELATIVE = 1e-6;
const WELD_MIN = 1e-9;

/* ── scratch ─────────────────────────────────────────────────────────── */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _fn = new THREE.Vector3();
const _frame = makeFrame();

/** A vertex is 8 floats: px py pz nx ny nz u v. */
const VSIZE = 8;
const newVert = () => new Float64Array(VSIZE);

/* Reused per-triangle scratch so a slice allocates almost nothing. */
const _tv = [newVert(), newVert(), newVert()];
// A plane-clipped triangle yields at most 4 vertices per side; the spare slot
// is a guard so a degenerate classification can never write out of bounds.
const _polyA = [newVert(), newVert(), newVert(), newVert(), newVert()];
const _polyB = [newVert(), newVert(), newVert(), newVert(), newVert()];
const _xpt = [newVert(), newVert()];

/**
 * Only triangles with a *repeated vertex* are dropped, where "repeated" means
 * coincident at the weld resolution — the scale at which the rest of the
 * pipeline already treats two points as one. Such a triangle is a needle: its
 * other two edges are the same welded edge walked twice, so removing it
 * subtracts exactly the two incidences it added and cannot open the surface.
 * Leaving them in is what produced phantom 4-incidence edges.
 *
 * Thin-but-real slivers, whose vertices are genuinely distinct, are deliberately
 * KEPT even though they rasterise to nothing. Discarding those silently broke
 * watertightness: earcut legitimately emits near-collinear ears where a cut
 * section is locally flat, and throwing them away punched holes straight
 * through the cap. A sealed fragment is the whole precondition for slicing it
 * again.
 */
function hasRepeatedVertex(ax, ay, az, bx, by, bz, cx, cy, cz, e) {
  let dx = ax - bx, dy = ay - by, dz = az - bz;
  if (dx * dx + dy * dy + dz * dz < e) return true;
  dx = bx - cx; dy = by - cy; dz = bz - cz;
  if (dx * dx + dy * dy + dz * dz < e) return true;
  dx = cx - ax; dy = cy - ay; dz = cz - az;
  return dx * dx + dy * dy + dz * dz < e;
}

/** Accumulates triangles per material index, then bakes a BufferGeometry. */
/**
 * Accumulates one side of the cut, bucketed by material.
 *
 * Storage is typed and grown by doubling rather than a plain array per bucket.
 * That is not premature: this is the slicer's inner loop, and a cut writes on
 * the order of a hundred thousand numbers. A JS array of doubles costs a boxed
 * write per component going in, and `Float32Array.prototype.set` on one has to
 * convert element by element coming out — doing it in float32 throughout turned
 * the accumulation from the most expensive part of a cut into a memcpy.
 *
 * `_seed` is sized from the input so the common case never reallocates.
 */
class SideBuilder {
  constructor(weldEps, seedTriangles = 256) {
    /** @type {Map<number, {pos:Float32Array,nor:Float32Array,uv:Float32Array,n:number,un:number}>} */
    this.buckets = new Map();
    this.triangles = 0;
    this.epsSq = weldEps * weldEps;
    this._seed = Math.max(64, seedTriangles);
  }

  _bucket(mat) {
    let b = this.buckets.get(mat);
    if (b === undefined) {
      b = {
        pos: new Float32Array(this._seed * 9),
        nor: new Float32Array(this._seed * 9),
        uv: new Float32Array(this._seed * 6),
        n: 0,   // floats used in pos/nor
        un: 0,  // floats used in uv
      };
      this.buckets.set(mat, b);
    } else if (b.n + 9 > b.pos.length) {
      b.pos = grow(b.pos);
      b.nor = grow(b.nor);
      b.uv = grow(b.uv);
    }
    return b;
  }

  /** Push one triangle from three 8-float vertices. */
  push(v0, v1, v2, mat) {
    if (hasRepeatedVertex(v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2], this.epsSq)) return;

    const b = this._bucket(mat);
    const p = b.pos, n = b.nor, u = b.uv;
    let i = b.n, j = b.un;
    p[i] = v0[0]; p[i+1] = v0[1]; p[i+2] = v0[2];
    p[i+3] = v1[0]; p[i+4] = v1[1]; p[i+5] = v1[2];
    p[i+6] = v2[0]; p[i+7] = v2[1]; p[i+8] = v2[2];
    n[i] = v0[3]; n[i+1] = v0[4]; n[i+2] = v0[5];
    n[i+3] = v1[3]; n[i+4] = v1[4]; n[i+5] = v1[5];
    n[i+6] = v2[3]; n[i+7] = v2[4]; n[i+8] = v2[5];
    u[j] = v0[6]; u[j+1] = v0[7];
    u[j+2] = v1[6]; u[j+3] = v1[7];
    u[j+4] = v2[6]; u[j+5] = v2[7];
    b.n = i + 9; b.un = j + 6;
    this.triangles++;
  }

  /** Push a triangle from raw component numbers (cap path — avoids copies). */
  pushRaw(px0, py0, pz0, px1, py1, pz1, px2, py2, pz2, nx, ny, nz, u0, v0, u1, v1, u2, v2, mat) {
    if (hasRepeatedVertex(px0, py0, pz0, px1, py1, pz1, px2, py2, pz2, this.epsSq)) return;

    const b = this._bucket(mat);
    const p = b.pos, n = b.nor, u = b.uv;
    let i = b.n, j = b.un;
    p[i] = px0; p[i+1] = py0; p[i+2] = pz0;
    p[i+3] = px1; p[i+4] = py1; p[i+5] = pz1;
    p[i+6] = px2; p[i+7] = py2; p[i+8] = pz2;
    n[i] = nx; n[i+1] = ny; n[i+2] = nz;
    n[i+3] = nx; n[i+4] = ny; n[i+5] = nz;
    n[i+6] = nx; n[i+7] = ny; n[i+8] = nz;
    u[j] = u0; u[j+1] = v0;
    u[j+2] = u1; u[j+3] = v1;
    u[j+4] = u2; u[j+5] = v2;
    b.n = i + 9; b.un = j + 6;
    this.triangles++;
  }

  isEmpty() { return this.triangles === 0; }

  /** Concatenate buckets in material order and emit groups. */
  build() {
    if (this.triangles === 0) return null;

    const mats = [...this.buckets.keys()].sort((x, y) => x - y);
    let total = 0;
    for (const m of mats) total += this.buckets.get(m).n;

    const pos = new Float32Array(total);
    const nor = new Float32Array(total);
    const uv = new Float32Array((total / 3) * 2);

    const geo = new THREE.BufferGeometry();
    let po = 0, uo = 0;
    for (const m of mats) {
      const b = this.buckets.get(m);
      pos.set(b.pos.subarray(0, b.n), po);
      nor.set(b.nor.subarray(0, b.n), po);
      uv.set(b.uv.subarray(0, b.un), uo);
      geo.addGroup(po / 3, b.n / 3, m);
      po += b.n;
      uo += b.un;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geo;
  }
}

function grow(a) {
  const b = new Float32Array(a.length * 2);
  b.set(a);
  return b;
}

/** Linear blend of two 8-float vertices into `out`, renormalising the normal. */
function lerpVert(out, va, vb, t) {
  for (let i = 0; i < VSIZE; i++) out[i] = va[i] + (vb[i] - va[i]) * t;
  const nx = out[3], ny = out[4], nz = out[5];
  const l = Math.hypot(nx, ny, nz);
  if (l > 1e-8) { out[3] = nx / l; out[4] = ny / l; out[5] = nz / l; }
  return out;
}

function copyVert(out, src) { out.set(src); return out; }

/**
 * Lexicographic order on position — a stable, direction-free edge ordering.
 *
 * Two triangles sharing an edge walk it in opposite directions, so computing
 * the plane intersection "from whichever end came first" gives results that are
 * equal in real arithmetic but differ in the last bits of floating point. That
 * disagreement is a T-junction: the cap welds the two into one ring vertex
 * while the skin keeps both, and the surface springs a leak. Ordering the two
 * endpoints by position instead makes both triangles run the identical
 * computation and produce bit-identical points.
 */
function comparePos(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

/** Per-triangle material index array, derived from geometry groups. */
function triangleMaterials(geometry, triCount) {
  const mats = new Uint8Array(triCount); // defaults to MAT_SKIN
  const groups = geometry.groups;
  if (!groups || groups.length === 0) return mats;
  for (const g of groups) {
    const start = Math.floor(g.start / 3);
    const end = Math.min(triCount, start + Math.floor(g.count / 3));
    const mi = g.materialIndex || 0;
    for (let t = start; t < end; t++) mats[t] = mi;
  }
  return mats;
}

/* ══════════════════════════════════════════════════════════════════════
   Loop stitching
   ══════════════════════════════════════════════════════════════════════ */

class LoopStitcher {
  constructor(weldEps) {
    this.points = [];       // flat xyz
    this.keyToIdx = new Map();
    this.edgeA = [];
    this.edgeB = [];
    this.adj = [];          // idx -> edge ids
    this.q = 1 / weldEps;
  }

  _vertex(x, y, z) {
    const q = this.q;
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let idx = this.keyToIdx.get(key);
    if (idx === undefined) {
      idx = this.points.length / 3;
      this.points.push(x, y, z);
      this.adj.push([]);
      this.keyToIdx.set(key, idx);
    }
    return idx;
  }

  addSegment(ax, ay, az, bx, by, bz) {
    const a = this._vertex(ax, ay, az);
    const b = this._vertex(bx, by, bz);
    if (a === b) return;
    const e = this.edgeA.length;
    this.edgeA.push(a);
    this.edgeB.push(b);
    this.adj[a].push(e);
    this.adj[b].push(e);
  }

  /** Walk the segment graph into closed (or open, best-effort) loops. */
  build() {
    const n = this.edgeA.length;
    if (n === 0) return [];
    const used = new Uint8Array(n);
    const loops = [];

    for (let seed = 0; seed < n; seed++) {
      if (used[seed]) continue;
      used[seed] = 1;
      const start = this.edgeA[seed];
      let cur = this.edgeB[seed];
      const loop = [start, cur];

      // follow unused edges until we come home or run out
      let guard = 0;
      while (cur !== start && guard++ < 100000) {
        const candidates = this.adj[cur];
        let nextEdge = -1;
        for (let i = 0; i < candidates.length; i++) {
          if (!used[candidates[i]]) { nextEdge = candidates[i]; break; }
        }
        if (nextEdge === -1) break;
        used[nextEdge] = 1;
        cur = this.edgeA[nextEdge] === cur ? this.edgeB[nextEdge] : this.edgeA[nextEdge];
        if (cur === start) break;
        loop.push(cur);
      }

      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   2D helpers for the cap
   ══════════════════════════════════════════════════════════════════════ */

function signedArea2D(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return a * 0.5;
}

/**
 * Does this closed contour cross itself once flattened?
 *
 * A ring that does cannot be triangulated — earcut emits overlapping garbage
 * and the cap tears — so the caller uses it to choose between the cutter's two
 * parameterisations. Quadratic, but rings run to a few hundred points at most
 * and this only runs while a cut is being made.
 */
function selfIntersects(pts) {
  const n = pts.length;
  if (n < 5) return false;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i], a2 = pts[(i + 1) % n];
    // skip the neighbours: they share an endpoint by construction
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a1, a2, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsCross(p1, p2, p3, p4) {
  const d1 = cross2(p3, p4, p1), d2 = cross2(p3, p4, p2);
  const d3 = cross2(p1, p2, p3), d4 = cross2(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-20) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function centroid2D(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return new THREE.Vector2(x / pts.length, y / pts.length);
}

/**
 * Is `inner` fully enclosed by `outer` — i.e. a genuine hole?
 *
 * Sampling only the centroid is not enough. Merged objects (the cluster
 * archetype welds several overlapping primitives) produce cross-sections whose
 * loops *partially* overlap, and a centroid can easily land inside a loop that
 * doesn't contain the rest of it. Treating that as a hole punches the cap full
 * of gaps. Two overlapping-but-not-nested loops are better triangulated
 * independently: the caps overlap, which is invisible, and each one's boundary
 * still matches its own ring.
 */
function loopEnclosedBy(inner, outer) {
  if (!pointInPolygon(centroid2D(inner), outer)) return false;
  const samples = Math.min(inner.length, 12);
  const stride = inner.length / samples;
  for (let i = 0; i < samples; i++) {
    if (!pointInPolygon(inner[Math.floor(i * stride)], outer)) return false;
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════
   Volume / centre of mass
   ══════════════════════════════════════════════════════════════════════ */

/** Signed volume and centroid of a closed triangle soup (divergence theorem). */
export function volumeAndCentroid(geometry) {
  const pos = geometry.attributes.position.array;
  let vol = 0, cx = 0, cy = 0, cz = 0;

  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i],     ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const cxx = pos[i + 6], cyy = pos[i + 7], czz = pos[i + 8];

    // v = a · (b × c) / 6
    const nx = by * czz - bz * cyy;
    const ny = bz * cxx - bx * czz;
    const nz = bx * cyy - by * cxx;
    const v = (ax * nx + ay * ny + az * nz) / 6;

    vol += v;
    cx += v * (ax + bx + cxx) * 0.25;
    cy += v * (ay + by + cyy) * 0.25;
    cz += v * (az + bz + czz) * 0.25;
  }

  const centroid = new THREE.Vector3();
  if (Math.abs(vol) > 1e-9) {
    centroid.set(cx / vol, cy / vol, cz / vol);
  } else {
    geometry.computeBoundingBox();
    geometry.boundingBox.getCenter(centroid);
  }
  // `volume` is a magnitude because that is what mass wants. The sign is
  // reported separately rather than thrown away: on a closed surface it says
  // which way the whole thing is turned, and a negative one is a piece that
  // bounds a hole instead of matter.
  return { volume: Math.abs(vol), signedVolume: vol, centroid };
}

/* ══════════════════════════════════════════════════════════════════════
   The slice
   ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {THREE.BufferGeometry} geometry  non-indexed preferred; must have position+normal+uv
 * @param {THREE.Plane} plane              in the geometry's LOCAL space
 * @param {object} [options]
 * @param {number} [options.epsilon]
 * @param {number} [options.capUvScale]    world units mapped to one uv tile on the cap
 * @param {boolean} [options.recenter]     move each half's origin to its centre of mass
 * @returns {null | {above, below, sectionArea, loops}}  null if the plane misses the mesh
 */
export function sliceGeometry(geometry, planeOrCutter, options = {}) {
  const cutter = planeOrCutter.isPlane ? new PlaneCutter(planeOrCutter) : planeOrCutter;
  const capUvScale = options.capUvScale ?? 1;
  const recenter = options.recenter !== false;

  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const posAttr = src.attributes.position;
  const norAttr = src.attributes.normal;
  const uvAttr = src.attributes.uv;

  const pos = posAttr.array;
  const nor = norAttr ? norAttr.array : null;
  const uv = uvAttr ? uvAttr.array : null;

  const triCount = (pos.length / 9) | 0;
  const triMat = triangleMaterials(geometry, triCount);

  // tolerances follow the object's size, so a fifth-generation fragment gets
  // the same *relative* precision the original mesh did
  if (!src.boundingSphere) src.computeBoundingSphere();
  const scale = src.boundingSphere ? Math.max(src.boundingSphere.radius, 1e-6) : 1;
  const weldEps = Math.max(scale * WELD_RELATIVE, WELD_MIN);
  const eps = options.epsilon ?? cutter.epsilonFor(scale);

  // A cut rarely lands worse than two thirds / one third, and a bucket that
  // guesses high just wastes a scratch allocation that is thrown away in build().
  const seed = Math.max(64, (triCount * 0.75) | 0);
  const above = new SideBuilder(weldEps, seed);
  const below = new SideBuilder(weldEps, seed);
  const stitcher = new LoopStitcher(weldEps);

  let crossed = false;

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    const ubase = t * 6;
    const mat = triMat[t];

    // ── load the triangle ──────────────────────────────────────────
    for (let k = 0; k < 3; k++) {
      const v = _tv[k];
      const p3 = base + k * 3;
      v[0] = pos[p3]; v[1] = pos[p3 + 1]; v[2] = pos[p3 + 2];
      if (nor) { v[3] = nor[p3]; v[4] = nor[p3 + 1]; v[5] = nor[p3 + 2]; }
      else { v[3] = 0; v[4] = 1; v[5] = 0; }
      if (uv) { v[6] = uv[ubase + k * 2]; v[7] = uv[ubase + k * 2 + 1]; }
      else { v[6] = 0; v[7] = 0; }
    }

    const d0 = cutter.signAt(_tv[0][0], _tv[0][1], _tv[0][2]);
    const d1 = cutter.signAt(_tv[1][0], _tv[1][1], _tv[1][2]);
    const d2 = cutter.signAt(_tv[2][0], _tv[2][1], _tv[2][2]);

    const s0 = d0 > eps ? 1 : d0 < -eps ? -1 : 0;
    const s1 = d1 > eps ? 1 : d1 < -eps ? -1 : 0;
    const s2 = d2 > eps ? 1 : d2 < -eps ? -1 : 0;

    // ── trivial accept: wholly on one side ─────────────────────────
    if (s0 >= 0 && s1 >= 0 && s2 >= 0) {
      above.push(_tv[0], _tv[1], _tv[2], mat);

      // The plane can also fall exactly along existing edges — slicing a
      // sphere on its equator is the common case, and it straddles nothing.
      // Register that edge as part of the cut ring, otherwise both halves
      // come out uncapped. Only the above-side triangle registers it, so
      // each shared edge enters the ring exactly once.
      if (s0 + s1 + s2 === 1) {
        const i = s0 === 0 ? 0 : 1;
        const j = s2 === 0 ? 2 : 1;
        const A = _tv[i], B = _tv[j];
        stitcher.addSegment(A[0], A[1], A[2], B[0], B[1], B[2]);
        crossed = true;
      }
      continue;
    }
    if (s0 <= 0 && s1 <= 0 && s2 <= 0) {
      below.push(_tv[0], _tv[1], _tv[2], mat);
      continue;
    }

    crossed = true;

    // ── clip ───────────────────────────────────────────────────────
    const dists = [d0, d1, d2];
    const sides = [s0, s1, s2];
    let na = 0, nb = 0, nx = 0;

    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const vi = _tv[i], vj = _tv[j];
      const si = sides[i], sj = sides[j];

      if (si >= 0) copyVert(_polyA[na++], vi);
      if (si <= 0) copyVert(_polyB[nb++], vi);

      // an exactly-on-plane vertex is itself part of the cut ring
      if (si === 0 && nx < 2) copyVert(_xpt[nx++], vi);

      if (si * sj < 0) {
        const di = dists[i], dj = dists[j];
        const cut = _polyA[na];
        // always interpolate from the lexicographically smaller endpoint, so
        // the two triangles sharing this edge compute bit-identical points
        if (comparePos(vi, vj) <= 0) {
          lerpVert(cut, vi, vj,
            cutter.crossing(vi[0], vi[1], vi[2], vj[0], vj[1], vj[2], di, dj));
        } else {
          lerpVert(cut, vj, vi,
            cutter.crossing(vj[0], vj[1], vj[2], vi[0], vi[1], vi[2], dj, di));
        }
        copyVert(_polyB[nb], cut);
        na++; nb++;
        if (nx < 2) copyVert(_xpt[nx++], cut);
      }
    }

    // ── fan-triangulate both clipped polygons ──────────────────────
    for (let i = 2; i < na; i++) above.push(_polyA[0], _polyA[i - 1], _polyA[i], mat);
    for (let i = 2; i < nb; i++) below.push(_polyB[0], _polyB[i - 1], _polyB[i], mat);

    if (nx === 2) {
      stitcher.addSegment(_xpt[0][0], _xpt[0][1], _xpt[0][2],
                          _xpt[1][0], _xpt[1][1], _xpt[1][2]);
    }
  }

  // The plane grazed or missed the mesh entirely — not a cut.
  // `crossed` is deliberately *not* required: a plane can pass cleanly between
  // two disjoint parts of a merged object, splitting it with no cut ring at
  // all. Both halves are already closed in that case.
  if (above.isEmpty() || below.isEmpty()) return null;
  void crossed;

  // ── cap ──────────────────────────────────────────────────────────
  const cap = buildCaps(stitcher, cutter, above, below, capUvScale);

  const geoAbove = above.build();
  const geoBelow = below.build();
  if (!geoAbove || !geoBelow) return null;

  const resAbove = finalise(geoAbove, recenter);
  const resBelow = finalise(geoBelow, recenter);

  return {
    above: resAbove,
    below: resBelow,
    sectionArea: cap.area,
    /** Cut rings in local space — drives the glowing slash and the spray. */
    loops: cap.loops,
    stats: cap.stats,
  };
}

function finalise(geo, recenter) {
  const { volume, signedVolume, centroid } = volumeAndCentroid(geo);
  if (recenter) geo.translate(-centroid.x, -centroid.y, -centroid.z);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geometry: geo, volume, signedVolume, centroid, radius: geo.boundingSphere.radius };
}

/**
 * Triangulate the cut cross-section and emit it into both halves.
 * Returns the total capped area (used for scoring and spray strength).
 */
function buildCaps(stitcher, cutter, above, below, capUvScale) {
  const stats = { loops: 0, loopSizes: [], contours: 0, earcutShort: 0, fallbacks: 0 };
  const loopsIdx = stitcher.build();
  if (loopsIdx.length === 0) return { area: 0, loops: [], stats };
  stats.loops = loopsIdx.length;
  stats.loopSizes = loopsIdx.map((l) => l.length);

  const pts = stitcher.points;

  // A freehand cut is not planar, so the frame is fitted to the ring rather
  // than handed down. It is used only to run the triangulation in 2D — the
  // emitted vertices keep their true 3D positions, so the cap follows the
  // curve of the cut instead of flattening it.
  const allRing = [];
  for (const loop of loopsIdx) {
    for (const idx of loop) {
      allRing.push(new THREE.Vector3(pts[idx * 3], pts[idx * 3 + 1], pts[idx * 3 + 2]));
    }
  }
  const frame = cutter.capFrame(allRing, _frame);
  const n = frame.n, u = frame.u, v = frame.v, origin = frame.origin;

  // ring copies in local space, handed back for effects
  const ringLoops = loopsIdx.map((loop) =>
    loop.map((idx) => new THREE.Vector3(pts[idx * 3], pts[idx * 3 + 1], pts[idx * 3 + 2])));

  // Triangulate in the cutter's 2D parameterisation, keeping each point's true
  // 3D position and a frame-projected uv attached. Triangulation happens flat;
  // the geometry does not.
  const project = (param) => loopsIdx.map((loop, li) => {
    const flat = loop.map((idx, k) => {
      const p3 = ringLoops[li][k];
      const p2 = param.call(cutter, p3.x, p3.y, p3.z, frame, new THREE.Vector2());
      p2.p3 = p3;
      const dx = p3.x - origin.x, dy = p3.y - origin.y, dz = p3.z - origin.z;
      p2.uvx = dx * u.x + dy * u.y + dz * u.z;
      p2.uvy = dx * v.x + dy * v.y + dz * v.z;
      return p2;
    });
    return { flat, area: signedArea2D(flat), used: false };
  }).filter((c) => Math.abs(c.area) > 1e-9);

  let contours = project(cutter.capParam);

  // A contour that crosses itself once flattened cannot be triangulated: the
  // triangulator emits overlapping garbage and the cap tears open. When the
  // cutter offers a second parameterisation that cannot fold, use it.
  if (cutter.capParamAlt && contours.some((c) => selfIntersects(c.flat))) {
    const alt = project(cutter.capParamAlt);
    if (!alt.some((c) => selfIntersects(c.flat))) contours = alt;
  }

  stats.contours = contours.length;
  if (contours.length === 0) return { area: 0, loops: ringLoops, stats };

  // biggest first, so a loop can only be a hole of something already seen
  contours.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

  let totalArea = 0;

  for (let i = 0; i < contours.length; i++) {
    const outer = contours[i];
    if (outer.used) continue;
    outer.used = true;

    // gather nested loops as holes
    const holes = [];
    for (let j = i + 1; j < contours.length; j++) {
      const inner = contours[j];
      if (inner.used) continue;
      if (loopEnclosedBy(inner.flat, outer.flat)) {
        inner.used = true;
        holes.push(inner);
      }
    }

    // normalise winding: outer CCW, holes CW — what triangulateShape expects
    const outerPts = outer.area < 0 ? outer.flat.slice().reverse() : outer.flat;
    const holePts = holes.map((h) => (h.area > 0 ? h.flat.slice().reverse() : h.flat));

    totalArea += Math.abs(outer.area);
    for (const h of holes) totalArea -= Math.abs(h.area);

    let faces;
    try {
      // NOTE: triangulateShape mutates its inputs (it strips a duplicated end
      // point), and the indices it returns address the post-mutation arrays.
      // The flat index space therefore has to be built *after* this call.
      faces = THREE.ShapeUtils.triangulateShape(outerPts, holePts);
    } catch (e) {
      faces = null;
    }

    // flatten into the one index space the triangulator's output addresses
    const all = outerPts.slice();
    for (const h of holePts) for (const p of h) all.push(p);

    // Earcut degrades quietly: on input it dislikes it returns *fewer*
    // triangles rather than throwing, which would leave a hole in the cap.
    // Anything short of a complete fan is treated as a failure.
    const expected = all.length - 2 - holePts.length * 0;
    if (faces && faces.length > 0 && faces.length < expected - holePts.length * 2) {
      stats.earcutShort++;
      faces = null;
    }

    if (!faces || faces.length === 0) {
      stats.fallbacks++;
      // fallback: fan from the centroid (fine for the convex-ish sections
      // that dominate here, and always closed)
      const c = centroid2D(outerPts);
      c.p3 = new THREE.Vector3();
      c.uvx = 0; c.uvy = 0;
      for (const p of outerPts) { c.p3.add(p.p3); c.uvx += p.uvx; c.uvy += p.uvy; }
      const inv = 1 / Math.max(1, outerPts.length);
      c.p3.multiplyScalar(inv); c.uvx *= inv; c.uvy *= inv;
      const ci = all.length;
      all.push(c);
      faces = [];
      for (let k = 0; k < outerPts.length; k++) {
        faces.push([ci, k, (k + 1) % outerPts.length]);
      }
    }

    emitCap(all, faces, u, v, origin, n, above, below, capUvScale);
  }

  return { area: Math.max(0, totalArea), loops: ringLoops, stats };
}

/** Four ulps of float32 — below this a coordinate difference is rounding. */
const F32_GRAIN = 4 * 1.1920929e-7;

/**
 * Is this triangle thinner than the precision of the numbers describing it?
 *
 * Exported for the test suite, which has to make the same judgement when it
 * recomputes a normal from the stored buffer and would otherwise be measuring
 * float32 rounding.
 */
export function isSubPixelThin(cross, e1, e2, A, B, C) {
  const longest = Math.sqrt(Math.max(e1.lengthSq(), e2.lengthSq()));
  if (longest <= 0) return true;
  const height = Math.sqrt(cross.lengthSq()) / longest;
  const scale = Math.max(
    Math.abs(A.x), Math.abs(A.y), Math.abs(A.z),
    Math.abs(B.x), Math.abs(B.y), Math.abs(B.z),
    Math.abs(C.x), Math.abs(C.y), Math.abs(C.z), longest);
  return height < scale * F32_GRAIN;
}

function emitCap(pts2, faces, u, v, origin, n, above, below, capUvScale) {
  const inv = 1 / (capUvScale * 2);
  void u; void v; void origin;

  for (const f of faces) {
    const p0 = pts2[f[0]], p1 = pts2[f[1]], p2 = pts2[f[2]];
    if (!p0 || !p1 || !p2 || !p0.p3 || !p1.p3 || !p2.p3) continue;

    // True 3D positions, not the 2D parameterisation pushed back out. On a
    // freehand cut the section is curved, and rebuilding it from a flat frame
    // would iron it out and tear it away from the walls it belongs to.
    let A = p0.p3, B = p1.p3, C = p2.p3;
    let ua = p0, ub = p1, uc = p2;

    // Per-triangle geometric normal, so a curved cap shades as the surface it
    // actually is rather than as the average plane.
    _e1.set(B.x - A.x, B.y - A.y, B.z - A.z);
    _e2.set(C.x - A.x, C.y - A.y, C.z - A.z);
    _fn.crossVectors(_e1, _e2);

    // Is this triangle thinner than the coordinates it is made of?
    //
    // area/longest-edge is its height; positions are stored as float32, so
    // anything under a few ulps of the coordinate magnitude is rounding rather
    // than shape. The cross product of such a triangle is noise, and
    // normalising noise yields a confident unit vector pointing nowhere in
    // particular — which is how a handful of sub-nanometre cap slivers ended up
    // wound against their own normals. They cover no area and shade as nothing,
    // and are kept only so the surface stays closed, so they take the fitted
    // normal instead.
    if (isSubPixelThin(_fn, _e1, _e2, A, B, C)) _fn.copy(n); else _fn.normalize();

    // Put the winding on the same side as the fitted frame by swapping two
    // vertices, not by flipping the normal — flipping alone would leave the
    // normal disagreeing with the triangle's own winding.
    //
    // Deciding this per triangle by probing the cut field instead — stepping
    // off the surface along the triangle's own normal to see which way the
    // field rises — sounds better and is not. On the caps that matter it agrees
    // with the fitted frame anyway, and on a needle triangle, whose normal is
    // near-perpendicular to the section, the two probes land on the same side
    // and the comparison is noise. That flipped slivers the fitted frame got right.
    if (_fn.dot(n) < 0) {
      const tp = B; B = C; C = tp;
      const tu = ub; ub = uc; uc = tu;
      _fn.negate();
    }

    const u0 = ua.uvx * inv + 0.5, v0 = ua.uvy * inv + 0.5;
    const u1 = ub.uvx * inv + 0.5, v1 = ub.uvy * inv + 0.5;
    const u2 = uc.uvx * inv + 0.5, v2 = uc.uvy * inv + 0.5;

    // The below-half's cap faces +n, and now genuinely winds that way.
    below.pushRaw(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z,
                  _fn.x, _fn.y, _fn.z, u0, v0, u1, v1, u2, v2, MAT_INTERIOR);

    // The above-half's cap faces -n: reverse winding and flip the normal.
    above.pushRaw(A.x, A.y, A.z, C.x, C.y, C.z, B.x, B.y, B.z,
                  -_fn.x, -_fn.y, -_fn.z, u0, v0, u2, v2, u1, v1, MAT_INTERIOR);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Convenience: slice a whole mesh (world-space plane → local, then cut)
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Slice `mesh` with a world-space plane or cutter.
 *
 * The cutter is told the object's transform rather than being converted into
 * local space itself — a freehand cut is a screen-space function and has no
 * local-space form, but folding the world matrix into its projection gives it
 * one for free.
 */
export function sliceMesh(mesh, planeOrCutter, options = {}) {
  mesh.updateWorldMatrix(true, false);
  const cutter = planeOrCutter.isPlane ? new PlaneCutter(planeOrCutter) : planeOrCutter;
  cutter.setObjectMatrix(mesh.matrixWorld);
  return sliceGeometry(mesh.geometry, cutter, options);
}
