import * as THREE from 'three';
import { buildHull, transformHull, hullContacts } from './collision.js';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  RIGID BODIES
 * ══════════════════════════════════════════════════════════════════════
 *
 *  A small sequential-impulse solver — enough for cut pieces to fall,
 *  tumble, knock together and settle on a table, which is the whole
 *  physical vocabulary this simulator needs.
 *
 *  The part that makes it read as real is the contact set. Each body
 *  precomputes its support points: the extreme vertex in each of 42
 *  directions, which is a cheap stand-in for its convex hull. A chair
 *  therefore rests on the bottoms of its four legs rather than on a
 *  bounding sphere, and a sliced-off slab lies flat on its cut face.
 *
 *  Bodies sleep once they stop moving, so a table of finished pieces
 *  costs nothing.
 */

const GRAVITY = -9.81;

/**
 * How close to the surface still counts as resting on it.
 *
 * Generous on purpose. A body settled on the bench hovers within a fraction of
 * a millimetre of it, and the push-out can lift it just clear; if the contact
 * is then dropped for even one step it free-falls and picks up a full step of
 * gravity — about 0.16 m/s — which is enough to keep resetting the sleep timer
 * forever. A centimetre of margin is invisible at this scale and makes the
 * contact persist.
 */
const CONTACT_SLOP = 0.008;

/** Surface speed above which a body can disturb a sleeping neighbour. */
const WAKE_SPEED = 0.16;

/** How far a body may wander over the sleep window and still count as still. */
const SLEEP_DRIFT = 0.004;

/** Nothing on a workbench moves this fast; past here it is solver noise. */
const MAX_SPEED = 30;
const MAX_SPIN = 40;

/** Fraction of remaining overlap converted to separating velocity per step. */
const BAUMGARTE = 0.35;
const PSEUDO_ITERATIONS = 4;
/** Overlap below this is left alone, so resting contact is not jittered. */
const PENETRATION_SLOP = 0.0016;
/** Cap on the push-out velocity, so deep overlap does not fire pieces away. */
const MAX_BIAS_SPEED = 0.6;

/** Closing speed of two bodies at a contact, positive when approaching. */
function relativeNormalVelocity(A, B, c) {
  _rA.set(c.px - A.position.x, c.py - A.position.y, c.pz - A.position.z);
  _rB.set(c.px - B.position.x, c.py - B.position.y, c.pz - B.position.z);
  _cross.crossVectors(A.angular, _rA);
  _vA.copy(A.velocity).add(_cross);
  _cross.crossVectors(B.angular, _rB);
  _vB.copy(B.velocity).add(_cross);
  _vp.subVectors(_vB, _vA);
  return _vp.x * c.nx + _vp.y * c.ny + _vp.z * c.nz;
}


/* 42 roughly even directions (icosahedron vertices + face centres). */
const SUPPORT_DIRS = (() => {
  const dirs = [];
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  for (const r of raw) dirs.push(new THREE.Vector3(...r).normalize());
  // face centres, for a denser sample
  for (let i = 0; i < raw.length; i++) {
    for (let j = i + 1; j < raw.length; j++) {
      const a = dirs[i], b = dirs[j];
      if (a.dot(b) < 0.3) continue;
      const m = new THREE.Vector3().addVectors(a, b).normalize();
      if (!dirs.some((d) => d.dot(m) > 0.985)) dirs.push(m);
      if (dirs.length >= 42) break;
    }
    if (dirs.length >= 42) break;
  }
  // always include straight down — it is the direction that matters most
  if (!dirs.some((d) => d.y < -0.99)) dirs.push(new THREE.Vector3(0, -1, 0));
  return dirs;
})();

/** The same directions, flat, for the support scan's inner loop. */
const SUPPORT_DIRS_FLAT = (() => {
  const f = new Float32Array(SUPPORT_DIRS.length * 3);
  SUPPORT_DIRS.forEach((v, i) => { f[i * 3] = v.x; f[i * 3 + 1] = v.y; f[i * 3 + 2] = v.z; });
  return f;
})();

/** Densities, in arbitrary but self-consistent units. */
const DENSITY = {
  wood: 0.7, ceramic: 2.3, stone: 2.7, metal: 7.8,
  organic: 1.0, citrus: 1.0, ice: 0.92, gem: 3.5, energy: 1.0, bomb: 3.0,
};

/**
 * Inertia tensor of a closed triangle mesh about its centre of mass.
 *
 * A single scalar — the sphere approximation this used to use — is wrong for
 * almost every piece a cut produces. A thin slab resists rotation about its
 * flat axis far less than about its long one, and treating those as equal is
 * exactly why flat fragments used to tumble like marbles instead of falling
 * over edge-first and slapping down flat.
 *
 * Each triangle forms a tetrahedron with the origin; the covariance of that
 * tetrahedron has a closed form, C = det(A) · A · Ccanon · Aᵀ with A = [a b c].
 * Summing those and taking I = tr(C)·1 − C gives the tensor. The geometry is
 * already centred on its centre of mass, so no parallel-axis shift is needed.
 */
export function computeInertiaTensor(geometry, density) {
  const pos = geometry.attributes.position.array;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];   // row-major 3x3
  let volume = 0;

  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i],     ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];

    const det = ax * (by * cz - bz * cy)
              - ay * (bx * cz - bz * cx)
              + az * (bx * cy - by * cx);
    if (det === 0) continue;
    volume += det / 6;

    // A · Ccanon · Aᵀ, with Ccanon = (1/120)[[2,1,1],[1,2,1],[1,1,2]].
    // Expanded, the (i,j) entry is (2(aᵢaⱼ + bᵢbⱼ + cᵢcⱼ) + sᵢsⱼ) / 120
    // where s = a + b + c — a rearrangement that avoids the matrix products.
    const sx = ax + bx + cx, sy = ay + by + cy, sz = az + bz + cz;
    const k = det / 120;

    C[0] += k * (2 * (ax * ax + bx * bx + cx * cx) + sx * sx);
    C[4] += k * (2 * (ay * ay + by * by + cy * cy) + sy * sy);
    C[8] += k * (2 * (az * az + bz * bz + cz * cz) + sz * sz);
    const xy = k * (2 * (ax * ay + bx * by + cx * cy) + sx * sy);
    const xz = k * (2 * (ax * az + bx * bz + cx * cz) + sx * sz);
    const yz = k * (2 * (ay * az + by * bz + cy * cz) + sy * sz);
    C[1] += xy; C[3] += xy;
    C[2] += xz; C[6] += xz;
    C[5] += yz; C[7] += yz;
  }

  const sign = volume < 0 ? -1 : 1;
  const tr = (C[0] + C[4] + C[8]) * sign * density;
  const m = new THREE.Matrix3();
  m.set(
    tr - C[0] * sign * density, -C[1] * sign * density, -C[2] * sign * density,
    -C[3] * sign * density, tr - C[4] * sign * density, -C[5] * sign * density,
    -C[6] * sign * density, -C[7] * sign * density, tr - C[8] * sign * density,
  );
  return { tensor: m, volume: Math.abs(volume) };
}

/**
 * Extreme vertex in each support direction — a convex-hull stand-in that
 * captures exactly the points able to touch the ground.
 */
export function computeContactPoints(geometry, limit = 42) {
  const pos = geometry.attributes.position.array;
  const n = pos.length / 3;
  const D = SUPPORT_DIRS.length;
  const bestDot = new Float32Array(D).fill(-Infinity);
  const bestIdx = new Int32Array(D).fill(-1);
  // Flat directions: 42 Vector3 property lookups per vertex is the single
  // largest cost of the frame right after a cut, when every new fragment
  // computes this for the first time.
  const dirs = SUPPORT_DIRS_FLAT;

  for (let i = 0; i < n; i++) {
    const p = i * 3;
    const x = pos[p], y = pos[p + 1], z = pos[p + 2];
    for (let d = 0; d < D; d++) {
      const q = d * 3;
      const dot = x * dirs[q] + y * dirs[q + 1] + z * dirs[q + 2];
      if (dot > bestDot[d]) { bestDot[d] = dot; bestIdx[d] = i; }
    }
  }

  const out = [];
  const seen = new Set();
  for (let d = 0; d < bestIdx.length && out.length < limit; d++) {
    const i = bestIdx[d];
    if (i < 0) continue;
    const key = `${Math.round(pos[i * 3] * 1e3)},${Math.round(pos[i * 3 + 1] * 1e3)},${Math.round(pos[i * 3 + 2] * 1e3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
  }
  return out;
}

const _r = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _vt = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _impNeg = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _rA = new THREE.Vector3();
const _rB = new THREE.Vector3();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nUp = new THREE.Vector3();
const _em = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _m3b = new THREE.Matrix3();
const _totalAng = new THREE.Vector3();

let _bodyId = 0;

export class Body {
  /**
   * @param {object} o {geometry, volume, radius, family, contactPoints}
   */
  constructor(o) {
    this.id = ++_bodyId;
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angular = new THREE.Vector3();

    // Split-impulse channel. Overlap is pushed out through these and they are
    // discarded after integration, so separating a resting stack costs it no
    // real momentum — the alternative injects energy on every step and the
    // stack slowly bounces itself awake forever.
    this.pseudoVel = new THREE.Vector3();
    this.pseudoAng = new THREE.Vector3();

    this.radius = o.radius;
    this.volume = Math.max(o.volume, 1e-5);
    this.density = DENSITY[o.family] ?? 1.2;
    this.mass = Math.max(this.volume * this.density, 1e-3);
    this.invMass = 1 / this.mass;

    // Real inertia tensor when there is geometry to compute it from, so a
    // slab and a cube of the same mass do not tumble identically.
    this.invInertiaLocal = new THREE.Matrix3();
    this._invInertiaWorld = new THREE.Matrix3();
    this._inertiaDirty = true;

    this._buildInertia(o.contactSource);

    this._contacts = o.contactPoints ?? null;
    this._geometry = o.contactSource ?? null;
    this._hull = undefined;                    // undefined = not built yet
    this._worldHull = { verts: null, planes: null, vertCount: 0, planeCount: 0 };
    this._hullStamp = -1;
    this.restitution = o.restitution ?? 0.12;
    this.friction = o.friction ?? 0.62;

    this.sleeping = false;
    this._stillFor = 0;
    this._touching = false;   // resting on the ground this step
    this.frozen = false;      // held in place until the first cut
  }

  /** Support points, built on first use — see the note at construction. */
  get contacts() {
    if (this._contacts === null) {
      this._contacts = this._geometry ? computeContactPoints(this._geometry) : [];
    }
    return this._contacts;
  }

  /** Convex hull, built on first use. Null for degenerate chips. */
  get hull() {
    if (this._hull === undefined) {
      this._hull = this._geometry ? buildHull(this._geometry) : null;
    }
    return this._hull;
  }

  /** World-space hull, refreshed at most once per solver stamp. */
  worldHull(stamp) {
    const h = this.hull;
    if (!h) return null;
    if (this._hullStamp !== stamp) {
      transformHull(h, this.quaternion, this.position, this._worldHull);
      this._hullStamp = stamp;
    }
    return this._worldHull;
  }

  /**
   * Build the inverse inertia tensor, defensively.
   *
   * A cut can produce a fragment that is essentially a sheet of paper, and the
   * exact tensor of such a shape is near-singular: inverting it yields enormous
   * — sometimes negative — values, the first impulse spins the body to
   * infinity, and NaN then spreads through every contact it touches and into
   * the camera. So the tensor is floored with a small isotropic term before
   * inversion, and rejected outright if it still is not positive definite.
   */
  _buildInertia(geometry) {
    const sphere = Math.max(0.4 * this.mass * this.radius * this.radius, 1e-8);

    if (geometry) {
      const { tensor } = computeInertiaTensor(geometry, this.density);
      const e = tensor.elements;                       // column-major
      const floor = sphere * 0.05;
      e[0] += floor; e[4] += floor; e[8] += floor;

      const finite = e.every((v) => isFinite(v));
      // Sylvester's criterion on the leading principal minors
      const m1 = e[0];
      const m2 = e[0] * e[4] - e[3] * e[1];
      const m3 = tensor.determinant();
      if (finite && m1 > 0 && m2 > 0 && m3 > sphere * sphere * sphere * 1e-6) {
        this.invInertiaLocal.copy(tensor).invert();
        if (this.invInertiaLocal.elements.every((v) => isFinite(v))) return;
      }
    }

    this.invInertiaLocal.set(1 / sphere, 0, 0, 0, 1 / sphere, 0, 0, 0, 1 / sphere);
  }

  /** I⁻¹ in world space is R · I⁻¹local · Rᵀ; it only changes when the body turns. */
  invInertiaWorld() {
    if (this._inertiaDirty) {
      _rot.makeRotationFromQuaternion(this.quaternion);
      _m3.setFromMatrix4(_rot);
      _m3b.copy(_m3).transpose();
      this._invInertiaWorld.copy(_m3).multiply(this.invInertiaLocal).multiply(_m3b);
      this._inertiaDirty = false;
    }
    return this._invInertiaWorld;
  }

  /**
   * A sleeping body is immovable, exactly like a frozen one.
   *
   * Letting the solver push one is subtly wrong: the impulse lands on a body
   * that is not integrating, so the velocity just banks up unseen, and the
   * moment anything wakes it that stored energy fires it off.
   */
  get isStatic() { return this.frozen || this.sleeping; }

  applyImpulse(impulse, r) {
    if (this.isStatic) return;
    this.velocity.addScaledVector(impulse, this.invMass);
    _cross.crossVectors(r, impulse).applyMatrix3(this.invInertiaWorld());
    this.angular.add(_cross);
  }

  applyPseudoImpulse(impulse, r) {
    if (this.isStatic) return;
    this.pseudoVel.addScaledVector(impulse, this.invMass);
    _cross.crossVectors(r, impulse).applyMatrix3(this.invInertiaWorld());
    this.pseudoAng.add(_cross);
  }

  /**
   * Effective inverse mass along `n` at offset `r`:
   *   1/m + n · ((I⁻¹ (r × n)) × r)
   */
  effectiveMass(r, n) {
    if (this.isStatic) return 0;
    _em.crossVectors(r, n).applyMatrix3(this.invInertiaWorld()).cross(r);
    return this.invMass + n.dot(_em);
  }

  wake() {
    this.sleeping = false;
    this._stillFor = 0;
  }
}

export class World {
  constructor(floorY = 0) {
    this.floorY = floorY;
    /** @type {Body[]} */
    this.bodies = [];
    this.gravity = GRAVITY;
    this.solverIterations = 8;
    this._pairContacts = [];
    this._pairCorrections = [];
    this._groundContacts = [];
    this._pairState = new Map();
    this._stamp = 0;
    // A settled pile never goes exactly still under an approximate solver: it
    // buzzes in place at a few centimetres per second forever. Sleeping is
    // allowed either when that buzz is small or when the body has demonstrably
    // gone nowhere, so a piece genuinely creeping across the bench stays awake
    // while one merely vibrating in place does not.
    this.sleepSpeed = 0.12;
    this.sleepTime = 0.45;
  }

  add(body) { this.bodies.push(body); return body; }

  remove(body) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
  }

  clear() {
    this.bodies.length = 0;
    this._pairState.clear();
  }

  /** Fixed-step integration; the caller may run several per frame. */
  step(dt) {
    const bodies = this.bodies;

    // Whether a body is moving enough to disturb a sleeping neighbour has to
    // be judged BEFORE gravity is applied. One step of gravity is 0.16 m/s —
    // more than the threshold — so every awake body looked lively the instant
    // the step began, and a settled stack woke itself up forever.
    for (const b of bodies) {
      b._wasLively = !b.sleeping && !b.frozen &&
        (b.velocity.length() + b.angular.length() * b.radius > WAKE_SPEED);
    }

    for (const b of bodies) {
      if (b.sleeping || b.frozen) continue;
      b.velocity.y += this.gravity * dt;
      // mild drag keeps tumbling from looking perpetual
      b.velocity.multiplyScalar(1 - Math.min(0.5, 0.16 * dt));
      b.angular.multiplyScalar(1 - Math.min(0.5, 0.5 * dt));
    }

    // Build every contact first, then relax them all together.
    //
    // Solving ground and piece-against-piece in separate passes lets the two
    // fight: the pair pass drives the lower box down into the bench, the ground
    // pass shoves it back up, and neither ever converges — a stacked box walked
    // slowly sideways off its neighbour and never fell asleep. One interleaved
    // relaxation over the combined set fixes it.
    this._buildGroundContacts();
    this._buildPairContacts();

    // Baumgarte factor: how much of the remaining overlap is turned into
    // separating velocity each step.
    this._bias = BAUMGARTE / dt;

    const ground = this._groundContacts;
    const pairs = this._pairContacts;

    if (ground.length || pairs.length) {
      for (let iter = 0; iter < this.solverIterations; iter++) {
        for (let i = 0; i < ground.length; i++) this._resolveGround(ground[i]);
        for (let i = 0; i < pairs.length; i++) this._resolveContact(pairs[i]);
      }
      // separate overlap on the pseudo channel, which is discarded after
      // integrating position — no energy enters the real velocities
      for (let iter = 0; iter < PSEUDO_ITERATIONS; iter++) {
        for (let i = 0; i < ground.length; i++) this._resolveGroundPseudo(ground[i]);
        for (let i = 0; i < pairs.length; i++) this._resolveContactPseudo(pairs[i]);
      }
      this._applyPositionalCorrection();
    }

    for (const b of bodies) {
      if (b.sleeping || b.frozen) continue;

      // Rolling resistance. Coulomb friction alone cannot stop a rolling
      // body — in pure rolling the contact point is not sliding, so the
      // tangential impulse is zero and a round chair leg rolls across the
      // bench forever. Real surfaces lose energy to deformation at the
      // contact; this stands in for that, and it is what actually brings
      // pieces to rest.
      if (b._touching) {
        const k = Math.min(0.9, 4.0 * dt);
        b.angular.multiplyScalar(1 - k);
        b.velocity.x *= 1 - Math.min(0.9, 2.2 * dt);
        b.velocity.z *= 1 - Math.min(0.9, 2.2 * dt);
      }

      // Clamp before integrating. An approximate solver plus a near-degenerate
      // fragment can occasionally produce an enormous impulse, and once a body
      // leaves the finite numbers it takes every contact it touches with it.
      const sp = b.velocity.length();
      if (sp > MAX_SPEED) b.velocity.multiplyScalar(MAX_SPEED / sp);
      const sw = b.angular.length();
      if (sw > MAX_SPIN) b.angular.multiplyScalar(MAX_SPIN / sw);

      if (!isFinite(b.position.x + b.position.y + b.position.z + sp + sw)) {
        b.broken = true;
        b.velocity.set(0, 0, 0);
        b.angular.set(0, 0, 0);
        continue;
      }

      // integrate with the pseudo channel folded in, then throw it away
      b.position.addScaledVector(b.velocity, dt).addScaledVector(b.pseudoVel, dt);

      _totalAng.copy(b.angular).add(b.pseudoAng);
      const len = _totalAng.length();
      if (len > 1e-6) {
        _spin.setFromAxisAngle(_delta.copy(_totalAng).divideScalar(len), len * dt);
        b.quaternion.premultiply(_spin).normalize();
        // the world inertia tensor is orientation-dependent
        b._inertiaDirty = true;
      }
      b.pseudoVel.set(0, 0, 0);
      b.pseudoAng.set(0, 0, 0);

      const w = b.angular;

      // Sleep on whether the body has actually gone anywhere, not on how fast
      // it is instantaneously moving.
      //
      // A settled stack never stops twitching under an approximate solver: it
      // buzzes in place at a few centimetres per second and any velocity
      // threshold either sits inside that buzz — so nothing ever sleeps — or
      // above it, which would also let a genuinely creeping piece doze off.
      // Displacement from where it was a moment ago separates the two cleanly.
      if (!b._anchor) { b._anchor = b.position.clone(); b._anchorQ = b.quaternion.clone(); }

      const moved = b.position.distanceTo(b._anchor);
      const turned = 2 * Math.acos(Math.min(1, Math.abs(b.quaternion.dot(b._anchorQ)))) * b.radius;

      const surfaceSpeed = b.velocity.length() + w.length() * b.radius;
      if (moved + turned < SLEEP_DRIFT || surfaceSpeed < this.sleepSpeed) {
        b._stillFor += dt;
        if (b._stillFor > this.sleepTime) {
          b.sleeping = true;
          b.velocity.set(0, 0, 0);
          b.angular.set(0, 0, 0);
        }
      } else {
        b._stillFor = 0;
        b._anchor.copy(b.position);
        b._anchorQ.copy(b.quaternion);
      }
    }
  }

  /** Support points below the bench, as contacts against a +Y plane. */
  _buildGroundContacts() {
    const floor = this.floorY;
    const out = this._groundContacts;
    out.length = 0;

    for (const b of this.bodies) {
      b._touching = false;
      b._deepestGround = 0;
      if (b.sleeping || b.frozen) continue;

      for (const local of b.contacts) {
        _wp.copy(local).applyQuaternion(b.quaternion).add(b.position);
        const depth = floor - _wp.y;

        // A contact margin, not just depth > 0. Without it a resting body
        // never counts as touching at the instant it is exactly on the
        // surface, so that step's gravity goes uncancelled and it sinks a
        // fraction of a millimetre before being caught again. The resulting
        // buzz is invisible but sits permanently above the sleep threshold,
        // and nothing on the bench ever settles.
        if (depth <= -CONTACT_SLOP) continue;

        b._touching = true;
        if (depth > b._deepestGround) b._deepestGround = depth;
        out.push({
          b, depth,
          rx: _wp.x - b.position.x, ry: _wp.y - b.position.y, rz: _wp.z - b.position.z,
        });
      }
    }
  }

  _resolveGround(c) {
    const b = c.b;
    _r.set(c.rx, c.ry, c.rz);

    // point velocity = v + w x r
    _cross.crossVectors(b.angular, _r);
    _vp.copy(b.velocity).add(_cross);

    const vn = _vp.y;
    if (vn >= 0) return;

    _nUp.set(0, 1, 0);
    const k = b.effectiveMass(_r, _nUp);
    // only bounce on a genuine impact, not on resting contact
    const e = vn < -0.9 ? b.restitution : 0;
    const j = -(1 + e) * vn / Math.max(k, 1e-8);
    if (j <= 0) return;

    _imp.set(0, j, 0);
    b.applyImpulse(_imp, _r);

    // Coulomb friction in the tangent plane
    _cross.crossVectors(b.angular, _r);
    _vt.copy(b.velocity).add(_cross);
    _vt.y = 0;
    const vtLen = _vt.length();
    if (vtLen <= 1e-5) return;

    _vt.divideScalar(vtLen);
    const kt = b.effectiveMass(_r, _vt);
    let jt = -vtLen / Math.max(kt, 1e-8);
    const maxT = b.friction * j;
    jt = Math.max(-maxT, Math.min(maxT, jt));
    _imp.copy(_vt).multiplyScalar(jt);
    b.applyImpulse(_imp, _r);
  }

  /** Push a body up out of the bench, on the pseudo channel. */
  _resolveGroundPseudo(c) {
    const b = c.b;
    const bias = Math.min(this._bias * Math.max(0, c.depth - PENETRATION_SLOP), MAX_BIAS_SPEED);
    if (bias <= 0) return;

    _r.set(c.rx, c.ry, c.rz);
    _cross.crossVectors(b.pseudoAng, _r);
    _vp.copy(b.pseudoVel).add(_cross);
    const vn = _vp.y;
    if (vn >= bias) return;

    _nUp.set(0, 1, 0);
    const k = b.effectiveMass(_r, _nUp);
    const j = (bias - vn) / Math.max(k, 1e-8);
    if (j <= 0) return;
    _imp.set(0, j, 0);
    b.applyPseudoImpulse(_imp, _r);
  }

  /** Push two pieces apart, on the pseudo channel. */
  _resolveContactPseudo(c) {
    const A = c.a, B = c.b;
    const bias = Math.min(this._bias * Math.max(0, c.correctDepth - PENETRATION_SLOP), MAX_BIAS_SPEED);
    if (bias <= 0) return;
    if (A.isStatic && B.isStatic) return;

    _rA.set(c.px - A.position.x, c.py - A.position.y, c.pz - A.position.z);
    _rB.set(c.px - B.position.x, c.py - B.position.y, c.pz - B.position.z);
    _n.set(c.nx, c.ny, c.nz);

    _cross.crossVectors(A.pseudoAng, _rA);
    _vA.copy(A.pseudoVel).add(_cross);
    _cross.crossVectors(B.pseudoAng, _rB);
    _vB.copy(B.pseudoVel).add(_cross);
    const vn = _vB.sub(_vA).dot(_n);
    if (vn >= bias) return;

    const kn = A.effectiveMass(_rA, _n) + B.effectiveMass(_rB, _n);
    if (kn <= 1e-9) return;
    const jn = (bias - vn) / kn;
    if (jn <= 0) return;

    _imp.copy(_n).multiplyScalar(jn);
    A.applyPseudoImpulse(_impNeg.copy(_imp).negate(), _rA);
    B.applyPseudoImpulse(_imp, _rB);
  }

  /**
   * A hard backstop for gross penetration only.
   *
   * Ordinary overlap is resolved through the velocity bias above. This exists
   * for the case that bias cannot fix in reasonable time — a body that ended up
   * deeply inside something after a very fast impact — and it deliberately
   * leaves everything shallower alone, because moving a resting body is what
   * creates the lift-off cycle in the first place.
   */
  _applyPositionalCorrection() {
    const gross = 0.02;
    for (const c of this._pairCorrections) {
      const A = c.a, B = c.b;
      const excess = c.correctDepth - gross;
      if (excess <= 0) continue;
      const invSum = (A.isStatic ? 0 : A.invMass) + (B.isStatic ? 0 : B.invMass);
      if (invSum <= 0) continue;
      const push = excess * 0.5 / invSum;
      if (!A.isStatic) {
        A.position.x -= c.nx * push * A.invMass;
        A.position.y -= c.ny * push * A.invMass;
        A.position.z -= c.nz * push * A.invMass;
      }
      if (!B.isStatic) {
        B.position.x += c.nx * push * B.invMass;
        B.position.y += c.ny * push * B.invMass;
        B.position.z += c.nz * push * B.invMass;
      }
    }

    for (const b of this.bodies) {
      if (!b.frozen && !b.sleeping && b._deepestGround > gross) {
        b.position.y += (b._deepestGround - gross) * 0.5;
      }
    }
  }

  /**
   * Piece against piece, via convex hulls.
   *
   * Broadphase is a bounding-sphere reject, which is only a *reject* — an
   * overlap here means nothing on its own, since two halves of a freshly cut
   * object always have overlapping spheres. The hull test decides.
   */
  _buildPairContacts() {
    const bodies = this.bodies;
    const stamp = ++this._stamp;
    const contacts = this._pairContacts;
    contacts.length = 0;
    this._pairCorrections.length = 0;

    for (let i = 0; i < bodies.length; i++) {
      const A = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const B = bodies[j];

        const bothIdle = (A.sleeping || A.frozen) && (B.sleeping || B.frozen);
        if (bothIdle) continue;
        if (A.frozen && B.frozen) continue;

        _delta.subVectors(B.position, A.position);
        const rsum = A.radius + B.radius;
        if (_delta.lengthSq() > rsum * rsum) continue;

        const ha = A.worldHull(stamp), hb = B.worldHull(stamp);
        if (!ha || !hb) continue;

        const found = hullContacts(ha, hb, 6);
        if (found.length === 0) continue;

        // A touched body has to wake, or a fragment dropped onto a settled pile
        // would pass straight through it — but only for *genuine* motion.
        // Waking on mere contact makes a heap self-sustaining: one twitching
        // piece wakes its neighbours, they wake theirs, and the pile never
        // sleeps however still it actually is.
        if (A.sleeping && B._wasLively) A.wake();
        if (B.sleeping && A._wasLively) B.wake();

        // ── overlap that was there to begin with ──────────────────
        //
        // A convex hull fills in whatever the shape does not. Cut a mug in
        // half and each half's hull spans the cavity, so the two hulls overlap
        // deeply while the actual halves merely touch. Resolving that as
        // penetration flings freshly cut pieces apart the instant the blade
        // lands — the exact thing a saw does not do.
        //
        // So a pair remembers how far it was overlapping when it first met,
        // and only penetration *beyond* that is pushed out. Two halves stay
        // where they were put; a piece dropped onto a pile later meets a fresh
        // pair with no allowance and is stopped properly.
        const key = A.id < B.id ? `${A.id}:${B.id}` : `${B.id}:${A.id}`;
        let st = this._pairState.get(key);
        if (st === undefined) {
          let deepest = 0, deepestC = null;
          for (const c of found) if (c.depth > deepest) { deepest = c.depth; deepestC = c; }

          // An allowance is only granted to a pair that appears *already*
          // overlapping and not moving into each other — the signature of two
          // halves that were one solid a moment ago. A pair created by an
          // impact is approaching fast, and its penetration is real and must
          // be pushed out, or a dropped piece sinks into whatever it lands on.
          const approach = deepestC ? -relativeNormalVelocity(A, B, deepestC) : 0;
          const settled = approach < 0.05;
          st = {
            allowance: settled ? Math.min(deepest, Math.min(A.radius, B.radius) * 0.75) : 0,
          };
          this._pairState.set(key, st);
        }
        st.seen = stamp;

        let worst = null;
        for (const c of found) {
          c.a = A; c.b = B;
          c.correctDepth = Math.max(0, c.depth - st.allowance);
          // resting on another piece counts as ground contact for the purpose
          // of rolling resistance, or a fragment rolls forever on top of a pile
          A._touching = true; B._touching = true;
          contacts.push(c);
          if (!worst || c.correctDepth > worst.correctDepth) worst = c;
        }
        // One correction per PAIR, from its deepest contact. Correcting every
        // contact separately pushes a four-point resting face out four times
        // as far as it needs: the stack lifts off, free-falls, lands, and
        // repeats — a slow limit cycle that never lets anything sleep.
        if (worst) this._pairCorrections.push(worst);
      }
    }

    // forget pairs that are no longer touching, so a re-contact starts clean
    if (this._pairState.size > 0) {
      for (const [k, st] of this._pairState) {
        if (st.seen !== stamp) this._pairState.delete(k);
      }
    }
  }

  _resolveContact(c) {
    const A = c.a, B = c.b;
    const invMA = A.isStatic ? 0 : A.invMass, invMB = B.isStatic ? 0 : B.invMass;
    if (invMA + invMB <= 0) return;

    _rA.set(c.px - A.position.x, c.py - A.position.y, c.pz - A.position.z);
    _rB.set(c.px - B.position.x, c.py - B.position.y, c.pz - B.position.z);
    _n.set(c.nx, c.ny, c.nz);

    // relative velocity of the contact point, B against A
    _cross.crossVectors(A.angular, _rA);
    _vA.copy(A.velocity).add(_cross);
    _cross.crossVectors(B.angular, _rB);
    _vB.copy(B.velocity).add(_cross);
    _vp.subVectors(_vB, _vA);

    const vn = _vp.dot(_n);
    if (vn > 0) return;                       // already separating

    const kn = A.effectiveMass(_rA, _n) + B.effectiveMass(_rB, _n);
    if (kn <= 1e-9) return;

    const e = vn < -0.7 ? Math.min(A.restitution, B.restitution) : 0;
    const jn = -(1 + e) * vn / kn;
    if (jn <= 0) return;

    _imp.copy(_n).multiplyScalar(jn);
    if (invMA > 0) A.applyImpulse(_impNeg.copy(_imp).negate(), _rA);
    if (invMB > 0) B.applyImpulse(_imp, _rB);

    // friction along the tangent
    _cross.crossVectors(A.angular, _rA);
    _vA.copy(A.velocity).add(_cross);
    _cross.crossVectors(B.angular, _rB);
    _vB.copy(B.velocity).add(_cross);
    _vp.subVectors(_vB, _vA);
    _vt.copy(_vp).addScaledVector(_n, -_vp.dot(_n));

    const vtLen = _vt.length();
    if (vtLen < 1e-5) return;
    _vt.divideScalar(vtLen);

    const kt = A.effectiveMass(_rA, _vt) + B.effectiveMass(_rB, _vt);
    if (kt <= 1e-9) return;

    const mu = Math.sqrt(A.friction * B.friction);
    let jt = -vtLen / kt;
    jt = Math.max(-mu * jn, Math.min(mu * jn, jt));

    _imp.copy(_vt).multiplyScalar(jt);
    if (invMA > 0) A.applyImpulse(_impNeg.copy(_imp).negate(), _rA);
    if (invMB > 0) B.applyImpulse(_imp, _rB);
  }
}

export { GRAVITY, DENSITY };
