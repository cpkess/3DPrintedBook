import Module from './node_modules/manifold-3d/manifold.js';
import { createGenerator } from './src/book.js';
import { DATA } from './src/data.js';
const wasm = await Module(); wasm.setup();
const { CrossSection } = wasm;
const gen = createGenerator(wasm);
const drop = DATA.drop.pages;
const bare = gen.thicken(gen.solidOf('pages',0,0), 0);
const built = gen.build({}).pages;
const box = CrossSection.square([8.2,153.6],true).translate([-83.35,0]);
let rows=[];
for(let z=-11.4;z<=11.4;z+=0.05){
  const a=bare.slice(z).intersect(box).area();
  const b=built.slice(z+drop).intersect(box).area();
  if (Math.abs(a-b) > 1e-6) rows.push([z, a, b, b-a]);
}
console.log(`heights where the notch area differs: ${rows.length}`);
for (const r of rows.slice(0,8)) console.log(`  z=${r[0].toFixed(2)}  bare ${r[1].toFixed(4)}  built ${r[2].toFixed(4)}  Δ${r[3].toFixed(6)}`);
if (rows.length>8) console.log(`  ... worst Δ ${rows.reduce((m,r)=>Math.abs(r[3])>Math.abs(m)?r[3]:m,0).toFixed(6)}`);
