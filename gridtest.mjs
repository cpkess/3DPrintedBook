// gridtest.mjs -- gridfinity fit checks, headless.
//
// The question a bin cares about is whether the socket in the *plate* follows
// the spec profile, so these measure the built plate rather than the helper
// that cut it.
import Module from './node_modules/manifold-3d/manifold.js';
import { createGenerator } from './src/book.js';
import { GRID } from './src/gridfinity.js';

const wasm = await Module(); wasm.setup();
const gen = createGenerator(wasm);
let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${msg}`); };

// radius of the spec profile at height z, linearly interpolated
function specRadius(z) {
  const R = GRID.rings;
  for (let i = 0; i < R.length - 1; i++) {
    const [z0, r0] = R[i], [z1, r1] = R[i + 1];
    if (z >= z0 - 1e-9 && z <= z1 + 1e-9) {
      return z1 === z0 ? r1 : r0 + (r1 - r0) * (z - z0) / (z1 - z0);
    }
  }
  return NaN;
}

function holes(m, z) {
  const out = [];
  for (const p of m.slice(z).toPolygons()) {
    let a = 0, xm = 1e9, xM = -1e9, ym = 1e9, yM = -1e9;
    for (let i = 0; i < p.length; i++) {
      const q = p[i], s = p[(i + 1) % p.length];
      a += q[0] * s[1] - s[0] * q[1];
      xm = Math.min(xm, q[0]); xM = Math.max(xM, q[0]);
      ym = Math.min(ym, q[1]); yM = Math.max(yM, q[1]);
    }
    if (a / 2 < 0) out.push({ w: xM - xm, h: yM - ym, cx: (xm + xM) / 2, cy: (ym + yM) / 2 });
  }
  return out;
}

console.log('compartment, measured off the mesh:');
const c = gen.compartment();
console.log(`  ${c.w.toFixed(3)} x ${c.l.toFixed(3)} x ${c.depth.toFixed(3)} mm,`
  + ` floor z=${c.floor.toFixed(4)}, centre (${c.cx.toFixed(3)}, ${c.cy.toFixed(3)})`);
check(c.rectError < 1e-6, `compartment outline is a true rectangle (area error ${c.rectError.toExponential(1)} mm2)`);

console.log('\nunit arithmetic round-trips:');
for (const [gx, gy, gz] of [[1,1,3],[2,3,3],[3,5,3],[3,5,4],[4,5,5],[5,5,9]]) {
  const s = gen.sizeForUnits({ gx, gy, gz, gap: 0.5 });
  const back = gen.unitsFor(s);
  check(back.gx === gx && back.gy === gy && back.gz === gz,
    `${gx}x${gy}x${gz} -> ${s.width.toFixed(2)} x ${s.length.toFixed(2)} x ${s.thickness.toFixed(2)} mm`
    + ` -> ${back.gx}x${back.gy}x${back.gz}`);
}

console.log('\nsocket profile in the built plate (every 0.05 mm):');
for (const [gx, gy, gz] of [[3,5,3],[2,2,4],[5,5,6]]) {
  const size = gen.sizeForUnits({ gx, gy, gz, gap: 0.5 });
  const r = gen.build({ ...size, gridfinity: 'plate' });
  const z0 = r.plate.boundingBox().min[2];
  let worst = 0, worstZ = 0, count = 0;
  for (let d = 0.02; d <= GRID.plateHeight - 0.02; d += 0.05) {
    const hs = holes(r.plate, z0 + d);
    if (hs.length !== gx * gy) { check(false, `${gx}x${gy}: ${hs.length} sockets at depth ${d.toFixed(2)}`); break; }
    const want = GRID.core + 2 * specRadius(d);
    for (const h of hs) {
      const e = Math.max(Math.abs(h.w - want), Math.abs(h.h - want));
      if (e > worst) { worst = e; worstZ = d; }
      count++;
    }
  }
  check(worst < 0.02, `${gx}x${gy}x${gz}: ${count} socket sections, worst profile error `
    + `${worst.toFixed(4)} mm at z=${worstZ.toFixed(2)}`);

  // pitch, straight off the mouths
  const mouths = holes(r.plate, z0 + GRID.plateHeight - 0.02);
  const ux = [...new Set(mouths.map(m => m.cx.toFixed(3)))].map(Number).sort((a, b) => a - b);
  const uy = [...new Set(mouths.map(m => m.cy.toFixed(3)))].map(Number).sort((a, b) => a - b);
  const dx = ux.slice(1).map((v, i) => v - ux[i]);
  const dy = uy.slice(1).map((v, i) => v - uy[i]);
  const pitchErr = Math.max(0, ...dx.concat(dy).map(v => Math.abs(v - GRID.pitch)));
  check(ux.length === gx && uy.length === gy && pitchErr < 1e-3,
    `${gx}x${gy}: ${ux.length}x${uy.length} sockets on a ${GRID.pitch} mm pitch (error ${pitchErr.toExponential(1)} mm)`);

  check(r.plate.decompose().filter(p => p.volume() > 1).length === 1
    && r.plate.genus() === gx * gy,
    `${gx}x${gy}: plate is one solid with ${r.plate.genus()} through-sockets`);
}

console.log('\ndepth available to a bin is exactly n x 7 mm:');
for (const gz of [3, 4, 5, 8]) {
  const size = gen.sizeForUnits({ gx: 3, gy: 5, gz, gap: 0.5 });
  const r = gen.build({ ...size, gridfinity: 'integrated' });
  const top = r.pages.boundingBox().max[2];
  const floor = c.floor + 11.712;   // drop.pages
  const usable = top - floor;
  check(Math.abs(usable - gz * GRID.heightUnit) < 5e-3,
    `${gz} units: ${usable.toFixed(3)} mm above the floor (want ${(gz * GRID.heightUnit).toFixed(3)})`);
}

console.log('\nan integrated plate leaves the compartment walls smooth:');
{
  const size = gen.sizeForUnits({ gx: 3, gy: 5, gz: 4, gap: 0.5 });
  const r = gen.build({ ...size, gridfinity: 'integrated' });
  const bb = r.pages.boundingBox();
  const zStart = c.floor + 11.712 + GRID.plateHeight + 0.2;
  const acc = { xm: [], xM: [], ym: [], yM: [] };
  for (let z = zStart; z <= bb.max[2] - 1; z += 0.05) {
    let best = null;
    for (const p of r.pages.slice(z).toPolygons()) {
      let a = 0, xm = 1e9, xM = -1e9, ym = 1e9, yM = -1e9;
      for (let i = 0; i < p.length; i++) {
        const q = p[i], s = p[(i + 1) % p.length];
        a += q[0] * s[1] - s[0] * q[1];
        xm = Math.min(xm, q[0]); xM = Math.max(xM, q[0]);
        ym = Math.min(ym, q[1]); yM = Math.max(yM, q[1]);
      }
      a /= 2;
      if (a < -10000 && (!best || a < best.a)) best = { a, xm, xM, ym, yM };
    }
    if (best) { acc.xm.push(best.xm); acc.xM.push(best.xM); acc.ym.push(best.ym); acc.yM.push(best.yM); }
  }
  const sp = (v) => Math.max(...v) - Math.min(...v);
  const worst = Math.max(sp(acc.xm), sp(acc.xM), sp(acc.ym), sp(acc.yM));
  check(worst < 1e-6, `${acc.xm.length} stations, wall peak-to-peak ${worst.toFixed(6)} mm`);
}

console.log(fail ? `\n${fail} FAILURES` : '\nall gridfinity checks passed');
process.exit(fail ? 1 : 0);
