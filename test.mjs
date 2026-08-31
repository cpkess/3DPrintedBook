import Module from './node_modules/manifold-3d/manifold.js';
import { createGenerator, PARTS } from './src/book.js';

const wasm = await Module(); wasm.setup();
const gen = createGenerator(wasm);

const NOM = { w: 185.503, l: 239.179, t: 33.150 };
const cases = [
  ['nominal',        {}],
  ['narrow+short',   { width: 120, length: 150 }],
  ['wide+long',      { width: 250, length: 250 }],
  ['thick +10',      { thickness: 43.15 }],
  ['thick +47',      { thickness: 80 }],
  ['all extremes',   { width: 250, length: 250, thickness: 80 }],
  ['small + thick',  { width: 120, length: 150, thickness: 60 }],
];

let fail = 0;
for (const [label, p] of cases) {
  const t0 = Date.now();
  const r = gen.build(p);
  const ms = Date.now() - t0;
  const row = [];
  for (const k of ['case', 'cover', 'pages']) {
    const m = r[k];
    const bb = m.boundingBox();
    const genus = m.genus();
    const vol = m.volume();
    const ok = m.isEmpty() === false && vol > 0;
    if (!ok) { fail++; }
    row.push(`${k}: vol=${(vol/1000).toFixed(1)}cm3 tris=${m.numTri()} genus=${genus}`);
  }
  const bb = r.case.boundingBox();
  const size = [bb.max[0]-bb.min[0], bb.max[1]-bb.min[1], bb.max[2]-bb.min[2]];
  const want = [p.width ?? NOM.w, p.length ?? NOM.l, Math.max(NOM.t, p.thickness ?? NOM.t)];
  const err = size.map((v,i)=>Math.abs(v-want[i]));
  const dimOK = err.every(e => e < 0.02);
  if (!dimOK) fail++;
  console.log(`${label.padEnd(15)} ${ms.toString().padStart(5)}ms  case bbox `
    + `${size.map(v=>v.toFixed(2)).join(' x ')}  want ${want.map(v=>v.toFixed(2)).join(' x ')}  `
    + (dimOK ? 'OK' : `DIM ERROR ${err.map(e=>e.toFixed(3))}`));
  console.log('                ' + row.join('  '));
}

// page line count check
console.log('\npage line count vs thickness:');
for (const t of [33.15, 38, 50, 80]) {
  const r = gen.build({ thickness: t });
  console.log(`  thickness ${t.toString().padStart(5)}  pages tris ${r.pages.numTri()}`);
}
console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
