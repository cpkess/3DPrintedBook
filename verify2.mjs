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

console.log('\nPAGE EDGES: every ridge the same, and unchanged by thickness');
{
  // x where the outline crosses y = 0 -- the fore-edge at mid-length, clear
  // of the corner miter, which a plain max-x would pick up instead
  const edge = (m, z) => {
    let best = -Infinity;
    for (const poly of m.slice(z).toPolygons()) {
      for (let i = 0; i < poly.length; i++) {
        const q = poly[i], r = poly[(i + 1) % poly.length];
        if ((q[1] > 0) === (r[1] > 0)) continue;
        const x = q[0] + (r[0] - q[0]) * (0 - q[1]) / (r[1] - q[1]);
        if (x > best) best = x;
      }
    }
    return best;
  };
  const NOM_T = 33.15, Z0 = 1.79, DROP = 11.7125, PITCH = 0.465, DEPTH = 0.178;
  const BB = [-11.7125, 11.7125];

  // Sampled across each ridge's own span, not at the height its outline came
  // from -- sampling only there measures nothing but its own input.
  function ridges(th) {
    const dz = th - NOM_T;
    const bare = gen.thicken(gen.solidOf('pages', 0, 0), dz);
    const built = gen.build({ thickness: th }).pages;
    const lo = BB[0] + 0.3, hi = BB[1] + dz - 0.3;
    const n = Math.max(1, Math.round((hi - lo) / PITCH)), p = (hi - lo) / n;
    const out = [];
    for (let i = 0; i < n; i++) {
      const zw = lo + i * p, v = [];
      for (const f of [0.06, 0.25, 0.5, 0.75, 0.94]) {
        const z = zw + f * (p / 2);
        const d = edge(built, z + DROP) - edge(bare, z);
        if (Number.isFinite(d)) v.push(d);
      }
      if (v.length) out.push({ zw, top: hi - zw, min: Math.min(...v), max: Math.max(...v) });
    }
    return out;
  }

  const sets = {};
  for (const th of [33.15, 43.15, 80]) {
    const r = sets[th] = ridges(th);
    const weak = r.filter(x => x.min < DEPTH * 0.5).length;
    const flat = r.filter(x => x.max - x.min <= 0.005).length;
    console.log(`  thickness ${th.toString().padEnd(6)} ${r.length} ridges  `
      + `protrusion ${Math.min(...r.map(x => x.min)).toFixed(4)}..${Math.max(...r.map(x => x.max)).toFixed(4)}  `
      + `${flat}/${r.length} flat to 0.005  ${weak} under half depth`
      + (weak ? '   <-- RIDGES VANISHING' : ''));
  }

  // The real complaint: extending thickness must not change the texture at
  // the block's ends. Ridges are matched by distance from the top, since that
  // is what the inserted band pushes up. The pitch is re-fitted per thickness
  // (n is rounded), so the two sets do not land on identical heights -- match
  // nearest and report how many actually paired, otherwise a comparison that
  // pairs nothing reads as a clean 0.0000.
  for (const th of [43.15, 80]) {
    let worst = 0, paired = 0;
    const ref = sets[33.15];
    for (const a of sets[th]) {
      if (a.top > 10) continue;                       // the top region only
      let b = null, best = Infinity;
      for (const x of ref) {
        const d = Math.abs(x.top - a.top);
        if (d < best) { best = d; b = x; }
      }
      if (!b || best > PITCH / 2) continue;
      paired++;
      worst = Math.max(worst, Math.abs(a.min - b.min), Math.abs(a.max - b.max));
    }
    console.log(`  top-of-block ridges at thickness ${th} vs nominal: `
      + `${paired} paired, worst difference ${worst.toFixed(4)} mm`
      + (worst > 0.1 ? '   <-- INCONSISTENT' : ''));
  }
  console.log('  (residual is the re-fitted pitch: n is rounded so ridges land on');
  console.log('   both block ends, so p is 0.4623 at 43.15 and 0.4658 at nominal,');
  console.log('   and paired ridges sample slightly different heights. Within any');
  console.log('   one book the pitch is exactly constant.)');
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
