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

console.log('\nPAGE EDGES: the middle\'s pattern everywhere, at every thickness');
{
  // x where the outline crosses y -- the fore-edge clear of the corner miter,
  // which a plain max-x would pick up instead
  const edgeAt = (m, z, y) => {
    let best = -Infinity;
    for (const poly of m.slice(z).toPolygons()) {
      for (let i = 0; i < poly.length; i++) {
        const q = poly[i], r = poly[(i + 1) % poly.length];
        if ((q[1] > y) === (r[1] > y)) continue;
        const x = q[0] + (r[0] - q[0]) * (y - q[1]) / (r[1] - q[1]);
        if (x > best) best = x;
      }
    }
    return best;
  };
  const NOM_T = 33.15, DROP = 11.7125, PITCH = 0.465, DEPTH = 0.178;
  const BB = [-11.7125, 11.7125];

  // Measured on the BUILT block, tip against the floor of the next groove.
  // Comparing against the untextured block would measure the wrong thing now:
  // the skin is levelled first, so the groove floor is no longer the bare
  // block's surface.
  function grooves(th, y) {
    const dz = th - NOM_T;
    const built = gen.build({ thickness: th }).pages;
    const lo = BB[0] + 0.3, hi = BB[1] + dz - 0.3;
    const n = Math.max(1, Math.round((hi - lo) / PITCH)), p = (hi - lo) / n;
    const tips = [], floors = [], depths = [];
    for (let i = 0; i < n - 1; i++) {
      const a = edgeAt(built, lo + i * p + p / 4 + DROP, y);       // ridge
      const b = edgeAt(built, lo + i * p + p * 0.75 + DROP, y);    // groove
      if (Number.isFinite(a) && Number.isFinite(b)) {
        tips.push(a); floors.push(b); depths.push(a - b);
      }
    }
    return { tips, floors, depths };
  }

  const sp = (v) => Math.max(...v) - Math.min(...v);
  const surfaces = {};
  for (const th of [33.15, 43.15, 80]) {
    let tip = 0, floor = 0, dmin = Infinity, dmax = -Infinity, nn = 0;
    for (const y of [0, 80]) {
      const g = grooves(th, y);
      tip = Math.max(tip, sp(g.tips)); floor = Math.max(floor, sp(g.floors));
      dmin = Math.min(dmin, ...g.depths); dmax = Math.max(dmax, ...g.depths);
      nn = g.depths.length;
      if (y === 0) surfaces[th] = g.tips[0];
    }
    console.log(`  thickness ${th.toString().padEnd(6)} ${nn} grooves  `
      + `tip spread ${tip.toFixed(6)}  floor spread ${floor.toFixed(6)}  `
      + `depth ${dmin.toFixed(4)}..${dmax.toFixed(4)} (want ${DEPTH})`
      + (tip > 1e-4 || floor > 1e-4 ? '   <-- ENDS DO NOT MATCH THE MIDDLE' : '')
      + (Math.abs(dmin - DEPTH) > 1e-3 || Math.abs(dmax - DEPTH) > 1e-3
          ? '   <-- WRONG DEPTH' : ''));
  }
  for (const th of [43.15, 80]) {
    const d = Math.abs(surfaces[th] - surfaces[33.15]);
    console.log(`  fore-edge surface at ${th} vs nominal: shift ${d.toFixed(6)} mm`
      + (d > 1e-4 ? '   <-- SURFACE MOVED' : ''));
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
