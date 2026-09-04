import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import { readdirSync, statSync, readFileSync, rmSync, mkdirSync } from 'fs';
const DL = '/tmp/dl'; rmSync(DL, {recursive:true, force:true}); mkdirSync(DL, {recursive:true});
const srv = spawn('node', ['serve.mjs'], { env: { ...process.env, PORT: '8097' } });
await new Promise(r => setTimeout(r, 700));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless:'new',
  args:['--no-sandbox','--disable-gpu','--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', String(e)));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior:'allow', downloadPath: DL, eventsEnabled:true });
await page.goto('http://localhost:8097/', { waitUntil:'domcontentloaded' });
for (let i=0;i<80;i++){ const h=await page.$eval('#hud',e=>e.textContent);
  if(!/starting|loading|generating\.\.\./i.test(h)) break; await new Promise(r=>setTimeout(r,500)); }
await page.click('#dl3mf');
await page.click('#dlstl');
await new Promise(r => setTimeout(r, 4000));
for (const f of readdirSync(DL)) {
  const b = readFileSync(`${DL}/${f}`);
  const sig = b.slice(0,4).toString('hex');
  let note = '';
  if (f.endsWith('.3mf')) note = sig === '504b0304' ? 'valid ZIP header' : 'BAD ZIP HEADER';
  if (f.endsWith('.stl')) { const n = b.readUInt32LE(80); note = `${n} tris, size ok=${b.length===84+50*n}`; }
  console.log(`${f}  ${(b.length/1048576).toFixed(2)} MB  ${note}`);
}

// --- with the colour inlay on: the inlay must ride in its parent's recess,
// not be laid out beside it, or the .3mf is no use for multi-material.
rmSync(DL, {recursive:true, force:true}); mkdirSync(DL, {recursive:true});
await page.evaluate(() => {
  const el = document.getElementById('inlaymode');
  el.value = 'on'; el.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 4000));
await page.click('#dl3mf');
await new Promise(r => setTimeout(r, 4000));
const f3 = readdirSync(DL).find(f => f.endsWith('.3mf'));
if (!f3) { console.log('INLAY 3MF: not produced'); }
else {
  const buf = readFileSync(`${DL}/${f3}`);
  // store-only zip: find the model part and read it straight out
  const txt = buf.toString('latin1');
  const start = txt.indexOf('<?xml', txt.indexOf('3D/3dmodel.model'));
  const model = txt.slice(start, txt.indexOf('</model>', start) + 8);
  const names = [...model.matchAll(/<object id="(\d+)"[^>]*name="([^"]+)"/g)]
    .map(m => [m[1], m[2]]);
  const items = [...model.matchAll(/<item objectid="(\d+)" transform="([^"]+)"/g)]
    .map(m => [m[1], m[2].trim().split(/\s+/).slice(9).join(',')]);
  const at = Object.fromEntries(items);
  const byName = Object.fromEntries(names.map(([id, n]) => [n, at[id]]));
  console.log(`\ninlay .3mf: ${(buf.length/1048576).toFixed(2)} MB, ${names.length} objects`);
  for (const [, n] of names) console.log(`  ${n.padEnd(11)} at ${byName[n]}`);
  const ok = byName.caseInlay === byName.case && byName.coverInlay === byName.cover;
  console.log(`  inlays sit on their parent: ${ok ? 'yes' : 'NO -- they are offset apart'}`);
}
await browser.close(); srv.kill();
