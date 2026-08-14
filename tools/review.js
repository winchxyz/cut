/**
 * Dev-only visual review harness.
 *
 * Renders an object from four angles into a single contact sheet and posts it
 * to the capture endpoint, so every archetype can actually be looked at from
 * more than one side instead of assumed correct. Reachable from the console as
 * `__CUT__.review(...)` in dev builds.
 */
export function makeReviewer({ engine, studio }) {
  const shoot = async (name, canvasEl) => {
    const data = canvasEl.toDataURL('image/jpeg', 0.9);
    const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
    return (await r.json()).file;
  };

  const step = (n, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) { studio.update(dt); engine.update(dt); engine.render(); }
  };

  /** Snap the camera to an exact orbit, bypassing the easing. */
  const setView = (yaw, pitch, distScale = 1) => {
    engine.orbitGoal.yaw = yaw;
    engine.orbitGoal.pitch = pitch;
    engine.orbitGoal.distance = engine.orbit.distance * distScale;
    for (let i = 0; i < 40; i++) engine.update(1 / 60);
    engine.render();
  };

  /**
   * @param {string} phrase
   * @param {object} opts {name, cell, angles, settle, cuts}
   */
  async function review(phrase, opts = {}) {
    const cell = opts.cell ?? 520;
    const angles = opts.angles ?? [0.42, 1.9, 3.35, 5.0];
    const pitches = opts.pitches ?? [0.30, 0.30, 0.30, 0.75];

    if (!opts._skipPlace) {
      studio.place(phrase);
      step(opts.settle ?? 100);
    }

    const src = document.getElementById('stage');
    const sheet = document.createElement('canvas');
    sheet.width = cell * 2;
    sheet.height = cell * 2;
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#2a2622';
    ctx.fillRect(0, 0, sheet.width, sheet.height);

    for (let i = 0; i < 4; i++) {
      setView(angles[i], pitches[i]);
      engine.render();
      const sx = (i % 2) * cell, sy = Math.floor(i / 2) * cell;
      // centre-crop the widescreen frame into a square cell
      const side = Math.min(src.width, src.height);
      ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side,
                    sx, sy, cell, cell);
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.strokeRect(sx + 0.5, sy + 0.5, cell - 1, cell - 1);
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.font = '13px monospace';
      ctx.fillText(`yaw ${angles[i].toFixed(2)} pitch ${pitches[i].toFixed(2)}`, sx + 8, sy + 18);
    }

    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(phrase, 8, sheet.height - 10);

    return shoot(opts.name ?? phrase.replace(/\s+/g, '-'), sheet);
  }

  /**
   * The same contact sheet, but of an object that has been cut apart.
   *
   * A whole object looking right says nothing about what a cut exposes, and the
   * cut face is the one surface nobody sees while building. The pieces are
   * tumbled first so the sheet shows the fresh faces rather than four views of
   * the same intact outside — a piece resting cut-side-down hides exactly the
   * thing that needs checking.
   *
   * @param {string} phrase
   * @param {object} [opts] {cuts, name, settle, tumble}
   */
  async function reviewCut(phrase, opts = {}) {
    const W = window.innerWidth, H = window.innerHeight;
    studio.place(phrase);
    step(opts.settle ?? 60);

    const cuts = opts.cuts ?? 2;
    for (let k = 0; k < cuts; k++) {
      const ang = 0.35 + k * 1.15;
      const path = [];
      for (let i = 0; i <= 20; i++) {
        const t = (i / 20 - 0.5) * 780;
        path.push({
          x: W / 2 + Math.cos(ang) * t + Math.sin(i / 20 * 3.1) * 26,
          y: H / 2 + Math.sin(ang) * t + Math.cos(i / 20 * 2.6) * 22,
        });
      }
      studio.blade.strokeId++;
      studio.cutAlongStroke(path);
      step(6);
    }

    // Let it actually come to rest. A shorter wait photographs pieces still in
    // flight, which then get read as fragments hanging in mid-air.
    if (opts.tumble !== false) { studio.nudge(); step(opts.settle ?? 900); }
    step(120);

    return review.call(null, phrase, {
      ...opts,
      name: opts.name ?? `cut-${phrase.replace(/\s+/g, '-')}`,
      _skipPlace: true,
    });
  }

  return { review, reviewCut, setView, step, shoot };
}
