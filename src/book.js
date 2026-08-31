// book.js -- parametric generator for the hidden book box.
//
// No DOM, no rendering. Everything here runs headless under Node, which is
// the whole point of moving off OpenSCAD: the geometry can be checked
// numerically (manifoldness, volume, bounding box) before anyone looks at it.
//
// Three techniques, because the geometry allows different things per axis:
//
//   width / length  feature-preserving stretch. Each part has a band along X
//                   and Y where the solid is prismatic; only that band is
//                   lengthened. Fillets, hinge knuckles and the ledges the
//                   pages snap into sit outside it and move rigidly, keeping
//                   the clearances the designer tuned for an unscaled nozzle.
//
//   thickness       cut at one shared plane, extrude the cut cross-section to
//                   fill the gap. There is no prismatic band in Z, so this is
//                   the only exact option. The spine's round-over gains a flat
//                   section at the cut -- deliberate.
//
//   page edges      the original lines are stripped from the base mesh (done
//                   at export time) and regenerated at a constant pitch over
//                   the whole block, so the inserted band matches the rest
//                   instead of reading as a patch.
//
// scale() is used nowhere. It would thin the walls and change the snap fit.

import { DATA } from './data.js';

const B64 = typeof atob === 'function'
  ? (s) => { const bin = atob(s); const u = new Uint8Array(bin.length);
             for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
             return u; }
  : (s) => new Uint8Array(Buffer.from(s, 'base64'));

function decodePart(p) {
  const vb = B64(p.v), fb = B64(p.f);
  return {
    verts: new Float32Array(vb.buffer, vb.byteOffset, p.nv * 3),
    tris: new Uint16Array(fb.buffer, fb.byteOffset, p.nf * 3),
    nv: p.nv, nf: p.nf, xb: p.xb, yb: p.yb, bbox: p.bbox,
  };
}

export const PARTS = Object.fromEntries(
  Object.entries(DATA.parts).map(([k, v]) => [k, decodePart(v)]));

// --- stretch ---------------------------------------------------------------
// Piecewise linear: rigid outside the band, uniform inside it.
function stretch1(t, band, d) {
  const [lo, hi] = band;
  if (t <= lo) return t - d / 2;
  if (t >= hi) return t + d / 2;
  const mid = (lo + hi) / 2, half = (hi - lo) / 2;
  return mid + (t - mid) * (1 + d / (2 * half));
}

function stretchedMesh(part, dx, dy) {
  const v = new Float32Array(part.verts.length);
  for (let i = 0; i < part.nv; i++) {
    v[i * 3] = stretch1(part.verts[i * 3], part.xb, dx);
    v[i * 3 + 1] = stretch1(part.verts[i * 3 + 1], part.yb, dy);
    v[i * 3 + 2] = part.verts[i * 3 + 2];
  }
  return v;
}

// --- main generator --------------------------------------------------------

export function createGenerator(wasm) {
  const { Manifold, CrossSection } = wasm;
  const { nominal, Z0, drop, page, text } = DATA;

  const BIG = 500;
  const halfSpaceBelow = (z) =>
    Manifold.cube([BIG * 2, BIG * 2, BIG], true).translate([0, 0, z - BIG / 2]);
  const halfSpaceAbove = (z) =>
    Manifold.cube([BIG * 2, BIG * 2, BIG], true).translate([0, 0, z + BIG / 2]);

  function solidOf(name, dx, dy) {
    const p = PARTS[name];
    return Manifold.ofMesh({
      numProp: 3,
      vertProperties: stretchedMesh(p, dx, dy),
      triVerts: new Uint32Array(p.tris),
    });
  }

  /** Insert `dz` of straight section at the shared plane. */
  function thicken(solid, dz) {
    if (dz <= 1e-9) return solid;
    const lower = solid.intersect(halfSpaceBelow(Z0));
    const upper = solid.intersect(halfSpaceAbove(Z0)).translate([0, 0, dz]);
    const bridge = Manifold.extrude(solid.slice(Z0), dz).translate([0, 0, Z0]);
    return Manifold.union([lower, bridge, upper]);
  }

  /**
   * Regenerate the page lines over the whole block.
   *
   * Each ridge takes its outline from the block at the height it sits at, so
   * it follows the block's curve. The fore-edge drifts ~0.38 mm over the
   * block's height, more than twice the ridge depth, so a single constant
   * outline would make lines protrude at mid-height and vanish at the ends.
   * Ridges inside the inserted band map back to Z0, since the band is a
   * prism of that section.
   */
  function pageLines(solid, dz, pitch, depth, dx, dy) {
    if (depth <= 0 || pitch <= 0) return null;
    const bb = PARTS.pages.bbox;
    const lo = bb[0][2] + 0.3, hi = bb[1][2] + dz - 0.3;
    const n = Math.max(1, Math.round((hi - lo) / pitch));
    const p = (hi - lo) / n;

    // one slice per table station, reused by every ridge that maps to it
    const step = page.tableStep;
    const cache = new Map();
    const sectionAt = (zo) => {
      const k = Math.round(zo / step);
      if (!cache.has(k)) {
        const xs = solid.slice(k * step);
        cache.set(k, xs.numContour() ? xs.offset(depth, 'Miter', 2) : null);
      }
      return cache.get(k);
    };

    const spineX = stretch1(page.xSpine, PARTS.pages.xb, dx);
    const mask = Manifold.cube([BIG, BIG * 2, BIG * 2], true)
      .translate([spineX + BIG / 2, 0, 0]);

    const ridges = [];
    for (let i = 0; i < n; i++) {
      const zw = lo + i * p;
      const zo = zw < Z0 ? zw : (zw > Z0 + dz ? zw - dz : Z0);
      const xs = sectionAt(zo);
      if (!xs) continue;
      ridges.push(Manifold.extrude(xs, p / 2).translate([0, 0, zw]));
    }
    if (!ridges.length) return null;
    // disjoint in z, so compose is exact and far cheaper than pairwise union
    return Manifold.compose(ridges).intersect(mask);
  }

  /** Glyph outlines -> a cutting solid, positioned by `xform`. */
  function cutter(shapes, xform, depth, proud, tol) {
    if (!shapes || !shapes.length) return null;
    let cs = CrossSection.ofPolygons(shapes, 'NonZero');
    if (cs.isEmpty()) return null;
    if (tol > 0) cs = cs.simplify(tol);
    return Manifold.extrude(cs, depth + proud)
      .translate([0, 0, -depth]).transform(xform);
  }

  /**
   * Subtract every cut in ONE call.
   *
   * Chaining `.subtract()` per line is what made this slow: the first cut
   * takes the cover from 2756 to 22848 triangles, and the second then has to
   * chew through that. Two chained subtracts measured 4771 ms; the same two
   * batched measured 953 ms.
   */
  function engraveAll(solid, cuts) {
    const live = cuts.filter(Boolean);
    if (!live.length) return solid;
    return Manifold.difference([solid, ...live]);
  }

  /**
   * @param {object} o  parameters
   * @returns {{case:Manifold, cover:Manifold, pages:Manifold, info:object}}
   */
  function build(o = {}) {
    const width = o.width ?? nominal.w;
    const length = o.length ?? nominal.l;
    const thickness = Math.max(nominal.t, o.thickness ?? nominal.t);
    const dx = width - nominal.w;
    const dy = length - nominal.l;
    const dz = thickness - nominal.t;
    const pitch = o.pagePitch ?? page.pitch;
    const depth = o.pageDepth ?? page.depth;
    const etch = o.etchDepth ?? text.etchDepth;

    // --- case: thickened, spine title engraved
    const tol = o.textTolerance ?? 0.01;
    let caseM = thicken(solidOf('case', dx, dy), dz);
    if (o.spineShapes) {
      const m = text.spineMatrix;
      // column-major 4x3 for manifold's transform()
      // manifold wants a COLUMN-major 4x4; the last row is ignored.
      const sp = [m[0][3], m[1][3], m[2][3]];
      const xf = [
        m[0][0], m[1][0], m[2][0], 0,
        m[0][1], m[1][1], m[2][1], 0,
        m[0][2], m[1][2], m[2][2], 0,
        stretch1(sp[0], PARTS.case.xb, dx),
        stretch1(sp[1], PARTS.case.yb, dy),
        sp[2] + dz / 2,           // spine title recentres on the taller spine
        1,
      ];
      caseM = engraveAll(caseM, [cutter(o.spineShapes, xf, etch, text.proud, tol)]);
    }

    // --- cover: thickness is panel stock, so it is not split
    let coverM = solidOf('cover', dx, dy);
    const coverCuts = [];
    for (const [key, anchor] of [['front1Shapes', text.front1],
                                 ['front2Shapes', text.front2]]) {
      if (!o[key]) continue;
      const xf = [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,
        stretch1(anchor[0], PARTS.cover.xb, dx),
        stretch1(anchor[1], PARTS.cover.yb, dy),
        anchor[2], 1];
      coverCuts.push(cutter(o[key], xf, etch, text.proud, tol));
    }
    coverM = engraveAll(coverM, coverCuts);

    // --- pages: thickened, then re-textured over the whole block
    let pagesM = thicken(solidOf('pages', dx, dy), dz);
    const lines = pageLines(pagesM, dz, pitch, depth, dx, dy);
    if (lines) pagesM = pagesM.add(lines);

    return {
      case: caseM.translate([0, 0, drop.case]),
      cover: coverM.translate([0, 0, drop.cover]),
      pages: pagesM.translate([0, 0, drop.pages]),
      info: { width, length, thickness, dx, dy, dz, pitch, depth },
    };
  }

  return { build, thicken, pageLines, solidOf, stretch1, cutter, engraveAll };
}
