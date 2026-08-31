import puppeteer from 'puppeteer';
import { spawn } from 'child_process';

const srv = spawn('node', ['serve.mjs'], { env: { ...process.env, PORT: '8099' } });
await new Promise(r => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome',
  headless: 'new',
  args: ['--no-sandbox','--disable-gpu','--use-gl=swiftshader','--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const logs = [], errs = [], failed = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => errs.push(String(e)));
page.on('requestfailed', r => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded', timeout: 30000 });

// wait for the HUD to stop saying "starting"/"loading"
let hud = '';
for (let i = 0; i < 60; i++) {
  hud = await page.$eval('#hud', e => e.textContent);
  if (!/starting|loading|generating\.\.\./i.test(hud)) break;
  await new Promise(r => setTimeout(r, 500));
}
const err = await page.$eval('#err', e => e.textContent);
const tris = await page.evaluate(() => document.querySelectorAll('canvas').length);

console.log('=== HUD ===\n' + hud);
console.log('\n=== #err ===\n' + (err.trim() || '(empty)'));
console.log('\ncanvases:', tris);
if (failed.length) { console.log('\n=== FAILED REQUESTS ==='); failed.forEach(f=>console.log('  '+f)); }
if (errs.length) { console.log('\n=== PAGE ERRORS ==='); errs.forEach(e=>console.log('  '+e)); }
console.log('\n=== CONSOLE ==='); logs.slice(0,25).forEach(l=>console.log('  '+l));

console.log('\n=== WARM REBUILD (move thickness slider) ===');
await page.evaluate(() => {
  const el = document.getElementById('thick');
  el.value = '45'; el.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 400));
for (let i = 0; i < 60; i++) {
  const h = await page.$eval('#hud', e => e.textContent);
  if (h.includes('45.00')) { console.log(h); break; }
  await new Promise(r => setTimeout(r, 500));
}
console.log('\n=== third build (width) ===');
await page.evaluate(() => {
  const el = document.getElementById('width');
  el.value = '210'; el.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 400));
for (let i = 0; i < 60; i++) {
  const h = await page.$eval('#hud', e => e.textContent);
  if (h.includes('210.0')) { console.log(h); break; }
  await new Promise(r => setTimeout(r, 500));
}
const dl = await page.evaluate(() => {
  try { const m = window.__book.last; return { ok: !!m, tris: m.case.numTri() }; }
  catch (e) { return { ok: false, err: String(e) }; }
});
console.log('\ndebug hook:', JSON.stringify(dl));

// --- gridfinity: drop-in plate, then sizing by units -----------------------
async function settle(want, label) {
  for (let i = 0; i < 60; i++) {
    const h = await page.$eval('#hud', e => e.textContent);
    if (h.includes(want)) return h;
    await new Promise(r => setTimeout(r, 500));
  }
  return `(never showed ${want}) ${label}`;
}

console.log('\n=== gridfinity: drop-in plate ===');
await page.evaluate(() => {
  const el = document.getElementById('gfmode');
  el.value = 'plate'; el.dispatchEvent(new Event('change', { bubbles: true }));
});
console.log(await settle('gridfinity', 'plate mode'));
console.log('plate button visible:',
  await page.evaluate(() => !document.getElementById('plateBtn').hidden));
console.log('gridfinity hint:',
  await page.$eval('#gfHint', e => e.textContent.trim()));

console.log('\n=== gridfinity: size the book in units (4 x 4 x 5) ===');
await page.evaluate(() => {
  const m = document.getElementById('sizemode');
  m.value = 'grid'; m.dispatchEvent(new Event('change', { bubbles: true }));
  for (const [id, v] of [['gx','4'],['gy','4'],['gz','5']]) {
    const el = document.getElementById(id);
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
console.log(await settle('4×4×5', 'unit sizing'));
console.log('size hint:', await page.$eval('#gridSizeHint', e => e.textContent.trim()));
console.log('mm sliders hidden:',
  await page.evaluate(() => document.getElementById('mmSize').hidden));

const gridState = await page.evaluate(() => {
  const r = window.__book.last;
  return { parts: ['case','cover','pages','plate'].filter(k => r[k]),
           grid: r.info.grid, plateTris: r.plate ? r.plate.numTri() : null };
});
console.log('built parts:', JSON.stringify(gridState));

console.log('\n=== gridfinity: integrated ===');
await page.evaluate(() => {
  const el = document.getElementById('gfmode');
  el.value = 'integrated'; el.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 1200));
console.log(await page.evaluate(() => {
  const r = window.__book.last;
  return `parts ${['case','cover','pages','plate'].filter(k => r[k]).join(', ')}`
    + `  pages ${r.pages.numTri()} tris`;
}));
const lateErrs = await page.$eval('#err', e => e.textContent.trim());
console.log('#err after gridfinity runs:', lateErrs || '(empty)');
await page.screenshot({ path: '/tmp/shot.png' });
await browser.close();
srv.kill();
