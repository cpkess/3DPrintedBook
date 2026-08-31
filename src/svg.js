// svg.js -- SVG outlines to polygons.
//
// No DOM, like book.js, so an uploaded file can be checked headless. That
// rules out DOMParser, hence the small tag scanner below: SVG is XML and all
// this needs is element names, attributes and nesting.
//
// Output matches what textPolygons() produces -- an array of closed rings of
// [x, y] -- so the same cutter() path engraves both. Winding is preserved
// rather than normalised, because SVG's default fill-rule is nonzero and
// manifold's 'NonZero' reads counter-wound subpaths as holes, which is
// exactly what a letter counter or a ring in a logo is.
//
// y is flipped on the way out: SVG's y runs down the page, the model's runs
// up. Flipping every ring the same way leaves the relative winding of an
// outer ring and its holes intact.

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const nums = (s) => (s.match(NUM) || []).map(Number);

// --- 2D affine: [a, b, c, d, e, f] as in SVG's matrix() -------------------
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4],
                         m[1] * p[0] + m[3] * p[1] + m[5]];

function parseTransform(s) {
  let m = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(s))) {
    const a = nums(hit[2]);
    const rad = (d) => d * Math.PI / 180;
    let t = I;
    switch (hit[1]) {
      case 'matrix':    t = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case 'translate': t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale':     t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'skewX':     t = [1, 0, Math.tan(rad(a[0] || 0)), 1, 0, 0]; break;
      case 'skewY':     t = [1, Math.tan(rad(a[0] || 0)), 0, 1, 0, 0]; break;
      case 'rotate': {
        const c = Math.cos(rad(a[0] || 0)), s2 = Math.sin(rad(a[0] || 0));
        t = [c, s2, -s2, c, 0, 0];
        if (a.length >= 3) {
          t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        }
        break;
      }
    }
    m = mul(m, t);
  }
  return m;
}

// --- curve flattening ----------------------------------------------------
// Fixed subdivision, chosen from the control polygon's length so a big arc
// and a 2 mm fillet both come out smooth without exploding the vertex count.
function steps(len, tol) {
  return Math.max(4, Math.min(64, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-4)) * 2)));
}
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function cubic(out, p0, p1, p2, p3, tol) {
  const n = steps(dist(p0, p1) + dist(p1, p2) + dist(p2, p3), tol);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
      u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1],
    ]);
  }
}
function quad(out, p0, p1, p2, tol) {
  const n = steps(dist(p0, p1) + dist(p1, p2), tol);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0],
              u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1]]);
  }
}
/** Endpoint-parameterised arc, per the SVG implementation notes. */
function arc(out, p0, rx, ry, rot, large, sweep, p1, tol) {
  if (!rx || !ry) { out.push(p1); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = rot * Math.PI / 180;
  const cs = Math.cos(phi), sn = Math.sin(phi);
  const dx2 = (p0[0] - p1[0]) / 2, dy2 = (p0[1] - p1[1]) / 2;
  const x1 = cs * dx2 + sn * dy2, y1 = -sn * dx2 + cs * dy2;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
  const sq = Math.max(0, (rx*rx*ry*ry - rx*rx*y1*y1 - ry*ry*x1*x1)
                        / (rx*rx*y1*y1 + ry*ry*x1*x1));
  const co = (large !== sweep ? 1 : -1) * Math.sqrt(sq);
  const cx1 = co * rx * y1 / ry, cy1 = -co * ry * x1 / rx;
  const cx = cs * cx1 - sn * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sn * cx1 + cs * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d = Math.sqrt((ux*ux + uy*uy) * (vx*vx + vy*vy));
    let c = d ? (ux*vx + uy*vy) / d : 1;
    c = Math.min(1, Math.max(-1, c));
    return (ux*vy - uy*vx < 0 ? -1 : 1) * Math.acos(c);
  };
  const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = steps(Math.abs(dt) * Math.max(rx, ry), tol);
  for (let i = 1; i <= n; i++) {
    const th = t0 + dt * i / n;
    const px = rx * Math.cos(th), py = ry * Math.sin(th);
    out.push([cs * px - sn * py + cx, sn * px + cs * py + cy]);
  }
}

// --- path data -----------------------------------------------------------
function pathRings(d, tol) {
  const rings = [];
  let ring = null, cur = [0, 0], start = [0, 0], prevC = null, prevQ = null;
  const tok = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  let i = 0, cmd = '';
  const num = () => Number(tok[i++]);
  const close = () => { if (ring && ring.length > 2) rings.push(ring); ring = null; };
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i])) cmd = tok[i++];
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    const rel = cmd === cmd.toLowerCase();
    const bx = rel ? cur[0] : 0, by = rel ? cur[1] : 0;
    switch (cmd.toUpperCase()) {
      case 'M': close(); cur = [num() + bx, num() + by]; start = cur;
                ring = [cur]; prevC = prevQ = null; break;
      case 'L': cur = [num() + bx, num() + by]; ring && ring.push(cur);
                prevC = prevQ = null; break;
      case 'H': cur = [num() + bx, cur[1]]; ring && ring.push(cur);
                prevC = prevQ = null; break;
      case 'V': cur = [cur[0], num() + by]; ring && ring.push(cur);
                prevC = prevQ = null; break;
      case 'C': {
        const c1 = [num() + bx, num() + by], c2 = [num() + bx, num() + by];
        const p = [num() + bx, num() + by];
        if (ring) cubic(ring, cur, c1, c2, p, tol);
        prevC = c2; prevQ = null; cur = p; break;
      }
      case 'S': {
        const c1 = prevC ? [2*cur[0] - prevC[0], 2*cur[1] - prevC[1]] : cur;
        const c2 = [num() + bx, num() + by], p = [num() + bx, num() + by];
        if (ring) cubic(ring, cur, c1, c2, p, tol);
        prevC = c2; prevQ = null; cur = p; break;
      }
      case 'Q': {
        const c1 = [num() + bx, num() + by], p = [num() + bx, num() + by];
        if (ring) quad(ring, cur, c1, p, tol);
        prevQ = c1; prevC = null; cur = p; break;
      }
      case 'T': {
        const c1 = prevQ ? [2*cur[0] - prevQ[0], 2*cur[1] - prevQ[1]] : cur;
        const p = [num() + bx, num() + by];
        if (ring) quad(ring, cur, c1, p, tol);
        prevQ = c1; prevC = null; cur = p; break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num();
        const lg = num(), sw = num();
        const p = [num() + bx, num() + by];
        if (ring) arc(ring, cur, rx, ry, rot, lg, sw, p, tol);
        prevC = prevQ = null; cur = p; break;
      }
      case 'Z': if (ring && ring.length > 2) rings.push(ring);
                ring = [start.slice()]; cur = start.slice();
                prevC = prevQ = null; break;
      default: i++; break;                       // unknown command: skip a token
    }
  }
  close();
  return rings;
}

// --- basic shapes --------------------------------------------------------
function ellipseRing(cx, cy, rx, ry, tol) {
  const n = steps(2 * Math.PI * Math.max(rx, ry), tol) * 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n * 2 * Math.PI;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}
function rectRings(x, y, w, h, rx, ry, tol) {
  if (!rx && !ry) return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
  rx = Math.min(rx || ry, w / 2); ry = Math.min(ry || rx, h / 2);
  const out = [];
  const corner = (cx, cy, a0) => {
    const n = steps(Math.PI / 2 * Math.max(rx, ry), tol);
    for (let i = 0; i <= n; i++) {
      const t = a0 + (i / n) * Math.PI / 2;
      out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
    }
  };
  corner(x + w - rx, y + ry, -Math.PI / 2);
  corner(x + w - rx, y + h - ry, 0);
  corner(x + rx, y + h - ry, Math.PI / 2);
  corner(x + rx, y + ry, Math.PI);
  return [out];
}

// --- the tag scanner -----------------------------------------------------
function* elements(text) {
  const re = /<\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>|<\s*\/\s*([a-zA-Z][\w:-]*)\s*>/g;
  let hit;
  while ((hit = re.exec(text))) {
    if (hit[4]) { yield { close: hit[4] }; continue; }
    const attrs = {};
    const are = /([a-zA-Z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = are.exec(hit[2] || ''))) attrs[a[1]] = a[3] ?? a[4] ?? '';
    yield { name: hit[1], attrs, selfClose: !!hit[3] };
  }
}

/**
 * Rings from an SVG document, in millimetres of its own user space, y up.
 *
 * `<defs>`, `<symbol>`, `<mask>`, `<clipPath>` and anything with
 * `display:none` are skipped; `<use>` is not resolved. Strokes are ignored --
 * only filled area becomes geometry, which is what an engraving is.
 */
export function svgPolygons(text, { tolerance = 0.05 } = {}) {
  const rings = [];
  const stack = [I];
  const rules = ['nonzero'];
  const skip = [];
  let vb = null, docW = null, docH = null;
  const SKIP = new Set(['defs', 'symbol', 'mask', 'clippath', 'marker', 'pattern']);
  const len = (s, fallback) => {
    if (s == null) return fallback;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : fallback;
  };

  for (const el of elements(text)) {
    if (el.close) {
      if (skip.length && skip[skip.length - 1] === el.close.toLowerCase()) skip.pop();
      else { if (stack.length > 1) stack.pop(); if (rules.length > 1) rules.pop(); }
      continue;
    }
    const tag = el.name.toLowerCase();
    if (skip.length) { if (!el.selfClose) skip.push(tag); continue; }
    if (SKIP.has(tag)) { if (!el.selfClose) skip.push(tag); continue; }
    const hidden = /display\s*:\s*none/i.test(el.attrs.style || '')
      || el.attrs.display === 'none';
    if (hidden) { if (!el.selfClose) skip.push(tag); continue; }

    const m = mul(stack[stack.length - 1], parseTransform(el.attrs.transform));
    const rule = el.attrs['fill-rule']
      || (/fill-rule\s*:\s*([\w-]+)/i.exec(el.attrs.style || '') || [])[1]
      || rules[rules.length - 1];
    const emit = (rs) => {
      let keep = rs.filter((r) => r.length > 2);
      if (/evenodd/i.test(rule) && keep.length > 1) keep = evenOddWind(keep);
      for (const r of keep) rings.push(r.map((p) => apply(m, p)));
    };

    switch (tag) {
      case 'svg':
        if (el.attrs.viewBox) { const v = nums(el.attrs.viewBox); if (v.length === 4) vb = v; }
        docW = len(el.attrs.width, docW); docH = len(el.attrs.height, docH);
        break;
      case 'path': emit(pathRings(el.attrs.d || '', tolerance)); break;
      case 'rect': emit(rectRings(
        len(el.attrs.x, 0), len(el.attrs.y, 0),
        len(el.attrs.width, 0), len(el.attrs.height, 0),
        len(el.attrs.rx, 0), len(el.attrs.ry, 0), tolerance)); break;
      case 'circle': {
        const r = len(el.attrs.r, 0);
        if (r > 0) emit([ellipseRing(len(el.attrs.cx, 0), len(el.attrs.cy, 0), r, r, tolerance)]);
        break;
      }
      case 'ellipse': {
        const rx = len(el.attrs.rx, 0), ry = len(el.attrs.ry, 0);
        if (rx > 0 && ry > 0) emit([ellipseRing(len(el.attrs.cx, 0), len(el.attrs.cy, 0), rx, ry, tolerance)]);
        break;
      }
      case 'polygon': case 'polyline': {
        const v = nums(el.attrs.points || '');
        const ring = [];
        for (let i = 0; i + 1 < v.length; i += 2) ring.push([v[i], v[i + 1]]);
        emit([ring]);
        break;
      }
    }
    if (!el.selfClose && tag !== 'svg') { stack.push(m); rules.push(rule); }
  }

  // viewBox wins over width/height: it is what the coordinates are in
  const box = vb ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : null;
  const flipped = rings.map((r) => r.map((p) => [p[0], -p[1]]));
  return {
    polys: flipped,
    view: box ? { x: box.x, y: -box.y - box.h, w: box.w, h: box.h }
              : bounds(flipped),
    width: docW, height: docH,
  };
}

/**
 * Re-wind rings so manifold's nonzero rule reproduces SVG's even-odd rule.
 *
 * Even-odd calls a point inside when it is inside an odd number of rings, so
 * setting each ring's winding by the parity of its nesting depth makes the two
 * rules agree. Only applied to elements that actually ask for even-odd:
 * under nonzero, two same-wound nested rings mean solid, and re-winding them
 * would punch a hole that the artwork does not have.
 */
function evenOddWind(rings) {
  const inside = (pt, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1])
        && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  };
  const area = (r) => {
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  return rings.map((r) => {
    let depth = 0;
    for (const o of rings) if (o !== r && inside(r[0], o)) depth++;
    const wantCCW = depth % 2 === 0;
    return (area(r) > 0) === wantCCW ? r : r.slice().reverse();
  });
}

function bounds(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of polys) for (const p of r) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
                             : { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Fit rings into a `w` x `h` panel centred on the origin, preserving aspect.
 * `fit` is the fraction of the panel the artwork may fill.
 */
export function fitPolygons(polys, view, w, h, fit = 0.8) {
  if (!polys.length || !view.w || !view.h) return [];
  const s = Math.min(w * fit / view.w, h * fit / view.h);
  const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
  return polys.map((r) => r.map((p) => [(p[0] - cx) * s, (p[1] - cy) * s]));
}
