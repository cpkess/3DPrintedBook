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
import { GRID, createGridfinity, unitsAcross } from './gridfinity.js';

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
  const gf = createGridfinity(wasm);

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

  const signedArea = (poly) => {
    let a = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const q = poly[i], r = poly[(i + 1) % n];
      a += q[0] * r[1] - r[0] * q[1];
    }
    return a / 2;
  };

  /** The voids in a section: fill the outer contours, subtract the section. */
  function voidsIn(xs) {
    const outer = xs.toPolygons().filter((poly) => signedArea(poly) > 0);
    if (!outer.length) return null;
    const v = CrossSection.ofPolygons(outer, 'NonZero').subtract(xs);
    return v.isEmpty() ? null : v;
  }

  // --- compartment ---------------------------------------------------------
  //
  // Measured off the mesh rather than written down: data.js is generated, so a
  // hard-coded compartment would go stale the moment it is regenerated.
  //
  // Measuring once is enough, because four things hold at every size. The
  // compartment is a sharp-cornered rectangle (its outline's corners sit
  // exactly on its bounding box). Its walls are prismatic in z. Its floor does
  // not move with thickness, since the block grows upward from the shared cut
  // plane. And both spans track width and length exactly 1:1, because the
  // compartment edges coincide with the ends of the stretch bands. So:
  //
  //   inner width = w + dx    inner length = l + dy    usable depth = depth + dz
  let COMP = null;
  function compartment() {
    if (COMP) return COMP;
    const base = solidOf('pages', 0, 0);
    const [bmin, bmax] = PARTS.pages.bbox;

    // The block also carries a 0.4 mm slot, so "this section has a hole" does
    // not locate the floor. The compartment is four orders of magnitude
    // bigger, which does.
    const BIG = 1000;
    const holeArea = (z) => {
      let worst = 0;
      for (const poly of base.slice(z).toPolygons()) {
        const a = signedArea(poly);
        if (a < worst) worst = a;
      }
      return -worst;
    };
    if (holeArea(Z0) < BIG) throw new Error('no compartment found in the page block');
    let lo = bmin[2], hi = Z0;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (holeArea(m) >= BIG) hi = m; else lo = m;
    }

    const xs = base.slice(Z0);
    const outer = xs.toPolygons().filter((poly) => signedArea(poly) > 0);
    const voids = CrossSection.ofPolygons(outer, 'NonZero').subtract(xs);
    let best = null;
    for (const poly of voids.toPolygons()) {
      const a = signedArea(poly);
      if (a > 0 && (!best || a > best.a)) best = { a, poly };
    }
    const px = best.poly.map((q) => q[0]), py = best.poly.map((q) => q[1]);
    const x0 = Math.min(...px), x1 = Math.max(...px);
    const y0 = Math.min(...py), y1 = Math.max(...py);
    const w = x1 - x0, l = y1 - y0;
    COMP = {
      w, l, depth: bmax[2] - hi, floor: hi,
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      // what the book carries around the space inside it -- the whole of the
      // unit arithmetic below is these three numbers
      wPad: nominal.w - w, lPad: nominal.l - l, tPad: nominal.t - (bmax[2] - hi),
      // how far the outline is from the rectangle we then treat it as
      rectError: Math.abs(best.a - w * l),
    };
    return COMP;
  }

  /** The compartment footprint at a given book size, shrunk by `gap` total. */
  function compartmentFootprint(dx, dy, gap = 0) {
    const c = compartment();
    return CrossSection
      .square([c.w + dx - gap, c.l + dy - gap], true)
      .translate([c.cx, c.cy]);
  }

  /**
   * The book size whose compartment is exactly gx by gy by gz gridfinity
   * units. Thickness only ever increases, so below three height units the
   * nominal book is already deeper than asked for and the clamp takes over.
   */
  function sizeForUnits({ gx, gy, gz, gap = 0 }) {
    const c = compartment();
    return {
      width: gx * GRID.pitch + gap + c.wPad,
      length: gy * GRID.pitch + gap + c.lPad,
      thickness: Math.max(nominal.t, gz * GRID.heightUnit + c.tPad),
    };
  }

  /** Whole gridfinity units that fit in the compartment of a given book. */
  function unitsFor(o = {}) {
    const c = compartment();
    const width = o.width ?? nominal.w;
    const length = o.length ?? nominal.l;
    const thickness = Math.max(nominal.t, o.thickness ?? nominal.t);
    return {
      gx: unitsAcross(c.w + (width - nominal.w)),
      gy: unitsAcross(c.l + (length - nominal.l)),
      gz: Math.max(0, Math.floor(
        (c.depth + (thickness - nominal.t)) / GRID.heightUnit + 1e-9)),
    };
  }

  /**
   * Re-texture the page block: level its outer skin, then lay the ridges on
   * it. Returns the finished solid.
   *
   * THE MIDDLE'S PATTERN, EVERYWHERE. The inserted band looks right because
   * two things there are constant: the base the grooves are cut into, and the
   * ridges themselves. Both come from the same section, since the band is a
   * prism of it. Everywhere else the block's own fore-edge wanders 0.228 mm
   * with no trend -- a best-fit parabola leaves 0.145 mm of a 0.218 mm range
   * unexplained, and the steepest run is 2.07 mm/mm -- which is leftover
   * erosion residual from tools/pagetex.py, not shape. It is the same wander
   * at every y (0.2281 mm at y = 0, 40, 80 and 105), so it is a radial wobble
   * of the whole outline and one outline fixes it the whole way round.
   *
   * Giving every ridge the Z0 outline lines the ridge TIPS up, but the groove
   * FLOORS are the block's own skin, so the grooves still varied from 0.022
   * to 0.234 mm deep and the ends still did not match the middle. So the skin
   * is levelled onto the same outline first: valleys filled, bulges trimmed,
   * both confined to the ridge z-range and to the mask the ridges already
   * own. After that the base and the ridges are both prisms of the Z0 section
   * and every groove is exactly `depth`, which is what the band always was.
   *
   * The trim removes at most 0.16 mm of outer skin and the fill adds at most
   * 0.06 mm. Neither touches the compartment or the 0.397 mm slot: both are
   * voids, and `voidEnv` is subtracted from everything added.
   *
   * The ridge is one prism spanning the whole block, so its section must
   * clear every void the block has ANYWHERE, not just at Z0 -- the slot only
   * exists from the base up to z -2, and a ridge built from the Z0 voids
   * alone would pinch it shut.
   */
  function pageTexture(solid, dz, pitch, depth, dx, dy) {
    if (depth <= 0 || pitch <= 0) return solid;
    const bb = PARTS.pages.bbox;
    const lo = bb[0][2] + 0.3, hi = bb[1][2] + dz - 0.3;
    const n = Math.max(1, Math.round((hi - lo) / pitch));
    const p = (hi - lo) / n;

    const at = solid.slice(Z0);
    if (!at.numContour()) return solid;
    const outer = at.toPolygons().filter((poly) => signedArea(poly) > 0);
    if (!outer.length) return solid;
    // the outline the band is a prism of, holes filled
    const target = CrossSection.ofPolygons(outer, 'NonZero');

    // Envelope of every void in the block, on the 0.5 mm table step. Fine
    // enough for the slot: it spans ~9.5 mm and only narrows going up, so its
    // widest point is caught. The band is prismatic and contributes one
    // sample however thick the book gets.
    const step = page.tableStep;
    const stations = [Z0];
    for (let z = lo; z <= hi + 1e-9; z += step) {
      if (z > Z0 && z < Z0 + dz) continue;
      stations.push(z);
    }
    let voidEnv = null;
    for (const z of stations) {
      const xs = solid.slice(z);
      if (!xs.numContour()) continue;
      const v = voidsIn(xs);
      if (v) voidEnv = voidEnv ? voidEnv.add(v) : v;
    }
    const solidPart = (cs) => (voidEnv ? cs.subtract(voidEnv) : cs);

    const spineX = stretch1(page.xSpine, PARTS.pages.xb, dx);
    const mask = Manifold.cube([BIG, BIG * 2, BIG * 2], true)
      .translate([spineX + BIG / 2, 0, 0]);
    const band = (cs) => Manifold.extrude(cs, hi - lo)
      .translate([0, 0, lo]).intersect(mask);

    // level the skin onto `target`: fill what falls short, trim what sticks out
    const fill = band(solidPart(target));
    const trim = band(CrossSection.square([BIG, BIG], true).subtract(target));
    const levelled = Manifold.difference([Manifold.union([solid, fill]), trim]);

    // then the ridges, one prism per line, all identical
    const section = solidPart(target.offset(depth, 'Miter', 2));
    const ridges = [];
    for (let i = 0; i < n; i++) {
      ridges.push(Manifold.extrude(section, p / 2).translate([0, 0, lo + i * p]));
    }
    // disjoint in z, so compose is exact and far cheaper than pairwise union
    return Manifold.union([levelled, Manifold.compose(ridges).intersect(mask)]);
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
    let pagesM = pageTexture(
      thicken(solidOf('pages', dx, dy), dz), dz, pitch, depth, dx, dy);

    // --- gridfinity: a baseplate standing on the compartment floor.
    // Added after the page lines, so the texture pass still sees the bare
    // compartment and keeps its walls smooth.
    const mode = o.gridfinity ?? 'none';
    let plateM = null, gridInfo = null;
    if (mode !== 'none') {
      const c = compartment();
      const fit = unitsFor({ width, length, thickness });
      const gx = Math.min(o.gridX ?? fit.gx, fit.gx);
      const gy = Math.min(o.gridY ?? fit.gy, fit.gy);
      const gap = o.gridGap ?? 0.5;
      const clearance = o.gridClearance ?? 0;
      if (gx >= 1 && gy >= 1) {
        const opts = { gx, gy, cx: c.cx, cy: c.cy, clearance };
        if (mode === 'integrated') {
          // no gap: it is the same solid as the block
          const bp = gf.baseplate(compartmentFootprint(dx, dy, 0), opts);
          if (bp) pagesM = pagesM.add(bp.translate([0, 0, c.floor]));
        } else {
          const bp = gf.baseplate(compartmentFootprint(dx, dy, gap), opts);
          if (bp) plateM = bp.translate([0, 0, c.floor]);
        }
      }
      gridInfo = {
        mode, gx, gy, gz: fit.gz, gap, clearance,
        innerW: c.w + dx, innerL: c.l + dy, innerDepth: c.depth + dz,
        slackW: (c.w + dx) - gx * GRID.pitch,
        slackL: (c.l + dy) - gy * GRID.pitch,
        slackDepth: (c.depth + dz) - fit.gz * GRID.heightUnit,
      };
    }

    return {
      case: caseM.translate([0, 0, drop.case]),
      cover: coverM.translate([0, 0, drop.cover]),
      pages: pagesM.translate([0, 0, drop.pages]),
      // present only when a separate drop-in plate was asked for
      plate: plateM ? plateM.translate([0, 0, drop.pages]) : null,
      info: { width, length, thickness, dx, dy, dz, pitch, depth, grid: gridInfo },
    };
  }

  return { build, thicken, pageTexture, solidOf, stretch1, cutter, engraveAll,
           compartment, compartmentFootprint, sizeForUnits, unitsFor, gridfinity: gf };
}
