import * as THREE from 'three';
import { GLSL_NOISE } from '../core/noise.js';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  MATERIAL FAMILIES
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Every forged object carries two materials:
 *
 *    [0] SKIN      what you see before you cut it
 *    [1] INTERIOR  what the slicer paints onto every new cap face
 *
 *  The interior is the whole trick. A cut only reads as a *cut* if the
 *  revealed face looks like the inside of something — flesh with a seed
 *  core, end-grain rings, a glowing crystal fracture, hot polished metal.
 *  So the interior shaders are the expensive ones, and they're driven by
 *  local-space position, which means a fragment sliced twice shows two
 *  faces cut from the same continuous internal volume.
 *
 *  All variation is done with *uniforms*, never by editing shader source,
 *  so every object in a family shares one compiled program. That's what
 *  `customProgramCacheKey` below guarantees — otherwise each new object
 *  would trigger a shader compile and hitch the frame.
 */

export const FAMILY = {
  ORGANIC: 'organic',
  CITRUS: 'citrus',
  STONE: 'stone',
  METAL: 'metal',
  GEM: 'gem',
  WOOD: 'wood',
  ICE: 'ice',
  GLASS: 'glass',
  CERAMIC: 'ceramic',
  SLIME: 'slime',
  CLAY: 'clay',
};

/** Numeric ids handed to the shaders (GLSL branches on these). */
const STYLE_ID = {
  [FAMILY.ORGANIC]: 0,
  [FAMILY.CITRUS]: 1,
  [FAMILY.STONE]: 2,
  [FAMILY.METAL]: 3,
  [FAMILY.GEM]: 4,
  [FAMILY.WOOD]: 5,
  [FAMILY.ICE]: 6,
  [FAMILY.CERAMIC]: 7,
  [FAMILY.GLASS]: 8,
  [FAMILY.SLIME]: 9,
  [FAMILY.CLAY]: 10,
};

/* Live materials that want a clock. Kept weak-ish: cleared by the pool. */
const animated = new Set();

export function tickMaterials(elapsed) {
  for (const m of animated) {
    if (m.userData.u) m.userData.u.uTime.value = elapsed;
  }
}

export function registerAnimated(m) { animated.add(m); }
export function unregisterAnimated(m) { animated.delete(m); }

/* ══════════════════════════════════════════════════════════════════════
   Shared GLSL
   ══════════════════════════════════════════════════════════════════════ */

/** Passes object-space position/normal through to the fragment stage. */
const VARYING_DECL = /* glsl */`
varying vec3 vObjPos;
varying vec3 vObjNrm;
`;

const VERTEX_TAIL = /* glsl */`
  vObjPos = position;
  vObjNrm = normal;
`;

/** Triplanar sampling weights from an object-space normal. */
const TRIPLANAR = /* glsl */`
vec3 cl_triWeights(vec3 n){
  vec3 w = abs(normalize(n));
  w = pow(w, vec3(4.0));
  return w / max(dot(w, vec3(1.0)), 1e-4);
}
`;

/* ══════════════════════════════════════════════════════════════════════
   SKIN
   ══════════════════════════════════════════════════════════════════════ */

const SKIN_FRAG_HEAD = /* glsl */`
uniform float uTime;
uniform float uStyle;
uniform float uScale;
uniform float uSeed;
uniform vec3  uTintA;
uniform vec3  uTintB;
uniform vec3  uTintC;
uniform float uDetail;
uniform float uBark;
uniform vec3  uAxis;
${VARYING_DECL}
${GLSL_NOISE}
${TRIPLANAR}
`;

/**
 * Injected right after the standard material sets `diffuseColor`, so we
 * inherit all of three's PBR lighting and only reshape albedo/roughness.
 */
const SKIN_FRAG_BODY = /* glsl */`
{
  vec3 p = vObjPos * uScale + uSeed;
  int style = int(uStyle + 0.5);

  float grain = cl_fbm(p * 3.0, 4);
  float mottle = cl_fbm(p * 1.2 + 11.0, 3);
  vec3 col = diffuseColor.rgb;

  if (style == 0) {               // ORGANIC — fruit skin, blush and speckle
    col = mix(uTintA, uTintB, smoothstep(-0.35, 0.45, mottle));
    float speck = smoothstep(0.62, 0.78, cl_fbm(p * 14.0, 2));
    col = mix(col, col * 1.55 + 0.06, speck * uDetail);
    col *= 0.9 + 0.2 * grain;

  } else if (style == 1) {        // CITRUS — dimpled peel
    vec2 w = cl_worley(p * 9.0);
    float pit = smoothstep(0.0, 0.35, w.x);
    col = mix(uTintA, uTintB, pit);
    col *= 0.86 + 0.28 * pit;
    roughnessFactor = clamp(roughnessFactor + (1.0 - pit) * 0.35, 0.05, 1.0);

  } else if (style == 2) {        // STONE — aggregate + ridged weathering
    float r = cl_ridged(p * 2.4, 4);
    col = mix(uTintA, uTintB, r * 0.5 + 0.5);
    vec2 w = cl_worley(p * 6.0);
    col = mix(col, col * 1.35, smoothstep(0.05, 0.0, w.y - w.x));
    col *= 0.82 + 0.3 * grain;
    roughnessFactor = clamp(roughnessFactor + 0.18 * r, 0.3, 1.0);

  } else if (style == 3) {        // METAL — brushed anisotropy + patina
    float brush = cl_fbm(vec3(p.x * 60.0, p.y * 2.0, p.z * 60.0), 3);
    col = mix(uTintA, uTintB, 0.5 + 0.5 * mottle);
    roughnessFactor = clamp(roughnessFactor + brush * 0.16, 0.04, 0.95);
    col *= 0.94 + 0.12 * brush;

  } else if (style == 4) {        // GEM — faceted colour shift
    float f = cl_fbm(p * 5.0, 3);
    col = mix(uTintA, uTintB, 0.5 + 0.5 * f);
    float fres = pow(1.0 - abs(dot(normalize(vObjNrm), vec3(0.0, 0.0, 1.0))), 2.0);
    col += uTintB * fres * 0.25;

  } else if (style == 5 && uBark > 0.5) {   // BARK — a log's outside
    // Bark runs ALONG the trunk in coarse ridges with deep splits between them,
    // and it has to look nothing like the sawn face at the ends, because the
    // contrast between the two is most of what says "log".
    //
    // The trunk axis is a uniform, not the Y axis. A log is turned standing up
    // and then laid down, so assuming Y wraps the ridges the wrong way round and
    // paints end grain along the flanks — which is exactly what it did.
    vec3 A = normalize(uAxis);
    vec3 T = normalize(abs(A.y) < 0.9 ? cross(A, vec3(0.0, 1.0, 0.0))
                                      : cross(A, vec3(1.0, 0.0, 0.0)));
    vec3 B = cross(A, T);
    float along = dot(vObjPos, A);
    float ang = atan(dot(vObjPos, B), dot(vObjPos, T));

    float ridge = cl_fbm(vec3(ang * 2.6, along * 0.7, uSeed) * 3.0, 4);
    float split = smoothstep(0.30, -0.14, ridge);
    float fibre = cl_fbm(vec3(ang * 22.0, along * 1.4, uSeed + 3.0), 2);

    col = mix(uTintA, uTintB, 0.44 + 0.36 * ridge);
    col *= 0.92 + 0.13 * fibre;
    col = mix(col, uTintB * 0.55, split * 0.70);          // the cracks

    // The sawn ends are not bark: fade to pale sapwood wherever the surface
    // faces along the trunk, so the ends read as a fresh cut through the middle.
    // And a sawn end has rings — concentric about the trunk, wandering slightly,
    // which is the difference between a log and a dowel painted brown.
    float radial = length(vObjPos - A * along);
    float wander = cl_fbm(vec3(radial * 2.5, along * 0.4, uSeed + 11.0), 2);
    float rings = sin(radial * 52.0 + wander * 2.6);
    vec3 endCol = mix(uTintC, uTintC * 0.70, smoothstep(0.1, 0.95, rings) * 0.5);
    endCol = mix(endCol, uTintC * 0.55, smoothstep(0.09, 0.0, radial));  // the pith
    float endGrain = smoothstep(0.62, 0.94, abs(dot(normalize(vObjNrm), A)));
    col = mix(col, endCol, endGrain * 0.92);
    roughnessFactor = clamp(0.74 + 0.20 * split - 0.28 * endGrain, 0.3, 1.0);

  } else if (style == 10) {       // CLAY — a fired brick: sandy, matte, plain
    // Not the stone branch. Stone draws worley veins for aggregate, and on a
    // brick that reads as a crazed slab of lava rather than something pressed
    // and fired. A brick is sand with a few darker inclusions and nothing else.
    float sand = cl_fbm(p * 26.0, 2);
    float blotch = cl_fbm(p * 1.8 + 7.0, 3);
    col = mix(uTintA, uTintB, 0.40 + 0.34 * blotch);
    col *= 0.93 + 0.13 * sand;
    float inclusion = smoothstep(0.72, 0.88, cl_fbm(p * 7.0 + 3.0, 2));
    col = mix(col, uTintB * 0.72, inclusion * 0.35);
    roughnessFactor = clamp(0.86 + 0.10 * sand, 0.6, 1.0);

  } else if (style == 9) {        // SLIME — a soft translucent blob
    // Almost no surface detail: slime is smooth and wet, and what little you
    // see is *inside* it. Slow-drifting darker clots plus a bright wet rim.
    vec3 q = vObjPos * 3.2 + vec3(0.0, uTime * 0.11, uSeed);
    float clots = cl_fbm(q, 3);
    col = mix(uTintA, uTintB, 0.42 + 0.40 * clots);
    float deep = smoothstep(0.15, 0.75, cl_fbm(q * 2.1 + 5.0, 2));
    col = mix(col, uTintB * 0.66, deep * 0.45);
    // A little rim light, not a crust. Pushed too far this bleaches the whole
    // spreading edge white and the blob reads as a dumpling.
    float rim = pow(1.0 - abs(dot(normalize(vObjNrm), normalize(vObjPos))), 3.4);
    col += vec3(0.10, 0.17, 0.06) * rim;
    roughnessFactor = clamp(0.055 + 0.05 * clots, 0.02, 0.2);

  } else if (style == 5) {        // WOOD — directional grain, triplanar
    // Grain has to run ALONG something. Sampling an isotropic 3D field gives
    // blotches on any wide face — a seat comes out looking like cork — while
    // sampling rings on the cross-section paints zebra stripes around every
    // leg. So each of the three projections is stretched along the axis a
    // board cut that way would actually run, then blended by the normal.
    vec3 wp = vObjPos * 3.4 + uSeed;
    vec3 wn = cl_triWeights(vObjNrm);

    // faces looking along X and Z are the sides of uprights: grain runs up Y.
    // faces looking along Y are flat-sawn boards: grain runs along X.
    float gx = cl_fbm(vec3(wp.y * 0.22, wp.z * 2.6, uSeed), 3);
    float gz = cl_fbm(vec3(wp.y * 0.22, wp.x * 2.6, uSeed + 5.0), 3);
    float gy = cl_fbm(vec3(wp.x * 0.22, wp.z * 2.6, uSeed + 9.0), 3);
    float fibre = gx * wn.x + gy * wn.y + gz * wn.z;

    float fx = cl_fbm(vec3(wp.y * 0.8, wp.z * 9.0, uSeed), 2);
    float fz = cl_fbm(vec3(wp.y * 0.8, wp.x * 9.0, uSeed + 5.0), 2);
    float fy = cl_fbm(vec3(wp.x * 0.8, wp.z * 9.0, uSeed + 9.0), 2);
    float fine = fx * wn.x + fy * wn.y + fz * wn.z;

    // darker late-wood lines following the figure
    float lines = smoothstep(0.50, 0.92, abs(sin(fibre * 6.5 + fine * 1.6)));

    col = mix(uTintA, uTintB, 0.40 + 0.34 * fibre);
    col *= 0.95 + 0.09 * fine;
    col = mix(col, col * 0.78, lines * 0.6);
    roughnessFactor = clamp(roughnessFactor + lines * 0.10 - fine * 0.04, 0.35, 1.0);

  } else if (style == 6) {        // ICE — frosted with clear patches
    float fr = cl_fbm(p * 4.5, 4);
    col = mix(uTintA, uTintB, 0.5 + 0.5 * fr);
    roughnessFactor = clamp(0.06 + 0.5 * smoothstep(-0.1, 0.5, fr), 0.03, 0.8);

  } else if (style == 8) {        // GLASS — clear, with the ripple of blown work
    // Deliberately not the ice branch. Ice frosts to roughness 0.8 in patches,
    // which is exactly right for ice and exactly what made a bottle read as
    // glazed stoneware. Glass stays smooth everywhere; the only variation is a
    // faint horizontal ripple from the blowing, and a darkening at grazing
    // angles that stands in for looking through more of the wall.
    float ripple = cl_fbm(vec3(p.x * 0.6, p.y * 7.0, p.z * 0.6), 2);
    col = mix(uTintA, uTintB, 0.44 + 0.22 * ripple);
    float graze = pow(1.0 - abs(dot(normalize(vObjNrm), normalize(vObjPos))), 2.2);
    col = mix(col, col * 0.55, graze * 0.7);
    roughnessFactor = clamp(0.035 + 0.03 * ripple, 0.02, 0.14);

  } else {                        // CERAMIC — glaze with fine crazing
    vec2 w = cl_worley(p * 7.0);
    float craze = smoothstep(0.045, 0.0, w.y - w.x);
    col = mix(uTintA, uTintB, 0.5 + 0.5 * mottle);
    col = mix(col, col * 0.72, craze * 0.55);
    roughnessFactor = clamp(roughnessFactor - 0.18 + craze * 0.4, 0.04, 1.0);
  }

  diffuseColor.rgb = col;
}
`;

export class SkinMaterial extends THREE.MeshPhysicalMaterial {
  constructor(family, opts = {}) {
    super({
      color: 0xffffff,
      roughness: opts.roughness ?? 0.5,
      metalness: opts.metalness ?? 0.0,
      clearcoat: opts.clearcoat ?? 0.0,
      clearcoatRoughness: opts.clearcoatRoughness ?? 0.15,
      iridescence: opts.iridescence ?? 0.0,
      iridescenceIOR: 1.9,
      sheen: opts.sheen ?? 0.0,
      sheenColor: new THREE.Color(opts.sheenColor ?? 0xffffff),
      emissive: new THREE.Color(opts.emissive ?? 0x000000),
      emissiveIntensity: opts.emissiveIntensity ?? 1,
      envMapIntensity: opts.envMapIntensity ?? 1.1,
      transmission: opts.transmission ?? 0,
      thickness: opts.thickness ?? 0,
      // Volumetric absorption: how far light gets through the material before
      // it takes on the colour. This, not the surface tint, is what makes thick
      // glass darker than thin glass.
      attenuationColor: new THREE.Color(opts.attenuationColor ?? 0xffffff),
      attenuationDistance: opts.attenuationDistance ?? Infinity,
      ior: opts.ior ?? 1.5,
      transparent: !!opts.transparent,
      flatShading: !!opts.flatShading,
      side: THREE.FrontSide,
    });

    this.family = family;
    this.userData.u = {
      uTime: { value: 0 },
      uStyle: { value: STYLE_ID[family] ?? 0 },
      uScale: { value: opts.scale ?? 1.6 },
      uSeed: { value: opts.seed ?? 0 },
      uTintA: { value: new THREE.Color(opts.tintA ?? 0xffffff) },
      uTintB: { value: new THREE.Color(opts.tintB ?? 0xcccccc) },
      // A third colour, for surfaces that are two things at once. Bark uses it
      // for the sawn ends of a log, which must not be painted with bark.
      uTintC: { value: new THREE.Color(opts.tintC ?? opts.tintA ?? 0xffffff) },
      uDetail: { value: opts.detail ?? 1 },
      uBark: { value: opts.bark ? 1 : 0 },
      // Which way the grain runs, for surfaces that have a direction.
      uAxis: { value: new THREE.Vector3(...(opts.axis ?? [0, 1, 0])) },
    };

    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.userData.u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VARYING_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_TAIL}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SKIN_FRAG_HEAD}`)
        .replace('#include <roughnessmap_fragment>',
                 `#include <roughnessmap_fragment>\n${SKIN_FRAG_BODY}`);
    };

  }

  /** One compiled program per family — variation lives entirely in uniforms. */
  customProgramCacheKey() { return 'cleaver-skin-' + this.family; }
}

/* ══════════════════════════════════════════════════════════════════════
   INTERIOR — the freshly revealed face
   ══════════════════════════════════════════════════════════════════════ */

const INT_FRAG_HEAD = /* glsl */`
uniform float uTime;
uniform float uStyle;
uniform float uScale;
uniform float uSeed;
uniform vec3  uCoreA;
uniform vec3  uCoreB;
uniform vec3  uRimColor;
uniform float uRimPower;
uniform float uRadius;
${VARYING_DECL}
${GLSL_NOISE}
`;

/**
 * Radial structure is built around the object's own centre, so a second cut
 * through the same fragment exposes a face that lines up with the first.
 */
const INT_FRAG_BODY = /* glsl */`
{
  vec3 p = vObjPos * uScale + uSeed;
  float rad = length(vObjPos) / max(uRadius, 1e-3);
  int style = int(uStyle + 0.5);
  vec3 col = uCoreA;

  if (style == 0) {               // ORGANIC — pale flesh, fibres, a seed core
    float fib = cl_fbm(vec3(vObjPos.xy * 22.0, vObjPos.z * 5.0) + uSeed, 3);
    col = mix(uCoreA, uCoreB, smoothstep(0.15, 0.95, rad) * 0.85);
    col *= 0.92 + 0.16 * fib;
    float core = 1.0 - smoothstep(0.06, 0.24, rad);
    col = mix(col, uCoreB * 0.55, core * 0.8);
    float seeds = smoothstep(0.80, 0.93, cl_fbm(p * 13.0, 2)) * (1.0 - smoothstep(0.18, 0.5, rad));
    col = mix(col, vec3(0.10, 0.07, 0.05), seeds);

  } else if (style == 1) {        // CITRUS — radial segments and pith
    float ang = atan(vObjPos.y, vObjPos.x);
    float seg = abs(sin(ang * 5.5 + cl_fbm(p * 4.0, 2) * 0.5));
    float wall = smoothstep(0.10, 0.0, seg) * step(0.16, rad);
    col = mix(uCoreA, uCoreB, smoothstep(0.1, 1.0, rad));
    float juice = cl_fbm(vec3(ang * 8.0, rad * 26.0, 0.0), 3);
    col *= 0.86 + 0.3 * juice;
    col = mix(col, vec3(0.98, 0.96, 0.88), wall * 0.9);
    col = mix(col, vec3(0.99, 0.97, 0.90), 1.0 - smoothstep(0.0, 0.17, rad));

  } else if (style == 2) {        // STONE — aggregate, unpolished
    vec2 w = cl_worley(p * 8.0);
    col = mix(uCoreA, uCoreB, smoothstep(0.0, 0.6, w.x));
    col *= 0.8 + 0.4 * cl_fbm(p * 16.0, 3);
    col = mix(col, col * 1.4, smoothstep(0.04, 0.0, w.y - w.x));

  } else if (style == 3) {        // METAL — mirror core, heat at the edge
    col = mix(uCoreA, uCoreB, 0.5 + 0.5 * cl_fbm(p * 9.0, 3));
    float swirl = sin(rad * 60.0 + cl_fbm(p * 4.0, 2) * 6.0) * 0.5 + 0.5;
    col *= 0.88 + 0.2 * swirl;
    metalnessFactor = 1.0;
    roughnessFactor = 0.14 + 0.1 * swirl;

  } else if (style == 4) {        // GEM — internal fractures that catch light
    vec2 w = cl_worley(p * 5.0);
    float frac = smoothstep(0.08, 0.0, w.y - w.x);
    col = mix(uCoreA, uCoreB, smoothstep(0.0, 0.8, w.x));
    col += uRimColor * frac * 0.85;
    totalEmissiveRadiance += uRimColor * frac * 0.5;
    roughnessFactor = 0.05;

  } else if (style == 5) {        // WOOD — end grain, the good stuff
    // Growth rings, uneven the way real ones are: wide early wood, a thin
    // dark late-wood line, and the whole set off-centre from the pith.
    vec2 q = vObjPos.xz + vec2(uSeed * 0.03, uSeed * 0.017);
    float rr = length(q) / max(uRadius, 1e-3);
    float wobble = cl_fbm(vec3(q * 5.0, uSeed), 3) * 0.16;
    float ring = fract(rr * 9.0 + wobble * 4.0);
    float late = smoothstep(0.72, 0.98, ring);

    col = mix(uCoreA, uCoreB, 0.30 + 0.34 * cl_fbm(vec3(q * 12.0, uSeed + 4.0), 2));
    col = mix(col, col * 0.66, late * 0.8);

    // medullary rays, faint, radiating from the pith
    float ray = smoothstep(0.72, 1.0, abs(sin(atan(q.y, q.x) * 26.0)));
    col *= 0.97 + 0.06 * ray;
    roughnessFactor = 0.66;

  } else if (style == 6) {        // ICE — trapped bubbles
    float b = cl_worley(p * 11.0).x;
    col = mix(uCoreA, uCoreB, smoothstep(0.1, 0.7, b));
    col += vec3(0.10, 0.16, 0.22) * smoothstep(0.25, 0.0, b);
    roughnessFactor = 0.08;

  } else if (style == 9) {        // SLIME — gel all the way through
    // Cut slime and there is no structure to reveal: it is the same stuff
    // inside, only darker where it is thicker. Deliberately almost flat, with
    // a wet sheen, because a cut face full of detail would read as a solid.
    float gel = cl_fbm(p * 2.2, 3);
    col = mix(uCoreA, uCoreB, 0.45 + 0.35 * gel);
    col = mix(col, uCoreB * 0.72, smoothstep(0.55, 0.05, rad) * 0.55);
    roughnessFactor = 0.12;

  } else if (style == 8) {        // GLASS — a fresh break: frosted, not clear
    // Broken glass has no internal structure to show, and it is not a window
    // either: a fracture surface is frosted where it tore and glassy along the
    // conchoidal arcs. Rendering it smooth and clear made a cut bottle look
    // like it was edged with plastic.
    float f = cl_fbm(p * 3.0, 3);
    float arcs = abs(sin(cl_fbm(p * 1.6, 3) * 7.0));
    col = mix(uCoreA, uCoreB, 0.45 + 0.4 * f);
    col = mix(col, col * 1.22 + 0.05, smoothstep(0.55, 0.95, arcs) * 0.7);
    col *= 0.94 + 0.12 * cl_fbm(p * 9.0, 2);
    // frosted over most of it, polished along the arcs
    roughnessFactor = clamp(0.42 - 0.30 * smoothstep(0.5, 0.98, arcs) + 0.10 * f, 0.06, 0.7);

  } else if (style == 10) {       // CLAY — a snapped brick: dry, sandy, matte
    // A brick's break has to look nothing like its face, or you cannot tell
    // which side you cut. The fired outside is dark and closed; the fracture is
    // pale, open and full of sand grains catching the light edge-on.
    col = mix(uCoreA, uCoreB, 0.40 + 0.42 * cl_fbm(p * 7.0, 3));
    vec2 grit = cl_worley(p * 30.0);
    float grains = smoothstep(0.30, 0.0, grit.y - grit.x);
    col = mix(col, col * 1.30 + 0.04, grains * 0.55);       // sand catching light
    col *= 0.90 + 0.18 * cl_fbm(p * 60.0, 2);
    float pores = smoothstep(0.80, 0.95, cl_fbm(p * 15.0 + 4.0, 2));
    col = mix(col, col * 0.62, pores * 0.5);                // little voids
    roughnessFactor = 0.96;

  } else {                        // CERAMIC — unglazed bisque, chalky break
    col = mix(uCoreA, uCoreB, 0.5 + 0.5 * cl_fbm(p * 12.0, 3));
    vec2 grit = cl_worley(p * 20.0);
    col *= 0.94 + 0.10 * smoothstep(0.0, 0.5, grit.x);
    roughnessFactor = 0.88;
  }

  // A faint darkening toward the silhouette of the cut face — the ambient
  // occlusion you would actually see in the shallow lip of a fresh cut.
  // Deliberately not emissive: nothing in a workshop glows.
  // (vNormal only exists on smooth-shaded programs — three omits the varying
  // entirely under FLAT_SHADED, so guard it or the shader fails to compile.)
  #ifndef FLAT_SHADED
    float fres = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), uRimPower);
    col = mix(col, col * mix(vec3(1.0), uRimColor * 2.0, 0.55), fres * 0.5);
  #endif

  diffuseColor.rgb = col;
}
`;

export class InteriorMaterial extends THREE.MeshPhysicalMaterial {
  constructor(family, opts = {}) {
    super({
      color: 0xffffff,
      roughness: opts.roughness ?? 0.62,
      metalness: opts.metalness ?? 0.0,
      envMapIntensity: opts.envMapIntensity ?? 0.9,
      sheen: opts.sheen ?? 0.35,
      sheenRoughness: 0.6,
      ior: opts.ior ?? 1.5,
      side: THREE.FrontSide,

      // ── a cut face is never a window ──────────────────────────────
      //
      // Not configurable, and that is the point: it was, and glass and slime
      // set it, and their cut faces stopped looking like anything. Three
      // renders a transmissive surface by refracting a render target holding
      // only the *opaque* scene, so a transmissive cut face shows the backdrop
      // rather than itself — flat, evenly lit, no reflection, no shading. It
      // reads exactly like a piece of untextured card, which is what it was
      // being reported as.
      //
      // It is also wrong on its own terms. Broken glass is frosted where it
      // fractured, cut gel is a solid face; neither is see-through. Whatever
      // the outside of an object does, the moment you open it you are looking
      // at material, so every interior is opaque.
      transmission: 0,
      thickness: 0,
      transparent: false,
    });

    this.family = family;
    this.userData.u = {
      uTime: { value: 0 },
      uStyle: { value: STYLE_ID[family] ?? 0 },
      uScale: { value: opts.scale ?? 2.2 },
      uSeed: { value: opts.seed ?? 0 },
      uCoreA: { value: new THREE.Color(opts.coreA ?? 0xffeedd) },
      uCoreB: { value: new THREE.Color(opts.coreB ?? 0xffbb88) },
      uRimColor: { value: new THREE.Color(opts.rim ?? 0x223344) },
      uRimPower: { value: opts.rimPower ?? 2.6 },
      uRadius: { value: opts.radius ?? 1 },
    };

    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.userData.u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VARYING_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_TAIL}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${INT_FRAG_HEAD}`)
        .replace('#include <metalnessmap_fragment>',
                 `#include <metalnessmap_fragment>\n${INT_FRAG_BODY}`);
    };

  }

  customProgramCacheKey() { return 'cleaver-interior-' + this.family; }
}

/** Radius drives the interior's radial structure; halves need it refreshed. */
export function setInteriorRadius(material, radius) {
  if (material?.userData?.u?.uRadius) material.userData.u.uRadius.value = radius;
}
