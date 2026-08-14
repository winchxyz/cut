import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

/**
 * Renderer, orbit camera, and a deliberately restrained post chain.
 *
 * The only screen-space effects are a mild vignette and a touch of warmth in
 * the highlights. No bloom, no aberration, no grain — the scene is lit, not
 * graded, and anything flashier would fight the material shaders rather than
 * flatter them.
 */

export const QUALITY = {
  low:    { pixelRatio: 1.0,  shadows: true,  shadowMap: 1024, smaa: false, ao: false, highDetail: false },
  medium: { pixelRatio: 1.35, shadows: true,  shadowMap: 2048, smaa: true,  ao: true,  highDetail: false },
  high:   { pixelRatio: 1.75, shadows: true,  shadowMap: 2048, smaa: true,  ao: true,  highDetail: true },
  ultra:  { pixelRatio: 2.0,  shadows: true,  shadowMap: 4096, smaa: true,  ao: true,  highDetail: true },
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.42 },
    uWarmth: { value: 0.05 },
    uLift: { value: 0.012 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uVignette, uWarmth, uLift;
    varying vec2 vUv;
    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      // a whisper of warmth in the highlights, coolness in the shadows —
      // the same thing a photographer would do, and nothing more
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col += vec3(uWarmth, uWarmth * 0.45, -uWarmth * 0.35) * l;
      col += vec3(-uLift * 0.3, 0.0, uLift) * (1.0 - l);

      vec2 c = vUv - 0.5;
      col *= mix(1.0, smoothstep(0.78, 0.12, dot(c, c) * 1.6), uVignette);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Engine {
  constructor(canvas, qualityName = 'high') {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 120);

    /* Orbit state. The camera looks at a point just above the bench and the
       user swings around it; the subject stays put. */
    this.target = new THREE.Vector3(0, 0.55, 0);
    this.orbit = { yaw: 0.42, pitch: 0.30, distance: 5.4 };
    this.orbitGoal = { ...this.orbit };
    this.minPitch = -0.12;
    this.maxPitch = 1.35;
    this.minDistance = 1.6;
    this.maxDistance = 14;

    this._buildComposer();
    this.applyQuality(QUALITY[qualityName] ? qualityName : 'high');
    this.resize();
    this._applyOrbit(1);
  }

  _buildComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Ambient occlusion does more for this scene than any other single effect.
    // Shadow maps put an object's shadow on the bench, but they cannot darken
    // the millimetre-wide crevice where two cut fragments meet — without it a
    // pile of pieces reads as a flat decal rather than a heap of solids.
    this.gtao = new GTAOPass(this.scene, this.camera, w, h);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 1.0;
    this.gtao.updateGtaoMaterial({
      // Objects here are roughly a unit across, so the radius is set to the
      // scale of a joint or the gap between two fragments — wide enough to
      // darken a crevice, narrow enough not to grey out whole surfaces.
      radius: 0.30,
      distanceExponent: 1.0,
      thickness: 0.6,
      scale: 1.6,
      samples: 16,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    this.composer.addPass(this.gtao);

    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
  }

  applyQuality(name) {
    const q = QUALITY[name];
    if (!q) return;
    this.quality = name;
    this.q = q;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    if (this.smaa) this.smaa.enabled = q.smaa;
    if (this.gtao) this.gtao.enabled = q.ao;

    this.scene.traverse((o) => {
      if (o.isDirectionalLight && o.shadow) {
        o.castShadow = q.shadows;
        o.shadow.mapSize.set(q.shadowMap, q.shadowMap);
        o.shadow.map?.dispose();
        o.shadow.map = null;
      }
    });
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.fov = h > w ? 52 : 38;   // wider on a phone held upright
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  /* ── camera ────────────────────────────────────────────────────── */

  orbitBy(dYaw, dPitch) {
    this.orbitGoal.yaw += dYaw;
    this.orbitGoal.pitch = THREE.MathUtils.clamp(this.orbitGoal.pitch + dPitch, this.minPitch, this.maxPitch);
  }

  zoomBy(delta) {
    this.orbitGoal.distance = THREE.MathUtils.clamp(
      this.orbitGoal.distance * (1 + delta), this.minDistance, this.maxDistance);
  }

  /** Frame a newly placed subject: pull back to fit, and look at its middle. */
  frameSubject(extent, height) {
    const fitH = (height * 0.5 + 0.35) / Math.tan((this.camera.fov * Math.PI / 180) / 2);
    const fitW = (extent * 0.5 + 0.35) / (Math.tan((this.camera.fov * Math.PI / 180) / 2) * Math.max(this.camera.aspect, 0.6));
    this.orbitGoal.distance = THREE.MathUtils.clamp(Math.max(fitH, fitW) * 1.5, this.minDistance, this.maxDistance);
    this.targetGoal = new THREE.Vector3(0, Math.max(0.28, height * 0.45), 0);
  }

  _applyOrbit(k = 1) {
    const o = this.orbit, g = this.orbitGoal;
    o.yaw += (g.yaw - o.yaw) * k;
    o.pitch += (g.pitch - o.pitch) * k;
    o.distance += (g.distance - o.distance) * k;

    if (this.targetGoal) this.target.lerp(this.targetGoal, k);

    const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(o.yaw) * cp * o.distance,
      this.target.y + sp * o.distance,
      this.target.z + Math.cos(o.yaw) * cp * o.distance);
    this.camera.lookAt(this.target);
  }

  update(dt) {
    this._applyOrbit(Math.min(1, dt * 7));
  }

  render() { this.composer.render(); }

  dispose() {
    this.composer?.dispose?.();
    this.renderer.dispose();
  }
}
