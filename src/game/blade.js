import * as THREE from 'three';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  THE BLADE
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Hold the button and the edge draws. Let go and it cuts, along the
 *  exact path your hand took, seen from where the camera is.
 *
 *  The cut happens on release rather than during the drag: a stroke is
 *  only finished when you finish it, and cutting as it grows carves an
 *  object into a slice per mouse-move.
 *
 *  The edge is exactly as long as what you drew — see `signAt` in
 *  cutter.js. That is what lets you take one leg off a chair rather than
 *  everything standing in that direction.
 *
 *  There is no speed threshold: a slow, deliberate stroke cuts exactly
 *  like a fast one.
 */

/** Cap on stroke samples, so a long slow drag stays cheap to evaluate. */
const MAX_STROKE = 160;

export class Blade {
  constructor(engine) {
    this.engine = engine;
    this.camera = engine.camera;

    this.active = false;
    this.start = { x: 0, y: 0 };
    this.current = { x: 0, y: 0 };
    /** The whole current stroke — what actually cuts. */
    this.stroke = [];
    /** Increments per press, so one pass cuts a given object only once. */
    this.strokeId = 0;

    this._buildGuide();
  }

  /* ── stroke ────────────────────────────────────────────────────── */

  begin(x, y) {
    this.active = true;
    this.strokeId++;
    this.stroke = [{ x, y }];
    this.current.x = x; this.current.y = y;
    this.guide.visible = false;
  }

  move(x, y) {
    if (!this.active) return;

    const last = this.stroke[this.stroke.length - 1];
    const dx = x - last.x, dy = y - last.y;
    const d2 = dx * dx + dy * dy;
    this.current.x = x; this.current.y = y;
    if (d2 < 4) return;                       // ignore sub-2px jitter

    const p = { x, y };
    this.stroke.push(p);

    if (this.stroke.length > MAX_STROKE) this.stroke.shift();
    this._updateGuide();
  }

  /**
   * The whole stroke, handed over when the button comes up.
   *
   * The cut lands on release, not during the drag. Cutting mid-stroke means
   * severing an object the moment the blade is merely *aimed* at it — the cut
   * surface reaches past both ends of whatever has been drawn so far, so a
   * stroke still a hundred pixels short of a chair would already have gone
   * through it. Holding the button draws the edge; letting go drives it.
   */
  end() {
    this.guide.visible = false;
    if (!this.active) return null;
    this.active = false;
    if (this.stroke.length < 2) return null;

    let len = 0;
    for (let i = 1; i < this.stroke.length; i++) {
      len += Math.hypot(this.stroke[i].x - this.stroke[i - 1].x,
                        this.stroke[i].y - this.stroke[i - 1].y);
    }
    if (len < 6) return null;                 // a click, not a stroke

    return this.stroke.map((p) => ({ x: p.x, y: p.y }));
  }

  cancel() {
    this.active = false;
    this.stroke = [];
    this.guide.visible = false;
  }

  /* ── the plane ─────────────────────────────────────────────────── */

  /**
   * Could the blade have reached this object at all?
   *
   * Only a cheap rejection, so the slicer is not run against every fragment on
   * the bench for every stroke. Whether the object is genuinely severed is
   * settled by the cut itself: the blade's surface is bounded by the ends of
   * the stroke, and a split that produces no cut ring is thrown away.
   *
   * It used to demand that the stroke start and finish outside this circle,
   * back when the cutting surface was infinite and that was the only thing
   * stopping the blade severing whatever happened to lie along its direction.
   * The circle is the whole object's, though, so a stroke aimed at one chair
   * leg begins and ends well inside it — which is exactly why a single leg
   * could not be cut.
   */
  pathHit(path, worldPos, radius) {
    const c = _v3.copy(worldPos).project(this.camera);
    if (c.z > 1) return null;

    const w = window.innerWidth, h = window.innerHeight;
    const cx = (c.x * 0.5 + 0.5) * w;
    const cy = (-c.y * 0.5 + 0.5) * h;

    _camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    _v4.copy(worldPos).addScaledVector(_camRight, radius).project(this.camera);
    const rx = (_v4.x * 0.5 + 0.5) * w;
    const ry = (-_v4.y * 0.5 + 0.5) * h;
    const screenRadius = Math.hypot(rx - cx, ry - cy);
    if (screenRadius < 0.5) return null;

    let best = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const d = pointSegmentDistance(cx, cy, path[i].x, path[i].y, path[i + 1].x, path[i + 1].y);
      if (d < best) best = d;
    }
    if (best > screenRadius) return null;

    return { distance: best, through: 1 - best / screenRadius };
  }

  /* ── guide ─────────────────────────────────────────────────────── */

  _buildGuide() {
    // a ribbon with room for a long stroke, rewritten each frame
    const max = 512;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(max * 2 * 2), 2));
    const idx = [];
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    this._guideMax = max;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        void main(){
          // bright edge, fading along its length: the wake of a blade
          float across = abs(vUv.y - 0.5) * 2.0;
          float core = pow(1.0 - across, 5.0);
          float along = pow(vUv.x, 1.6);
          vec3 col = mix(vec3(0.85, 0.86, 0.88), vec3(1.0, 0.99, 0.96), core);
          gl_FragColor = vec4(col, (core * 0.8 + (1.0 - across) * 0.14) * along);
        }
      `,
    });

    this.guide = new THREE.Mesh(geo, mat);
    this.guide.frustumCulled = false;
    this.guide.renderOrder = 900;
    this.guide.visible = false;
    this.engine.scene.add(this.guide);
  }

  /** The edge as drawn so far — this is exactly what will be cut on release. */
  _updateGuide() {
    const pts = this.stroke;
    if (pts.length < 2) { this.guide.visible = false; return; }
    const count = Math.min(pts.length, this._guideMax);
    const pos = this.guide.geometry.attributes.position;
    const uv = this.guide.geometry.attributes.uv;
    const arr = pos.array, uarr = uv.array;
    const halfPx = 1.8;
    const depth = 1.2;

    for (let i = 0; i < count; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let nx = -(next.y - prev.y), ny = next.x - prev.x;
      const l = Math.hypot(nx, ny) || 1;
      // taper toward the tail so it reads as a wake
      const w = halfPx * (0.25 + 0.75 * (i / (count - 1)));
      nx = (nx / l) * w; ny = (ny / l) * w;

      this._toWorld(pts[i].x + nx, pts[i].y + ny, depth, _v1);
      arr[i * 6] = _v1.x; arr[i * 6 + 1] = _v1.y; arr[i * 6 + 2] = _v1.z;
      this._toWorld(pts[i].x - nx, pts[i].y - ny, depth, _v1);
      arr[i * 6 + 3] = _v1.x; arr[i * 6 + 4] = _v1.y; arr[i * 6 + 5] = _v1.z;

      const t = i / (count - 1);
      uarr[i * 4] = t; uarr[i * 4 + 1] = 0;
      uarr[i * 4 + 2] = t; uarr[i * 4 + 3] = 1;
    }

    pos.needsUpdate = true;
    uv.needsUpdate = true;
    this.guide.geometry.setDrawRange(0, (count - 1) * 6);
    this.guide.geometry.computeBoundingSphere();
    this.guide.visible = true;
  }

  _toWorld(x, y, depth, out) {
    const w = window.innerWidth, h = window.innerHeight;
    out.set((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5).unproject(this.camera);
    out.sub(this.camera.position).normalize().multiplyScalar(depth).add(this.camera.position);
    return out;
  }

  dispose() {
    this.guide.geometry.dispose();
    this.guide.material.dispose();
    this.engine.scene.remove(this.guide);
  }
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _camRight = new THREE.Vector3();
