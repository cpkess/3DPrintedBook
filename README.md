# Hidden Book Box — parametric configurator

A browser configurator that generates the model directly, replacing the
OpenSCAD build. Geometry from a 3MF by "Truitt" (MakerWorld, Standard Digital
File License). Local-use rebuild.

```bash
node serve.mjs      # then open http://localhost:8080
```

ES modules need `http://`. Opening `index.html` from `file://` will not work.
Three.js, manifold-3d and opentype.js load from jsDelivr, so first load needs
a network connection.

## Why this instead of OpenSCAD

OpenSCAD was the wrong tool, and it cost several rounds of guesswork:

- **No numeric inspection.** There was no way to ask whether a solid was
  manifold, what its volume was, or whether a boolean had actually removed
  anything. A bridge wound inside-out still rendered, still passed an edge
  check, and quietly *subtracted* 4652 mm³ while reporting a taller bounding
  box. It took a hand-written signed-volume test in Python to catch.
- **No text metrics.** `text()` can only align to the font baseline, so the
  build carried a hand-tuned `baseline_k` fudge that needed re-tuning whenever
  the string or font changed.
- **No debugging.** Every change meant regenerating a 340 KB file and hoping.

Here the whole generator is plain JS with no DOM dependency, so it runs under
Node and every claim below is a number produced by `node test.mjs`.

## Verification

```
$ node test.mjs
nominal           145ms  case bbox 185.50 x 239.18 x 33.15   OK
narrow+short       65ms  case bbox 120.00 x 150.00 x 33.15   OK
wide+long          55ms  case bbox 250.00 x 250.00 x 33.15   OK
thick +47         167ms  case bbox 185.50 x 239.18 x 80.00   OK
all extremes      152ms  case bbox 250.00 x 250.00 x 80.00   OK
all checks passed
```

Every part comes back a valid manifold with positive volume at every corner
of the parameter space. Further checks in `verify2.mjs`:

| check | result |
|---|---|
| spine flat run at nominal / +10 / +20 mm | 6.40 / 16.40 / 26.40 mm (exact) |
| cavity growth per 10 mm of thickness | +372.4, +372.3 cm³ — linear |
| engraved volume per title line | 158.0 mm³ vs 122.94 mm² × 1.285 mm |
| page pitch requested 0.465 / 0.8 / 1.2 | tracks, depth within 0.001 mm |
| 3MF output | passes `unzip -t`, 3 named objects, 3 build items |

## How the geometry works

**Width and length — feature-preserving stretch.** Each part has a band along
X and Y where the solid is prismatic; only that band lengthens. Fillets, hinge
knuckles and the ledges the pages snap into sit outside it and move rigidly,
keeping the clearances the designer tuned for an unscaled nozzle. `scale()` is
used nowhere — it would thin the walls and change the snap fit.

| part | X band | Y band |
|---|---|---|
| case | 166.3 mm | 120.1 mm |
| cover | 153.7 mm | 156.8 mm |
| pages | 160.0 mm | 122.1 mm |

**Thickness — shared-plane split.** There is no prismatic band in Z, so the
solid is cut at z = 1.790 and the cut cross-section extruded to fill the gap.
Both mating parts use the *same* plane: if they used different heights, any
engaging feature pair between the two planes would have one member move and
its partner stay, and the dovetail would lose engagement by exactly that
amount. The plane sits inside the spine's existing flat band (z −3.20 to
+3.20), so the spine gains no new crease, and inside the cavity, so the
compartment grows rather than a solid slab being added beneath it. Thickness
increases only.

**Page edges — regenerated.** The designer's lines are irregular (crest
spacing 0.15–0.84 mm) and the fore-edge is curved in Z, so no two cross
sections are identical and no slab of real geometry tiles. They are stripped
from the base mesh at export time and regenerated at constant pitch over the
whole block, so the inserted band matches the rest instead of reading as a
patch. Measured original: 0.465 mm pitch, 0.178 mm deep — both adjustable.

**Titles.** Glyph outlines come from opentype.js, so X is centred on the
advance width and Y on the ink bounding box, matching the source 3MF exactly.
No fudge factor. Any .ttf/.otf can be dropped in.

## Files

```
index.html        UI
src/app.js        viewport, controls, downloads (the only DOM code)
src/book.js       the generator — headless, no DOM
src/export.js     text layout, STL writer, 3MF writer (store-only ZIP)
src/data.js       base meshes + constants, 159 KB
test.mjs          parameter-space checks
verify2.mjs       spine flat, texture depth, cavity growth
serve.mjs         static server
```

## Browser verification

The UI is tested in real Chrome via Puppeteer (`node browsertest.mjs`,
`node dltest.mjs`), not just reasoned about:

| check | result |
|---|---|
| page boots, no page errors | HUD reports geometry, `#err` empty |
| all three parts render | 33,502 tris at nominal, camera auto-fits |
| slider drives a rebuild | 478 ms warm |
| `.3mf` download | 2.02 MB, valid ZIP header, passes `unzip -t` |
| `.stl` download | 10,842 tris, header/size consistent |
| network requests | none external; only a favicon 404, now fixed |

### Two bugs this caught

**Stuck on "starting…".** `updateReadouts()` read `p.etch`, which `params()`
never sets, so `p.etch.toFixed` threw a TypeError. It ran *before* the try
block, so it surfaced as an unhandled rejection with nothing on screen. Fixed,
and there are now `error` / `unhandledrejection` handlers that write the
message into the sidebar, plus staged boot status, so a failure can never
again present as a silent hang.

**5.4 s per rebuild.** The first timing split blamed "gl", which was wrong —
manifold evaluates lazily, so the real work landed wherever the result was
first touched. Forcing evaluation inside the timer showed the cost was two
chained `.subtract()` calls on the cover: the first cut takes it from 2,756 to
22,848 triangles and the second then has to chew through that. Batching into
one `Manifold.difference([cover, cut1, cut2])` and simplifying the text
cross-section at 0.01 mm took it to **899 ms cold, 478 ms warm**, and 138k
triangles to 33.5k. Engraved volume changed 434.73 → 434.47 mm³ (0.06%) with
genus unchanged, so nothing but redundant tessellation was lost.

## Offline

`vendor/` holds three.js, manifold-3d (+wasm), opentype.js and Liberation
Serif, so nothing is fetched at boot. The other fonts in the picker load from
jsDelivr on demand and fail soft — a failed font never blocks geometry.

## Not verified

Everything above was measured, but only under headless Chrome with software
rendering on one machine. Not checked: other browsers, touch input, very long
titles in scripts with complex shaping (Arabic, Devanagari — opentype.js does
no bidi or contextual shaping here), and real print fit. The generated
geometry is manifold, which is not the same as printable.
