import * as THREE from 'three';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  THE ROOM
 * ══════════════════════════════════════════════════════════════════════
 *
 *  A quiet daylit workshop: a wooden bench, a soft paper backdrop, warm
 *  light from a window on the left and a cool bounce filling the shadows.
 *
 *  There are no textures or HDR files here, so the reflections in a brass
 *  lamp or a glazed mug have to come from somewhere real. `_bakeProbe`
 *  renders a handful of emissive cards — the window, the ceiling, the
 *  bounce off the bench — into a cube target and runs PMREM over it. The
 *  highlights you see are those cards.
 */

const BACKDROP_VERT = /* glsl */`
varying vec3 vPos;
void main(){
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** A seamless studio sweep: warm near the light, cooler and darker away. */
const BACKDROP_FRAG = /* glsl */`
uniform vec3 uTop, uMid, uBottom, uWarm;
varying vec3 vPos;

void main(){
  vec3 d = normalize(vPos);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);

  vec3 col = mix(uBottom, uMid, smoothstep(0.0, 0.52, h));
  col = mix(col, uTop, smoothstep(0.48, 1.0, h));

  // gentle warmth spilling in from the window side
  float warm = smoothstep(0.1, 1.0, -d.x * 0.6 + 0.4) * smoothstep(-0.4, 0.6, d.y);
  col = mix(col, uWarm, warm * 0.22);

  // a soft falloff into the corners so the sweep never reads as a flat wall
  float corner = smoothstep(1.0, 0.15, length(d.xz));
  col *= 0.94 + 0.06 * corner;

  gl_FragColor = vec4(col, 1.0);
}
`;

export class Scene3D {
  constructor(engine) {
    this.engine = engine;
    this.scene = engine.scene;

    /** Everything the player creates lives in here. */
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this._buildBackdrop();
    this._buildBench();
    this._buildLights();
    this._bakeProbe();
    this._buildMotes();
  }

  _buildBackdrop() {
    const geo = new THREE.SphereGeometry(40, 32, 20);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop:    { value: new THREE.Color(0xcfc8bb) },
        uMid:    { value: new THREE.Color(0xa89f90) },
        uBottom: { value: new THREE.Color(0x5f574c) },
        uWarm:   { value: new THREE.Color(0xe8d6b6) },
      },
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
    });
    this.backdrop = new THREE.Mesh(geo, mat);
    this.backdrop.frustumCulled = false;
    this.scene.add(this.backdrop);
  }

  _buildBench() {
    // A worktop, not a floor. Small enough that its edges stay in frame at
    // normal framing — without them the surface reads as an infinite plane,
    // and the whole scene stops being a table.
    const W = 3.9, D = 2.7, T = 0.14;

    const top = new THREE.Mesh(new THREE.BoxGeometry(W, T, D, 1, 1, 1), this._benchMaterial());
    top.position.y = -T / 2;
    top.receiveShadow = true;
    top.castShadow = true;
    this.scene.add(top);
    this.bench = top;

    // Apron and legs, mostly out of shot, but they anchor the top in space
    // whenever the camera drops toward the surface.
    const dark = new THREE.MeshPhysicalMaterial({
      color: 0x4a3524,
      roughness: 0.78, metalness: 0, envMapIntensity: 0.5,
    });
    const apron = new THREE.Mesh(new THREE.BoxGeometry(W - 0.3, 0.12, D - 0.3), dark);
    apron.position.y = -T - 0.06;
    this.scene.add(apron);

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.4, 0.16), dark);
        leg.position.set(sx * (W / 2 - 0.22), -1.32, sz * (D / 2 - 0.22));
        this.scene.add(leg);
      }
    }

    // Soft contact darkening under the work area. Shadow maps alone leave
    // objects looking like stickers; this is the ambient occlusion that
    // actually plants them.
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.9, 48),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uStrength: { value: 0.30 } },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */`
          uniform float uStrength;
          varying vec2 vUv;
          void main(){
            float r = length(vUv - 0.5) * 2.0;
            gl_FragColor = vec4(0.16, 0.11, 0.07, pow(1.0 - smoothstep(0.0, 1.0, r), 1.6) * uStrength);
          }`,
      }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.0015;
    this.scene.add(shadow);
  }

  /** Planked oak, darker than anything likely to be placed on it. */
  _benchMaterial() {
    const mat = new THREE.MeshPhysicalMaterial({
      // Deliberately darker than the timber palettes. The bench is a backdrop
      // for whatever sits on it; matched in value, object and surface merge
      // into one field and the silhouette disappears.
      color: 0x6b4d31,
      roughness: 0.66,
      metalness: 0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.62,
      envMapIntensity: 0.7,
    });

    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBenchPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBenchPos = position;');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vBenchPos;
          float bHash(vec2 p){ return fract(sin(dot(p, vec2(41.7, 289.1))) * 43758.5); }
          float bNoise(vec2 p){
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(bHash(i), bHash(i + vec2(1,0)), f.x),
                       mix(bHash(i + vec2(0,1)), bHash(i + vec2(1,1)), f.x), f.y);
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          {
            // planks running the length of the bench
            float plank = vBenchPos.z / 0.46;
            float id = floor(plank);
            float seam = abs(fract(plank) - 0.5);

            // each plank a slightly different board
            float tone = 0.86 + 0.28 * bHash(vec2(id, 3.0));
            vec3 col = diffuseColor.rgb * tone;

            // grain along the plank, stretched hard so it reads as long fibre
            float g = bNoise(vec2(vBenchPos.x * 3.4, id * 17.0 + vBenchPos.z * 26.0));
            float g2 = bNoise(vec2(vBenchPos.x * 22.0, id * 31.0 + vBenchPos.z * 90.0));
            col *= 0.90 + 0.14 * g + 0.06 * g2;

            // the dark line between boards
            col *= mix(0.55, 1.0, smoothstep(0.0, 0.035, seam));
            roughnessFactor = clamp(roughnessFactor + (1.0 - g) * 0.10, 0.3, 1.0);

            diffuseColor.rgb = col;
          }`);
    };
    mat.customProgramCacheKey = () => 'cut-bench';
    return mat;
  }

  _buildLights() {
    // Ambient stays low — with the probe also filling, anything higher washes
    // the whole scene into one flat tone and every material stops reading.
    this.scene.add(new THREE.AmbientLight(0xc8c2b4, 0.18));

    // Key: a window, high and to the left, warm.
    const key = new THREE.DirectionalLight(0xfff0d6, 2.9);
    key.position.set(-6.5, 8.5, 5.0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 26;
    const s = 5.2;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.022;
    key.shadow.radius = 4;
    this.scene.add(key);
    this.keyLight = key;

    // Fill: cool skylight from the opposite side, no shadows.
    const fill = new THREE.DirectionalLight(0xd6e2f0, 0.85);
    fill.position.set(5.5, 4.0, 2.0);
    this.scene.add(fill);

    // Rim: a low warm bounce off the bench, separates objects from the sweep.
    const rim = new THREE.DirectionalLight(0xffd9a8, 0.5);
    rim.position.set(1.5, 1.2, -6.0);
    this.scene.add(rim);
  }

  _bakeProbe() {
    const pmrem = new THREE.PMREMGenerator(this.engine.renderer);
    pmrem.compileEquirectangularShader();

    const probe = new THREE.Scene();
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(30, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x9c968a, side: THREE.BackSide }));
    probe.add(shell);

    const card = (color, intensity, pos, size) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size[0], size[1]),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }));
      m.position.set(...pos);
      m.lookAt(0, 0, 0);
      probe.add(m);
    };

    card(0xfff2de, 5.4, [-16, 10, 12], [16, 20]);  // window
    card(0xf2f5ff, 2.2, [0, 22, 0], [40, 40]);     // ceiling / sky
    card(0xd8c3a0, 1.5, [0, -8, 0], [40, 40]);     // bounce off the bench
    card(0xcfd8e6, 1.1, [18, 5, -6], [18, 18]);    // cool side fill
    card(0x8e8578, 0.9, [0, 2, -22], [40, 24]);    // back wall

    const target = pmrem.fromScene(probe, 0.03);
    this.scene.environment = target.texture;
    this.envMap = target.texture;

    probe.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    pmrem.dispose();
  }

  /** Barely-there dust in the light shaft. Sells scale without drawing attention. */
  _buildMotes() {
    const count = 150;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 9;
      pos[i * 3 + 1] = Math.random() * 4.5 + 0.2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 6;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime;
        varying float vA;
        void main(){
          vec3 p = position;
          p.y += sin(uTime * 0.13 + aSeed * 37.0) * 0.5;
          p.x += cos(uTime * 0.09 + aSeed * 23.0) * 0.4;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // Small and dim. At any real size these stop being motes hanging in
          // a sunbeam and become falling snow across the whole frame.
          gl_PointSize = (0.8 + aSeed * 1.4) / max(-mv.z, 0.1) * 7.0;
          gl_Position = projectionMatrix * mv;
          vA = 0.020 + 0.045 * (0.5 + 0.5 * sin(uTime * 0.5 + aSeed * 51.0));
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(1.0, 0.96, 0.88, smoothstep(0.5, 0.0, d) * vA);
        }`,
    });

    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);
  }

  /** Pull the camera back far enough to see whatever was just placed. */
  frameObject(meta) {
    const h = meta.size?.y ?? 1;
    const w = Math.max(meta.size?.x ?? 1, meta.size?.z ?? 1);
    this.engine.frameSubject(Math.max(h, w), h);
  }

  update(dt, elapsed) {
    if (this.motes) this.motes.material.uniforms.uTime.value = elapsed;
  }

  dispose() { this.envMap?.dispose(); }
}
