// export.js -- text layout to polygons, and STL / 3MF writers.

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Lay out a string with opentype.js and return closed polygons in mm.
 *
 * Alignment matches the original 3MF exactly rather than approximating it:
 * X is centred on the advance width, Y on the ink bounding box. The OpenSCAD
 * version could not do this -- it can only align to the font baseline, which
 * is why that build needed a hand-tuned `baseline_k` fudge factor that had to
 * be re-tuned whenever the string or font changed. Here the glyph outlines
 * are in hand, so the box is measured directly and the fudge factor is gone.
 *
 * @param {object} font     opentype.js Font
 * @param {string} str
 * @param {number} size     em size in mm
 * @param {number} tracking extra letter spacing in mm
 * @param {number} curveTol flattening tolerance in mm
 */
export function textPolygons(font, str, size, tracking = 0, curveTol = 0.02) {
  if (!font || !str) return { polys: [], width: 0, height: 0 };
  const scale = size / font.unitsPerEm;
  const contours = [];
  let cur = null, pen = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  const push = (x, y) => {
    if (!cur) return;
    cur.push([x, y]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  const steps = (len) =>
    Math.max(2, Math.min(48, Math.ceil(len / Math.max(curveTol, 1e-4))));

  const glyphs = font.stringToGlyphs(str);
  for (let gi = 0; gi < glyphs.length; gi++) {
    const g = glyphs[gi];
    const path = g.getPath(pen, 0, size);
    let sx = 0, sy = 0, px = 0, py = 0;
    for (const c of path.commands) {
      if (c.type === 'M') {
        if (cur && cur.length > 2) contours.push(cur);
        cur = [];
        px = c.x; py = -c.y; sx = px; sy = py;
        push(px, py);
      } else if (c.type === 'L') {
        px = c.x; py = -c.y; push(px, py);
      } else if (c.type === 'Q') {
        const n = steps(Math.hypot(c.x - px, -c.y - py));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push(u * u * px + 2 * u * t * c.x1 + t * t * c.x,
               u * u * py + 2 * u * t * -c.y1 + t * t * -c.y);
        }
        px = c.x; py = -c.y;
      } else if (c.type === 'C') {
        const n = steps(Math.hypot(c.x - px, -c.y - py));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push(u*u*u*px + 3*u*u*t*c.x1 + 3*u*t*t*c.x2 + t*t*t*c.x,
               u*u*u*py + 3*u*u*t*-c.y1 + 3*u*t*t*-c.y2 + t*t*t*-c.y);
        }
        px = c.x; py = -c.y;
      } else if (c.type === 'Z') {
        if (cur && cur.length > 2) contours.push(cur);
        cur = null;
        px = sx; py = sy;
      }
    }
    if (cur && cur.length > 2) contours.push(cur);
    cur = null;
    pen += g.advanceWidth * scale + (gi < glyphs.length - 1 ? tracking : 0);
  }
  if (!contours.length) return { polys: [], width: 0, height: 0 };

  // X on the advance width, Y on the ink box -- matching the source 3MF.
  const cx = pen / 2;
  const cy = (minY + maxY) / 2;
  const polys = contours.map(c => c.map(([x, y]) => [x - cx, y - cy]));
  return { polys, width: maxX - minX, height: maxY - minY, advance: pen };
}

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

export function meshToSTL(mesh, name = 'part') {
  const n = mesh.triVerts.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  const hdr = new TextEncoder().encode(name.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(hdr);
  dv.setUint32(80, n, true);
  const P = mesh.vertProperties, S = mesh.numProp;
  let off = 84;
  for (let i = 0; i < n; i++) {
    const a = mesh.triVerts[i*3]*S, b = mesh.triVerts[i*3+1]*S, c = mesh.triVerts[i*3+2]*S;
    const ux=P[b]-P[a], uy=P[b+1]-P[a+1], uz=P[b+2]-P[a+2];
    const vx=P[c]-P[a], vy=P[c+1]-P[a+1], vz=P[c+2]-P[a+2];
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const L=Math.hypot(nx,ny,nz)||1;
    dv.setFloat32(off, nx/L, true);
    dv.setFloat32(off+4, ny/L, true);
    dv.setFloat32(off+8, nz/L, true);
    for (let k=0;k<3;k++){
      const j=mesh.triVerts[i*3+k]*S;
      dv.setFloat32(off+12+k*12, P[j], true);
      dv.setFloat32(off+16+k*12, P[j+1], true);
      dv.setFloat32(off+20+k*12, P[j+2], true);
    }
    dv.setUint16(off+48, 0, true);
    off += 50;
  }
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// 3MF (store-only ZIP, no compression -- valid per APPNOTE and accepted by
// Bambu Studio, PrusaSlicer and Cura)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(files) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);                       // store
    dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    lh.set(name, 30);
    locals.push(lh, data);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    centrals.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of locals) { out.set(c, p); p += c.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

export function meshesTo3MF(parts) {
  let objects = '';
  let items = '';
  parts.forEach((part, i) => {
    const id = i + 1;
    const m = part.mesh, S = m.numProp;
    const nv = m.vertProperties.length / S;
    const v = [];
    for (let j = 0; j < nv; j++) {
      v.push(`<vertex x="${m.vertProperties[j*S].toFixed(4)}" y="${
        m.vertProperties[j*S+1].toFixed(4)}" z="${m.vertProperties[j*S+2].toFixed(4)}"/>`);
    }
    const t = [];
    for (let j = 0; j < m.triVerts.length; j += 3) {
      t.push(`<triangle v1="${m.triVerts[j]}" v2="${m.triVerts[j+1]}" v3="${m.triVerts[j+2]}"/>`);
    }
    objects += `<object id="${id}" type="model" name="${part.name}"><mesh>` +
      `<vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles>` +
      `</mesh></object>`;
    items += `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${
      (part.offset?.[0] ?? 0)} ${(part.offset?.[1] ?? 0)} 0"/>`;
  });

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">Hidden Book Configurator</metadata>
<resources>${objects}</resources><build>${items}</build></model>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const ct = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

  return zipStore([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rels },
    { name: '3D/3dmodel.model', data: model },
  ]);
}
