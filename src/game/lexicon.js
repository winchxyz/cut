import { FAMILY } from './materials.js';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  LEXICON
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Maps a word to a *construction*, not to a model. There are no assets
 *  here — an entry chooses a builder, a material family and a palette,
 *  and everything else comes from a seeded RNG. "chair" builds a real
 *  chair: seat, four legs, a back. "oak chair" builds the same chair in
 *  oak. An unrecognised word still builds something specific, derived
 *  from a hash of the letters, and the same word always builds the same
 *  object.
 */

/**
 * Only shapes that read as a real object are kept here.
 *
 * An earlier version also had spiky "star", jagged "shard", swept "helix" and
 * a merged "cluster" of random primitives. They were the ugly ones: lumpy,
 * asymmetric, full of protruding bits, and never recognisable as anything you
 * could name. Simple and correct beats varied and strange.
 */
export const ARCHETYPE = {
  // constructed things
  CHAIR: 'chair',
  TABLE: 'table',
  STOOL: 'stool',
  LAMP: 'lamp',
  SHELF: 'shelf',
  VESSEL: 'vessel',      // hollow: mugs, bowls, pots
  BOTTLE: 'bottle',      // hollow, with a neck
  // shaped things
  SPHEROID: 'spheroid',  // fruit, balls, eggs
  LOBED: 'lobed',        // pumpkins, tomatoes
  LATHE: 'lathe',        // named silhouettes turned on an axis
  SLAB: 'slab',          // books, boxes, bricks
  RING: 'ring',          // rings, beads, tori
  ROCK: 'rock',          // the one thing allowed to be irregular
  SLIME: 'slime',        // a settled blob: soft, translucent, faintly wobbling
};

/* Palettes: [skinA, skinB, coreA, coreB, rim]
   Warm, muted, naturalistic. The rim colour is a soft ambient tint on the
   freshly cut face, not a glow. */
const P = {
  oak:        [0xa9814f, 0x76552f, 0xcaa46e, 0x9c7a45, 0x4e3a20],
  walnut:     [0x59402c, 0x332215, 0x8d6a45, 0x63472c, 0x2a1c12],
  pine:       [0xcbab77, 0xa88650, 0xdfc396, 0xbfa06d, 0x5f4a2c],
  cherrywood: [0x8a4a2e, 0x5b2f1b, 0xb2764c, 0x8a5432, 0x3a1d10],
  ash:        [0xc0ab86, 0x9a8763, 0xd6c4a1, 0xb09b74, 0x554a35],

  clay:       [0xc98a68, 0x9a6244, 0xdba983, 0xb8805c, 0x5c3826],
  terracotta: [0xc0714c, 0x8e4a2c, 0xd89570, 0xb06a46, 0x552b18],
  porcelain:  [0xf4f1ea, 0xdcd6c8, 0xfaf8f3, 0xe4ded1, 0x8a8375],
  stoneware:  [0xb9b3a4, 0x8d8778, 0xd2ccbd, 0xa9a394, 0x585448],
  cream:      [0xefe6d5, 0xd6c9b2, 0xf7f1e5, 0xdfd4bf, 0x8a8070],
  // Glazed outside, unglazed break. The two have to differ in *value*, not just
  // in gloss: with a break the same brightness as the glaze you cannot tell a
  // cut face from an original one, which is what the cream palette did to the
  // vase — 0.04 apart out of 1, against 0.39 for the brick and 0.45 for the log.
  glazedclay: [0xf2ead9, 0xdccfb8, 0xc9b795, 0xa89476, 0x6b6049],

  marble:     [0xefece6, 0xc9c4ba, 0xf6f4f0, 0xd8d3c9, 0x6f6c66],
  slate:      [0x6e747a, 0x474c52, 0x8b9198, 0x646a70, 0x2e3236],
  sandstone:  [0xd9c49a, 0xab9268, 0xe9d9b6, 0xc7b189, 0x6a5b3e],
  granite:    [0x9a9690, 0x6a6762, 0xb6b2ac, 0x8b8781, 0x3e3c39],

  brass:      [0xc9a24a, 0x8f6f21, 0xe0c078, 0xb08c34, 0x4e3d13],
  copper:     [0xb87352, 0x82462b, 0xd49874, 0xa16241, 0x442313],
  steel:      [0xb6bbc1, 0x82888f, 0xd2d6db, 0x9ba1a8, 0x3c4046],
  iron:       [0x6b6f74, 0x43464a, 0x8d9196, 0x62666b, 0x26282b],

  linen:      [0xe6dfd0, 0xc9c0ac, 0xf1ebdf, 0xd8d0be, 0x8b8474],
  sage:       [0xa9b79a, 0x7d8c70, 0xc6d1ba, 0x9aa88c, 0x4e5a44],
  dusk:       [0x8f95ad, 0x666c85, 0xafb4c6, 0x848aa1, 0x3d4155],
  rust:       [0xb5643f, 0x824124, 0xd08a63, 0xa15e3c, 0x4a2515],
  ochre:      [0xd0a04e, 0x9c7228, 0xe4c188, 0xbe9146, 0x574119],

  apple:      [0xa9241f, 0x6d1210, 0xf6ecc8, 0xe4d197, 0x4a3418],
  green:      [0x8fae4e, 0x627c30, 0xeaf0cc, 0xcdd9a0, 0x3d4a1e],
  citrus:     [0xdb8f34, 0xa96412, 0xe7b25c, 0xd08a2e, 0x5a3a0e],
  melon:      [0x4e7a44, 0x2c4a26, 0xd9615f, 0xecc0be, 0x3e2020],
  plum:       [0x6c4360, 0x412839, 0xe0bb84, 0xc59156, 0x3a2416],

  ice:        [0xd6e6ec, 0xacc4ce, 0xeef6f9, 0xc9dde4, 0x7f97a1],
  glass:      [0xdfe8e6, 0xb6c6c3, 0xeff5f4, 0xcedcd9, 0x7d8f8c],
  bottleglass:[0x8ec49c, 0x5f9a72, 0xaedcb8, 0x7cb38c, 0x2c5238],
  wax:        [0xeadfc4, 0xcfc09f, 0xf5eddc, 0xdfd2b8, 0x8a7f66],
  paper:      [0xece7dc, 0xd2cabb, 0xf5f2ea, 0xdfd8cb, 0x8d8779],

  // Fired clay: a brick is redder and darker than terracotta pottery, and its
  // break is paler than its weathered face.
  fireclay:   [0x9c4a31, 0x68301f, 0xe0b598, 0xc08a68, 0x40190f],
  // Bark outside, sapwood inside. The two are further apart than any other
  // material here, which is most of why a cut log reads as a cut log.
  bark:       [0x6a5340, 0x3d2e22, 0xe0c79a, 0xc0a377, 0x4a3a28],
  slime:      [0x7fbf46, 0x4a8a2a, 0xa8e06a, 0x76b840, 0x24451a],
};

const A = ARCHETYPE;

/**
 * Each entry: [archetypes, family, palette, sizeBias]
 *
 * sizeBias is a *compressed* physical scale. Literal proportions would make a
 * chair nine times a mug, leaving the mug a few pixels across and impossible
 * to aim at; matching them makes a mug the size of a chair, which looks
 * absurd on the bench. Roughly a square-root compression keeps the ordering
 * legible while everything stays comfortably cuttable.
 */
const ENTRIES = {
  /* ── furniture ────────────────────────────────────────────── */
  chair:      [[A.CHAIR], FAMILY.WOOD, P.oak, 1.55],
  seat:       [[A.CHAIR], FAMILY.WOOD, P.oak, 1.55],
  armchair:   [[A.CHAIR], FAMILY.WOOD, P.walnut, 1.65],
  bench:      [[A.TABLE], FAMILY.WOOD, P.pine, 1.6],
  table:      [[A.TABLE], FAMILY.WOOD, P.walnut, 1.7],
  desk:       [[A.TABLE], FAMILY.WOOD, P.oak, 1.7],
  stool:      [[A.STOOL], FAMILY.WOOD, P.pine, 1.25],
  shelf:      [[A.SHELF], FAMILY.WOOD, P.oak, 1.7],
  bookcase:   [[A.SHELF], FAMILY.WOOD, P.walnut, 1.8],
  cabinet:    [[A.SHELF], FAMILY.WOOD, P.walnut, 1.7],
  ladder:     [[A.SHELF], FAMILY.WOOD, P.pine, 1.7],
  lamp:       [[A.LAMP], FAMILY.CERAMIC, P.cream, 1.15],
  light:      [[A.LAMP], FAMILY.CERAMIC, P.linen, 1.15],

  /* ── vessels ──────────────────────────────────────────────── */
  mug:        [[A.VESSEL], FAMILY.CERAMIC, P.stoneware, 0.52, 'mug'],
  cup:        [[A.VESSEL], FAMILY.CERAMIC, P.porcelain, 0.46, 'cup'],
  bowl:       [[A.VESSEL], FAMILY.CERAMIC, P.clay, 0.62, 'bowl'],
  pot:        [[A.VESSEL], FAMILY.CERAMIC, P.terracotta, 0.75, 'pot'],
  planter:    [[A.VESSEL], FAMILY.CERAMIC, P.terracotta, 0.8, 'planter'],
  vase:       [[A.VESSEL], FAMILY.CERAMIC, P.glazedclay, 1.05, 'vase'],
  jar:        [[A.VESSEL], FAMILY.CERAMIC, P.porcelain, 0.6, 'jar'],
  glass:      [[A.VESSEL], FAMILY.GLASS, P.glass, 0.5, 'glass'],
  bottle:     [[A.BOTTLE], FAMILY.GLASS, P.bottleglass, 0.86],
  teapot:     [[A.VESSEL], FAMILY.CERAMIC, P.porcelain, 0.62, 'teapot'],
  urn:        [[A.LATHE], FAMILY.CERAMIC, P.stoneware, 0.9, 'urn'],

  /* ── household objects ────────────────────────────────────── */
  book:       [[A.SLAB], FAMILY.WOOD, P.cherrywood, 0.55, 'book'],
  box:        [[A.SLAB], FAMILY.WOOD, P.pine, 0.7, 'box'],
  crate:      [[A.SLAB], FAMILY.WOOD, P.pine, 0.95, 'box'],
  brick:      [[A.SLAB], FAMILY.CLAY, P.fireclay, 0.62, 'brick'],
  candle:     [[A.LATHE], FAMILY.CERAMIC, P.wax, 0.5, 'candle'],
  sculpture:  [[A.LATHE], FAMILY.STONE, P.marble, 1.0, 'column'],
  statue:     [[A.LATHE], FAMILY.STONE, P.marble, 1.15, 'column'],
  column:     [[A.LATHE], FAMILY.STONE, P.marble, 1.2, 'column'],
  bust:       [[A.LOBED], FAMILY.STONE, P.marble, 0.85],
  egg:        [[A.LATHE], FAMILY.CERAMIC, P.porcelain, 0.34, 'egg'],
  ball:       [[A.SPHEROID], FAMILY.CERAMIC, P.linen, 0.5],
  stone:      [[A.ROCK], FAMILY.STONE, P.granite, 0.55],
  rock:       [[A.ROCK], FAMILY.STONE, P.granite, 0.65],
  pebble:     [[A.SPHEROID], FAMILY.STONE, P.slate, 0.3],
  log:        [[A.LATHE], FAMILY.WOOD, P.bark, 1.05, 'log'],
  slime:      [[A.SLIME], FAMILY.SLIME, P.slime, 0.62],
  blob:       [[A.SLIME], FAMILY.SLIME, P.slime, 0.62],
  goo:        [[A.SLIME], FAMILY.SLIME, P.slime, 0.55],
  bead:       [[A.RING], FAMILY.WOOD, P.walnut, 0.34],
  ring:       [[A.RING], FAMILY.METAL, P.brass, 0.38],
  donut:      [[A.RING], FAMILY.ORGANIC, P.sandstone, 0.42],

  /* ── produce ──────────────────────────────────────────────── */
  apple:      [[A.SPHEROID], FAMILY.ORGANIC, P.apple, 0.44, 'apple'],
  pear:       [[A.LATHE], FAMILY.ORGANIC, P.green, 0.42, 'pear'],
  orange:     [[A.SPHEROID], FAMILY.CITRUS, P.citrus, 0.4],
  lemon:      [[A.LATHE], FAMILY.CITRUS, P.citrus, 0.34, 'lemon'],
  melon:      [[A.SPHEROID], FAMILY.ORGANIC, P.melon, 0.7],
  watermelon: [[A.SPHEROID], FAMILY.ORGANIC, P.melon, 0.85],
  pumpkin:    [[A.LOBED], FAMILY.ORGANIC, P.citrus, 0.75],
  tomato:     [[A.LOBED], FAMILY.ORGANIC, P.apple, 0.34],
  onion:      [[A.LATHE], FAMILY.ORGANIC, P.cream, 0.36, 'onion'],
  potato:     [[A.SPHEROID], FAMILY.ORGANIC, P.sandstone, 0.38],
  bread:      [[A.SPHEROID], FAMILY.ORGANIC, P.sandstone, 0.6],
  cake:       [[A.LATHE], FAMILY.ORGANIC, P.cream, 0.7, 'cake'],
  plum:       [[A.SPHEROID], FAMILY.ORGANIC, P.plum, 0.3],
};

/* Adjectives change material and palette, never the silhouette. */
const MODIFIERS = {
  oak:        { family: FAMILY.WOOD, palette: P.oak },
  wooden:     { family: FAMILY.WOOD, palette: P.oak },
  wood:       { family: FAMILY.WOOD, palette: P.oak },
  walnut:     { family: FAMILY.WOOD, palette: P.walnut },
  pine:       { family: FAMILY.WOOD, palette: P.pine },
  ash:        { family: FAMILY.WOOD, palette: P.ash },
  cherry:     { family: FAMILY.WOOD, palette: P.cherrywood },

  clay:       { family: FAMILY.CERAMIC, palette: P.clay },
  terracotta: { family: FAMILY.CERAMIC, palette: P.terracotta },
  ceramic:    { family: FAMILY.CERAMIC, palette: P.stoneware },
  porcelain:  { family: FAMILY.CERAMIC, palette: P.porcelain },
  stoneware:  { family: FAMILY.CERAMIC, palette: P.stoneware },

  marble:     { family: FAMILY.STONE, palette: P.marble },
  stone:      { family: FAMILY.STONE, palette: P.granite },
  granite:    { family: FAMILY.STONE, palette: P.granite },
  slate:      { family: FAMILY.STONE, palette: P.slate },
  sandstone:  { family: FAMILY.STONE, palette: P.sandstone },

  brass:      { family: FAMILY.METAL, palette: P.brass },
  copper:     { family: FAMILY.METAL, palette: P.copper },
  steel:      { family: FAMILY.METAL, palette: P.steel },
  iron:       { family: FAMILY.METAL, palette: P.iron },
  metal:      { family: FAMILY.METAL, palette: P.steel },

  glass:      { family: FAMILY.GLASS, palette: P.glass },
  ice:        { family: FAMILY.ICE, palette: P.ice },
  wax:        { family: FAMILY.CERAMIC, palette: P.wax },
  paper:      { family: FAMILY.CERAMIC, palette: P.paper },

  sage:       { palette: P.sage },
  cream:      { palette: P.cream },
  linen:      { palette: P.linen },
  rust:       { palette: P.rust },
  ochre:      { palette: P.ochre },
  dusk:       { palette: P.dusk },

  large:      { size: 1.25 },
  big:        { size: 1.25 },
  giant:      { size: 1.4 },
  small:      { size: 0.78 },
  little:     { size: 0.78 },
  tiny:       { size: 0.62 },
  tall:       { size: 1.15, stretch: 1.3 },
  short:      { size: 0.9, stretch: 0.75 },
};

function singularise(w) {
  if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// An unknown word still has to produce something that looks made, so it draws
// from the plain shapes only.
const ALL_ARCHETYPES = [A.SPHEROID, A.LOBED, A.LATHE, A.SLAB, A.VESSEL, A.RING, A.ROCK];
const ALL_FAMILIES = [
  FAMILY.WOOD, FAMILY.CERAMIC, FAMILY.STONE, FAMILY.METAL, FAMILY.ORGANIC,
];
const ALL_PALETTES = Object.values(P);

export function interpret(phrase, rng) {
  const cleaned = String(phrase || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').trim();
  const words = cleaned.split(/[\s-]+/).filter(Boolean);

  let head = null;
  const mods = [];

  for (const raw of words) {
    const w = singularise(raw);
    if (ENTRIES[w]) head = ENTRIES[w];
    else if (ENTRIES[raw]) head = ENTRIES[raw];
    if (MODIFIERS[w]) mods.push(MODIFIERS[w]);
    else if (MODIFIERS[raw]) mods.push(MODIFIERS[raw]);
  }

  let archetypes, family, palette, size, profile, known;

  if (head) {
    [archetypes, family, palette, size, profile] = head;
    known = true;
  } else {
    archetypes = [rng.pick(ALL_ARCHETYPES)];
    family = rng.pick(ALL_FAMILIES);
    palette = rng.pick(ALL_PALETTES);
    size = rng.range(0.55, 0.95);
    profile = null;
    known = false;
  }

  let stretch = 1;
  for (const m of mods) {
    if (m.family) family = m.family;
    if (m.palette) palette = m.palette;
    if (m.size) size *= m.size;
    if (m.stretch) stretch *= m.stretch;
  }

  return {
    archetype: rng.pick(archetypes),
    family, palette, size, stretch, profile, known,
    label: cleaned || 'thing',
  };
}

/**
 * The starting set.
 *
 * Ten objects, chosen so that every material family and every construction is
 * represented and each one gives you something different when it opens: end
 * grain, a hollow wall, flesh and skin, aggregate stone, glass.
 */
export const ASSETS = [
  { id: 'brick',  phrase: 'brick',       label: 'Brick',  note: 'fired clay · solid' },
  { id: 'log',    phrase: 'log',         label: 'Log',    note: 'bark out · rings in' },
  { id: 'bottle', phrase: 'bottle',      label: 'Bottle', note: 'green glass · hollow' },
  { id: 'vase',   phrase: 'vase',        label: 'Vase',   note: 'stoneware · thin wall' },
  { id: 'slime',  phrase: 'slime',       label: 'Slime',  note: 'soft · translucent' },
];

/** Kept for the test suites, which still exercise the wider vocabulary. */
export const PRESETS = ASSETS.map((a) => a.phrase);

export { P as PALETTES };
