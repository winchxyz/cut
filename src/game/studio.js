import * as THREE from 'three';
import { forge } from './forge.js';
import { Entity, MaterialLedger } from './entity.js';
import { World } from './physics.js';
import { Blade } from './blade.js';
import { FreehandCutter } from './cutter.js';
import { tickMaterials } from './materials.js';

const _spillBox = new THREE.Box3();

/**
 * ══════════════════════════════════════════════════════════════════════
 *  THE STUDIO
 * ══════════════════════════════════════════════════════════════════════
 *
 *  A table, an object on it, and a knife. Name a thing, it gets built and
 *  set down in front of you; drag across it and it comes apart along
 *  exactly the line you drew. The pieces fall, tumble and settle, and
 *  every one of them can be cut again.
 *
 *  There is no score, no timer and nothing to lose.
 */

export const TABLE_Y = 0;

const PHYSICS_HZ = 120;
const MAX_SUBSTEPS = 6;

/** Upper bound on fragments on the bench, for frame time. */
const MAX_PIECES = 220;

export class Studio {
  constructor({ engine, scene3d, ui }) {
    this.engine = engine;
    this.scene3d = scene3d;
    this.ui = ui;

    this.blade = new Blade(engine);
    this.world = new World(TABLE_Y);
    this.ledger = new MaterialLedger();

    /** @type {Entity[]} */
    this.entities = [];

    this.current = null;       // the phrase currently on the table
    this.cutting = true;       // false while the camera is being orbited
    this.elapsed = 0;
    this._accum = 0;
    this._busy = false;

    this.stats = { cuts: 0, pieces: 0 };
  }

  /* ── objects ───────────────────────────────────────────────────── */

  /**
   * Build `phrase` and set it on the table, replacing whatever is there.
   * @param {string} phrase
   * @param {object} [opts] {variant, keep}
   */
  place(phrase, opts = {}) {
    if (this._busy) return null;
    this._busy = true;
    try {
      if (!opts.keep) this.clear();

      const forged = forge(phrase, {
        highDetail: this.engine.q.highDetail,
        variant: opts.variant,
      });

      const e = new Entity(forged, {});
      // Set down on the bench with its lowest point exactly on the surface and
      // no velocity, so a stable object simply stands. Everything is live from
      // the first frame — an object that could not balance falls over, because
      // nothing here is holding it up.
      e.placeOn(TABLE_Y, opts.x ?? 0, opts.z ?? 0);

      e.addTo(this.scene3d.group, this.world);
      this.entities.push(e);
      this.ledger.retain(e.materials);

      this.current = phrase;
      this.currentLabel = opts.label ?? this.currentLabel ?? forged.meta.label;
      this.stats = { cuts: 0, pieces: 1 };

      this.ui?.onPlaced({ ...forged.meta, label: this.currentLabel });
      this.scene3d.frameObject(forged.meta);
      return e;
    } finally {
      this._busy = false;
    }
  }

  /** Re-roll the same phrase into a different object of the same kind. */
  reroll() {
    if (!this.current) return;
    this.place(this.current, { variant: 1 + ((Math.random() * 99999) | 0) });
  }

  /** Put the current phrase back, uncut. */
  restore() {
    if (this.current) this.place(this.current);
  }

  clear() {
    for (const e of this.entities) {
      e.dispose(this.scene3d.group, this.world);
      this.ledger.release(e.materials);
    }
    this.entities.length = 0;
    this.world.clear();
    this.stats = { cuts: 0, pieces: 0 };
  }

  /** Shove everything so it tumbles — useful for seeing all the cut faces. */
  nudge() {
    for (const e of this.entities) {
      e.body.frozen = false;
      e.body.wake();
      e.body.velocity.set((Math.random() - 0.5) * 1.6, 1.7 + Math.random(), (Math.random() - 0.5) * 1.6);
      e.body.angular.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5);
    }
  }

  /* ── cutting ───────────────────────────────────────────────────── */

  /** Cut everything the given stretch of blade travel passed through. */
  cutAlongStroke(path) {
    if (!path || path.length < 2) return;
    // Continuous cutting can multiply pieces quickly; past this the bench is
    // already sawdust and more fragments only cost frames.
    if (this.entities.length >= MAX_PIECES) return;

    // The cut follows the surface swept by the drawn path through the camera,
    // so a curved stroke makes a curved cut.
    const cutter = new FreehandCutter(
      this.engine.camera, path, window.innerWidth, window.innerHeight);
    if (!cutter.valid) return;

    // One pass of the blade parts a given piece once. Without this the edge
    // re-cuts its own fragments every few pixels as it advances, and a single
    // sweep through one stone leaves ninety slivers.
    const stroke = this.blade.strokeId;

    const targets = [];
    for (const e of this.entities) {
      if (!e.sliceable || e.cutByStroke === stroke) continue;
      if (this.blade.pathHit(path, e.position, e.radius)) targets.push(e);
    }
    if (targets.length === 0) return;

    const spawned = [];
    for (const e of targets) {
      const cut = e.slice(cutter);
      if (!cut) continue;
      spawned.push(...cut.pieces);
      this.stats.cuts++;
    }

    if (spawned.length) {
      for (const p of spawned) {
        p.cutByStroke = stroke;
        p.addTo(this.scene3d.group, this.world);
        this.entities.push(p);
        this.ledger.retain(p.materials);
      }

      // Wake everything on the bench. A sleeping body has no idea the thing it
      // was resting on has just been cut out from under it, and would hang in
      // mid-air until something else disturbed it.
      for (const e of this.entities) e.body.wake();

      this.stats.pieces = this.entities.filter((e) => e.alive).length;
      this.ui?.onCut(this.stats);
    }
  }

  /* ── frame ─────────────────────────────────────────────────────── */

  update(dt) {
    this.elapsed += dt;


    // Skip the solver entirely while everything is standing still. In normal
    // use every piece is frozen, so carving an object into fifty parts costs
    // nothing per frame beyond drawing them.
    let moving = false;
    for (const e of this.entities) {
      if (!e.body.frozen && !e.body.sleeping) { moving = true; break; }
    }

    if (moving) {
      // fixed-step physics, so behaviour does not change with frame rate
      this._accum += Math.min(dt, 0.1);
      const h = 1 / PHYSICS_HZ;
      let steps = 0;
      while (this._accum >= h && steps < MAX_SUBSTEPS) {
        this.world.step(h);
        this._accum -= h;
        steps++;
      }
      if (steps === MAX_SUBSTEPS) this._accum = 0;

      for (const e of this.entities) e.syncMesh();
    } else {
      this._accum = 0;
    }

    // retire anything that fell off the bench, or that the solver lost
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (e.sliced || e.body.broken) { this._remove(i); continue; }
      if (e.body.position.y < TABLE_Y - 14 || Math.abs(e.body.position.x) > 30) this._remove(i);
    }

    tickMaterials(this.elapsed);
  }

  _remove(i) {
    const e = this.entities[i];
    e.dispose(this.scene3d.group, this.world);
    this.ledger.release(e.materials);
    this.entities.splice(i, 1);
  }

  dispose() {
    this.clear();
    this.blade.dispose();
  }
}
