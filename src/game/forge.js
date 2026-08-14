import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { SimplexNoise } from '../core/noise.js';
import { interpret, ARCHETYPE } from './lexicon.js';
import { FAMILY, SkinMaterial, InteriorMaterial, registerAnimated } from './materials.js';
import { volumeAndCentroid, MAT_SKIN, MAT_ACCENT } from './slicer.js';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  THE FORGE
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Turns a string into a watertight, sliceable, shaded 3D object.
 *
 *  Every archetype below builds a *closed* surface — that is the one hard
 *  requirement, because the slicer's cap generation assumes the mesh it
 *  receives has no boundary. Where a generator would naturally leave a
 *  hole (a lathe profile, a swept tube) it is closed explicitly rather
 *  than left to chance.
 *
 *  Output geometry is non-indexed with two material groups already in
 *  place: group 0 = skin, group 1 = interior. The interior group starts
 *  empty and fills in as the object gets cut.
 */

const MAX_TRIS_BUDGET = 4200;

const _dirScratch = new THREE.Vector3();

/* ── helpers ─────────────────────────────────────────────────────── */

/**
 * Build a closed surface of revolution from a radius profile.
 *
 * The profile must touch the axis at both ends, otherwise the lathe leaves a
 * hole where the poles should be and the slicer inherits an open mesh. Adding
 * an r=0 point at the same height as the first/last ring closes it with a flat
 * disc — which is also exactly the right shape for a flat-bottomed vase.
 */
function latheGeometry(profile, segments, closeTop, closeBottom) {
  const pts = profile.map((p) => new THREE.Vector2(Math.max(p.r, 0), p.y));

  if (closeBottom && pts[0].x > 0) pts.unshift(new THREE.Vector2(0, pts[0].y));
  if (closeTop && pts[pts.length - 1].x > 0) {
    pts.push(new THREE.Vector2(0, pts[pts.length - 1].y));
  }
  const geo = new THREE.LatheGeometry(pts, segments);
  geo.computeVertexNormals(); // robust across the degenerate pole ring
  return geo;
}

/** Displace a sphere's vertices by a noise field — the fruit/rock workhorse. */
function displaceSphere(geo, noise, opts) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const {
    amp = 0.12, freq = 1.8, octaves = 3, ridged = false,
    lobes = 0, lobeDepth = 0, squash = 1, taper = 0, seed = 0,
  } = opts;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const len = v.length() || 1e-6;
    const n = v.clone().divideScalar(len);

    let d = ridged
      ? noise.ridged(n.x * freq + seed, n.y * freq, n.z * freq, octaves)
      : noise.fbm(n.x * freq + seed, n.y * freq, n.z * freq, octaves);

    let r = len * (1 + d * amp);

    // Vertical lobing — pumpkins, brains, hearts.
    //
    // Fading the effect out with the horizontal radius is not just styling: at
    // a sphere's poles x and z are *signed* zeros, and atan2 maps those to 0,
    // -0, +pi and -pi depending on the sign bits. The pole's coincident
    // vertices would then displace by different amounts and tear open. Scaling
    // by `horiz` drives the term to zero before that matters — and lobes that
    // converge at the stem look right anyway.
    if (lobes > 0) {
      const horiz = Math.hypot(n.x, n.z);
      if (horiz > 1e-6) {
        const theta = Math.atan2(n.z, n.x);
        r *= 1 - lobeDepth * horiz * Math.pow(Math.abs(Math.sin(theta * lobes * 0.5)), 1.6);
      }
    }
    // taper toward the top — pears, eggs
    if (taper !== 0) r *= 1 - taper * (n.y * 0.5 + 0.5);

    v.copy(n).multiplyScalar(r);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Drop triangles that have a repeated vertex.
 *
 * Primitives that close on an axis — every lathe, cone and shard — emit a ring
 * of needle triangles where the profile touches r=0. They render as nothing,
 * but each one contributes the same welded edge twice, which reads as
 * non-manifold to anything that inspects the topology. The slicer discards
 * them on its own; stripping them here means the mesh handed to it is already
 * clean, and the "input is closed" precondition genuinely holds.
 */
function stripDegenerateTriangles(geometry, eps) {
  const pos = geometry.attributes.position.array;
  const nor = geometry.attributes.normal?.array;
  const uv = geometry.attributes.uv?.array;
  const slot = geometry.attributes.slot?.array;
  const triCount = (pos.length / 9) | 0;
  const e2 = eps * eps;

  const keep = new Uint8Array(triCount);
  let kept = 0;
  const near = (i, j) => {
    const dx = pos[i] - pos[j], dy = pos[i + 1] - pos[j + 1], dz = pos[i + 2] - pos[j + 2];
    return dx * dx + dy * dy + dz * dz < e2;
  };
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    if (near(b, b + 3) || near(b + 3, b + 6) || near(b + 6, b)) continue;
    keep[t] = 1;
    kept++;
  }
  if (kept === triCount) return geometry;

  const np = new Float32Array(kept * 9);
  const nn = nor ? new Float32Array(kept * 9) : null;
  const nu = uv ? new Float32Array(kept * 6) : null;
  const ns = slot ? new Float32Array(kept * 3) : null;
  let o = 0;
  for (let t = 0; t < triCount; t++) {
    if (!keep[t]) continue;
    np.set(pos.subarray(t * 9, t * 9 + 9), o * 9);
    if (nn) nn.set(nor.subarray(t * 9, t * 9 + 9), o * 9);
    if (nu) nu.set(uv.subarray(t * 6, t * 6 + 6), o * 6);
    if (ns) ns.set(slot.subarray(t * 3, t * 3 + 3), o * 3);
    o++;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(np, 3));
  if (nn) out.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
  if (nu) out.setAttribute('uv', new THREE.BufferAttribute(nu, 2));
  if (ns) out.setAttribute('slot', new THREE.BufferAttribute(ns, 1));
  geometry.dispose();
  return out;
}

/**
 * Recompute normals, smoothing across gentle joins and keeping sharp ones sharp.
 *
 * `computeVertexNormals` averages every face meeting at a point, and on a
 * turned object that folds back on itself — a bowl, a mug, a lampshade — the
 * outer wall and the inner wall meet at the rim facing opposite directions.
 * Averaging them produces a normal pointing at neither, and on a wall a couple
 * of millimetres thick the result actually faces *behind* its own triangle: the
 * rim shades as though lit from inside the object. Before this, 45 of a bowl's
 * triangles and 44 of a lampshade's were back-facing before anything was even
 * cut.
 *
 * Two faces are averaged only if they genuinely belong to the same smooth
 * surface. Around the revolution neighbouring faces differ by a few degrees and
 * blend as before; at the rim they differ by more than a right angle and each
 * keeps its own normal, which is what a real edge looks like.
 *
 * Faces are weighted by area, so a sliver cannot outvote the surface it sits on.
 */
function smoothNormals(geometry, maxAngleDeg = 50) {
  const pos = geometry.attributes.position.array;
  const triCount = (pos.length / 9) | 0;
  if (triCount === 0) return geometry;
  const limit = Math.cos((maxAngleDeg * Math.PI) / 180);

  // face normals, left un-normalised so their length is twice the area
  const fx = new Float64Array(triCount), fy = new Float64Array(triCount), fz = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    fx[t] = uy * vz - uz * vy;
    fy[t] = uz * vx - ux * vz;
    fz[t] = ux * vy - uy * vx;
  }

  geometry.computeBoundingSphere();
  const r = Math.max(geometry.boundingSphere?.radius ?? 1, 1e-6);
  const q = 1 / Math.max(r * 1e-5, 1e-9);
  const at = new Map();
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const i = t * 9 + c * 3;
      const key = `${Math.round(pos[i] * q)},${Math.round(pos[i + 1] * q)},${Math.round(pos[i + 2] * q)}`;
      const list = at.get(key);
      if (list) list.push(t); else at.set(key, [t]);
    }
  }

  const out = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    const nl = Math.hypot(fx[t], fy[t], fz[t]) || 1;
    const ox = fx[t] / nl, oy = fy[t] / nl, oz = fz[t] / nl;

    for (let c = 0; c < 3; c++) {
      const i = t * 9 + c * 3;
      const key = `${Math.round(pos[i] * q)},${Math.round(pos[i + 1] * q)},${Math.round(pos[i + 2] * q)}`;
      let ax = 0, ay = 0, az = 0;
      for (const s of at.get(key)) {
        const sl = Math.hypot(fx[s], fy[s], fz[s]);
        if (sl < 1e-20) continue;                       // needle: contributes nothing
        if ((fx[s] * ox + fy[s] * oy + fz[s] * oz) / sl < limit) continue;
        ax += fx[s]; ay += fy[s]; az += fz[s];          // un-normalised: area-weighted
      }
      const al = Math.hypot(ax, ay, az);
      if (al > 1e-20) { out[i] = ax / al; out[i + 1] = ay / al; out[i + 2] = az / al; }
      else { out[i] = ox; out[i + 1] = oy; out[i + 2] = oz; }
    }
  }

  geometry.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geometry;
}

/**
 * Tag a part so it gets its own surface.
 *
 * A lamp is a brass base under a linen shade; one material for the whole thing
 * makes it a piece of brass shaped like a lamp. A tagged part lands in
 * MAT_ACCENT and takes the second material the builder describes in
 * `geometry.userData.accent`; everything else is the object's own skin.
 */
function accent(geometry) {
  geometry.userData.slot = MAT_ACCENT;
  return geometry;
}

/** Merge a list of geometries into one non-indexed soup, disposing the inputs. */
function mergeGeometries(list) {
  let total = 0;
  // Skin parts first, accent parts after, keeping the original order within
  // each. Groups have to come out sorted by material index, and leaving that to
  // whoever wrote the builder means it breaks the first time someone adds a
  // finial above the lampshade.
  const ordered = list.filter((g) => !g.userData.slot)
    .concat(list.filter((g) => g.userData.slot));
  const prepped = ordered.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) n.userData.slot = g.userData.slot;
    if (!n.attributes.normal) n.computeVertexNormals();
    if (!n.attributes.uv) {
      n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
    }
    total += n.attributes.position.count;
    return n;
  });

  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const slot = new Float32Array(total);
  let o3 = 0, o2 = 0, o1 = 0;
  for (const g of prepped) {
    pos.set(g.attributes.position.array, o3);
    nor.set(g.attributes.normal.array, o3);
    uv.set(g.attributes.uv.array, o2);
    const count = g.attributes.position.count;
    if (g.attributes.slot) slot.set(g.attributes.slot.array, o1);
    else if (g.userData.slot) slot.fill(g.userData.slot, o1, o1 + count);
    o3 += g.attributes.position.array.length;
    o2 += g.attributes.uv.array.length;
    o1 += count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('slot', new THREE.BufferAttribute(slot, 1));

  // Carry a part's declarations onto the merged whole, so a surface override
  // survives having another part welded on.
  for (const g of ordered) {
    for (const key of ['skin', 'accent']) {
      if (g.userData[key] && !out.userData[key]) out.userData[key] = g.userData[key];
    }
  }

  // free both the originals and any non-indexed copies made along the way
  for (let i = 0; i < ordered.length; i++) {
    if (prepped[i] !== ordered[i]) prepped[i].dispose();
    ordered[i].dispose();
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   ARCHETYPES
   ══════════════════════════════════════════════════════════════════ */

/**
 * A clean, slightly squashed sphere — apples, plums, potatoes, balls.
 *
 * Deliberately almost smooth. An earlier version pushed several octaves of
 * noise through the radius, which turned every piece of fruit into a lumpy
 * potato and made none of them look like the thing they were named after.
 * Fruit is close to a sphere; the recognisable part is the proportion and the
 * dimple at the top, not surface warts.
 */
function buildSpheroid(rng, noise, detail, profileName) {
  if (profileName === 'apple') return buildApple(rng, noise, detail);

  const w = detail.high ? 48 : 36;
  const h = detail.high ? 36 : 26;
  const geo = new THREE.SphereGeometry(1, w, h);

  const squash = rng.range(0.86, 1.00);
  const dimple = rng.range(0.10, 0.17);
  const wobble = rng.range(0.008, 0.022);   // barely there, kills the CG-perfect look
  const seed = rng.range(0, 40);

  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    // a soft crease at both poles, deeper on top: the stem well
    const polar = Math.abs(n.y);
    const well = Math.pow(Math.max(0, polar), 3.0) * dimple * (n.y > 0 ? 1 : 0.6);
    const r = 1 - well + noise.noise3(n.x * 1.6 + seed, n.y * 1.6, n.z * 1.6) * wobble;
    v.copy(n).multiplyScalar(r);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * An apple, rather than a sphere with a dent in it.
 *
 * Four things do the work, and dropping any one of them takes it back to
 * "reddish ball": the widest point sits above the middle, the top and bottom
 * both go in (a deep stem well and a shallower calyx), the waist carries five
 * very soft lobes, and there is an actual stem. The stem matters more than its
 * size suggests — it is the part of the silhouette that names the object.
 */
function buildApple(rng, noise, detail) {
  const w = detail.high ? 52 : 40;
  const h = detail.high ? 40 : 30;
  const geo = new THREE.SphereGeometry(1, w, h);

  // An apple is very slightly taller than it is wide once the stem well is cut
  // into the top. Squashing below 1 — the obvious way to make fruit look like
  // fruit — produced a tomato instead, and the size normalisation then fitted
  // the widest axis and made it look flatter still.
  const squash = rng.range(1.06, 1.12);
  const stemWell = rng.range(0.26, 0.32);
  const calyx = rng.range(0.11, 0.15);
  const lobeDepth = rng.range(0.016, 0.028);
  const wobble = rng.range(0.006, 0.013);
  const seed = rng.range(0, 40);
  const lobes = 5;

  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.copy(v).normalize();

    // Shoulders: fattest a third of the way up, tapering to a narrower base.
    // pow on the signed height, so the top stays broad and the bottom draws in.
    const t = THREE.MathUtils.clamp(n.y, -1, 1);
    let r = 1 + 0.075 * Math.exp(-Math.pow((t - 0.28) * 1.9, 2)) - 0.085 * Math.pow(Math.max(0, -t), 1.7);

    // Both wells. The top one is deep and narrow, the bottom shallow and wide.
    r -= Math.pow(Math.max(0, t), 7.0) * stemWell;
    r -= Math.pow(Math.max(0, -t), 5.0) * calyx;

    // Five soft ribs around the waist. Faded out by the horizontal radius, or
    // the pole's coincident vertices displace differently and tear open — at a
    // sphere's poles x and z are signed zeros and atan2 splits them.
    const horiz = Math.hypot(n.x, n.z);
    if (horiz > 1e-6) {
      const theta = Math.atan2(n.z, n.x);
      r *= 1 - lobeDepth * horiz * Math.pow(Math.abs(Math.sin(theta * lobes * 0.5)), 1.4);
    }

    r += noise.noise3(n.x * 1.7 + seed, n.y * 1.7, n.z * 1.7) * wobble;

    v.copy(n).multiplyScalar(r);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // The stem: a short woody peg rising out of the well, leaning a little. It
  // gets its own material — a red stem is a wax nub, a brown one is a stem, and
  // that is most of what tells you this is an apple rather than a tomato. Its
  // foot is sunk well below the surface so the union is solid.
  const lean = rng.range(0.08, 0.18);
  const stemR = rng.range(0.042, 0.052);
  const top = squash * (1 - stemWell);
  const rise = rng.range(0.40, 0.48);
  const stem = sweptTube(curveOf((t) => new THREE.Vector3(
    Math.sin(t * 1.5) * lean * t,
    top - 0.12 + t * rise,
    lean * 0.35 * t * t,
  )), detail.high ? 16 : 12, 10, (t) => stemR * (1.25 - 0.45 * t + 0.35 * Math.pow(t, 6)));

  const geometry = mergeGeometries([geo, accent(stem)]);
  geometry.userData.accent = {
    family: FAMILY.WOOD,
    tintA: 0x6b4a2c, tintB: 0x46301b,
    opts: { roughness: 0.86, metalness: 0, clearcoat: 0, envMapIntensity: 0.5 },
  };
  // Waxy, not fuzzy. The organic family's sheen is peach skin and it turns a
  // deep red into pale pink across the whole lit side; an apple's shine is a
  // tight clearcoat highlight over saturated colour. The speckle is dialled
  // back for the same reason — at full strength it frosts the surface white.
  geometry.userData.skin = {
    sheen: 0, clearcoat: 0.85, clearcoatRoughness: 0.14,
    roughness: 0.44, envMapIntensity: 0.62, detail: 0.35,
  };
  return geometry;
}

/** Wrap a function of t in [0,1] as a THREE.Curve, for sweeping along. */
function curveOf(fn) {
  const c = new THREE.Curve();
  c.getPoint = (t, target = new THREE.Vector3()) => target.copy(fn(t));
  return c;
}

/** Gentle vertical lobes — pumpkins, tomatoes. Shallow, and always even. */
function buildLobed(rng, noise, detail) {
  const w = detail.high ? 56 : 40;
  const h = detail.high ? 36 : 26;
  const geo = new THREE.SphereGeometry(1, w, h);
  return displaceSphere(geo, noise, {
    amp: 0.012,
    freq: 1.6,
    octaves: 2,
    lobes: rng.int(4, 6) * 2,
    lobeDepth: rng.range(0.07, 0.12),
    squash: rng.range(0.74, 0.86),
    seed: rng.range(0, 40),
  });
}

/**
 * A surface of revolution built from a named silhouette rather than random
 * control points. Random radii produced bulging, asymmetric blobs that read as
 * nothing in particular; a small set of hand-shaped profiles produces objects
 * you can name on sight.
 */
const LATHE_PROFILES = {
  // r as a fraction of max radius, y from 0 (base) to 1 (top)
  pear:    [[0.00, 0.00], [0.50, 0.02], [0.88, 0.12], [1.00, 0.28], [0.95, 0.42], [0.74, 0.55], [0.60, 0.65], [0.56, 0.74], [0.52, 0.82], [0.38, 0.91], [0.20, 0.97], [0.09, 0.99], [0.00, 1.00]],
  egg:     [[0.00, 0.00], [0.55, 0.05], [0.92, 0.26], [1.00, 0.44], [0.86, 0.68], [0.55, 0.88], [0.00, 1.00]],
  candle:  [[0.00, 0.00], [1.00, 0.00], [1.00, 0.94], [0.86, 0.98], [0.30, 1.00], [0.00, 1.00]],
  bottle:  [[0.00, 0.00], [0.94, 0.02], [1.00, 0.10], [0.96, 0.44], [0.62, 0.60], [0.34, 0.70], [0.32, 0.94], [0.40, 0.99], [0.00, 1.00]],
  urn:     [[0.00, 0.00], [0.52, 0.02], [0.60, 0.08], [0.96, 0.34], [1.00, 0.52], [0.72, 0.82], [0.62, 0.92], [0.74, 1.00], [0.00, 1.00]],
  column:  [[0.00, 0.00], [0.86, 0.00], [0.86, 0.06], [0.70, 0.12], [0.66, 0.86], [0.84, 0.93], [0.84, 1.00], [0.00, 1.00]],
  // straight sided: the spline overshoots any waist here into an hourglass
  log:     [[0.00, 0.00], [1.00, 0.00], [1.00, 0.34], [1.00, 0.66], [1.00, 1.00], [0.00, 1.00]],
  lemon:   [[0.00, 0.00], [0.28, 0.02], [0.80, 0.16], [1.00, 0.44], [0.84, 0.76], [0.34, 0.96], [0.00, 1.00]],
  cake:    [[0.00, 0.00], [0.96, 0.00], [1.00, 0.16], [1.00, 0.84], [0.96, 1.00], [0.00, 1.00]],
  onion:   [[0.00, 0.00], [0.30, 0.01], [0.78, 0.12], [1.00, 0.34], [0.98, 0.52], [0.78, 0.70], [0.46, 0.84], [0.20, 0.93], [0.08, 0.98], [0.00, 1.00]],
};

/**
 * Resample a silhouette through a spline.
 *
 * A lathe interpolates linearly between profile points, so a hand-written
 * outline of a dozen points comes out visibly faceted down its side — an onion
 * ends up looking like a cut gem. Smoothing first costs nothing and is what
 * separates a turned shape from a polygon.
 *
 * Endpoints are pinned: they sit on the axis and closing the surface depends
 * on them staying at exactly r = 0.
 */
function smoothProfile(points, count) {
  const pts = points.map(([r, y]) => new THREE.Vector2(r, y));
  const out = [];
  const p = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];

  for (let s = 0; s < count; s++) {
    const t = (s / (count - 1)) * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(t));
    const f = t - i;
    const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
    const f2 = f * f, f3 = f2 * f;
    // Catmull-Rom
    const r = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * f +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * f2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * f3);
    const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * f +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * f2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * f3);
    out.push({ r: Math.max(0, r), y });
  }
  out[0] = { r: pts[0].x, y: pts[0].y };
  out[out.length - 1] = { r: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  return out;
}

/**
 * A bottle: a hollow one.
 *
 * Turning the bottle silhouette on a lathe as a *solid* gives an object with a
 * bottle's outline and nothing else — cut it and you get two lumps of glass,
 * which is exactly what it looked like. A bottle is a wall around a void, so
 * the profile runs up the outside, over the lip, down the bore, out across the
 * inside of the shoulder and back down to a thick base before closing on the
 * axis. Cutting through the shoulder then opens a real chamber.
 *
 * The silhouette is a wine bottle's: near-cylindrical body, a shoulder that
 * turns in sharply, a long parallel neck, and a lip standing proud of it.
 */
function buildBottle(rng, noise, detail) {
  const seg = detail.high ? 56 : 40;
  const h = 2.0;
  // A bottle is about two and a half times as tall as it is wide. Wider than
  // that and it reads as a jar, however good the shoulder is.
  const rBody = rng.range(0.38, 0.42);
  const rNeck = rBody * rng.range(0.35, 0.39);
  const rLip = rNeck * rng.range(1.18, 1.26);
  const wall = rBody * rng.range(0.13, 0.15);
  const bore = rNeck - wall * 0.62;

  const yHeel = h * 0.035;                 // the base rolls into the side here
  const yShoulder = h * rng.range(0.42, 0.46);
  const yNeck = h * rng.range(0.62, 0.66);
  const yLip = h * 0.955;

  // Outside, bottom to top. The shoulder is a two-segment curve rather than one
  // straight run: the single-line version reads as a funnel, not a bottle.
  const outside = [
    { r: 0.00, y: 0 },
    { r: rBody * 0.86, y: 0 },
    { r: rBody, y: yHeel },
    { r: rBody, y: yShoulder },
    { r: rBody * 0.90, y: yShoulder + (yNeck - yShoulder) * 0.34 },
    { r: rBody * 0.56, y: yShoulder + (yNeck - yShoulder) * 0.72 },
    { r: rNeck, y: yNeck },
    { r: rNeck, y: yLip - 0.075 },
    { r: rLip, y: yLip - 0.055 },
    { r: rLip, y: h - 0.012 },
    { r: rLip * 0.94, y: h },
  ];

  // Inside, top back down to the axis. The base is left thick — a real bottle's
  // punt — and the bore stays parallel until it opens out under the shoulder.
  const yFloor = wall * 1.5;
  const inside = [
    { r: bore, y: h - 0.012 },
    { r: bore, y: yNeck },
    { r: (rBody - wall) * 0.56, y: yShoulder + (yNeck - yShoulder) * 0.70 },
    { r: (rBody - wall) * 0.90, y: yShoulder + (yNeck - yShoulder) * 0.30 },
    { r: rBody - wall, y: yShoulder },
    { r: rBody - wall, y: yHeel + wall },
    { r: (rBody - wall) * 0.80, y: yFloor },
    { r: 0.00, y: yFloor },
  ];

  const geometry = latheGeometry([...outside, ...inside], seg, false, false);

  // Volumetric tint rather than a green surface. The colour of bottle glass
  // comes from how far the light travelled inside it, so the thick base and the
  // punt go almost black while the wall stays clear enough to see the bench
  // through — which is the difference between glass and a green glaze.
  // Light enough to read as glass rather than as a green glaze. A convincing
  // deep bottle-green wall dyes everything behind it to the same green, and the
  // bottle stops looking transparent at all.
  geometry.userData.skin = {
    attenuationColor: 0x86c495, attenuationDistance: 1.5, thickness: 0.16,
  };
  return geometry;
}

/**
 * A sawn log, lying down.
 *
 * Standing it up makes a stump; on its side it reads as a log and is far more
 * interesting to cut, because the two surfaces a log has — bark around it,
 * sawn end grain across it — end up facing different ways. The taper and the
 * out-of-round cross-section are both load-bearing: a perfect cylinder looks
 * like a dowel, and it rolls off the bench instead of settling.
 */
function buildLog(rng, noise, detail) {
  const rings = detail.high ? 40 : 28;
  const along = detail.high ? 22 : 14;
  const len = rng.range(2.5, 2.9);
  const r0 = rng.range(0.40, 0.46);
  const taper = rng.range(0.86, 0.94);       // thinner at one end
  const seed = rng.range(0, 30);

  // Profile down the trunk, with a chamfer at each sawn end so the rim of the
  // cut catches light rather than ending in a razor edge.
  const chamfer = r0 * 0.06;
  const prof = [];
  prof.push({ r: 0, y: 0 });
  prof.push({ r: r0 - chamfer, y: 0 });
  for (let i = 0; i <= along; i++) {
    const t = i / along;
    const y = chamfer + t * (len - chamfer * 2);
    const swell = 1 + Math.sin(t * Math.PI) * 0.035;
    prof.push({ r: r0 * (1 - (1 - taper) * t) * swell, y });
  }
  prof.push({ r: r0 * taper - chamfer, y: len });
  prof.push({ r: 0, y: len });

  const geo = latheGeometry(prof, rings, false, false);

  // Out of round: bark is lumpy, and a log that is exactly circular rolls
  // forever. Fading with the horizontal radius keeps the end discs flat.
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const horiz = Math.hypot(v.x, v.z);
    if (horiz < 1e-5) continue;
    const th = Math.atan2(v.z, v.x);
    const lump = noise.fbm(Math.cos(th) * 1.6 + seed, v.y * 0.9, Math.sin(th) * 1.6, 3);
    const k = 1 + lump * 0.055 + Math.sin(th * 3 + v.y * 0.7) * 0.018;
    v.x *= k; v.z *= k;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;

  // Lay it down, and give it a little yaw so it is not square to the bench.
  geo.translate(0, -len / 2, 0);
  geo.rotateZ(Math.PI / 2);
  const yaw = rng.range(-0.35, 0.35);
  geo.rotateY(yaw);
  geo.computeVertexNormals();

  // Hand the trunk direction to the shader: standing up it was +Y, and the two
  // rotations above put it here. Bark wraps around this axis and the sawn ends
  // are the faces looking along it.
  geo.userData.skin = { bark: true, axis: [-Math.cos(yaw), 0, Math.sin(yaw)] };
  return geo;
}

/**
 * A blob of slime, settled.
 *
 * The shape is doing one job: convincing you it is soft. Everything that says
 * so is at the bottom — it spreads where it meets the bench, its lower edge
 * bulges out past its widest point, and the base is flat rather than resting on
 * a curve. The top is smooth, because slime has no texture of its own; all the
 * interest is in the material seeing through it.
 */
function buildSlime(rng, noise, detail) {
  const w = detail.high ? 48 : 36;
  const h = detail.high ? 34 : 26;
  const geo = new THREE.SphereGeometry(1, w, h);

  const squash = rng.range(0.66, 0.76);
  const spread = rng.range(0.13, 0.20);
  const lumps = rng.range(0.10, 0.16);
  const seed = rng.range(0, 40);

  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.copy(v).normalize();

    // slow, asymmetric bulges — nothing high-frequency, it is a liquid
    const r = 1 + noise.fbm(n.x * 1.15 + seed, n.y * 1.15, n.z * 1.15, 2) * lumps;
    v.copy(n).multiplyScalar(r);
    v.y *= squash;

    // Spread at the foot: widen as it approaches the base, so the silhouette
    // flares outward at the bottom instead of tucking under like a ball.
    const t = Math.max(0, -n.y);
    const flare = 1 + spread * t * t;
    v.x *= flare; v.z *= flare;
    pos.setXYZ(i, v.x, v.y, v.z);
  }

  // Flatten what is below the bench line by squeezing rather than clamping —
  // clamping collapses a whole ring of vertices onto one plane and leaves a
  // fan of degenerate triangles where the base should be.
  let minY = Infinity;
  for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i));
  const base = minY * 0.62;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < base) pos.setY(i, base + (y - base) * 0.10);
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function buildLathe(rng, noise, detail, profileName) {
  if (profileName === 'log') return buildLog(rng, noise, detail);
  const segments = detail.high ? 56 : 44;
  const key = profileName && LATHE_PROFILES[profileName]
    ? profileName
    : rng.pick(['pear', 'egg', 'urn', 'column', 'bottle']);

  const height = rng.range(1.9, 2.1);
  const width = rng.range(0.94, 1.06);

  const profile = smoothProfile(LATHE_PROFILES[key], detail.high ? 40 : 30)
    .map(({ r, y }) => ({ r: r * width, y: y * height }));

  return latheGeometry(profile, segments, false, false);
}

/** Books, boxes, bricks: a plain slab with softened corners. */
function buildSlab(rng, noise, detail, profileName) {
  const dims = {
    book:  [1.0, 0.22, 1.36],
    box:   [1.0, 0.80, 1.0],
    // A standard brick is 215 x 102.5 x 65 mm. Getting that ratio right is the
    // whole job — at the old 1 : 0.44 : 0.48 it read as a block of stone.
    brick: [1.0, 0.302, 0.477],
  }[profileName] ?? [1.0, rng.range(0.5, 0.9), rng.range(0.8, 1.1)];

  const g = new THREE.BoxGeometry(dims[0], dims[1], dims[2], 4, 4, 4);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const half = new THREE.Vector3(dims[0] / 2, dims[1] / 2, dims[2] / 2);
  const r = Math.min(half.x, half.y, half.z) * rng.range(0.18, 0.30);

  // Round the corners properly: clamp each vertex to the inner box, then push
  // back out by a fixed radius. Lerping toward a sphere, the cheap version,
  // bows every flat face outward and the result stops looking manufactured.
  const inner = new THREE.Vector3(half.x - r, half.y - r, half.z - r);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const cx = THREE.MathUtils.clamp(v.x, -inner.x, inner.x);
    const cy = THREE.MathUtils.clamp(v.y, -inner.y, inner.y);
    const cz = THREE.MathUtils.clamp(v.z, -inner.z, inner.z);
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
    const d = Math.hypot(dx, dy, dz);
    if (d > 1e-6) {
      const k = r / d;
      pos.setXYZ(i, cx + dx * k, cy + dy * k, cz + dz * k);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Rings, beads, doughnuts. */
function buildRing(rng, noise, detail) {
  const tube = rng.range(0.26, 0.38);
  return new THREE.TorusGeometry(1, tube, detail.high ? 24 : 16, detail.high ? 72 : 48);
}

/**
 * A stone. The one thing here allowed to be irregular — but rounded and
 * water-worn rather than spiky, because a jagged polyhedron reads as a
 * low-poly crystal, not a rock off a beach.
 */
function buildRock(rng, noise, detail) {
  const geo = new THREE.IcosahedronGeometry(1, detail.high ? 4 : 3);
  const pos = geo.attributes.position;
  const nor = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const seed = rng.range(0, 30);
  const squash = rng.range(0.62, 0.84);

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    // radial direction doubles as the normal — see below
    nor[i * 3] = v.x; nor[i * 3 + 1] = v.y / squash; nor[i * 3 + 2] = v.z;
    const big = noise.fbm(v.x * 1.1 + seed, v.y * 1.1, v.z * 1.1, 2) * 0.16;
    const small = noise.fbm(v.x * 3.4 + seed, v.y * 3.4, v.z * 3.4, 2) * 0.045;
    v.multiplyScalar(1 + big + small);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;

  // IcosahedronGeometry is non-indexed, so computeVertexNormals() has no shared
  // vertices to average across and produces flat per-face normals — which made
  // a weathered stone look like a cut gem. The displacement is a gentle radial
  // one, so the sphere direction is a good smooth normal.
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.normalizeNormals();
  return geo;
}

/**
 * A tapering tube swept along a curve, closed at both ends.
 *
 * Built by hand rather than with TubeGeometry for two reasons: the radius has
 * to taper (shells and horns are unconvincing at constant thickness), and the
 * end caps must reuse the *exact* ring vertices. A cap generated separately —
 * say from a CircleGeometry — lands on the same circle but at a different
 * rotation, leaving a ring of slivers the slicer would inherit as an open mesh.
 */
function sweptTube(curve, steps, radial, radiusAt) {
  const frames = curve.computeFrenetFrames(steps, false);
  const rings = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const centre = curve.getPoint(t);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const r = radiusAt(t);
    const ring = [];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cos = Math.cos(a) * r, sin = Math.sin(a) * r;
      ring.push(new THREE.Vector3(
        centre.x + N.x * cos + B.x * sin,
        centre.y + N.y * cos + B.y * sin,
        centre.z + N.z * cos + B.z * sin));
    }
    rings.push(ring);
  }

  const pos = [];
  const uv = [];
  const tri = (a, b, c, ua, ub, uc) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };

  // wall
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      const a = rings[i][j], b = rings[i][j2];
      const c = rings[i + 1][j2], d = rings[i + 1][j];
      const u0 = i / steps, u1 = (i + 1) / steps;
      const v0 = j / radial, v1 = (j + 1) / radial;
      tri(a, b, c, [u0, v0], [u0, v1], [u1, v1]);
      tri(a, c, d, [u0, v0], [u1, v1], [u1, v0]);
    }
  }

  // caps, fanned from each end ring's centre using those same vertices
  for (const [ringIdx, flip] of [[0, true], [steps, false]]) {
    const ring = rings[ringIdx];
    const c = new THREE.Vector3();
    for (const p of ring) c.add(p);
    c.divideScalar(ring.length);
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      if (flip) tri(c, ring[j2], ring[j], [0.5, 0.5], [0, 0], [1, 0]);
      else      tri(c, ring[j], ring[j2], [0.5, 0.5], [0, 0], [1, 0]);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.computeVertexNormals();
  return geo;
}

/* ══════════════════════════════════════════════════════════════════
   CONSTRUCTED OBJECTS
   Assembled from closed solids. Parts may intersect — that is fine and
   intended, it is how real joinery reads — but each part is watertight
   on its own, which is what the slicer needs.
   ══════════════════════════════════════════════════════════════════ */

/** An axis-aligned bar, optionally tapered, centred at (x,y,z). */
function bar(w, h, d, x, y, z, opts = {}) {
  const g = new THREE.BoxGeometry(w, h, d, 1, opts.segY ?? 1, 1);
  if (opts.taper && opts.taper !== 1) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const vy = pos.getY(i);
      const t = (vy / h) + 0.5;                    // 0 bottom, 1 top
      const s = 1 + (opts.taper - 1) * (1 - t);
      pos.setX(i, pos.getX(i) * s);
      pos.setZ(i, pos.getZ(i) * s);
    }
    pos.needsUpdate = true;
  }
  g.translate(x, y, z);
  return g;
}

/**
 * A bar standing on (bx,by,bz) and leaning about the X axis by `a`.
 *
 * The rotation is applied while the bar is still centred on the origin, then
 * the bar is moved so its *base* lands where it was asked to. Rotating after
 * translating — the obvious way to write this — turns about the world origin
 * instead, which swings a chair back clean off the seat it is supposed to be
 * joined to.
 */
function leaningBar(w, h, d, bx, by, bz, a) {
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  g.rotateX(a);
  g.translate(bx, by + Math.cos(a) * h / 2, bz + Math.sin(a) * h / 2);
  return g;
}

/** A point `s` up from the base of a bar leaning by `a`. */
function alongLean(bx, by, bz, a, s) {
  return [bx, by + Math.cos(a) * s, bz + Math.sin(a) * s];
}

function post(r0, r1, h, x, y, z, seg = 12) {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg, 1, false);
  g.translate(x, y, z);
  return g;
}

function buildChair(rng, noise, detail) {
  const seatW = rng.range(0.92, 1.08);
  const seatD = rng.range(0.88, 1.04);
  const seatT = rng.range(0.07, 0.11);
  const legH = rng.range(0.82, 1.0);
  const legT = rng.range(0.075, 0.105);
  const backH = rng.range(0.85, 1.15);
  const round = rng.bool(0.45);

  const parts = [];
  const seatY = legH + seatT / 2;

  // seat
  parts.push(bar(seatW, seatT, seatD, 0, seatY, 0));

  // four legs, slightly splayed and tapered
  const lx = seatW / 2 - legT * 0.85;
  const lz = seatD / 2 - legT * 0.85;
  const taper = rng.range(0.62, 0.95);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(round
        ? post(legT * 0.5 * taper, legT * 0.5, legH, sx * lx, legH / 2, sz * lz, 10)
        : bar(legT, legH, legT, sx * lx, legH / 2, sz * lz, { taper }));
    }
  }

  // stretchers between the legs
  if (rng.bool(0.7)) {
    const sy = legH * rng.range(0.26, 0.4);
    const t = legT * 0.62;
    for (const sz of [-1, 1]) parts.push(bar(seatW - legT * 1.2, t, t, 0, sy, sz * lz));
    for (const sx of [-1, 1]) parts.push(bar(t, t, seatD - legT * 1.2, sx * lx, sy, 0));
  }

  // Back: two uprights rising from the seat, leaning back a little. Negative
  // rotation about X tips the top toward -Z, which is behind the sitter.
  const backZ = -seatD / 2 + legT * 0.7;
  const lean = -rng.range(0.02, 0.14);
  const baseY = seatY - seatT * 0.5;              // start inside the seat slab

  for (const sx of [-1, 1]) {
    parts.push(leaningBar(legT, backH, legT * 0.92, sx * lx, baseY, backZ, lean));
  }

  if (rng.bool(0.55)) {
    // horizontal slats, spaced up the leaning uprights
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const s = backH * (0.30 + (i + 1) / (n + 1) * 0.52);
      const [px, py, pz] = alongLean(0, baseY, backZ, lean, s);
      parts.push(leaningBar(seatW - legT * 1.1, backH * rng.range(0.09, 0.15), legT * 0.55,
        px, py - backH * 0.06, pz, lean));
    }
  } else {
    // solid panel
    const s = backH * 0.36;
    const [px, py, pz] = alongLean(0, baseY, backZ, lean, s);
    parts.push(leaningBar(seatW - legT * 1.1, backH * 0.60, legT * 0.5, px, py, pz, lean));
  }

  // top rail, capping the uprights
  const railH = backH * rng.range(0.10, 0.16);
  const [rx, ry, rz] = alongLean(0, baseY, backZ, lean, backH - railH);
  parts.push(leaningBar(seatW - legT * 0.2, railH, legT * 0.9, rx, ry, rz, lean));

  return mergeGeometries(parts);
}

function buildTable(rng, noise, detail) {
  const w = rng.range(1.5, 1.9);
  const d = rng.range(0.95, 1.25);
  const t = rng.range(0.08, 0.13);
  const h = rng.range(0.8, 0.95);
  const legT = rng.range(0.10, 0.15);
  const round = rng.bool(0.4);

  const parts = [bar(w, t, d, 0, h + t / 2, 0)];
  const lx = w / 2 - legT * 1.1;
  const lz = d / 2 - legT * 1.1;
  const taper = rng.range(0.6, 0.95);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(round
        ? post(legT * 0.5 * taper, legT * 0.55, h, sx * lx, h / 2, sz * lz, 12)
        : bar(legT, h, legT, sx * lx, h / 2, sz * lz, { taper }));
    }
  }
  // apron
  if (rng.bool(0.75)) {
    const ay = h - rng.range(0.09, 0.15);
    for (const sz of [-1, 1]) parts.push(bar(w - legT * 2.4, 0.09, 0.05, 0, ay, sz * (lz - 0.01)));
    for (const sx of [-1, 1]) parts.push(bar(0.05, 0.09, d - legT * 2.4, sx * (lx - 0.01), ay, 0));
  }
  return mergeGeometries(parts);
}

function buildStool(rng, noise, detail) {
  const r = rng.range(0.42, 0.55);
  const t = rng.range(0.08, 0.12);
  const h = rng.range(0.62, 0.86);
  const legs = rng.int(3, 4);
  const legR = rng.range(0.045, 0.065);

  const parts = [post(r, r * rng.range(0.95, 1.05), t, 0, h + t / 2, 0, 26)];
  const rr = r * 0.7;
  const angles = [];
  for (let i = 0; i < legs; i++) {
    const a = (i / legs) * Math.PI * 2 + rng.range(0, 0.6);
    angles.push(a);
    parts.push(post(legR * 0.75, legR, h, Math.cos(a) * rr, h / 2, Math.sin(a) * rr, 10));
  }

  // Footrest as short rails between adjacent legs. A solid disc here would
  // pass straight through the middle of every leg, and heavily overlapping
  // unions are exactly the case where a cut section stops being a set of
  // cleanly nested loops.
  if (rng.bool(0.6)) {
    const ry = h * 0.35;
    const railR = legR * 0.55;
    for (let i = 0; i < legs; i++) {
      const a0 = angles[i], a1 = angles[(i + 1) % legs];
      const p0 = new THREE.Vector3(Math.cos(a0) * rr, ry, Math.sin(a0) * rr);
      const p1 = new THREE.Vector3(Math.cos(a1) * rr, ry, Math.sin(a1) * rr);

      // Stop each rail just short of the leg centre. Two rails meeting exactly
      // at a leg would build their end caps around the same point, and for
      // straight horizontal segments the Frenet normal is identical, so the
      // two rings would share vertices outright — leaving degree-4 nodes that
      // make the cut-ring walk ambiguous. Ending inside the leg still reads as
      // a joint and keeps every part's surface its own.
      const dir = _dirScratch.subVectors(p1, p0).normalize();
      p0.addScaledVector(dir, legR * 0.9);
      p1.addScaledVector(dir, -legR * 0.9);

      const curve = new THREE.Curve();
      curve.getPoint = (t2, target = new THREE.Vector3()) => target.lerpVectors(p0, p1, t2);
      parts.push(sweptTube(curve, 4, 8, () => railR));
    }
  }
  return mergeGeometries(parts);
}

function buildShelf(rng, noise, detail) {
  const w = rng.range(1.0, 1.4);
  const h = rng.range(1.3, 1.8);
  const d = rng.range(0.34, 0.46);
  const t = rng.range(0.06, 0.09);
  const shelves = rng.int(3, 5);

  const parts = [];
  for (const sx of [-1, 1]) parts.push(bar(t, h, d, sx * (w / 2 - t / 2), h / 2, 0));
  for (let i = 0; i < shelves; i++) {
    const y = t / 2 + (h - t) * (i / (shelves - 1));
    parts.push(bar(w - t * 1.6, t, d, 0, y, 0));
  }
  if (rng.bool(0.5)) parts.push(bar(w, t * 0.7, t * 0.7, 0, h - t, -d / 2 + t * 0.4));
  return mergeGeometries(parts);
}

/**
 * A table lamp: turned brass base, slim stem, and a linen shade.
 *
 * The shade is the whole reason this reads as a lamp rather than as an
 * ornament, and it needs two things. It has to be *wide* — a shade narrower
 * than about twice the base looks like a cup balanced on a stick — and it has
 * to be a different material from the metal under it. An earlier version got
 * the second point wrong by letting "brass lamp" paint the shade too, and the
 * result was a piece of brass shaped vaguely like a lamp.
 */
function buildLamp(rng, noise, detail) {
  const seg = detail.high ? 44 : 32;
  const fine = detail.high ? 28 : 20;

  const baseR = rng.range(0.34, 0.40);
  const stemH = rng.range(0.86, 1.00);
  const shadeBot = baseR * rng.range(1.75, 1.95);
  const shadeTop = shadeBot * rng.range(0.62, 0.70);
  const shadeH = shadeBot * rng.range(0.80, 0.92);
  const stemR = rng.range(0.036, 0.048);

  // The base is turned, not a puck: a broad foot, a cove above it and a short
  // neck the stem rises out of. The step is what catches the light and says
  // "metal object" instead of "cylinder".
  const footH = rng.range(0.055, 0.075);
  const base = latheGeometry([
    { r: 0.00, y: 0 },
    { r: baseR, y: 0 },
    { r: baseR, y: footH },
    { r: baseR * 0.86, y: footH * 1.5 },
    { r: baseR * 0.60, y: footH * 2.4 },
    { r: baseR * 0.34, y: footH * 3.4 },
    { r: baseR * 0.26, y: footH * 4.4 },
    { r: 0.00, y: footH * 4.4 },
  ], seg, false, false);

  const stemBase = footH * 4.0;
  const parts = [
    base,
    post(stemR, stemR * 1.18, stemH, 0, stemBase + stemH / 2, 0, fine),
    // socket: the little collar the shade sits on
    post(stemR * 2.0, stemR * 2.0, 0.075, 0, stemBase + stemH + 0.035, 0, fine),
  ];

  // A real shade is a thin open cone, not a solid one. The profile runs up the
  // outside, across the top rim and back down the inside, then closes on
  // itself at the bottom rim — a loop that never touches the axis, which
  // lathes into a closed surface with an actual wall to cut through.
  const y0 = stemBase + stemH - 0.02;
  const wall = rng.range(0.016, 0.024);
  parts.push(accent(latheGeometry([
    { r: shadeBot, y: y0 },
    { r: shadeTop, y: y0 + shadeH },
    { r: shadeTop - wall, y: y0 + shadeH },
    { r: shadeBot - wall, y: y0 },
    { r: shadeBot, y: y0 },          // close the loop
  ], seg, false, false)));

  // finial, poking out of the top of the shade
  parts.push(post(stemR * 0.8, stemR * 0.5, 0.09, 0, y0 + shadeH + 0.035, 0, fine));

  const geometry = mergeGeometries(parts);
  geometry.userData.accent = {
    family: FAMILY.CERAMIC,
    // Warm off-white linen, lit from inside. The emissive is small — enough to
    // read as a shade with a bulb behind it, not enough to look like a lantern.
    tintA: 0xf6ecd8, tintB: 0xe0cfae,
    opts: {
      roughness: 0.86, metalness: 0, sheen: 0.7, sheenColor: 0xfff0d8,
      clearcoat: 0, envMapIntensity: 0.8,
      emissive: 0xffdba6, emissiveIntensity: 0.34,
    },
  };
  return geometry;
}

/**
 * A hollow vessel: mugs, bowls, pots.
 *
 * The profile runs up the outside, across the rim, back down the inside and
 * closes on the axis — a single closed surface of revolution with a genuine
 * cavity, so cutting one in half reveals a wall of real thickness.
 */
/**
 * Vessel silhouettes. A single "generic hollow form" made a bowl, a vase and a
 * mug come out as the same beaker at three sizes — and put a handle on the
 * bowl. Shape and handle are per-word.
 *
 *   [heightScale, rimRadius, footRatio, belly, handle]
 */
const VESSEL_SHAPES = {
  //        [heightScale, rimRadius, footRatio, belly, handle]
  mug:     [1.00, 0.44, 0.90, 1.00, true,  0],
  cup:     [0.88, 0.42, 0.72, 1.06, true,  0],
  teapot:  [0.86, 0.50, 0.66, 1.30, true,  0],
  bowl:    [0.52, 0.62, 0.42, 1.02, false],
  vase:    [1.55, 0.30, 0.52, 1.55, false],
  pot:     [0.80, 0.50, 0.70, 1.14, false],
  planter: [0.78, 0.54, 0.62, 1.00, false],
  jar:     [1.00, 0.38, 0.86, 1.12, false],
  glass:   [1.30, 0.34, 0.80, 1.00, false],
};

function buildVessel(rng, noise, detail, profileName) {
  const shape = VESSEL_SHAPES[profileName] ?? VESSEL_SHAPES.mug;
  const [hScale, rimR, footRatio, bellyAmt, wantsHandle] = shape;

  const h = hScale * rng.range(0.92, 1.08);
  const rOut = rimR * rng.range(0.95, 1.05);
  const wall = rng.range(0.045, 0.062);
  const belly = bellyAmt * rng.range(0.97, 1.03);
  const footR = rOut * footRatio;
  const steps = 10;

  const outer = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const flare = 1 + (belly - 1) * Math.sin(t * Math.PI);
    outer.push({ r: THREE.MathUtils.lerp(footR, rOut, Math.pow(t, 0.55)) * flare, y: t * h });
  }
  const inner = [];
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const flare = 1 + (belly - 1) * Math.sin(t * Math.PI);
    const r = THREE.MathUtils.lerp(footR, rOut, Math.pow(t, 0.55)) * flare - wall;
    inner.push({ r: Math.max(r, 0.02), y: Math.max(t * h - wall, wall * 0.9) });
  }

  const profile = [{ r: 0, y: 0 }, ...outer, ...inner, { r: 0, y: wall * 0.9 }];
  const body = latheGeometry(profile, detail.high ? 44 : 30, false, false);

  // handle: a swept tube, so it is capped and closed
  if (wantsHandle) {
    // NOTE: the thickness is sampled ONCE. Passing `() => rng.range(...)` here
    // re-rolls it for every ring of the sweep, which builds a lumpy noise-tube
    // instead of a handle — and eats a different amount of the seeded stream
    // each time, so the object stops being reproducible.
    const thick = rng.range(0.048, 0.066);
    const reach = rng.range(0.26, 0.34);
    const cy = h * 0.52;
    const hy = h * rng.range(0.22, 0.30);

    // Both ends land just inside the outer wall rather than somewhere in the
    // middle of the mug. Burying them deep is what turns the union into
    // heavily overlapping solids, and a cut through that region stops
    // producing cleanly nested loops.
    const xEnd = rOut * 0.95;
    const curve = new THREE.Curve();
    curve.getPoint = (t, target = new THREE.Vector3()) =>
      target.set(xEnd + Math.sin(Math.PI * t) * reach, cy + (t * 2 - 1) * hy, 0);

    return mergeGeometries([body, sweptTube(curve, 28, 12, () => thick)]);
  }
  return body;
}

const BUILDERS = {
  [ARCHETYPE.CHAIR]: buildChair,
  [ARCHETYPE.TABLE]: buildTable,
  [ARCHETYPE.STOOL]: buildStool,
  [ARCHETYPE.SHELF]: buildShelf,
  [ARCHETYPE.LAMP]: buildLamp,
  [ARCHETYPE.VESSEL]: buildVessel,
  [ARCHETYPE.BOTTLE]: buildBottle,
  [ARCHETYPE.SLIME]: buildSlime,
  [ARCHETYPE.SPHEROID]: buildSpheroid,
  [ARCHETYPE.LOBED]: buildLobed,
  [ARCHETYPE.LATHE]: buildLathe,
  [ARCHETYPE.SLAB]: buildSlab,
  [ARCHETYPE.RING]: buildRing,
  [ARCHETYPE.ROCK]: buildRock,
};

/* ══════════════════════════════════════════════════════════════════
   Material assembly
   ══════════════════════════════════════════════════════════════════ */

function familyMaterialOpts(family, rng) {
  switch (family) {
    case FAMILY.METAL:
      return { skin: { metalness: 1, roughness: rng.range(0.14, 0.42), envMapIntensity: 1.6 },
               interior: { metalness: 1, roughness: 0.18, envMapIntensity: 1.5, rimPower: 3.2 } };
    case FAMILY.GEM:
      return { skin: { metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02,
                       iridescence: 0.65, envMapIntensity: 2.4, flatShading: true },
               interior: { metalness: 0, roughness: 0.06, envMapIntensity: 1.8, rimPower: 1.7 } };
    case FAMILY.ICE:
      // Actual transmission, not a shiny white stand-in. Glass that reads as
      // porcelain is the wrong object. three renders transmissive materials in
      // one extra pass regardless of how many there are, so a bottle cut into
      // twenty pieces costs the same as one.
      return { skin: { metalness: 0, roughness: 0.06, transmission: 0.94, thickness: 0.28,
                       ior: 1.48, clearcoat: 1, clearcoatRoughness: 0.04,
                       envMapIntensity: 1.7, transparent: true },
               interior: { metalness: 0, roughness: 0.1, ior: 1.48, envMapIntensity: 1.4, rimPower: 1.9 } };
    case FAMILY.GLASS:
      // Thinner and clearer than ice, and much smoother. A bottle's wall is a
      // few millimetres of glass, so the transmission runs high and the
      // thickness low — pushing thickness up tints it until it looks solid.
      return { skin: { metalness: 0, roughness: 0.04, transmission: 0.97, thickness: 0.12,
                       ior: 1.52, clearcoat: 1, clearcoatRoughness: 0.02,
                       envMapIntensity: 2.0, transparent: true },
               interior: { metalness: 0, roughness: 0.08, ior: 1.52, envMapIntensity: 1.6, rimPower: 1.6 } };
    case FAMILY.SLIME:
      // Thick, wet and soft. Transmission with a short attenuation distance is
      // what separates slime from a green rubber ball: light gets a little way
      // in and comes back stained, so thin edges glow and the middle goes deep.
      return { skin: { metalness: 0, roughness: 0.06, transmission: 0.62, thickness: 0.55,
                       ior: 1.36, clearcoat: 1, clearcoatRoughness: 0.04,
                       attenuationColor: 0x4f9a2c, attenuationDistance: 0.55,
                       envMapIntensity: 1.5, transparent: true, sheen: 0.3,
                       sheenColor: 0xd6f2a8 },
               interior: { metalness: 0, roughness: 0.12, ior: 1.36, envMapIntensity: 1.1, rimPower: 1.8 } };
    case FAMILY.CLAY:
      return { skin: { metalness: 0, roughness: 0.92, envMapIntensity: 0.45 },
               interior: { metalness: 0, roughness: 0.95, envMapIntensity: 0.35, rimPower: 3.6 } };
    case FAMILY.STONE:
      return { skin: { metalness: 0, roughness: 0.88, envMapIntensity: 0.7 },
               interior: { metalness: 0, roughness: 0.92, envMapIntensity: 0.5, rimPower: 3.4 } };
    case FAMILY.WOOD:
      return { skin: { metalness: 0, roughness: 0.74, envMapIntensity: 0.7 },
               interior: { metalness: 0, roughness: 0.6, envMapIntensity: 0.6, rimPower: 3.2 } };
    case FAMILY.CERAMIC:
      return { skin: { metalness: 0, roughness: 0.22, clearcoat: 0.7, envMapIntensity: 1.2 },
               interior: { metalness: 0, roughness: 0.85, envMapIntensity: 0.6, rimPower: 3.0 } };
    case FAMILY.CITRUS:
      return { skin: { metalness: 0, roughness: 0.62, sheen: 0.4, envMapIntensity: 0.9 },
               interior: { metalness: 0, roughness: 0.5, sheen: 0.6, envMapIntensity: 0.7, rimPower: 2.4 } };
    default: // ORGANIC
      return { skin: { metalness: 0, roughness: rng.range(0.36, 0.62), sheen: 0.5,
                       clearcoat: 0.25, envMapIntensity: 1.0 },
               interior: { metalness: 0, roughness: 0.55, sheen: 0.7, envMapIntensity: 0.7, rimPower: 2.5 } };
  }
}

/* ══════════════════════════════════════════════════════════════════
   Public API
   ══════════════════════════════════════════════════════════════════ */

/**
 * Forge an object from a phrase.
 *
 * @param {string} phrase
 * @param {object} [opts]
 * @param {boolean} [opts.highDetail]  raise tessellation (quality setting)
 * @param {number}  [opts.variant]     salt, so repeat spawns of the same word
 *                                     differ; omit for a stable "canonical" object
 * @returns {{geometry, materials, meta}}
 */
export function forge(phrase, opts = {}) {
  const salt = opts.variant ? `#${opts.variant}` : '';
  const rng = new Rng(phrase + salt);
  const spec = interpret(phrase, rng);
  const noise = new SimplexNoise(() => rng.next());
  const detail = { high: !!opts.highDetail };

  const builder = BUILDERS[spec.archetype] || buildSpheroid;
  let geometry = builder(rng, noise, detail, spec.profile);

  // Read before the rebuilds below: toNonIndexed and the degenerate strip both
  // return fresh geometry and userData does not come along.
  const accentSpec = geometry.userData.accent ?? null;
  const skinOverrides = geometry.userData.skin ?? null;

  if (geometry.index) geometry = geometry.toNonIndexed();
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  if (!geometry.attributes.uv) {
    geometry.setAttribute('uv',
      new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2));
  }

  // normalise scale so every archetype occupies a comparable screen area,
  // "tall" / "short" stretch the silhouette before normalising
  if (spec.stretch && spec.stretch !== 1) geometry.scale(1, spec.stretch, 1);

  // Normalise on the longest side of the bounding box rather than the bounding
  // sphere: a chair and a mug should read as sensible relative sizes on the
  // same table, and a sphere-fit makes tall thin things far too small.
  geometry.computeBoundingBox();
  const span = new THREE.Vector3();
  geometry.boundingBox.getSize(span);
  const longest = Math.max(span.x, span.y, span.z, 1e-4);
  const target = 1.15 * spec.size * (opts.scale ?? 1);
  const k = target / longest;
  geometry.scale(k, k, k);

  // clean up axis needles now that the mesh is at its final scale
  geometry = stripDegenerateTriangles(geometry, target * 1e-6);

  // Shade it properly: smooth around a turned surface, sharp at every rim and
  // corner. Done here rather than per-builder so nothing can forget.
  smoothNormals(geometry);

  // Re-centre on the centre of mass: rotation has to happen about the real
  // pivot or the physics reads as wrong the moment anything tips over.
  const { volume, centroid } = volumeAndCentroid(geometry);
  geometry.translate(-centroid.x, -centroid.y, -centroid.z);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  // Group 0 is skin, group 1 is the cut face and the slicer creates it. A
  // builder that asked for a second surface (a lamp's shade against its brass)
  // tagged those vertices, and they are listed last so the runs come out in
  // material order.
  geometry.clearGroups();
  const slots = geometry.attributes.slot?.array;
  const vertexCount = geometry.attributes.position.count;
  let usesAccent = false;
  if (slots) {
    let runStart = 0;
    for (let v = 3; v <= vertexCount; v += 3) {
      const here = v < vertexCount ? slots[v] : -1;
      if (here !== slots[runStart]) {
        const idx = slots[runStart] === MAT_ACCENT ? MAT_ACCENT : MAT_SKIN;
        if (idx === MAT_ACCENT) usesAccent = true;
        geometry.addGroup(runStart, v - runStart, idx);
        runStart = v;
      }
    }
    geometry.deleteAttribute('slot');
  }
  if (geometry.groups.length === 0) geometry.addGroup(0, vertexCount, MAT_SKIN);

  const [sa, sb, ca, cb, rim] = spec.palette;
  const mo = familyMaterialOpts(spec.family, rng);
  const seed = rng.range(0, 100);
  const radius = geometry.boundingSphere.radius;

  const skin = new SkinMaterial(spec.family, {
    ...mo.skin,
    tintA: sa, tintB: sb, tintC: ca,
    seed, scale: rng.range(1.2, 2.4),
    detail: rng.range(0.6, 1.2),
    // A builder gets the last word on its own surface. The family defaults are
    // a reasonable middle for a whole class of objects, and an apple is not the
    // middle of "organic": the family's sheen is peach fuzz, and on an apple it
    // washes a deep red out to pale pink no matter what the palette says.
    ...(skinOverrides ?? {}),
  });

  const interior = new InteriorMaterial(spec.family, {
    ...mo.interior,
    coreA: ca, coreB: cb, rim,
    seed, scale: rng.range(1.6, 2.8),
    radius,
  });

  // Slime is the one surface here that moves. Nothing else needs a clock, and
  // a material that is not registered never costs a uniform write per frame.
  if (spec.family === FAMILY.SLIME) registerAnimated(skin);

  const materials = [skin, interior];
  if (usesAccent && accentSpec) {
    materials[MAT_ACCENT] = new SkinMaterial(accentSpec.family, {
      ...accentSpec.opts,
      tintA: accentSpec.tintA, tintB: accentSpec.tintB,
      seed: seed + 17, scale: 2.2, detail: 0.8,
    });
  }

  const triangles = geometry.attributes.position.count / 3;
  const bbox = geometry.boundingBox;

  return {
    geometry,
    materials,
    meta: {
      label: spec.label,
      archetype: spec.archetype,
      family: spec.family,
      known: spec.known,
      triangles,
      volume,
      radius,
      palette: spec.palette,
      /** Distance from the centre of mass down to the lowest point — how far
       *  above the table the origin has to sit for the object to rest on it. */
      baseDrop: -bbox.min.y,
      size: { x: bbox.max.x - bbox.min.x, y: bbox.max.y - bbox.min.y, z: bbox.max.z - bbox.min.z },
    },
  };
}

/** Cheap probe used by the Forge panel to preview stats without spawning. */
export function describe(phrase) {
  const rng = new Rng(phrase);
  return interpret(phrase, rng);
}

export { MAX_TRIS_BUDGET };
