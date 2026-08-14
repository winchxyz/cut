<div align="center">

# Cut

**A quiet 3D slicing sandbox.** Pick something off the shelf, drag across it,
and it comes apart along the exact path your hand drew.

[![live demo](https://img.shields.io/badge/live-demo-1f6feb?style=flat-square)](https://winchxyz.github.io/cut/)
[![build & deploy](https://img.shields.io/github/actions/workflow/status/winchxyz/cut/deploy.yml?branch=main&style=flat-square&label=build)](https://github.com/winchxyz/cut/actions/workflows/deploy.yml)
[![three.js](https://img.shields.io/badge/three.js-r180-black?style=flat-square)](https://threejs.org)
[![no assets](https://img.shields.io/badge/textures%20%26%20models-none-2ea043?style=flat-square)](#everything-is-generated)

<img src="docs/media/hero.jpg" alt="Five objects on a wooden workbench: a sawn log, a fired brick, a green glass bottle, a stoneware vase and a blob of slime" width="820">

</div>

---

The cut is real geometry, not a texture trick. The mesh is split triangle by triangle,
both halves are sealed with a generated cross-section, and every piece can be cut again —
so a fragment sliced five times still reads as *shell outside, material inside*.

**[▶ Try it](https://winchxyz.github.io/cut/)** — no install, runs in the browser.

## Everything is generated

There is not a single texture, model, or audio file in this repository. Every object is
built from a phrase at load time, every surface is a shader, and the reflections come
from an environment probe baked at startup out of a handful of emissive cards. The whole
thing is about 500 kB gzipped, and nearly all of that is three.js.

| | |
|---|---|
| **Shapes** | lathes, swept tubes and displaced spheres assembled per object — `src/game/forge.js` |
| **Surfaces** | eleven procedural material families, skin and cut-face, driven by uniforms so one program serves a whole family — `src/game/materials.js` |
| **Cutting** | Sutherland–Hodgman clipping, loop stitching, earcut capping — `src/game/slicer.js` |
| **Physics** | sequential-impulse solver with convex hulls, real inertia tensors and sleeping — `src/game/physics.js` |

## The shelf

<table>
<tr>
<td width="20%"><img src="docs/media/whole-brick.jpg" alt="brick"></td>
<td width="20%"><img src="docs/media/whole-log.jpg" alt="log"></td>
<td width="20%"><img src="docs/media/whole-bottle.jpg" alt="bottle"></td>
<td width="20%"><img src="docs/media/whole-vase.jpg" alt="vase"></td>
<td width="20%"><img src="docs/media/whole-slime.jpg" alt="slime"></td>
</tr>
<tr>
<td align="center"><b>Brick</b><br><sub>fired clay, solid</sub></td>
<td align="center"><b>Log</b><br><sub>bark out, rings in</sub></td>
<td align="center"><b>Bottle</b><br><sub>green glass, hollow</sub></td>
<td align="center"><b>Vase</b><br><sub>stoneware, thin wall</sub></td>
<td align="center"><b>Slime</b><br><sub>soft, translucent</sub></td>
</tr>
</table>

Five objects, chosen so each one opens differently: a solid, a fibrous solid with two
completely different surfaces, a thin-walled void, a thicker-walled void, and something
soft and see-through.

<img src="docs/media/cut-face.jpg" alt="Close-up of a sawn log end showing growth rings around the pith" width="820">

> A cut has to *look* like a cut. The log's bark and its sawn end are the furthest apart
> of anything here — 0.45 in brightness out of 1 — and that contrast is most of what says
> "this was opened". When the vase's glaze and its bisque break came out only 0.04 apart,
> it read as though the cut had failed to texture.

## Controls

| | |
|---|---|
| **drag** | cut — one stroke, one cut, along the exact curve you drew |
| **right-drag** or **shift-drag** | orbit |
| **scroll** | zoom |
| <kbd>R</kbd> | another one like it |
| <kbd>Space</kbd> | put it back |
| <kbd>T</kbd> | tumble the pieces, to see the cut faces |

Nothing is thrown and there is no debris. A cut piece starts exactly where its material
already was, carrying only the motion it already had, and then falls under its own
weight. It is also silent.

## Running it

```bash
npm install
npm run dev
```

```bash
npm test     # geometry invariants, every archetype, physics, every cut fragment
npm run bench   # where a cut's milliseconds actually go
npm run build
```

The test suites are pure Node — no browser, no GPU — because the simulation never
touches the DOM. CI runs exactly what runs locally.

## Verified, not assumed

Every asset is cut three generations deep from four camera angles and **every resulting
fragment is inspected**: does it have a cut face, is any of it wound inside-out, is it
missing a face, is its volume positive.

```
  object      pieces   no cut face   back-facing   missing a face
  Brick          56             0             0                0
  Log            56             0             0                0
  Bottle         42             0             0                0
  Vase           56             0             0                0
  Slime          56             0             0                0
```

<details>
<summary><b>The same five, cut five times, from four angles each</b></summary>

<img src="docs/media/deep-log.jpg" alt="log cut five times, four angles" width="49%"> <img src="docs/media/deep-brick.jpg" alt="brick cut five times, four angles" width="49%">
<img src="docs/media/deep-bottle.jpg" alt="bottle cut five times, four angles" width="49%"> <img src="docs/media/deep-vase.jpg" alt="vase cut five times, four angles" width="49%">
<img src="docs/media/deep-slime.jpg" alt="slime cut five times, four angles" width="49%">

</details>

## Tech

| | |
|---|---|
| **Renderer** | [three.js](https://threejs.org) r180 — WebGL2, ACES tonemapping |
| **Post** | GTAO ambient occlusion, SMAA, a restrained vignette/warmth grade |
| **Build** | [Vite](https://vitejs.dev) 7, ES modules, no transpiler |
| **Language** | plain JavaScript — no framework, no state library, no TypeScript step |
| **Shading** | `MeshPhysicalMaterial` extended through `onBeforeCompile`, with `customProgramCacheKey` so a family shares one compiled program |
| **Tests** | Node, no runner — five suites, run in CI on every push |
| **Deploy** | GitHub Actions → GitHub Pages |

---

## What's actually happening

### The slicer

`src/game/slicer.js` is the core. Given a mesh and a plane it:

1. classifies every vertex against the plane
2. clips each straddling triangle into an above- and below-polygon
   (Sutherland–Hodgman), interpolating normal and uv across the new edges
3. stitches the intersection segments into closed loops via a spatial hash
4. works out which loops are holes inside which — a sliced tube is an annulus,
   not two disks
5. triangulates each contour and its holes in the plane's 2D basis and emits it
   into both halves with opposing winding
6. recomputes signed volume and centre of mass, and moves each half's origin onto
   its new centroid

Material indices survive the cut, so skin stays skin and every new cap face is
tagged as interior. **A cut face is never transmissive**, whatever the
outside of the object does. Three renders a transmissive surface by refracting a render
target holding only the *opaque* scene, so a see-through cut face shows the backdrop
instead of itself: flat, evenly lit, no reflection — indistinguishable from untextured
card, which is exactly what a cut bottle and a cut blob of slime looked like. It is also
wrong on its own terms; broken glass is frosted where it fractured. The moment you open
something you are looking at material, so the interior is opaque and cannot be
configured otherwise.

A cut face also has to differ from the outside in **value**, not only in finish. The vase
was glazed cream outside and bisque inside — correct materially, and 0.04 apart in
brightness out of 1, so the only thing distinguishing a fresh break from an original
surface was gloss. Against 0.39 for the brick and 0.45 for the log it was the outlier,
and it read as though the cut had not textured. Its break is buff now.

Together these are what let a twice-cut fragment still read as *shell outside, material
inside*.

A few details in there are load-bearing and were found the hard way:

- **Intersections are computed direction-independently.** Two triangles sharing an
  edge walk it in opposite directions; computing "from whichever end came first"
  gives results equal in real arithmetic but different in the last bits of floating
  point. That disagreement is a T-junction, and the surface springs a leak.
- **Tolerances scale with the object.** A fragment cut five times is a fraction of
  the original's size, and a fixed epsilon that was tight at full size starts
  merging distinct points.
- **Thin slivers are kept; needles are dropped.** Earcut legitimately emits
  near-collinear ears where a section is locally flat. Discarding those for being
  small punches holes straight through the cap. Triangles with a genuinely repeated
  vertex are the only safe thing to remove.
- **A plane landing exactly on an existing vertex ring is still a cut.** Slicing a
  sphere on its equator makes no triangle straddle anything, so the naive
  implementation both rejects the cut and forgets to cap it.

### The blade

Hold the button and the edge draws; let go and it cuts, along the exact path your hand
took. The cut is **not** a plane between press and release — it is the surface swept by
that path, seen from the camera. Draw an S and you get an S-shaped section.

Two rules keep it honest, and both exist because breaking them looked badly wrong:

- **The cut lands on release, not during the drag.** A stroke is only finished when
  you finish it, and cutting as it grows carves an object into one slice per
  mouse-move.
- **The edge is exactly as long as what you drew.** The obvious implementation — the
  signed distance to the drawn polyline — defines an *infinite* surface, one that
  reaches out past both ends of the stroke and severs everything standing in that
  direction. That is also why a chair could only ever be cut in half: any stroke short
  enough to hit one leg took the seat with it. Past the ends the blade is simply not
  there, so those points are forced to the uncut side, and `max` of the two conditions
  gives an edge with a beginning and an end. Draw a short line across one chair leg
  and the foot comes off; the rest of the chair keeps standing, 99.76% intact.

Two splits are refused outright:

- **No cut ring.** The surface passed cleanly between two disjoint parts of a merged
  object — a chair's legs and its seat — separating them without intersecting any
  geometry. The pieces come away with **no cut face**, which is exactly what "the
  object is hollow" looks like: material on one side of the break and nothing on the
  other. Before this guard, 72 of 80 pieces produced by cutting the shelf had no
  cut face.
- **A half that encloses negative volume.** Hollow things have two surfaces, and a cut
  can pass through the cavity of a bottle without ever crossing the wall. The slicer
  dutifully separates a patch of the *inner* surface — whose normals face into the
  cavity — and hands back a sealed fragment that bounds air rather than matter, while
  the other half comes away with the cavity filled in as though it were solid. Signed
  volume catches it in one comparison, but only if the sign is kept: `volumeAndCentroid`
  used to return a magnitude, which is what mass wants and which let an inside-out
  piece pass every check there was.

`FreehandCutter` works in screen space: a point is projected, the nearest segment of
the drawn polyline is found, and the signed distance to it says which side the point
lies on. The zero set of that function is exactly the ruled surface through the eye
and the stroke. Edge crossings have no closed form (the function is piecewise across
segments and non-linear under perspective) so they are found by bisection.

Three details make it hold together. The cut section is no longer planar, so its
frame is fitted to the ring by Newell's method — and that frame's **sign has to be
resolved by sampling the field**, because Newell follows the ring's winding and the
loop stitcher walks it in whichever direction it happens to. Left alone, roughly half
of all freehand cuts came out with both cut faces wound inside-out: the new surface
was back-facing and culled, so a piece showed a face on one side of the cut and
nothing on the other, and every object read as a hollow shell. The section is
triangulated in that fitted plane, falling back to the cutter's own parameterisation —
how far along the stroke a point lies against how far from the camera it is — whenever
flattening makes the contour cross itself, which is what a sharply folded cut does to
it. The fallback exists because now that the blade has ends, the cut surface is the
swept ribbon *plus a face at each end*, and the ribbon's own coordinates go degenerate
on those: every point of an end face has the same position along the stroke. And the
stroke is smoothed before use, because at a sharp corner an entire wedge of space
shares one nearest point and the parameterisation stops being one-to-one.

Deciding cap orientation per triangle by probing the field — stepping off the surface
along each triangle's own normal to see which way the field rises — is a tempting
refinement and was tried. On the caps that matter it agrees with the fitted frame
anyway, and on a needle triangle, whose normal is near-perpendicular to the section,
both probes land on the same side and the comparison is noise. It flipped slivers the
fitted frame got right.

There is no speed threshold; a slow, deliberate stroke cuts exactly like a fast one.

### The forge

`src/game/forge.js` builds an object from a phrase. Nothing is a loaded model —
`chair` assembles a seat, four tapered legs, stretchers and a slatted back; `mug` is a
surface of revolution whose profile runs up the outside, across the rim and back down
the inside, so it has a real wall to cut through; the lampshade is a thin open cone
built the same way. Nothing touches `Math.random`, so a phrase always builds the same
object, and the generator still handles words outside the shelf's ten.

Shapes are deliberately plain. Earlier versions pushed several octaves of noise
through every radius and offered spiky, jagged and swept archetypes; the results were
lumpy, asymmetric and never recognisable as the thing they were named after. Silhouettes
are now hand-shaped and smoothed through a spline, and only forms that read as real
objects remain. Everything emitted is watertight, which is the slicer's one hard
precondition.

Each of the five needed more than a silhouette to be the thing it is named after:

- **The brick** is 215 x 102.5 x 65 mm, and getting that ratio right is most of the
  job — at the old proportions it read as a block of stone. It also needed its own
  surface: the stone shader draws worley veins for aggregate, which on a brick reads as
  a crazed slab of lava. Fired clay is sand with a few darker inclusions and nothing
  else.
- **The log** is turned standing up and then laid down, because a standing one is a
  stump and a lying one is far better to cut. Bark runs *along* the trunk in ridges with
  dark splits between them, the sawn ends show growth rings about the pith, and the two
  must look nothing alike — that contrast is what says "log". The trunk axis is a shader
  uniform rather than assumed to be Y, which is what stopped the ridges wrapping the
  wrong way and end grain being painted down the flanks.
- **The bottle** was a solid lathe — a bottle's outline with nothing inside, which is
  precisely what "a piece of glass" means. It is now a wall around a void: up the
  outside, over the lip, down the bore, out under the shoulder and back to a thick punt.
  Cutting through the shoulder opens a real chamber.
- **The vase** is a surface of revolution with a genuine wall, so cutting one opens a
  real cavity rather than parting a solid.
- **The slime** is doing one job: convincing you it is soft. Everything that says so is
  at the bottom — it spreads where it meets the bench, its lower edge bulges past its
  widest point, and the base is flat rather than resting on a curve. The top is smooth,
  because slime has no texture of its own; all the interest is the light going into it
  and coming back stained, which is transmission with a short attenuation distance.

Normals are recomputed at the end with a smoothing angle rather than by plain
averaging. `computeVertexNormals` averages every face meeting at a point, and a turned
object that folds back on itself — a bowl, a mug, a lampshade — has an outer wall and
an inner wall meeting at the rim facing opposite directions. Averaging them gives a
normal pointing at neither, and on a wall a couple of millimetres thick the result
faces *behind its own triangle*: 45 of a bowl's faces and 44 of a lampshade's shaded
back-to-front before anything was even cut, and every fragment cut from them inherited
it. Faces are averaged only when they belong to the same smooth surface, so a
revolution stays smooth and a rim stays sharp.

### The physics

`src/game/physics.js` is a small sequential-impulse solver. Everything is live from
the frame it appears: an object that can balance stands, one that cannot falls over,
and a piece whose support has just been cut away drops.

Each body computes its support points on first use — the extreme vertex in each of 42
directions, a cheap stand-in for its convex hull — so a chair rests on the bottoms of
its four legs rather than on a bounding sphere, and a sliced-off slab lies flat on its
cut face. Bodies sleep once they stop moving and the solver is skipped entirely while
the bench is still, so a pile of fifty settled fragments costs nothing per frame. A
cut wakes everything: a sleeping body has no idea the thing it was resting on has just
been cut out from under it.

Pieces collide with each other properly, not just with the bench. Each body carries a
convex hull built from its support points; contacts come from SAT over both hulls'
face normals, and every contact of a pair shares that one axis. Choosing an exit plane
per vertex instead — the obvious way — breaks on the case that matters most here: two
flat pieces stacked in line have corners sitting exactly on each other's side faces,
so a per-vertex search finds a zero-depth sideways exit and shoves the top piece off.

Each body's **inertia tensor** is computed from its actual mesh, by summing the
closed-form covariance of the tetrahedron each triangle forms with the origin. A
single scalar — the sphere approximation — is wrong for almost every piece a cut
produces: a thin slab resists rotation about its flat axis far less than about its
long one, and treating those as equal is why flat fragments used to tumble like
marbles. The tensor is floored with a small isotropic term and rejected if it is not
positive definite, because a fragment thin enough to be a sheet of paper yields a
near-singular matrix whose inverse sends the body to infinity and NaN through
everything it touches.

Overlap is resolved with **split impulses**: the push-out goes into a separate
pseudo-velocity that is used for integrating position and then discarded, so
separating a resting stack costs it no real momentum.

Five things in there were found by watching pieces misbehave rather than by design:

- **The wake threshold was evaluated after gravity had been applied.** One step of
  gravity is 0.16 m/s, more than the threshold itself, so every awake body looked
  "lively" the instant a step began and woke all of its sleeping neighbours — forever.
  A settled pile could never sleep, and chasing the symptom led through three other
  plausible-but-wrong explanations first. Judging liveliness before gravity took the
  test pile from *0/8 asleep, permanently jittering* to *8/8 asleep, 0.0000 m/s, zero
  cost*.

- Resting contact needs a small margin, or gravity sinks a body a fraction of a
  millimetre every step and nothing on the bench ever settles.
- Coulomb friction alone cannot stop a rolling body — in pure rolling the contact
  point is not sliding, so a round chair leg rolls across the bench forever.
- Ground and piece-against-piece contacts have to be relaxed together. Solved in
  separate passes they fight: one drives a box down into the bench, the other shoves
  it back up, and a stacked box slowly walks off its neighbour.
- **A convex hull fills in whatever the shape does not.** Cut a mug in half and each
  half's hull spans the cavity, so the two hulls overlap deeply while the halves
  merely touch — and resolving that flings freshly cut pieces apart. A pair therefore
  remembers how far it was overlapping when it first met, and only penetration beyond
  that gets pushed out. The allowance is granted only to pairs that appear already
  overlapping *and not approaching*; a pair created by an impact gets none, so a
  dropped piece is still stopped properly.

What is not handled is a pure edge-against-edge crossing with no vertex inside either
hull, and hulls are convex, so a deeply concave fragment collides as its hull.

### The materials

No textures and no image files anywhere in the project. Surfaces and interiors are
procedural, and the reflections come from an environment probe baked at startup from
a handful of emissive cards standing in for the window, the ceiling and the bounce off
the bench. Wood shows long fibre along the grain and growth rings on a cut face;
ceramic shows glaze crazing outside and a chalky break inside.

---

## Tests

```bash
npm test
```

`tools/test-slicer.mjs` checks the invariants the whole thing rests on — watertightness,
mass conservation, material survival, centre-of-mass placement, and behaviour on
degenerate planes — across eight primitive shapes and under recursive slicing.
`tools/test-forge.mjs` checks that every archetype comes out closed, that the vocabulary
is deterministic, that forged objects survive the slicer, and that a short stroke across
one chair leg takes the leg rather than the chair. `tools/test-physics.mjs` checks hull
convexity, stacking, that a dropped heap comes to rest without sinking or
interpenetrating, and that a cut never throws its own halves apart.

`tools/test-cuts.mjs` is the exhaustive version of *look at it from every side*: every
shelf asset, cut three generations deep from four camera angles, and every one of the
resulting fragments inspected. It exists because "the object is hollow" has three separate
causes that look identical from the bench — no cap at all, a cap wound inside-out, or a
cap that leaves a gap — and each needs its own check.

Two of its measurements are deliberately not counts:

- **Back-facing surface is measured as area, not triangles.** A cut leaves slivers whose
  area is nine orders of magnitude below the surface they sit on, and whose normals are
  therefore float32 rounding rather than direction. Counting those says a bowl is broken
  when nothing is visible at any zoom.
- **An unmatched edge is not automatically a hole.** The cap's boundary comes from the
  loop stitcher, welded at a tolerance set by the object being cut, while the clipped
  surface keeps the crossing points it computed — so on a fragment a fifth the size of
  its parent, the two descriptions of one edge disagree in the last few bits. An
  unmatched edge with a near-twin among the others is a seam that wide; one with no twin
  is a missing face. Loosening the weld tolerance instead does not work: it merges
  genuinely distinct vertices on small triangles and invents mismatches that were never
  there. Currently: 0 hollow pieces, 0 back-facing, 5 of 528 missing a face, and every
  other unmatched edge a seam under 3.4e-6 of its piece.

All four run in Node with no browser, because the simulation never touches the DOM.

`npm run bench` reports what a cut costs. Worst case across the shelf is 4.15 ms for a
first cut — slice, hull, ground contacts and inertia tensor for both halves — and
11.24 ms for a stroke that cuts three generations deep in one go, against a 16.7 ms
frame. Two things got it there: the slicer accumulates into typed arrays rather than
arrays of doubles (a cut writes on the order of a hundred thousand numbers, and
`Float32Array.prototype.set` on a JS array converts element by element), and the support
scans read their directions from a flat buffer instead of 68 Vector3 property lookups
per vertex. Measure in a browser with devtools attached and everything above is roughly
six times slower — an attached debugger deoptimises V8, and a benchmark that does not
account for it will send you optimising the wrong thing.

`tools/review.js` renders an object from four angles into a contact sheet, whole
(`__CUT__.review`) or after being cut apart and tumbled (`__CUT__.reviewCut`) — because
a whole object looking right says nothing about what a cut exposes, and a piece resting
cut-side-down hides exactly the surface that needs checking.

### Known limits

- Objects merged from many heavily overlapping parts (a stool: seat, splayed legs and
  rails all intersecting) can produce a cut section whose loops partially overlap rather
  than nest, and one of those loses a cap face. It happens to about 1 fragment in 100,
  and mass properties stay correct. Fixing it properly means a real CSG union.
- Past the third recursive cut, fragments approach float32's noise floor and a few
  needle artefacts survive. The test suite reports the seal rate rather than hiding it.
- Collision hulls are convex, so a deeply concave fragment collides as its hull, and
  edge-against-edge crossings with no vertex inside either hull are missed. In a heap
  of sawn pieces both are shallow and rare.

---

## Layout

```
src/
  core/
    engine.js      renderer, orbit camera, restrained post chain
    scene3d.js     the room: bench, backdrop, lights, environment probe
    rng.js         seeded, deterministic
    noise.js       simplex, CPU and GLSL
  game/
    slicer.js      plane/mesh cutting and cap generation
    forge.js       phrase -> watertight geometry
    lexicon.js     the five shelf assets; phrase -> shape, material, palette
    materials.js   procedural skin, accent and interior shaders
    physics.js     rigid bodies, contacts, sleeping
    collision.js   convex hulls, SAT, contact generation
    entity.js      mesh + body + slicing
    studio.js      the sandbox itself
    blade.js       stroke capture, guide ribbon, cheap reach test
    cutter.js      plane and freehand cut surfaces, cap parameterisation
    ui.js          the shelf, the readout, the help sheet
tools/
  test-slicer.mjs  geometry invariants
  test-forge.mjs   every archetype closed, deterministic, sliceable
  test-physics.mjs hulls, stacking, sleeping, inertia, freshly cut halves
  test-cuts.mjs    every asset cut apart, every fragment inspected
  bench-cut.mjs    what a cut costs, warmed and reported as a median
  review.js        dev-only: renders an object from four angles to a contact
                   sheet, whole or cut open, so shapes get looked at rather
                   than assumed
```
