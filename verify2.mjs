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

console.log('\nPAGE EDGES: one pattern everywhere, and unchanged by thickness');
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
  const NOM_T = 33.15, DROP = 11.7125, PITCH = 0.465, BB = [-11.7125, 11.7125];

  function ridges(th, y) {
    const dz = th - NOM_T;
    const bare = gen.thicken(gen.solidOf('pages', 0, 0), dz);
    const built = gen.build({ thickness: th }).pages;
    const lo = BB[0] + 0.3, hi = BB[1] + dz - 0.3;
    const n = Math.max(1, Math.round((hi - lo) / PITCH)), p = (hi - lo) / n;
    const tips = [], prot = [];
    for (let i = 0; i < n; i++) {
      const zc = lo + i * p + p / 4;
      const a = edgeAt(built, zc + DROP, y), b = edgeAt(bare, zc, y);
      if (Number.isFinite(a) && Number.isFinite(b)) { tips.push(a); prot.push(a - b); }
    }
    return { tips, prot };
  }

  // Every ridge must reach the same outer surface -- that is what makes the
  // block's ends read like its middle. What varies instead is how deep each
  // one is cut into a base that still wanders by 0.228 mm of erosion residual.
  const ref = {};
  for (const th of [33.15, 43.15, 80]) {
    let worstTip = 0, minProt = Infinity;
    for (const y of [0, 80]) {
      const r = ridges(th, y);
      worstTip = Math.max(worstTip, Math.max(...r.tips) - Math.min(...r.tips));
      minProt = Math.min(minProt, Math.min(...r.prot));
      if (y === 0) ref[th] = r.prot.slice().sort((a, b) => a - b);
    }
    console.log(`  thickness ${th.toString().padEnd(6)} tip spread ${worstTip.toFixed(6)} mm`
      + `   shallowest ridge ${minProt.toFixed(4)} mm`
      + (worstTip > 1e-4 ? '   <-- RIDGES NOT ALIGNED' : '')
      + (minProt <= 0 ? '   <-- RIDGES VANISHING' : ''));
  }

  // and the outer surface those ridges reach must not move when thickness
  // does. Comparing the *set of depths* instead would be meaningless: the
  // pitch is re-fitted per thickness (n is rounded so ridges land on both
  // block ends), so ridges sample the wandering base at different heights
  // and the depths legitimately differ. Where the tips land does not.
  for (const th of [43.15, 80]) {
    const a = ridges(th, 0).tips[0], b = ridges(33.15, 0).tips[0];
    console.log(`  fore-edge surface at ${th} vs nominal: x ${a.toFixed(4)} vs `
      + `${b.toFixed(4)}, shift ${Math.abs(a - b).toFixed(6)} mm`
      + (Math.abs(a - b) > 1e-4 ? '   <-- SURFACE MOVED' : ''));
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
