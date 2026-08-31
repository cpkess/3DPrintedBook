# CLAUDE.md

Parametric configurator for a hidden book storage box. Browser app: adjust
size and title, see it live, download printable geometry.

Base geometry came from a Bambu Studio 3MF by "Truitt" (MakerWorld, Standard
Digital File License). This is a local-use rebuild — **do not redistribute the
generated output or the mesh data.**

## Commands

```bash
npm install            # three, manifold-3d, opentype.js (also vendored)
node serve.mjs         # http://localhost:8080 — ES modules need http, not file://
npm test               # test.mjs + verify2.mjs + gridtest.mjs, headless
node browsertest.mjs   # real Chrome via puppeteer: boot, render, rebuild
node dltest.mjs        # verifies .3mf / .stl downloads are well-formed
cd tools && python3 export_data.py    # regenerate src/data.js (needs numpy)
```

`browsertest.mjs` and `dltest.mjs` default to Chrome at
`/opt/google/chrome/chrome`. Set `CHROME_PATH` to override for your machine,
e.g. `CHROME_PATH=/opt/pw-browsers/chromium node browsertest.mjs`.

## Layout

```
index.html        UI + importmap (points at ./vendor, nothing external)
src/app.js        viewport, controls, downloads — the ONLY file touching the DOM
src/book.js       the generator — headless, testable, no DOM
src/gridfinity.js Gridfinity socket profile, baseplates, unit arithmetic
src/export.js     text layout, STL writer, 3MF writer (store-only ZIP)
src/data.js       GENERATED. base meshes + constants. 159 KB
tools/            export_data.py, pagetex.py, extract_3mf.py, stl/
vendor/           three, manifold(+wasm), opentype, Liberation Serif
```

Keep `book.js` DOM-free. That separation is what makes every claim in the
README a measured number rather than a guess, and it is the main reason this
project left OpenSCAD.

## Invariants — break these and the model silently goes wrong

**Never use `scale()` for dimensions.** Scaling to 80% gives 1.6 mm walls
where 2 mm was specified, shrinks hinge clearance below what a 0.4 mm nozzle
resolves, and changes snap-fit interference. Width and length use a
piecewise-linear *stretch* confined to each part's prismatic band, so fillets,
hinge knuckles and snap ledges translate rigidly at original size. Bands are
in `data.js` per part; they are derived, not hand-picked.

**The shared cut plane is load-bearing.** Case and page block must both be cut
at `Z0 = 1.790`. If they use different heights, any engaging feature pair
falling between the two planes has one member move with DZ while its partner
stays, and the dovetail loses engagement by exactly DZ. A shared plane makes
that impossible. `Z0` also sits inside the spine's existing flat band
(z −3.20 … +3.20), so the spine gains no new crease, and inside the cavity, so
the compartment grows. Below about z = −8.5 the page block is **solid**: a cut
there gives a 38 841 mm² bridge instead of 3 134 mm², meaning a thicker book
with the same storage and seven times the plastic. If you move `Z0`, re-derive
all three conditions.

**Thickness increases only.** Going below nominal means removing material
rather than inserting it, which collides the two halves. `build()` clamps it.

**manifold evaluates lazily.** `build()` returns fast and does the real work on
first access to `numTri()` / `volume()` / `getMesh()`. Any benchmark that does
not force evaluation inside the timer is measuring nothing. This produced a
completely wrong performance diagnosis once already.

**Batch booleans, never chain.** Two chained `.subtract()` calls on the cover
measured 4771 ms; the same two as one `Manifold.difference([solid, a, b])`
measured 953 ms. The first cut takes the cover from 2,756 to 22,848 triangles
and the second has to chew through that. Use `engraveAll()`.

**Simplify text cross-sections.** `textTolerance` defaults to 0.01 mm.
Without it: 138k triangles, 5.7 s. With it: 33.5k triangles, 344 ms. Engraved
volume changes 0.06% and genus is unchanged, so only redundant tessellation is
lost.

**`Manifold.transform()` takes a column-major 4×4 (16 numbers)**, last row
ignored. Passing 12 silently scatters geometry into space — the engraving
added 19,000 triangles while removing exactly 0 mm³.

**STL winds counter-clockwise from outside; OpenSCAD's `polyhedron()` wants
clockwise.** Only relevant if you write mesh exporters. `export_data.py`
asserts positive signed volume for this reason.

## Page texture

The designer's page lines are irregular (crest spacing 0.15–0.84 mm) and the
fore-edge is curved in Z, so no two cross-sections of the block are identical
and **no slab of real geometry can be tiled.** Do not try again; it was
attempted twice.

Instead the original lines are eroded away in `tools/pagetex.py` at export
time and regenerated in `book.js` at constant pitch over the whole block, so
the inserted band matches the rest instead of reading as a patch. Measured
original: 0.465 mm pitch, 0.178 mm deep.

The erosion min-filters each outer-skin vertex **along its own surface
normal** — x-facing walls binned by y, y-facing walls binned by x. Binning by
polar angle does not work: on a 175 × 231 rounded rectangle the radius varies
~0.8 mm across one angular bin, which swamps a 0.178 mm texture and removes
less than a third of it. Normal-axis filtering takes the residual from
0.178 mm to 0.040 mm.

**Only the outside gets texture.** `offset()` grows every contour of a
cross-section, and a hole contour grows *inward*, so offsetting the raw
section textures the inside of every void as well as the fore-edge. That
narrowed the compartment by `depth` on all four walls, and pinched the
0.397 mm slot at x 85.31 … 85.71 (full length, base up to z −2) down to
0.041 mm at every ridge — effectively closed. `ridgeSection()` subtracts the
voids back off, leaving the section plus an outward band. Derive the voids
per station, not once: the compartment walls are prismatic in z (0.0000 mm
drift, measured at every thickness) but the slot only exists over part of the
height, so a single sample silently misses whatever it does not span. Ridges
keep covering the whole block interior rather than being trimmed to a bare
band — a band whose inner edge did not meet solid material would union in as
a detached shell.

**One outline rule, everywhere.** Each ridge takes its outline from the solid
at *its own mid-height*, with no rounding and no remapping. The fore-edge
drifts 0.235 mm over the ridge range — more than the 0.178 mm depth — and is
not smooth: it steps 0.109 mm in 0.116 mm of z at z 4.2. Two shortcuts used to
live here and both made the ends of the block disagree with its middle:

- Rounding the sample to a 0.5 mm table station (`page.tableStep`, now unused)
  put the outline up to 0.25 mm away in z. That is nothing in the inserted
  band, which is prismatic, and up to 0.13 mm at the ends, where the fore-edge
  turns over — so the band came out uniform and the ends ragged.
- Ridges above the band sampled `zw - dz` on the **thickened** solid, but that
  solid's section at `zw - dz` is not the original section there once
  `zw - dz` lands inside the band. At dz 46.85 every ridge above the band
  resolved into the bridge and got the Z0 outline: 16 of 20 wrong, one at
  0.065 mm against 0.178 mm, and three ridges vanished outright.

Collapsing band ridges onto Z0 is kept — there it is exact, not an
approximation — and keeps the whole band at one slice however thick the book.

Measured after: no ridge below half depth at any thickness (was 1 / 3 / 2 at
33.15 / 43.15 / 80), minimum protrusion 0.0029 → 0.1145 mm, and 133 of 150
ridges flat to 0.005 mm across their own span.

**Do not subdivide ridges to chase the rest.** The residual is the block's own
round-over: a prism cannot follow a surface that moves under it. Lofting with
k sub-slabs per ridge needs a real union instead of `compose`, and measured
517 ms → 2444 ms (k=2) → 7649 ms (k=4) to take the worst within-ridge
variation from 0.116 to 0.066 to 0.028 mm. Not worth it on an interactive
slider.

Outlines are decimated to 0.5 mm before offsetting. Corner fillets are
tessellated down to 0.014 mm edges, and any offset larger than half such an
edge flips it and self-intersects the polygon.

## Gridfinity

Numbers come from kennetek/gridfinity-rebuilt-openscad `src/core/standard.scad`
and are restated in `gridfinity.js`. `BASE_PROFILE` is (outward offset from the
bottom, height), so every ring is the **same 34 x 34 core square** offset by its
radius: 35.6 at z 0, 37.2 at 0.8, 37.2 at 2.6, 41.5 at 4.75.

That shared core is what makes the socket exact. Each 45 degree chamfer is a
convex hull between its two rings, and for convex sections a hull's
cross-section is the Minkowski average of the ends — here the core offset by
the interpolated radius, which is the chamfer. No stair-steps, no tessellation
dependence. Measured worst error against the spec in the built plate:
**0.0042 mm**. Do not replace this with `extrude(..., scale)`: scaling a
rounded rectangle scales the corner radius too, and the profile needs a
constant-radius *offset*.

Sockets cut **right through** the plate, so a bin's foot lands on the
compartment floor. A bin of n height units then needs exactly n x 7 mm of
depth whether or not a plate is fitted, which is what makes the thickness
arithmetic below a single term.

**The compartment is measured, never written down.** `data.js` is generated,
so a hard-coded compartment goes stale the moment it is regenerated.
`compartment()` slices the nominal page block once and caches it (~46 ms). One
measurement covers every size because the compartment is a sharp-cornered
rectangle (area error 0.0 against w x l), its walls are prismatic in z, its
floor does not move with thickness, and its spans track width and length
exactly 1:1 — the compartment edges *coincide* with the ends of the stretch
bands, so `stretch1` moves each by d/2. Hence:

```
inner width = 159.982 + dx     book width     = 42*gx + slack + 25.521
inner length = 223.939 + dy    book length    = 42*gy + slack + 15.240
usable depth = 20.250 + dz     book thickness = 7*gz + 12.900
```

The three pads (25.521, 15.240, 12.900) are all `compartment()` reports;
nothing else in the unit arithmetic is a constant. Thickness still only
increases, so below 3 height units the clamp wins and the book comes out
deeper than asked — the UI says so rather than overshooting silently.

Printable ceiling on a 250 mm plate is **5 x 5 units** (6 would need 277 mm of
width, 268 mm of length) and 9 height units at the 80 mm thickness cap.

## Text

Glyph outlines come from opentype.js, so X centres on the advance width and Y
on the ink bounding box — matching the source 3MF exactly. There is no
`baseline_k` fudge factor; if you find yourself adding one, something else is
wrong. opentype 2.0 exports **named** bindings, no default: use
`import * as opentype`.

## Known limits

- **Cover hinge zone is fixed at 22 mm** (x −88.66 … −66.66) with no prismatic
  gap anywhere inside it, so it cannot be widened by any mesh operation. It
  was designed around a 33.15 mm spine. Whether the cover still folds shut at
  greater thickness depends on hinge kinematics that cannot be measured from a
  mesh. **Untested — print the cover and case spine before committing.**
- Build plate: original footprint is already 185.5 × 239.2 mm. Length has
  ~11 mm of headroom on a 256 mm plate, width ~64 mm. Sliders go wider than
  what is printable; the UI warns past 250 mm.
- Manifold geometry is not the same as printable geometry. No test print has
  been done.
- Browser testing is Chrome-only, software rendering, one machine.
- opentype.js here does no bidi or contextual shaping, so Arabic and
  Devanagari titles will not lay out correctly.

## Conventions

- All units are millimetres.
- Failures must be visible. `app.js` has `error` / `unhandledrejection`
  handlers that write into the sidebar, plus staged boot status. An early
  version threw a TypeError before its try block and presented as a permanent
  "starting…" with nothing on screen. Do not reintroduce a silent path.
- Anything added to `params()` must have a matching readout; the audit that
  caught that bug compares every `p.*` read against the `params()` keys.
- Prefer measuring over reasoning. There is a real browser and a real CSG
  kernel available here; use them.
