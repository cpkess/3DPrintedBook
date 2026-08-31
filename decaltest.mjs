// decaltest.mjs -- the spine decal panel and the SVG that can replace it.
import Module from './node_modules/manifold-3d/manifold.js';
import { createGenerator } from './src/book.js';
import { svgPolygons, fitPolygons } from './src/svg.js';
import { DATA } from './src/data.js';

const wasm = await Module(); wasm.setup();
const gen = createGenerator(wasm);
const D = gen.DECAL;
let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${msg}`); };

// x of the spine face where the outline crosses y, at height z
const xAt = (m, z, y) => {
  let best = Infinity;
  for (const poly of m.slice(z).toPolygons()) {
    for (let i = 0; i < poly.length; i++) {
      const q = poly[i], r = poly[(i + 1) % poly.length];
      if ((q[1] > y) === (r[1] > y)) continue;
      const v = q[0] + (r[0] - q[0]) * (y - q[1]) / (r[1] - q[1]);
      if (v < best) best = v;
    }
  }
  return best;
};
// bounding box of whatever is recessed on the spine, near the panel
function recess(m, dz) {
  const cz = D.cz + dz / 2 + DATA.drop.case;
  let n = 0, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  let deep = 0, shallow = Infinity;
  for (let z = cz - 16; z <= cz + 16; z += 0.25) {
    const ref = xAt(m, z, 0);
    if (!Number.isFinite(ref)) continue;
    for (let y = -116; y <= -82; y += 0.25) {
      const v = xAt(m, z, y);
      if (!Number.isFinite(v) || v <= ref + 0.3) continue;
      n++; deep = Math.max(deep, v - ref); shallow = Math.min(shallow, v - ref);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
  }
  return { n, y0, y1, z0, z1, deep, shallow, cz };
}

console.log('the moulded panel is where DECAL says it is:');
{
  const r = recess(gen.build({}).case, 0);
  check(Math.abs((r.y1 - r.y0) - D.w) < 0.6 && Math.abs((r.z1 - r.z0) - D.h) < 0.6,
    `size ${(r.y1 - r.y0).toFixed(3)} x ${(r.z1 - r.z0).toFixed(3)} mm (DECAL says ${D.w} x ${D.h})`);
  check(Math.abs((r.y0 + r.y1) / 2 - D.cy) < 0.3,
    `centred at y ${((r.y0 + r.y1) / 2).toFixed(3)} (DECAL says ${D.cy})`);
  check(Math.abs((r.z0 + r.z1) / 2 - r.cz) < 0.3,
    `centred at local z ${((r.z0 + r.z1) / 2 - DATA.drop.case).toFixed(3)} (DECAL says ${D.cz})`);
  // The moulded floor is flat and the spine face is curved, so the cut is
  // shallower at the panel's ends than across its middle. DECAL.depth is the
  // modal value; assert it lies inside the range actually present.
  check(D.depth >= r.shallow - 0.02 && D.depth <= r.deep + 0.02,
    `cut ${r.shallow.toFixed(3)}..${r.deep.toFixed(3)} mm deep, DECAL.depth ${D.depth} sits inside it`);
}

console.log('\nturning it off leaves nothing recessed, at any thickness:');
for (const t of [33.15, 43.15, 60, 80]) {
  const dz = t - DATA.nominal.t;
  const a = recess(gen.build({ thickness: t }).case, dz);
  const b = recess(gen.build({ thickness: t, spineDecal: 'none' }).case, dz);
  check(b.n === 0, `thickness ${t}: ${a.n} recessed samples with the panel, ${b.n} without`);
}

console.log('\na replacement is placed, not inherited, so it never stretches:');
{
  const art = svgPolygons('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>');
  const shapes = fitPolygons(art.polys, art.view, D.w, D.h, 0.8);
  const want = D.w * 0.8 * 0.8;                       // r40 of a 100 viewBox
  let ref = null;
  for (const t of [33.15, 43.15, 80]) {
    const dz = t - DATA.nominal.t;
    const r = recess(gen.build({ thickness: t, spineDecal: 'svg', decalShapes: shapes }).case, dz);
    const size = [r.y1 - r.y0, r.z1 - r.z0];
    if (ref === null) ref = size;
    check(Math.abs(size[0] - want) < 0.6 && Math.abs(size[1] - want) < 0.6
      && Math.abs(size[0] - ref[0]) < 1e-9 && Math.abs(size[1] - ref[1]) < 1e-9,
      `thickness ${String(t).padStart(5)}: ${size[0].toFixed(3)} x ${size[1].toFixed(3)} mm `
      + `(want ${want.toFixed(3)}, and identical at every thickness)`);
  }
  // the moulded one does stretch -- that is the bug the replacement avoids
  const a0 = recess(gen.build({}).case, 0), a1 = recess(gen.build({ thickness: 80 }).case, 46.85);
  console.log(`  (for contrast, the moulded panel goes ${(a0.z1 - a0.z0).toFixed(2)} mm -> `
    + `${(a1.z1 - a1.z0).toFixed(2)} mm tall between 33.15 and 80)`);
}

console.log('\nSVG fill rules survive the trip into geometry:');
{
  const ring = (rule) => {
    const art = svgPolygons(`<svg viewBox="0 0 100 100"><path ${rule} `
      + `d="M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z"/></svg>`);
    const shapes = fitPolygons(art.polys, art.view, D.w, D.h, 0.9);
    const c = gen.build({ spineDecal: 'svg', decalShapes: shapes }).case;
    const z = DATA.drop.case, ref = xAt(c, z, 0);
    return { mid: xAt(c, z, D.cy) - ref, band: xAt(c, z, D.cy - 8) - ref };
  };
  const eo = ring('fill-rule="evenodd"');
  check(eo.mid < 0.05 && eo.band > 1.0,
    `even-odd: centre ${eo.mid.toFixed(4)} mm (want ~0, it is a hole), `
    + `band ${eo.band.toFixed(4)} mm (want ~${D.depth})`);
  const nz = ring('');
  check(nz.mid > 1.0 && nz.band > 1.0,
    `nonzero same-wound: centre ${nz.mid.toFixed(4)} mm (want ~${D.depth}, solid)`);
}

console.log(fail ? `\n${fail} FAILURES` : '\nall decal checks passed');
process.exit(fail ? 1 : 0);
