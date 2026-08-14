import * as THREE from 'three';
import { sliceMesh, MAT_INTERIOR } from './slicer.js';
import { setInteriorRadius, unregisterAnimated } from './materials.js';
import { Body, computeContactPoints } from './physics.js';

/**
 * A thing on the table: a mesh, a rigid body, and the bookkeeping that lets
 * it be cut apart.
 *
 * A cut piece inherits its parent's motion, gains a small shove along the cut
 * normal, and — crucially — starts at exactly the world position its matter
 * occupied a moment ago. The slicer re-centres each half on its own centre of
 * mass and reports where that centre was; re-applying the parent's transform
 * to that point is what stops halves jumping when they separate.
 */

/**
 * How many times one object may be re-cut.
 *
 * Set high on purpose: the point is to be able to chop something down to
 * crumbs. Pieces are static until you drop them, so the only real cost of a
 * deep pile is triangles, and size is what actually stops the process.
 */
export const MAX_SLICE_DEPTH = 24;

/** Below this radius a fragment is chippings — it stops being sliceable. */
const MIN_SLICE_RADIUS = 0.012;

/**
 * How far a container may lean before what it is holding runs out — cos(32°).
 *
 */
const TIP_COS = 0.848;

let _uid = 0;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Entity {
  constructor(forged, opts = {}) {
    this.id = ++_uid;
    this.meta = forged.meta;
    this.materials = forged.materials;
    this.depth = opts.depth ?? 0;

    this.mesh = new THREE.Mesh(forged.geometry, forged.materials);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.entity = this;

    this.radius = this.meta.radius;
    this.volume = this.meta.volume;

    this.body = new Body({
      volume: this.volume,
      radius: this.radius,
      family: this.meta.family,
      // Support points are only needed once a body is actually falling, and
      // they cost a pass over every vertex. Chopping something into fifty
      // static pieces should not pay for fifty of those.
      contactPoints: null,
      contactSource: forged.geometry,
    });

    if (opts.position) this.body.position.copy(opts.position);
    if (opts.quaternion) this.body.quaternion.copy(opts.quaternion);
    if (opts.velocity) this.body.velocity.copy(opts.velocity);
    if (opts.angular) this.body.angular.copy(opts.angular);


    this.alive = true;
    this.sliced = false;
    this.syncMesh();
  }


  get position() { return this.body.position; }

  addTo(scene, world) {
    scene.add(this.mesh);
    world.add(this.body);
    return this;
  }

  syncMesh() {
    this.mesh.position.copy(this.body.position);
    this.mesh.quaternion.copy(this.body.quaternion);
  }

  /** Rest the object on a surface at `y`, centred at (x, z). */
  placeOn(y, x = 0, z = 0) {
    this.body.position.set(x, y + this.meta.baseDrop, z);
    this.body.velocity.set(0, 0, 0);
    this.body.angular.set(0, 0, 0);
    this.syncMesh();
    return this;
  }

  /**
   * Cut with a world-space plane or freehand cutter.
   * @returns {null | {pieces: Entity[], ring: THREE.Vector3[], area: number, centre: THREE.Vector3}}
   */
  slice(cutter) {
    if (!this.sliceable) return null;

    const result = sliceMesh(this.mesh, cutter, {
      capUvScale: this.radius,
      recenter: true,
    });
    if (!result) return null;

    // A split that produced no cut ring is not a cut. It happens when the
    // surface passes cleanly between two disjoint parts of a merged object —
    // a chair's legs and its seat — separating them without touching any
    // geometry. The pieces come away with no cut face at all, which is exactly
    // what "the object is hollow" looks like. Refuse it: the blade has to
    // actually go through something.
    if (!result.loops || result.loops.length === 0 || result.sectionArea <= 0) return null;

    // A half that encloses negative volume is not a piece of the object — it is
    // a piece of the hole in it. Hollow things have two surfaces, and a cut can
    // pass through the cavity of a bottle or a mug without ever crossing the
    // wall: the slicer dutifully separates a patch of the *inner* surface,
    // whose normals face into the cavity, and hands back a sealed fragment that
    // bounds air. It renders as nothing from outside and as a shell from
    // within, and the other half comes away with the cavity filled in as though
    // it were solid. The blade did not part any material here, so nothing is cut.
    if (!(result.above.signedVolume > 0) || !(result.below.signedVolume > 0)) return null;

    this.sliced = true;
    this.alive = false;

    const pieces = [];
    for (const [side, sign] of [[result.above, 1], [result.below, -1]]) {
      pieces.push(this._makePiece(side, sign));
    }

    // Both halves share one material instance, so the interior's radial
    // structure is sized to the larger of them.
    setInteriorRadius(this.materials[MAT_INTERIOR],
      Math.max(pieces[0].radius, pieces[1].radius));

    const ring = [];
    if (result.loops) {
      this.mesh.updateWorldMatrix(true, false);
      for (const loop of result.loops) {
        for (const p of loop) ring.push(p.clone().applyMatrix4(this.mesh.matrixWorld));
      }
    }

    const centre = new THREE.Vector3();
    if (ring.length) {
      for (const p of ring) centre.add(p);
      centre.divideScalar(ring.length);
    } else {
      centre.copy(this.body.position);
    }


    return { pieces, ring, area: result.sectionArea, centre };
  }


  _makePiece(side, sign) {
    this.mesh.updateWorldMatrix(true, false);
    const worldCentre = _v.copy(side.centroid).applyMatrix4(this.mesh.matrixWorld);

    const forged = {
      geometry: side.geometry,
      materials: this.materials,
      meta: { ...this.meta, radius: side.radius, volume: side.volume },
    };

    // No separation impulse and no spin: a saw does not throw what it cuts.
    // Each half starts exactly where its matter already was, carrying only the
    // motion the parent already had. Everything that happens next — a cut-off
    // chair back tipping over, an unsupported half dropping — is gravity
    // acting on the piece's own new centre of mass, not a scripted shove.
    const piece = new Entity(forged, {
      position: worldCentre,
      quaternion: this.body.quaternion,
      velocity: this.body.velocity,
      angular: this.body.angular,
      depth: this.depth + 1,
    });

    void sign;
    return piece;
  }


  get sliceable() {
    return this.alive && !this.sliced && this.depth < MAX_SLICE_DEPTH &&
           this.radius > MIN_SLICE_RADIUS;
  }

  dispose(scene, world) {
    scene.remove(this.mesh);
    world.remove(this.body);
    this.mesh.geometry.dispose();
  }
}

/**
 * Materials are shared by every fragment cut from one object, so they are
 * released only when the last of that lineage is gone.
 */
export class MaterialLedger {
  constructor() { this.counts = new Map(); }

  retain(materials) {
    this.counts.set(materials, (this.counts.get(materials) || 0) + 1);
  }

  release(materials) {
    const n = (this.counts.get(materials) || 0) - 1;
    if (n <= 0) {
      this.counts.delete(materials);
      for (const m of materials) { unregisterAnimated(m); m.dispose(); }
    } else {
      this.counts.set(materials, n);
    }
  }
}
