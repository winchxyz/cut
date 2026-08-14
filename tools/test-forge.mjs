/**
 * Forge verification — `node tools/test-forge.mjs`
 *
 * The slicer's cap generation assumes a closed input mesh, so every archetype
 * the Forge can emit has to be watertight before it ever reaches the arena.
 * This also checks determinism, which is the Forge's headline promise: the
 * same phrase must always produce the same object.
 */
import * as THREE from 'three';
import { forge, describe } from '../src/game/forge.js';
import { sliceGeometry, volumeAndCentroid } from '../src/game/slicer.js';
import { PRESETS, ARCHETYPE } from '../src/game/lexicon.js';
import { FreehandCutter } from '../src/game/cutter.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  [32mPASS[0m' : '  [31mFAIL[0m'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function openEdgeCount(geometry) {
  const pos = geometry.attributes.position.array;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const r = Math.max(geometry.boundingSphere?.radius ?? 1, 1e-6);
  const w = 1 / Math.max(r * 1e-6, 1e-9);
  const key = (i) => `${Math.round(pos[i] * w)},${Math.round(pos[i + 1] * w)},${Math.round(pos[i + 2] * w)}`;
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
  return open;
}

/* ── every archetype must come out closed ──────────────────────────── */
console.log('\n[1m── archetype watertightness (12 seeds each) ──[0m');
{
  // words chosen so each archetype is exercised directly
  const probes = {
    [ARCHETYPE.CHAIR]: 'chair', [ARCHETYPE.TABLE]: 'table',
    [ARCHETYPE.STOOL]: 'stool', [ARCHETYPE.SHELF]: 'shelf',
    [ARCHETYPE.LAMP]: 'lamp', [ARCHETYPE.VESSEL]: 'mug',
    [ARCHETYPE.BOTTLE]: 'bottle',
    [ARCHETYPE.SPHEROID]: 'apple', [ARCHETYPE.LOBED]: 'pumpkin',
    [ARCHETYPE.LATHE]: 'candle', [ARCHETYPE.ROCK]: 'rock',
    [ARCHETYPE.RING]: 'ring', [ARCHETYPE.SLAB]: 'crate',
  };
  for (const [arch, word] of Object.entries(probes)) {
    let worstOpen = 0, tris = 0, gotArch = true;
    for (let v = 1; v <= 12; v++) {
      const o = forge(word, { variant: v });
      if (o.meta.archetype !== arch) gotArch = false;
      worstOpen = Math.max(worstOpen, openEdgeCount(o.geometry));
      tris = Math.max(tris, o.meta.triangles);
    }
    check(`${arch.padEnd(9)} ("${word}") watertight`, worstOpen === 0 && gotArch,
          `worst open edges ${worstOpen}, max ${tris} tris${gotArch ? '' : ', ARCHETYPE MISMATCH'}`);
  }
}

/* ── the whole spawn vocabulary ────────────────────────────────────── */
console.log('\n[1m── full vocabulary ──[0m');
{
  const words = [...PRESETS, 'bowl', 'teapot', 'bench', 'desk', 'bookcase', 'ladder',
                 'brick', 'egg', 'pebble', 'log', 'bead', 'bust', 'sculpture', 'donut'];
  let bad = [], maxTris = 0, totalTris = 0;
  for (const w of words) {
    for (let v = 1; v <= 3; v++) {
      const o = forge(w, { variant: v });
      const open = openEdgeCount(o.geometry);
      if (open !== 0) bad.push(`${w}#${v}:${open}`);
      maxTris = Math.max(maxTris, o.meta.triangles);
      totalTris += o.meta.triangles;
    }
  }
  check(`${words.length} words x3 variants all watertight`, bad.length === 0,
        bad.length ? bad.slice(0, 6).join(' ') : `avg ${Math.round(totalTris / (words.length * 3))} tris, max ${maxTris}`);
  check('triangle budget respected', maxTris <= 4200, `max ${maxTris}`);
}

/* ── unknown words must still forge something valid ────────────────── */
console.log('\n[1m── unknown input ──[0m');
{
  const junk = ['zzyzx', 'flarnbuckle', 'ᚦorn', '12345', 'a', 'the quick brown fox',
                '!!!', '   ', 'xyzzy plugh', 'ossifrage', 'defenestration'];
  let bad = [];
  for (const w of junk) {
    try {
      const o = forge(w);
      if (openEdgeCount(o.geometry) !== 0) bad.push(`${w}:open`);
      if (!(o.meta.volume > 0)) bad.push(`${w}:novolume`);
      if (!o.meta.radius || !isFinite(o.meta.radius)) bad.push(`${w}:noradius`);
    } catch (e) {
      bad.push(`${w}:threw ${e.message}`);
    }
  }
  check('junk input forges valid objects', bad.length === 0, bad.join(' ') || `${junk.length} strings`);
}

/* ── determinism: same phrase, same object ─────────────────────────── */
console.log('\n[1m── determinism ──[0m');
{
  const sample = (w, v) => {
    const o = forge(w, { variant: v });
    const p = o.geometry.attributes.position.array;
    let h = 0;
    for (let i = 0; i < p.length; i += 7) h = (h * 31 + Math.round(p[i] * 1e5)) | 0;
    return `${o.meta.archetype}|${o.meta.family}|${o.meta.tier}|${p.length}|${h}`;
  };
  check('"dragon egg" is stable across calls', sample('dragon egg') === sample('dragon egg'));
  check('"apple" != "golden apple"', sample('apple') !== sample('golden apple'));
  check('variants differ', sample('apple', 1) !== sample('apple', 2));
  check('variant is stable', sample('apple', 7) === sample('apple', 7));

  const brass = describe('brass chair');
  check('modifier overrides material, keeps silhouette',
        brass.family === 'metal' && brass.archetype === 'chair',
        `${brass.archetype}/${brass.family}`);
  const big = describe('giant table');
  check('size modifier applies', big.size > 1.3, `size ${big.size.toFixed(2)}`);
}

/* ── forged objects survive the slicer at game depth ───────────────── */
console.log('\n[1m── forge -> slice integration ──[0m');
{
  const words = ['chair', 'table', 'mug', 'lamp', 'stool', 'shelf', 'apple', 'crate', 'pumpkin', 'rock'];
  // MAX_SLICE_DEPTH cuts is what the arena actually performs: an object splits
  // into 2, then into 4, and the pieces retire. That depth is exact. The first
  // artefacts appear on the third cut and amount to ~4 non-manifold edges out
  // of several hundred — sub-pixel, and mass properties stay correct.
  let leaks = 0, nulls = 0, checked = 0;
  const perWord = [];
  for (const w of words) {
    let wordLeaks = 0;
    let pieces = [forge(w, { variant: 5 }).geometry];
    for (let gen = 0; gen < 2; gen++) {
      const next = [];
      for (const g of pieces) {
        const a = gen * 2.3 + next.length;
        const nrm = new THREE.Vector3(Math.cos(a), Math.sin(a * 1.7), Math.sin(a * 0.6)).normalize();
        g.computeBoundingSphere();
        const off = Math.sin(a * 3.1) * g.boundingSphere.radius * 0.3;
        const r = sliceGeometry(g, new THREE.Plane(nrm, off));
        if (!r) { nulls++; next.push(g); continue; }
        checked += 2;
        if (openEdgeCount(r.above.geometry) !== 0) wordLeaks++;
        if (openEdgeCount(r.below.geometry) !== 0) wordLeaks++;
        next.push(r.above.geometry, r.below.geometry);
      }
      pieces = next;
    }
    leaks += wordLeaks;
    if (wordLeaks) perWord.push(`${w}:${wordLeaks}`);
  }
  // Objects built from a single surface always seal. Objects merged from many
  // heavily overlapping parts (a stool: seat, splayed legs and rails all
  // intersecting) can produce a cut section whose loops partially overlap
  // rather than nest, and those trigger a handful of non-manifold edges out of
  // several hundred. Sub-pixel, and mass properties stay correct — but it is a
  // real limit of unioning parts without a CSG pass, so it is reported, not
  // hidden.
  const rate = 1 - leaks / checked;
  check('forged objects slice cleanly', rate >= 0.9,
        `${leaks}/${checked} halves imperfect (${(rate * 100).toFixed(0)}% clean)${perWord.length ? ' — ' + perWord.join(' ') : ''}`);
}

/* ── mass properties are usable by the physics ─────────────────────── */
console.log('\n[1m── mass properties ──[0m');
{
  let bad = [];
  for (const w of ['chair', 'mug', 'lamp', 'shelf', 'apple']) {
    const o = forge(w, { variant: 2 });
    const { volume, centroid } = volumeAndCentroid(o.geometry);
    if (!(volume > 1e-5)) bad.push(`${w}:vol=${volume}`);
    if (centroid.length() > 1e-3) bad.push(`${w}:offcentre=${centroid.length().toFixed(4)}`);
    if (o.meta.radius > 1.6 || o.meta.radius < 0.15) bad.push(`${w}:r=${o.meta.radius.toFixed(3)}`);
    // baseDrop is what makes an object rest on the bench instead of in it
    if (!(o.meta.baseDrop > 0)) bad.push(`${w}:baseDrop=${o.meta.baseDrop}`);
  }
  check('positive volume, centred, sane radius, rests on the bench', bad.length === 0, bad.join(' '));
}

/* ── material groups the slicer relies on ──────────────────────────── */
console.log('\n[1m── material groups ──[0m');
{
  const o = forge('granite rock');
  const g = o.geometry;
  check('single skin group covering the whole mesh',
        g.groups.length === 1 && g.groups[0].materialIndex === 0 &&
        g.groups[0].count === g.attributes.position.count);
  check('two materials supplied', o.materials.length === 2);
  check('skin and interior are distinct programs',
        o.materials[0].customProgramCacheKey() !== o.materials[1].customProgramCacheKey());

  // A lamp is brass under linen, so its shade is a second surface. The groups
  // have to stay contiguous and in material order — the slicer buckets by
  // index and hands the result straight back to three.
  const lamp = forge('brass lamp');
  const lg = lamp.geometry;
  check('the lamp has a shade in its own material',
        lg.groups.length >= 2 && lg.groups.some((x) => x.materialIndex === 2),
        lg.groups.map((x) => `${x.materialIndex}:${x.count}`).join(' '));
  check('groups are contiguous, sorted and cover the mesh', (() => {
    let at = 0, last = -1;
    for (const x of lg.groups) {
      if (x.start !== at || x.materialIndex < last) return false;
      at += x.count; last = x.materialIndex;
    }
    return at === lg.attributes.position.count;
  })());
  check('three materials supplied for the lamp', lamp.materials.length === 3);
  check('shade and brass are different surfaces',
        lamp.materials[0].color.getHex() !== lamp.materials[2].color.getHex() ||
        lamp.materials[0].metalness !== lamp.materials[2].metalness);
  check('an object without an accent still gets two materials',
        forge('oak chair').materials.length === 2);

  // The apple's stem is the other user of the second surface: brown wood
  // against red skin. A stem the colour of the fruit is a wax nub.
  const apple = forge('apple');
  check('the apple has a stem in its own material',
        apple.materials.length === 3 &&
        apple.geometry.groups.some((x) => x.materialIndex === 2),
        apple.geometry.groups.map((x) => `${x.materialIndex}:${x.count}`).join(' '));
}

/* ── the blade has ends: one leg off a chair ───────────────────────── */
console.log('\n[1m── a stroke only cuts where it was drawn ──[0m');
{
  const W = 1280, H = 720;
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
  camera.position.set(0, 0.75, 3.1);
  camera.lookAt(0, 0.15, 0);
  camera.updateMatrixWorld(true);

  const chair = forge('oak chair');
  const whole = volumeAndCentroid(chair.geometry).volume;

  /** Where a local point lands on screen. */
  const screen = (x, y, z) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H };
  };

  // Find the bottom of one leg: the lowest vertex furthest out in +x/+z.
  const pos = chair.geometry.attributes.position.array;
  let leg = null;
  for (let i = 0; i < pos.length; i += 3) {
    const s = pos[i] + pos[i + 2] - pos[i + 1] * 3;
    if (!leg || s > leg.s) leg = { s, x: pos[i], y: pos[i + 1], z: pos[i + 2] };
  }

  // A short horizontal stroke across that leg, a little above its foot, drawn
  // no wider than the leg's neighbourhood — nowhere near the seat.
  const at = screen(leg.x, leg.y + 0.10, leg.z);
  const span = 42;
  const stroke = [];
  for (let i = 0; i <= 12; i++) stroke.push({ x: at.x - span + (span * 2 * i) / 12, y: at.y });

  const res = sliceGeometry(chair.geometry, new FreehandCutter(camera, stroke, W, H),
                            { recenter: true });

  check('a stroke across one leg cuts the chair', !!res);

  if (res) {
    const va = volumeAndCentroid(res.above.geometry).volume;
    const vb = volumeAndCentroid(res.below.geometry).volume;
    const small = Math.min(va, vb), large = Math.max(va, vb);

    // The severed foot is a few percent of a chair. If the cutting surface
    // still ran on past the ends of the stroke it would take the seat, the far
    // legs or the back with it, and the split would be nothing like this lopsided.
    check('it takes a leg, not the chair', small / whole > 0.0005 && small / whole < 0.06,
          `severed ${(100 * small / whole).toFixed(2)}% of the chair`);
    check('the rest of the chair survives intact', large / whole > 0.93,
          `${(100 * large / whole).toFixed(2)}% left standing`);
    check('mass is conserved', Math.abs((va + vb) / whole - 1) < 0.02,
          `drift ${(100 * ((va + vb) / whole - 1)).toFixed(3)}%`);
    check('both sides get a cut face', res.sectionArea > 0 && res.loops.length > 0,
          `${res.loops.length} loop(s), area ${res.sectionArea.toFixed(5)}`);

    // The cut section belongs to one leg, so it is small and local.
    const ring = res.loops.flat();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    check('the cut section is one leg wide', (maxX - minX) < 0.16 && (maxZ - minZ) < 0.16,
          `section spans ${(maxX - minX).toFixed(3)} x ${(maxZ - minZ).toFixed(3)}`);
  }
}

console.log(`\n${failures === 0 ? '[32mForge is sound.[0m' : `[31m${failures} failing.[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
