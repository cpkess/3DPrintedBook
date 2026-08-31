#!/usr/bin/env python3
"""
export_data.py -- regenerate ../src/data.js from the extracted STLs.

src/data.js is generated, not hand-written. It holds the three base meshes
(base64 float32 vertices + uint16 indices) plus every constant the generator
depends on: prismatic stretch bands, the shared cut plane, part drop heights,
title anchor transforms, and the page-texture parameters.

The page block is exported with its ORIGINAL page lines already stripped --
that erosion is a numpy min-filter and is not something to redo in JS. The
lines are regenerated in the browser at a constant pitch.

Usage:
    cd tools && python3 export_data.py
"""

import base64
import json
import struct
from collections import Counter
from pathlib import Path

import numpy as np

import pagetex

HERE = Path(__file__).resolve().parent
STL = HERE / "stl"
OUT = HERE.parent / "src" / "data.js"

# Nominal closed-book dimensions, taken from the case part.
NOM = dict(w=185.503, l=239.179, t=33.150)
# Shared cut plane. Must be identical for the case and the page block -- see
# CLAUDE.md, "the shared cut plane is load-bearing".
Z0 = 1.790
STRIP_WINDOW = 0.5


def read_stl(p):
    b = Path(p).read_bytes()
    n = struct.unpack("<I", b[80:84])[0]
    assert len(b) == 84 + 50 * n, f"{p}: not a binary STL"
    rec = np.frombuffer(
        b[84:], dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    return rec["v"].astype(np.float64)


def weld(tri, precision=4):
    q = np.round(tri.reshape(-1, 3), precision)
    V, inv = np.unique(q, axis=0, return_inverse=True)
    F = inv.reshape(-1).reshape(-1, 3)
    ok = (F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])
    return V, F[ok]


def check(V, F):
    """(non-manifold edge count, signed volume). Volume must be positive:
    STL winds counter-clockwise from outside, and a negative result means the
    mesh is inside-out."""
    e = Counter()
    for f in F:
        for i in range(3):
            a, b = int(f[i]), int(f[(i + 1) % 3])
            e[(min(a, b), max(a, b))] += 1
    bad = sum(1 for v in e.values() if v != 2)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    return bad, float(np.sum(np.sum(a * np.cross(b, c), axis=1)) / 6.0)


def widest_band(V, F, axis, eps=0.01):
    """Widest interval along `axis` crossed by no facet whose normal has a
    component along it. Inside such a band the surface is ruled along the
    axis, so stretching there is exact."""
    tri = V[F]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    L = np.linalg.norm(n, axis=1)
    m = L > 1e-12
    n, t = n[m] / L[m, None], tri[m]
    amin, amax = float(tri[:, :, axis].min()), float(tri[:, :, axis].max())
    bl = np.abs(n[:, axis]) > eps
    if not bl.any():
        return amin, amax
    lo, hi = t[bl][:, :, axis].min(1), t[bl][:, :, axis].max(1)
    merged = []
    for a, b in sorted(zip(lo, hi)):
        if merged and a <= merged[-1][1] + 1e-9:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    free, cur = [], amin
    for a, b in merged:
        if a - cur > 1e-6:
            free.append((cur, a))
        cur = max(cur, b)
    if amax - cur > 1e-6:
        free.append((cur, amax))
    return max(free, key=lambda p: p[1] - p[0]) if free else (amin, amax)


def main():
    parts = {}
    for name, fn in [("case", "bottom.stl"), ("cover", "top.stl"),
                     ("pages", "pages.stl")]:
        V, F = weld(read_stl(STL / fn))
        bad, vol = check(V, F)
        note = ""
        if name == "pages":
            V, _ = pagetex.strip_texture(V, F, window=STRIP_WINDOW)
            bad, vol = check(V, F)
            note = " (original page lines stripped)"
        if bad:
            raise SystemExit(f"{name}: non-manifold, {bad} bad edges")
        if vol <= 0:
            raise SystemExit(f"{name}: winding is inside-out (volume {vol})")
        if F.max() >= 65536:
            raise SystemExit(f"{name}: too many vertices for uint16 indices")

        xb, yb = widest_band(V, F, 0), widest_band(V, F, 1)
        parts[name] = dict(
            v=base64.b64encode(V.astype(np.float32).tobytes()).decode(),
            f=base64.b64encode(F.astype(np.uint16).tobytes()).decode(),
            nv=len(V), nf=len(F),
            xb=[round(xb[0], 4), round(xb[1], 4)],
            yb=[round(yb[0], 4), round(yb[1], 4)],
            bbox=[V.min(0).round(4).tolist(), V.max(0).round(4).tolist()],
            vol=round(vol, 1),
        )
        print(f"{name:6s} {len(V):5d}v {len(F):5d}f vol={vol:.0f} "
              f"X{[round(x,2) for x in xb]} Y{[round(y,2) for y in yb]}{note}")

    data = dict(
        parts=parts,
        nominal=NOM,
        Z0=Z0,
        drop=dict(case=16.575, cover=3.175, pages=11.712),
        split=dict(case=True, cover=False, pages=True),
        page=dict(pitch=0.465, depth=0.178, xSpine=-76.0, tableStep=0.5),
        text=dict(
            etchDepth=1.285, proud=0.05, baselineK=-0.38,
            front1=[0.0888977051, 50.3688736, 3.17499924],
            front2=[0.0888977051, 34.6189957, 3.17499924],
            spineMatrix=[[0, 0, -1, -92.7517242],
                         [-1, 0, 0, 15.1925964],
                         [0, 1, 0, 0.417481422]],
            frontSize=12.0, spineSize=11.5,
            defaults=dict(front1="A Treatise on",
                          front2="The Science of Chance",
                          spine="A Treatise on the Science of Chance"),
        ),
    )
    OUT.write_text("// GENERATED by tools/export_data.py -- do not edit.\n"
                   "export const DATA = " + json.dumps(data) + ";\n")
    print(f"\nwrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
