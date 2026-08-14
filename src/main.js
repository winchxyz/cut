import './styles/ui.css';
import * as THREE from 'three';

import { Engine } from './core/engine.js';
import { Scene3D } from './core/scene3d.js';
import { Studio } from './game/studio.js';
import { UI } from './game/ui.js';
import { forge } from './game/forge.js';
import { ASSETS } from './game/lexicon.js';

/**
 * Boot, input and the frame loop.
 *
 * Input has one rule worth stating: the left button cuts, everything else
 * moves the camera. Mixing the two on one button would mean guessing whether
 * a drag was meant as a stroke or a look-around, and guessing wrong ruins
 * both.
 */

const canvas = document.getElementById('stage');

let engine, scene3d, studio, ui;
let last = performance.now();
let running = false;

const frame = () => new Promise((resolve) => {
  // rAF never fires in a hidden tab, so race it against a timer or startup
  // stalls forever for anyone who opens this in a background tab
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 60);
});

async function boot() {
  ui = new UI({
    onPick: (asset) => studio.place(asset.phrase, { label: asset.label }),
    onReroll: () => studio.reroll(),
    onRestore: () => studio.restore(),
    onNudge: () => studio.nudge(),
  });

  ui.bootProgress('starting renderer');
  await frame();
  engine = new Engine(canvas, 'high');

  ui.bootProgress('lighting the room');
  await frame();
  scene3d = new Scene3D(engine);

  ui.bootProgress('warming shaders');
  await frame();
  await precompile();

  studio = new Studio({ engine, scene3d, ui });

  bindInput();
  window.addEventListener('resize', () => engine.resize());

  await frame();
  ui.bootDone();

  // something on the bench to greet you
  ui.pick(ASSETS[0].id);

  if (import.meta.env.DEV) {
    window.__CUT__ = { engine, scene3d, studio, THREE };
    const { makeReviewer } = await import('../tools/review.js');
    Object.assign(window.__CUT__, makeReviewer({ engine, studio }));
  }

  running = true;
  last = performance.now();
  requestAnimationFrame(tick);
}

/**
 * Draw one of each material family once, off-camera, so their shader programs
 * are built during startup. A program is only compiled the first time
 * something using it is drawn — without this, the first cut into a material
 * you haven't used yet compiles its interior shader mid-stroke.
 */
async function precompile() {
  const probes = [...new Set(ASSETS.map((a) => a.phrase))];
  const holder = new THREE.Group();
  holder.position.set(0, -500, 0);
  engine.scene.add(holder);

  const made = [];
  for (const p of probes) {
    const f = forge(p, { variant: 1 });
    const g = f.geometry;
    const count = g.attributes.position.count;
    // give it a second group so the interior program is exercised too
    g.clearGroups();
    g.addGroup(0, Math.max(3, count - 3), 0);
    g.addGroup(Math.max(3, count - 3), Math.min(3, count), 1);
    const m = new THREE.Mesh(g, f.materials);
    m.castShadow = true;
    holder.add(m);
    made.push({ mesh: m, mats: f.materials });
  }

  engine.renderer.compile(engine.scene, engine.camera);
  engine.render();
  await frame();

  for (const { mesh, mats } of made) {
    holder.remove(mesh);
    mesh.geometry.dispose();
    for (const mat of mats) mat.dispose();
  }
  engine.scene.remove(holder);
}

/* ── input ─────────────────────────────────────────────────────────── */

function bindInput() {
  let lastMove = performance.now();
  let mode = null;              // 'cut' | 'orbit'
  let ox = 0, oy = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Capture keeps a fast stroke from escaping the canvas mid-drag. It throws
  // for pointer ids the browser is not actually tracking, which must not take
  // the whole handler down with it.
  const capture = (e, on) => {
    try { on ? canvas.setPointerCapture(e.pointerId) : canvas.releasePointerCapture(e.pointerId); }
    catch { /* not a live pointer */ }
  };

  canvas.addEventListener('pointerdown', (e) => {
    capture(e, true);
    if (e.button === 0 && !e.shiftKey) {
      mode = 'cut';
      studio.blade.begin(e.clientX, e.clientY);
    } else {
      mode = 'orbit';
      ox = e.clientX; oy = e.clientY;
      document.body.classList.add('orbiting');
    }
  });

  const endDrag = (e, commit) => {
    if (mode === 'cut') {
      // One stroke, one cut, made on release along the line actually drawn.
      if (commit) studio.cutAlongStroke(studio.blade.end());
      else studio.blade.cancel();
    }
    mode = null;
    document.body.classList.remove('orbiting');
    if (e) capture(e, false);
  };
  canvas.addEventListener('pointerup', (e) => endDrag(e, true));
  canvas.addEventListener('pointercancel', (e) => endDrag(e, false));
  window.addEventListener('blur', () => endDrag(null, false));

  canvas.addEventListener('pointermove', (e) => {
    if (mode === 'cut') {
      studio.blade.move(e.clientX, e.clientY);
    } else if (mode === 'orbit') {
      engine.orbitBy(-(e.clientX - ox) * 0.006, -(e.clientY - oy) * 0.006);
      ox = e.clientX; oy = e.clientY;
    }
  }, { passive: true });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    engine.zoomBy(Math.sign(e.deltaY) * 0.11);
  }, { passive: false });

  // touch: one finger cuts, two fingers orbit
  let pinch = 0;
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      mode = 'orbit';
      studio.cutting = false;
      ox = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      oy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                         e.touches[0].clientY - e.touches[1].clientY);
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && mode === 'orbit') {
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      engine.orbitBy(-(mx - ox) * 0.006, -(my - oy) * 0.006);
      ox = mx; oy = my;
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                           e.touches[0].clientY - e.touches[1].clientY);
      if (pinch > 0) engine.zoomBy((pinch - d) * 0.004);
      pinch = d;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => { pinch = 0; }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.repeat || ui.typing) return;
    switch (e.key.toLowerCase()) {
      case 'r': studio.reroll(); break;
      case 't': studio.nudge(); break;
      case ' ': e.preventDefault(); studio.restore(); break;
      case 'escape': if (ui.helpOpen) ui.toggleHelp(false); break;
      case '?': case '/': ui.toggleHelp(!ui.helpOpen); break;
    }
  });
}

/* ── loop ──────────────────────────────────────────────────────────── */

function tick(now) {
  requestAnimationFrame(tick);
  if (!running) return;

  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  studio.update(dt);
  scene3d.update(dt, now / 1000);
  engine.update(dt);
  engine.render();
}

boot().catch((err) => {
  console.error(err);
  const m = document.querySelector('#preboot .m');
  if (m) { m.textContent = 'failed to start — see console'; m.style.color = '#b4432f'; }
});
