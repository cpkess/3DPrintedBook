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
npm test               # test.mjs + verify2.mjs + gridtest.mjs + decaltest.mjs
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
src/svg.js        SVG outlines to polygons, for the spine decal
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

**The middle's pattern, everywhere.** The inserted band looks right because
*two* things are constant there: the base the grooves are cut into, and the
ridges themselves. Both are prisms of the `Z0` section, since the band is a
prism of it. `pageTexture()` gives the whole block that treatment — it levels
the outer skin onto the `Z0` outline, then lays identical ridges on it.

The block's own fore-edge cannot be followed, because it is not shape. It
wanders **0.228 mm with no trend** — a best-fit parabola leaves 0.145 mm of a
0.218 mm range unexplained, and the steepest run is 2.07 mm/mm — which is
leftover erosion residual from `pagetex.py`. It is the same wander at every y
(0.2281 mm at y = 0, 40, 80, 105), so it is a radial wobble of the whole
outline and one outline corrects it the whole way round.

Both halves are needed, and this took two passes to get right. Sampling the
block per ridge reproduces the residual: ridge tips scattered over 0.213 mm on
a 0.178 mm feature. Giving every ridge the `Z0` outline lines the *tips* up
but leaves the groove *floors* on the raw skin, so grooves still ran 0.022 to
0.234 mm deep and the ends still did not match the middle. Levelling the skin
first is what closes it:

```
tip spread    0.000000 mm    floor spread  0.000000 mm
groove depth  0.1780 mm exactly, at 33.15 / 43.15 / 80 and at y = 0 and 80
```

The levelling trims at most 0.16 mm of outer skin and fills at most 0.06 mm,
both confined to the ridge z-range and to the mask the ridges already own, so
the spine side is untouched. The block gets *narrower*, not wider (x max
87.364 → 87.334). The compartment and the 0.397 mm slot are unaffected —
both are voids, and `voidEnv` is subtracted from everything added. It also
incidentally merges the page block into **one** solid at every thickness; it
used to come apart into two at the cut plane.

Because the ridge is one prism spanning the whole block, its section must
clear every void the block has **anywhere**, not just at `Z0` — the slot only
exists from the base up to z −2, and a ridge built from the `Z0` voids alone
would pinch it shut. Hence the envelope, sampled on `page.tableStep`.
Over-removing is safe: ridges are only ever unioned on, so anything taken out
where the block is solid is put straight back.

**The mask is per-edge, not a half-space.** The block is not a rectangle in
plan: it steps at |y| = 76.82, reaching x −87.46 only in two **wings** — the
sections carrying the dovetail — and is cut back to x −79.23 between them. The
old mask was a half-space at `page.xSpine` (−76), which cleared the wings'
spine face but took 11.5 mm of the head and tail faces with it at each end.
The designer textures those: of the 729 head-face triangles in the source
mesh, 236 span the full 174 mm width, and sampled over the wing at x −85 they
swing 0.3810 mm with 76 sign changes — the same as the fore-edge.

Both spine faces must still be left alone. The wings' one carries a 0.88 mm
round-over (1 sign change: a curve, not lines) and the inner one faces the
hinge. So `spineShield()` builds a strip per edge instead, on any edge whose
outward normal points within 45° of −x:

- `reach = depth * 2` **outside** the outline, to clear the band.
- `inset = 1.2` **inside** it. Without this a ridge prism reaches out to the
  Z0 outline at every line and re-textures the round-over — measured 171 sign
  changes on a face that must have 1.
- overrun `depth * 1.5` along the edge, past both ends. The mitre tip reaches
  exactly `depth` along the neighbouring edge, so stopping short leaves a
  0.178 mm spike past the spine face, and stopping *exactly* on it makes the
  two boundaries coincide and leaves a degenerate sliver at every line
  (315 stray shells at thickness 80 against 14).

**Decimate the target before offsetting.** The raw Z0 slice carries 24
sub-0.5 mm edges of pure tessellation noise out of 50. `simplify(0.001)` takes
it to 15 points for a worst deviation of 0.00095 mm, and since every ridge is
a prism of that section it is the difference between ~320 and ~100 triangles
per line — 77k triangles and 2545 ms at thickness 80, against 34k and 1093.

**Probe every textured face, not just the fore-edge.** That is exactly how the
wings were missed. `verify2.mjs` now measures the fore-edge, the head at two
x positions, and the head *and* tail over the wings, plus both spine faces.
When checking a spine face is still smooth, count only turns bigger than
5 microns: a flat prism face slices with about **7 nanometres** of
floating-point jitter, which is hundreds of meaningless sign changes over a
tall block.

**Do not go back to following the block.** Lofting each ridge so it tracks the
skin needs a real union instead of `compose` and measured 552 ms → 1517 (k=2)
→ 2193 (k=3) → 3329 (k=4), converging at 0.028 mm rather than 0. `hull` is not
a shortcut either: the outer contour is **not convex** and splits into 3–5
separate islands at most heights.

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

## Spine decal

The base mesh carries a moulded panel on the spine near the tail: a recessed
square frame with a device in it. Measured off the nominal build by bisecting
the edges of the recess — **22.2250 mm square (7/8 inch)**, centred at
y −98.9520 and local z 0.0000, and `decaltest.mjs` re-derives all four so a
regenerated `data.js` cannot move them silently.

`DECAL.depth` is 1.19 and is a **modal** value, not a true one: the moulded
floor is flat while the spine face is curved, so the cut measures 1.09 mm at
the panel's ends and 1.23 mm across its middle. A replacement is cut a
constant depth from the face instead, so its floor follows the curve.

**The moulded panel straddles the cut plane** (local z −11.11 … +11.11,
Z0 = 1.79), so thickening stretches it: at 43.15 mm it comes out 32.1 mm tall
instead of 22.2, and at 80 mm, 32.0. `'none'` and `'svg'` do not have that
problem, because a replacement is *placed* rather than inherited — measured
identical at 33.15, 43.15 and 80.

Filling it back works because the spine's x-z profile is prismatic along y to
within **0.008 mm** (measured at y 0, −70, −85, −113, −116). `fillDecal()`
takes the section at y = 0, sweeps it across the panel, clips it to a box
round the spine face and unions it on — which fills the recess and changes
nothing where the face is already smooth.

`svg.js` has no DOM dependency, so an uploaded file can be checked headless;
that rules out `DOMParser`, hence the small tag scanner. It emits the same
shape of data as `textPolygons()`, so the same `cutter()` engraves both.
Winding is **preserved, not normalised** — SVG's default fill-rule is nonzero
and manifold's `'NonZero'` reads a counter-wound subpath as a hole, which is
what a counter or a ring is. Only elements that actually ask for `evenodd`
get re-wound, by nesting parity; re-winding everything would punch holes that
nonzero artwork does not have. Strokes are ignored: only filled area is
geometry. y is flipped on the way out, which reverses every ring together and
so leaves outer-vs-hole winding intact.

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
