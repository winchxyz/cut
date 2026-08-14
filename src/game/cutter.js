import * as THREE from 'three';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  CUTTERS
 * ══════════════════════════════════════════════════════════════════════
 *
 *  A cutter answers two questions for the slicer:
 *
 *    signAt(x,y,z)   which side of the cut is this point on?
 *    crossing(...)   where along this edge does the cut fall?
 *
 *  A plane is the trivial implementation. The one that matters is
 *  FreehandCutter: it cuts along the surface swept by the *actual path*
 *  the mouse drew, seen from the camera — not the straight line between
 *  where you pressed and where you let go.
 *
 *  Its sign function works in screen space. A point is projected, the
 *  nearest segment of the drawn polyline is found, and the 2D cross
 *  product against that segment gives the signed distance to it. The
 *  zero set of that function is exactly the ruled surface through the eye
 *  and the stroke, so an object comes apart along the curve you drew, at
 *  any depth and from any camera angle.
 *
 *  Both work in the mesh's LOCAL space: `setObjectMatrix` folds the
 *  object's world transform in, so the slicer never has to leave local
 *  coordinates.
 */

const _inv = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);

export class PlaneCutter {
  /** @param {THREE.Plane} worldPlane */
  constructor(worldPlane) {
    this.planar = true;
    this.worldPlane = worldPlane.clone();
    this.local = new THREE.Plane().copy(worldPlane);
    this._cache();
  }

  /** Sign is a world-space distance, so the tolerance is in world units. */
  epsilonFor(scale) { return Math.max(scale * 1e-6, 1e-9); }

  setObjectMatrix(m) {
    _inv.copy(m).invert();
    _nm.getNormalMatrix(_inv);
    this.local.copy(this.worldPlane).applyMatrix4(_inv, _nm);
    this._cache();
  }

  _cache() {
    const n = this.local.normal;
    this.nx = n.x; this.ny = n.y; this.nz = n.z; this.c = this.local.constant;
  }

  signAt(x, y, z) {
    return this.nx * x + this.ny * y + this.nz * z + this.c;
  }

  /** The crossing of a straight edge with a plane is exact. */
  crossing(ax, ay, az, bx, by, bz, da, db) {
    void ax; void ay; void az; void bx; void by; void bz;
    return da / (da - db);
  }

  capFrame(_points, out) {
    out.n.set(this.nx, this.ny, this.nz);
    out.origin.copy(out.n).multiplyScalar(-this.c);
    buildTangents(out);
    return out;
  }

  /** Triangulation coordinates: the plane's own tangent frame. */
  capParam(x, y, z, frame, out) {
    const dx = x - frame.origin.x, dy = y - frame.origin.y, dz = z - frame.origin.z;
    out.set(dx * frame.u.x + dy * frame.u.y + dz * frame.u.z,
            dx * frame.v.x + dy * frame.v.y + dz * frame.v.z);
    return out;
  }
}

export class FreehandCutter {
  /**
   * @param {THREE.Camera} camera
   * @param {Array<{x:number,y:number}>} points  stroke in CSS pixels
   * @param {number} width
   * @param {number} height
   */
  constructor(camera, points, width, height) {
    this.planar = false;
    this.width = width;
    this.height = height;

    camera.updateMatrixWorld();
    this._viewProj = new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._mvp = this._viewProj.clone();

    // Simplify, round off, simplify again.
    //
    // Raw pointer input arrives in clusters of near-identical samples; each
    // becomes a segment the sign function must search, and a near-zero-length
    // one gives a meaningless side. Rounding matters for a second reason: at a
    // sharp corner of the stroke, an entire wedge of space has that one corner
    // as its nearest point, so the surface parameterisation stops being
    // one-to-one there and the cap tears. Rounded corners keep it injective —
    // and a hand-drawn line looks better for it either way.
    const pts = simplify(smooth(simplify(points, 2.5), 2), 1.0);
    this.n = pts.length;

    this.px = new Float64Array(this.n);
    this.py = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) { this.px[i] = pts[i].x; this.py[i] = pts[i].y; }

    const m = Math.max(0, this.n - 1);
    this.dx = new Float64Array(m);
    this.dy = new Float64Array(m);
    this.invLen2 = new Float64Array(m);
    this.invLen = new Float64Array(m);
    this.len = new Float64Array(m);
    this.cumLen = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      const ddx = this.px[i + 1] - this.px[i];
      const ddy = this.py[i + 1] - this.py[i];
      this.dx[i] = ddx; this.dy[i] = ddy;
      const len2 = ddx * ddx + ddy * ddy;
      const len = Math.sqrt(len2);
      this.len[i] = len;
      this.cumLen[i + 1] = this.cumLen[i] + len;
      this.invLen2[i] = len2 > 1e-9 ? 1 / len2 : 0;
      this.invLen[i] = len2 > 1e-9 ? 1 / len : 0;
    }
    this.segments = m;
    this.totalLen = this.cumLen[m] || 1;
  }

  get valid() { return this.segments >= 1; }

  /** Sign is a distance in pixels, so the tolerance is sub-pixel. */
  epsilonFor(_scale) { return 0.02; }

  setObjectMatrix(m) {
    this._mvp.multiplyMatrices(this._viewProj, m);
  }

  /**
   * Signed distance, in pixels, to the drawn curve.
   *
   * The nearest segment decides, so the two sides meet exactly on the curve.
   * Past the ends the first and last segments extend — the freehand equivalent
   * of a plane being infinite.
   */
  signAt(x, y, z) {
    const e = this._mvp.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (Math.abs(w) < 1e-9) return 0;
    const iw = 1 / w;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) * iw * 0.5 + 0.5) * this.width;
    const sy = (-(e[1] * x + e[5] * y + e[9] * z + e[13]) * iw * 0.5 + 0.5) * this.height;

    let bestD2 = Infinity, perp = 0;
    for (let i = 0; i < this.segments; i++) {
      const ax = this.px[i], ay = this.py[i];
      const wx = sx - ax, wy = sy - ay;
      const ddx = this.dx[i], ddy = this.dy[i];

      let t = (wx * ddx + wy * ddy) * this.invLen2[i];
      if (t < 0) t = 0; else if (t > 1) t = 1;

      const cx = sx - (ax + ddx * t);
      const cy = sy - (ay + ddy * t);
      const d2 = cx * cx + cy * cy;

      if (d2 < bestD2) {
        bestD2 = d2;
        // normalised 2D cross: perpendicular distance in pixels, signed
        perp = (wx * ddy - wy * ddx) * this.invLen[i];
      }
    }

    // ── the blade has ends ──────────────────────────────────────────
    //
    // Taking the perpendicular distance alone makes the cutting surface
    // infinite: it reaches out past both ends of the stroke and severs
    // everything lying along that direction. It is also why a single chair leg
    // could not be cut — the surface that took the leg took the seat with it.
    //
    // Beyond the drawn ends the blade simply is not there, so those points are
    // pushed firmly to the uncut side. `max` intersects the two conditions:
    // material is only severed where it is on the far side of the edge AND
    // within the span the edge actually swept.
    const over = this._overshoot(sx, sy);
    return over > 0 ? Math.max(perp, over) : perp;
  }

  /** How far past either end of the stroke a screen point lies, in pixels. */
  _overshoot(sx, sy) {
    const last = this.segments - 1;

    // before the start
    let dx = sx - this.px[0], dy = sy - this.py[0];
    const beforeStart = -(dx * this.dx[0] + dy * this.dy[0]) * this.invLen[0];

    // past the end
    dx = sx - this.px[last + 1]; dy = sy - this.py[last + 1];
    const pastEnd = (dx * this.dx[last] + dy * this.dy[last]) * this.invLen[last];

    const o = Math.max(beforeStart, pastEnd);
    return o > 0 ? o : 0;
  }

  /**
   * Where the cut falls along an edge, by bisection.
   *
   * There is no closed form: the sign function is piecewise across segments
   * and non-linear under perspective. Sixteen halvings put the crossing within
   * a sixty-thousandth of the edge — far below anything visible, and cheap
   * because it only runs on edges that actually straddle.
   */
  crossing(ax, ay, az, bx, by, bz, da, db) {
    let lo = 0, hi = 1;
    const negAtLo = da < 0;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) * 0.5;
      const s = this.signAt(ax + (bx - ax) * mid, ay + (by - ay) * mid, az + (bz - az) * mid);
      if ((s < 0) === negAtLo) lo = mid; else hi = mid;
    }
    void db;
    return (lo + hi) * 0.5;
  }

  /**
   * Best-fit frame for the cut section, by Newell's method.
   *
   * A freehand cut is not planar, so there is no exact frame. This is the
   * area-weighted average plane of the ring, and it is only used to run the
   * triangulation in 2D — every vertex keeps its true 3D position, so the cap
   * follows the curve of the cut rather than flattening it.
   */
  /**
   * Primary triangulation coordinates: the fitted plane's own tangent frame.
   *
   * Now that the blade has ends, the cut surface is the swept ribbon plus a
   * face at each end, and the ribbon's natural (along, depth) coordinates go
   * degenerate on those end faces — every point on one collapses to the same
   * `along`. The fitted plane handles the whole ring instead, and the caller
   * falls back to `capParamAlt` on the rare ring that folds enough to
   * self-intersect when flattened.
   */
  capParam(x, y, z, frame, out) {
    const dx = x - frame.origin.x, dy = y - frame.origin.y, dz = z - frame.origin.z;
    out.set(dx * frame.u.x + dy * frame.u.y + dz * frame.u.z,
            dx * frame.v.x + dy * frame.v.y + dz * frame.v.z);
    return out;
  }

  /**
   * Fallback coordinates on the ribbon itself: how far along the stroke a
   * point lies, against how far from the camera it is. A sharply folded cut
   * cannot self-intersect here, because every point of the ribbon has exactly
   * one such coordinate.
   */
  capParamAlt(x, y, z, _frame, out) {
    const e = this._mvp.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const iw = Math.abs(w) < 1e-9 ? 0 : 1 / w;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) * iw * 0.5 + 0.5) * this.width;
    const sy = (-(e[1] * x + e[5] * y + e[9] * z + e[13]) * iw * 0.5 + 0.5) * this.height;

    let bestD2 = Infinity, along = 0;
    for (let i = 0; i < this.segments; i++) {
      const ax = this.px[i], ay = this.py[i];
      const wx = sx - ax, wy = sy - ay;
      const ddx = this.dx[i], ddy = this.dy[i];
      let t = (wx * ddx + wy * ddy) * this.invLen2[i];
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = sx - (ax + ddx * t), cy = sy - (ay + ddy * t);
      const d2 = cx * cx + cy * cy;
      if (d2 < bestD2) { bestD2 = d2; along = this.cumLen[i] + t * this.len[i]; }
    }

    // depth scaled into roughly the same range as `along`, so the triangulator
    // is not handed a degenerate sliver of a domain
    out.set(along, w * this.totalLen * 0.25);
    return out;
  }

  capFrame(points, out) {
    const c = out.origin.set(0, 0, 0);
    for (const p of points) c.add(p);
    c.divideScalar(Math.max(1, points.length));

    const n = out.n.set(0, 0, 0);
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      n.x += (a.y - b.y) * (a.z + b.z);
      n.y += (a.z - b.z) * (a.x + b.x);
      n.z += (a.x - b.x) * (a.y + b.y);
    }
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
    n.normalize();

    // Point it the way the slicer expects: toward increasing sign, i.e. into
    // the "above" half.
    //
    // Newell's normal follows the ring's winding, and the loop stitcher walks
    // that ring in whichever direction it happens to — so the sign is
    // arbitrary. Left alone, roughly half of all freehand cuts come out with
    // both cut faces wound inside-out: the new surface is back-facing, gets
    // culled, and the piece shows a face on one side of the cut and nothing on
    // the other. That is the hollow look.
    //
    // The samples must be taken AT RING POINTS, which lie exactly on the cut
    // surface. Sampling either side of the ring's centroid is worthless for a
    // curved cut: the centroid is nowhere near the surface, both probes land
    // in the same half, and the comparison is noise.
    let extent = 0;
    for (const p of points) extent = Math.max(extent, p.distanceTo(c));
    const step = Math.max(extent * 0.02, 1e-5);

    let vote = 0;
    const stride = Math.max(1, Math.floor(points.length / 12));
    for (let i = 0; i < points.length; i += stride) {
      const p = points[i];
      const a = this.signAt(p.x + n.x * step, p.y + n.y * step, p.z + n.z * step);
      const b = this.signAt(p.x - n.x * step, p.y - n.y * step, p.z - n.z * step);
      if (a > b) vote++; else if (a < b) vote--;
    }
    if (vote < 0) n.negate();

    buildTangents(out);
    return out;
  }
}

function buildTangents(frame) {
  const n = frame.n;
  const helper = Math.abs(n.y) < 0.9 ? _up : _right;
  frame.u.crossVectors(helper, n).normalize();
  frame.v.crossVectors(n, frame.u).normalize();
}

/** Ramer–Douglas–Peucker, so a shaky stroke does not become 200 segments. */
export function simplify(points, tolerance) {
  if (points.length <= 2) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;

  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;

    const ax = points[first].x, ay = points[first].y;
    const dx = points[last].x - ax, dy = points[last].y - ay;
    const len2 = dx * dx + dy * dy;

    let worst = -1, worstIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const wx = points[i].x - ax, wy = points[i].y - ay;
      let t = len2 > 1e-9 ? (wx * dx + wy * dy) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = wx - dx * t, cy = wy - dy * t;
      const d2 = cx * cx + cy * cy;
      if (d2 > worst) { worst = d2; worstIdx = i; }
    }

    if (worst > tol2 && worstIdx > 0) {
      keep[worstIdx] = 1;
      stack.push([first, worstIdx], [worstIdx, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Chaikin corner cutting: rounds a polyline without pulling it off course. */
export function smooth(points, iterations = 1) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

export function makeFrame() {
  return {
    origin: new THREE.Vector3(),
    n: new THREE.Vector3(),
    u: new THREE.Vector3(),
    v: new THREE.Vector3(),
  };
}
