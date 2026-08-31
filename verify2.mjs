import Module from './node_modules/manifold-3d/manifold.js';
import { createGenerator } from './src/book.js';
const wasm = await Module(); wasm.setup();
const gen = createGenerator(wasm);

function sliceY(man, y0) {
  const m = man.getMesh(), P = m.vertProperties, S = m.numProp, T = m.triVerts;
  const pts = [];
  for (let i = 0; i < T.length; i += 3) {
    const v = [0,1,2].map(k => { const j = T[i+k]*S; return [P[j],P[j+1],P[j+2]]; });
    const d = v.map(p => p[1]-y0);
    if (d.every(x=>x>0) || d.every(x=>x<0)) continue;
    for (let k = 0; k < 3; k++) {
      const a=v[k], b=v[(k+1)%3], da=d[k], db=d[(k+1)%3];
      if ((da>0)!==(db>0)) { const w=da/(da-db);
        pts.push([a[0]+w*(b[0]-a[0]), a[2]+w*(b[2]-a[2])]); }
    }
  }
  return pts;
}

console.log('CASE spine outer face -- flat run through the cut plane');
for (const th of [33.15, 43.15, 53.15]) {
  const r = gen.build({ thickness: th });
  const pts = sliceY(r.case, 0).filter(p => p[0] < -92.0);
  const xmin = Math.min(...pts.map(p=>p[0]));
  const flat = pts.filter(p => p[0] < xmin + 0.005).map(p=>p[1]).sort((a,b)=>a-b);
  console.log(`  thickness ${th.toString().padEnd(6)} spine x=${xmin.toFixed(3)}  `
    + `flat spans z ${flat[0].toFixed(2)}..${flat[flat.length-1].toFixed(2)} `
    + `= ${(flat[flat.length-1]-flat[0]).toFixed(2)} mm`
    + `   (expected ${(6.4 + th - 33.15).toFixed(2)})`);
}

console.log('\nPAGES fore-edge depth, measured as full crest-to-trough swing');
for (const [p,d] of [[0.465,0.178],[0.8,0.25],[1.2,0.15]]) {
  const r = gen.build({ pagePitch: p, pageDepth: d });
  const pts = sliceY(r.pages, 0).filter(q => q[0] > 86.0 && q[1] > 2 && q[1] < 20);
  const xs = pts.map(q=>q[0]);
  const swing = Math.max(...xs) - Math.min(...xs);
  console.log(`  requested depth ${d}  ->  measured peak-to-valley ${swing.toFixed(4)} mm`);
}

console.log('\nPAGE EDGES: every textured face the same, spine faces left alone');
{
  // where the outline crosses a line, on the far side -- the fore-edge, head
  // or tail surface clear of the corner miter a plain min/max would catch
  const cross = (m, z, mode, fixed) => {
    let best = mode.startsWith('min') ? Infinity : -Infinity;
    for (const poly of m.slice(z).toPolygons()) {
      for (let i = 0; i < poly.length; i++) {
        const q = poly[i], r = poly[(i + 1) % poly.length];
        const ai = mode.endsWith('@y') ? 1 : 0, vi = 1 - ai;
        if ((q[ai] > fixed) === (r[ai] > fixed)) continue;
        const v = q[vi] + (r[vi] - q[vi]) * (fixed - q[ai]) / (r[ai] - q[ai]);
        if (mode.startsWith('min')) { if (v < best) best = v; }
        else if (v > best) best = v;
      }
    }
    return best;
  };
  const NOM_T = 33.15, DROP = 11.7125, PITCH = 0.465, DEPTH = 0.178;
  const BB = [-11.7125, 11.7125];

  // The block is not a rectangle in plan: it steps at |y| = 76.82 and reaches
  // x -87.46 only in two wings, the sections carrying the dovetail. The head
  // and tail faces run across those wings and the designer textures them, so
  // they are probed here too -- the fore-edge alone would not have caught it.
  const FACES = [
    ['fore-edge  y=0   ', 'max@y', 0],
    ['head       x=+40 ', 'max@x', 40],
    ['head       x=-40 ', 'max@x', -40],
    ['head  WING x=-85 ', 'max@x', -85],
    ['tail  WING x=-85 ', 'min@x', -85],
  ];
  // and these must stay smooth: the wings' spine face carries a 0.88 mm
  // round-over, the inner one faces the hinge
  const SMOOTH = [
    ['wing spine  y=+100', 'min@y', 100],
    ['inner spine y=0   ', 'min@y', 0],
  ];

  for (const th of [33.15, 43.15, 80]) {
    const dz = th - NOM_T;
    const built = gen.build({ thickness: th }).pages;
    const lo = BB[0] + 0.3, hi = BB[1] + dz - 0.3;
    const n = Math.max(1, Math.round((hi - lo) / PITCH)), p = (hi - lo) / n;
    const sp = (v) => Math.max(...v) - Math.min(...v);
    let worstTip = 0, worstFloor = 0, dmin = Infinity, dmax = -Infinity;
    for (const [, mode, fixed] of FACES) {
      const tips = [], floors = [], dep = [];
      for (let i = 0; i < n - 1; i++) {
        const a = cross(built, lo + i * p + p / 4 + DROP, mode, fixed);
        const b = cross(built, lo + i * p + p * 0.75 + DROP, mode, fixed);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        tips.push(a); floors.push(b); dep.push(Math.abs(a - b));
      }
      worstTip = Math.max(worstTip, sp(tips));
      worstFloor = Math.max(worstFloor, sp(floors));
      dmin = Math.min(dmin, ...dep); dmax = Math.max(dmax, ...dep);
    }
    // A spine face carries a curve, not lines: its profile turns once or twice.
    // Only turns bigger than 5 microns count -- a flat prism face slices with
    // about 7 nanometres of floating-point jitter, which is hundreds of
    // meaningless sign changes over a tall block.
    let worstTurns = 0;
    for (const [, mode, fixed] of SMOOTH) {
      const prof = [];
      for (let z = lo + 0.4; z <= hi - 0.4; z += 0.03) {
        const v = cross(built, z + DROP, mode, fixed);
        if (Number.isFinite(v)) prof.push(v);
      }
      const d = prof.slice(1).map((v, i) => v - prof[i]);
      worstTurns = Math.max(worstTurns, d.slice(1).filter(
        (v, i) => (v > 0) !== (d[i] > 0) && Math.abs(v) > 0.005).length);
    }
    console.log(`  thickness ${th.toString().padEnd(6)} ${FACES.length} textured faces  `
      + `tip spread ${worstTip.toFixed(6)}  floor spread ${worstFloor.toFixed(6)}  `
      + `depth ${dmin.toFixed(4)}..${dmax.toFixed(4)}  spine turns ${worstTurns}`
      + (worstTip > 1e-4 || worstFloor > 1e-4 ? '   <-- FACES DO NOT MATCH' : '')
      + (Math.abs(dmin - DEPTH) > 1e-3 || Math.abs(dmax - DEPTH) > 1e-3 ? '   <-- WRONG DEPTH' : '')
      + (worstTurns > 8 ? '   <-- SPINE FACE TEXTURED' : ''));
  }
}

console.log('\nCavity volume grows with thickness (compartment, not a solid slab):');
let prev = null;
for (const th of [33.15, 43.15, 53.15]) {
  const r = gen.build({ thickness: th });
  const bb = r.pages.boundingBox();
  const solid = r.pages.volume();
  const box = (bb.max[0]-bb.min[0])*(bb.max[1]-bb.min[1])*(bb.max[2]-bb.min[2]);
  const hollow = box - solid;
  console.log(`  thickness ${th.toString().padEnd(6)} block ${(solid/1000).toFixed(1)}cm3  `
    + `void inside bbox ${(hollow/1000).toFixed(1)}cm3` + (prev!==null ? `  (+${((hollow-prev)/1000).toFixed(1)})` : ''));
  prev = hollow;
}
