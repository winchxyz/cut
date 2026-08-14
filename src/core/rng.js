/**
 * Deterministic randomness.
 *
 * Everything the Forge builds is derived from a string seed, so the same word
 * always produces the same object — "obsidian skull" is a specific object, not
 * a random one. That property only holds if the RNG is fully deterministic and
 * never touches Math.random().
 */

/** FNV-1a — string to 32-bit unsigned hash. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 — small, fast, statistically decent for content generation. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small ergonomic wrapper — the shape every generator in the game consumes. */
export class Rng {
  constructor(seed) {
    this.seed = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
    this._next = mulberry32(this.seed);
  }

  /** [0,1) */
  next() { return this._next(); }

  /** [min,max) */
  range(min, max) { return min + this._next() * (max - min); }

  /** integer in [min,max] inclusive */
  int(min, max) { return Math.floor(min + this._next() * (max - min + 1)); }

  /** symmetric ±amount */
  spread(amount = 1) { return (this._next() * 2 - 1) * amount; }

  bool(chanceTrue = 0.5) { return this._next() < chanceTrue; }

  pick(arr) { return arr[Math.floor(this._next() * arr.length) % arr.length]; }

  /** Weighted pick. `weights[i]` corresponds to `arr[i]`. */
  weighted(arr, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this._next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /** Fisher-Yates, in place. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Approximately normal via the sum of four uniforms (Irwin–Hall). */
  gaussian(mean = 0, sd = 1) {
    const s = this._next() + this._next() + this._next() + this._next();
    return mean + (s - 2) * 0.8660254 * sd;
  }

  /** A fresh independent stream — lets one generator branch without coupling. */
  fork(salt = 0) {
    return new Rng((this.seed ^ Math.imul(salt + 1, 0x9e3779b9) ^ (this._next() * 0xffffffff)) >>> 0);
  }
}

/** Ungovernable randomness for pure presentation (sparks, jitter) — cheap path. */
export const rand = Math.random;
export const randRange = (a, b) => a + Math.random() * (b - a);
export const randSpread = (a = 1) => (Math.random() * 2 - 1) * a;
export const pickOne = (arr) => arr[(Math.random() * arr.length) | 0];
