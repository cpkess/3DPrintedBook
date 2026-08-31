// app.js -- viewport, controls and export wiring.
// All geometry lives in book.js, which has no DOM dependency so it can be
// tested headless under Node.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ManifoldModule from 'manifold-3d';
import * as opentype from 'opentype';
import { createGenerator, PARTS } from './book.js';
import { textPolygons, meshToSTL, meshesTo3MF } from './export.js';
import { svgPolygons, fitPolygons } from './svg.js';
import { DATA } from './data.js';

const $ = (id) => document.getElementById(id);

// Anything that throws must end up on screen. The first version of this file
// died in updateReadouts() before the try block and left the HUD reading
// "starting..." forever with nothing in the UI to say why.
function fail(where, e) {
  console.error(where, e);
  const box = document.getElementById('err');
  if (box) box.textContent = `${where}: ${e && e.message ? e.message : e}`;
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = 'failed — see the message in the sidebar';
  const busy = document.getElementById('busy');
  if (busy) busy.classList.remove('show');
}
addEventListener('error', (e) => fail('Script error', e.error || e.message));
addEventListener('unhandledrejection', (e) => fail('Async error', e.reason));

function status(msg) {
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = msg;
}
const PLATE = 250;

// The first entry is vendored, so the app can engrave titles with no network
// at all. The rest are fetched on demand and fail soft if unreachable.
const FONTS = [
  ['Liberation Serif (offline)', './vendor/LiberationSerif-Regular.ttf'],
  ['EB Garamond', 'https://cdn.jsdelivr.net/fontsource/fonts/eb-garamond@latest/latin-400-normal.ttf'],
  ['Libre Baskerville', 'https://cdn.jsdelivr.net/fontsource/fonts/libre-baskerville@latest/latin-400-normal.ttf'],
  ['Playfair Display', 'https://cdn.jsdelivr.net/fontsource/fonts/playfair-display@latest/latin-400-normal.ttf'],
  ['Lora', 'https://cdn.jsdelivr.net/fontsource/fonts/lora@latest/latin-400-normal.ttf'],
  ['Cinzel', 'https://cdn.jsdelivr.net/fontsource/fonts/cinzel@latest/latin-400-normal.ttf'],
  ['Roboto Slab', 'https://cdn.jsdelivr.net/fontsource/fonts/roboto-slab@latest/latin-400-normal.ttf'],
];

// ---------------------------------------------------------------- viewport

const main = $('main');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
main.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12100e);
const camera = new THREE.PerspectiveCamera(38, 1, 1, 5000);
camera.position.set(360, -430, 300);
camera.up.set(0, 0, 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 20);

scene.add(new THREE.HemisphereLight(0xf2e6d2, 0x2a231a, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(220, -320, 420);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9ab8d0, 0.5);
rim.position.set(-300, 220, 120);
scene.add(rim);

const grid = new THREE.GridHelper(600, 24, 0x3a332a, 0x262119);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

const MATS = {
  case: new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: .78, metalness: .04 }),
  cover: new THREE.MeshStandardMaterial({ color: 0x9c6a3d, roughness: .78, metalness: .04 }),
  pages: new THREE.MeshStandardMaterial({ color: 0xd9cfb6, roughness: .92, metalness: 0 }),
  plate: new THREE.MeshStandardMaterial({ color: 0x7fa66a, roughness: .7, metalness: .05 }),
};
// case | cover | pages | plate -- `plate` only exists in drop-in mode
const ORDER = ['case', 'cover', 'pages', 'plate'];
const group = new THREE.Group();
scene.add(group);

function resize() {
  const w = main.clientWidth, h = main.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(main);
resize();
(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
})();

let fitted = false;
function fitView() {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.62;
  const d = radius / Math.sin((camera.fov * Math.PI / 180) / 2);
  controls.target.copy(c);
  camera.position.set(c.x + d * 0.45, c.y - d * 0.78, c.z + d * 0.52);
  camera.near = d / 100; camera.far = d * 10;
  camera.updateProjectionMatrix();
  controls.update();
}

function manifoldToThree(mesh) {
  const g = new THREE.BufferGeometry();
  const S = mesh.numProp;
  const n = mesh.vertProperties.length / S;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i*3] = mesh.vertProperties[i*S];
    pos[i*3+1] = mesh.vertProperties[i*S+1];
    pos[i*3+2] = mesh.vertProperties[i*S+2];
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- state

let gen = null;
let font = null;
let decalArt = null;   // { polys, view, name } from the uploaded SVG
let last = null;
const visible = { case: true, cover: true, pages: true, plate: true };
let queued = false, running = false;

const num = (id) => parseFloat($(id).value);

// Gridfinity sizing is a view onto the same three millimetre dimensions, not
// a second set: the unit sliders are converted here and everything downstream
// still sees width/length/thickness in mm.
function params() {
  const sizeMode = $('sizemode').value;
  const gx = num('gx'), gy = num('gy'), gz = num('gz'), slack = num('gslack');
  const mm = { width: num('width'), length: num('length'), thickness: num('thick') };
  const size = sizeMode === 'grid' && gen
    ? gen.sizeForUnits({ gx, gy, gz, gap: slack })
    : mm;
  return {
    ...size, sizeMode, gx, gy, gz, slack,
    pagePitch: num('pitch'), pageDepth: num('pdepth'), etchDepth: num('etch'),
    f1: $('f1').value, f2: $('f2').value, sp: $('sp').value,
    fsize: num('fsize'), ssize: num('ssize'), track: num('track'),
    gfMode: $('gfmode').value,
    decalMode: $('decalmode').value,
    decalFit: num('decalfit'), decalDepth: num('decaldepth'),
    gfx: num('gfx'), gfy: num('gfy'),
    gclear: num('gclear'), ggap: num('ggap'),
  };
}

// The uploaded artwork, scaled into the panel. Recomputed per build so the
// fit slider works without re-parsing the file.
function decalShapesFor(p) {
  if (p.decalMode !== 'svg' || !decalArt || !gen) return null;
  const d = gen.DECAL;
  const polys = fitPolygons(decalArt.polys, decalArt.view, d.w, d.h, p.decalFit);
  return polys.length ? polys : null;
}

function shapesFor(str, size, track) {
  if (!font || !str.trim()) return null;
  const r = textPolygons(font, str, size, track);
  return r.polys.length ? r.polys : null;
}

function updateReadouts(p) {
  const grid = p.sizeMode === 'grid';
  $('mmSize').hidden = grid;
  $('gridSize').hidden = !grid;
  $('vw').textContent = p.width.toFixed(1);
  $('vl').textContent = p.length.toFixed(1);
  $('vt').textContent = p.thickness.toFixed(2);
  $('vgx').textContent = p.gx.toFixed(0);
  $('vgy').textContent = p.gy.toFixed(0);
  $('vgz').textContent = p.gz.toFixed(0);
  $('vgs').textContent = p.slack.toFixed(2);
  $('vgfx').textContent = p.gfx ? p.gfx.toFixed(0) : 'auto';
  $('vgfy').textContent = p.gfy ? p.gfy.toFixed(0) : 'auto';
  $('vgc').textContent = p.gclear.toFixed(2);
  $('vgg').textContent = p.ggap.toFixed(2);
  $('vdf').textContent = p.decalFit.toFixed(2);
  $('vdd').textContent = p.decalDepth.toFixed(3);
  $('decalHint').innerHTML = p.decalMode === 'original'
    ? 'The moulded panel is used as-is.'
    : p.decalMode === 'none'
      ? 'Panel filled back to the spine face.'
      : decalArt
        ? `${decalArt.name}: ${decalArt.polys.length} outline${decalArt.polys.length === 1 ? '' : 's'}, `
          + `drawn ${decalArt.view.w.toFixed(0)} &times; ${decalArt.view.h.toFixed(0)} in its own units.`
        : '<span class="warn">No SVG loaded — the panel is filled smooth.</span>';

  if (gen) {
    const fit = gen.unitsFor(p);
    const c = gen.compartment();
    const inner = [c.w + (p.width - DATA.nominal.w), c.l + (p.length - DATA.nominal.l),
                   c.depth + (p.thickness - DATA.nominal.t)];
    if (grid) {
      // thickness clamps at nominal, so a small height request can come back
      // deeper than asked for -- say so rather than silently overshooting
      const over = fit.gz > p.gz;
      $('gridSizeHint').innerHTML =
        `Compartment ${inner[0].toFixed(1)} &times; ${inner[1].toFixed(1)} &times; `
        + `${inner[2].toFixed(1)} mm for ${p.gx}&times;${p.gy}&times;${p.gz} units`
        + (over ? ` — thickness cannot go below nominal, so this is `
                  + `${fit.gz} units deep.` : '.');
    }
    $('gfHint').innerHTML = p.gfMode === 'none'
      ? `Compartment holds ${fit.gx} &times; ${fit.gy} &times; ${fit.gz} gridfinity units.`
      : `${Math.min(p.gfx || fit.gx, fit.gx)} &times; `
        + `${Math.min(p.gfy || fit.gy, fit.gy)} sockets, `
        + `${fit.gz} height units of clearance above the floor.`;
  }

  $('vfs').textContent = p.fsize.toFixed(1);
  $('vss').textContent = p.ssize.toFixed(1);
  $('vtr').textContent = p.track.toFixed(1);
  $('vpp').textContent = p.pagePitch.toFixed(3);
  $('vpd').textContent = p.pageDepth.toFixed(3);
  $('ved').textContent = p.etchDepth.toFixed(3);

  const over = p.width > PLATE || p.length > PLATE;
  $('plateWarn').innerHTML = over
    ? `<span class="warn">${p.width.toFixed(0)} × ${p.length.toFixed(0)} mm exceeds a
       ${PLATE} mm plate — the case will not print.</span>`
    : `Footprint ${p.width.toFixed(0)} × ${p.length.toFixed(0)} mm
       (${PLATE} mm plate leaves ${(PLATE - Math.max(p.width, p.length)).toFixed(0)} mm).`;

  // spine channel fit
  if (font && $('sp').value.trim()) {
    const r = textPolygons(font, $('sp').value, p.ssize, p.track);
    const avail = 183.686 + (p.length - DATA.nominal.l);
    $('fitHint').innerHTML = r.width > avail
      ? `<span class="warn">Spine title is ${r.width.toFixed(0)} mm; the channel is
         ${avail.toFixed(0)} mm. Reduce size or spacing.</span>`
      : `Spine title ${r.width.toFixed(0)} mm of ${avail.toFixed(0)} mm available.`;
  }
}

async function regenerate() {
  if (running) { queued = true; return; }
  running = true;
  $('busy').classList.add('show');
  $('err').textContent = '';
  await new Promise(r => setTimeout(r, 0));
  const t0 = performance.now();
  try {
    const p = params();
    updateReadouts(p);
    const tText = performance.now();
    const shapes = {
      front1Shapes: shapesFor(p.f1, p.fsize, p.track),
      front2Shapes: shapesFor(p.f2, p.fsize, p.track),
      spineShapes: shapesFor(p.sp, p.ssize, p.track),
    };
    const msText = performance.now() - tText;
    const tCSG = performance.now();
    const r = gen.build({
      width: p.width, length: p.length, thickness: p.thickness,
      pagePitch: p.pagePitch, pageDepth: p.pageDepth, etchDepth: p.etchDepth,
      gridfinity: p.gfMode,
      spineDecal: p.decalMode,
      decalShapes: decalShapesFor(p),
      decalDepth: p.decalDepth,
      gridX: p.gfx || undefined, gridY: p.gfy || undefined,
      gridClearance: p.gclear, gridGap: p.ggap,
      ...shapes,
    });
    // manifold is lazy: build() returns a promise-of-geometry and does the
    // real work on first access. Force it here so the timer means something.
    ORDER.forEach((k) => { if (r[k]) r[k].numTri(); });
    const msCSG = performance.now() - tCSG;
    last = r;
    const tGL = performance.now();
    group.clear();
    let tris = 0;
    const present = ORDER.filter((k) => r[k]);
    $('plateBtn').hidden = !r.plate;
    const spread = p.width + 15;
    present.forEach((k, i) => {
      tris += r[k].numTri();
      if (!visible[k]) return;
      const m = new THREE.Mesh(manifoldToThree(r[k].getMesh()), MATS[k]);
      m.position.x = (i - (present.length - 1) / 2) * spread;
      group.add(m);
    });
    const msGL = performance.now() - tGL;
    if (!fitted) { fitView(); fitted = true; }
    const ms = performance.now() - t0;
    $('hud').textContent =
      `${p.width.toFixed(1)} × ${p.length.toFixed(1)} × ${p.thickness.toFixed(2)} mm\n` +
      `${tris.toLocaleString()} triangles\n` +
      `${ms.toFixed(0)} ms  (text ${msText.toFixed(0)} · csg ${msCSG.toFixed(0)} · gl ${msGL.toFixed(0)})\n` +
      present.map((k) => `${k} ${(r[k].volume()/1000).toFixed(0)} cm³`).join('  ') +
      (r.info.grid
        ? `\ngridfinity ${r.info.grid.gx}×${r.info.grid.gy}×${r.info.grid.gz} units`
        : '');
  } catch (e) {
    fail('Generation failed', e);
  }
  $('busy').classList.remove('show');
  running = false;
  if (queued) { queued = false; regenerate(); }
}

let timer = null;
function schedule() { clearTimeout(timer); timer = setTimeout(regenerate, 140); }

// ---------------------------------------------------------------- downloads

function save(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

$('dl3mf').onclick = () => {
  if (!last) return;
  const p = params();
  const parts = [];
  const present = ORDER.filter((k) => last[k]);
  const spread = p.width + 15;
  present.forEach((k, i) => {
    parts.push({ name: k, mesh: last[k].getMesh(),
                 offset: [(i - (present.length - 1) / 2) * spread, 0] });
  });
  save(meshesTo3MF(parts), 'hidden-book.3mf', 'model/3mf');
};

$('dlstl').onclick = () => {
  if (!last) return;
  const k = ORDER.find(x => last[x] && visible[x]) || 'case';
  save(meshToSTL(last[k].getMesh(), k), `hidden-book-${k}.stl`, 'model/stl');
};

document.querySelectorAll('#parts button').forEach(b => {
  b.onclick = () => {
    const k = b.dataset.p;
    visible[k] = !visible[k];
    b.classList.toggle('on', visible[k]);
    regenerate();
  };
});

// ---------------------------------------------------------------- boot

async function loadFont(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  font = opentype.parse(buf);
}

(async function boot() {
 try {
  const sel = $('font');
  FONTS.forEach(([n, u]) => {
    const o = document.createElement('option');
    o.value = u; o.textContent = n; sel.appendChild(o);
  });
  sel.onchange = async () => {
    try { await loadFont(sel.value); regenerate(); }
    catch (e) { $('err').textContent = 'Font load failed: ' + e.message; }
  };
  $('fontFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    font = opentype.parse(await f.arrayBuffer());
    regenerate();
  };

  status('loading CSG engine...');
  const wasm = await ManifoldModule();
  wasm.setup();
  gen = createGenerator(wasm);

  status('loading font...');
  try { await loadFont(FONTS[0][1]); }
  catch (e) {
    console.warn('font load failed', e);
    $('err').textContent =
      'Could not fetch the default font. Titles will be skipped — '
      + 'pick another font or load a .ttf below.';
  }

  status('generating...');

  ['width','length','thick','pitch','pdepth','etch','fsize','ssize','track',
   'gx','gy','gz','gslack','gfx','gfy','gclear','ggap','decalfit','decaldepth']
    .forEach(id => $(id).addEventListener('input', schedule));
  ['f1','f2','sp'].forEach(id => $(id).addEventListener('input', schedule));
  ['sizemode','gfmode','decalmode'].forEach(id => $(id).addEventListener('change', regenerate));

  $('decalFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const parsed = svgPolygons(await f.text());
      if (!parsed.polys.length) throw new Error('no filled outlines found');
      decalArt = { ...parsed, name: f.name };
      $('decalmode').value = 'svg';
      regenerate();
    } catch (err) {
      decalArt = null;
      $('err').textContent = `Could not read ${f.name}: ${err.message}`;
    }
  };

  window.__book = { get last() { return last; }, gen, params, regenerate, fitView };
  regenerate();
 } catch (e) { fail('Startup failed', e); }
})();
