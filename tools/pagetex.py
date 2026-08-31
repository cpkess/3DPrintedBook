#!/usr/bin/env python3
"""
pagetex.py -- build a repeating synthetic page-edge texture for the inserted
band of the page block.

Why synthetic. The original page lines are irregular (crest spacing varies
0.15-0.84 mm) and the block's fore-edge is curved in Z, so no two cross
sections of the mesh are ever identical and no slab of the real geometry can
be tiled seamlessly. Rather than fight that, we measure the real texture --
0.465 mm mean pitch, 0.178 mm peak-to-peak depth -- and regenerate a regular
version of it at the same scale. Less faithful, consistent, and it tiles.

How it works. The cut cross-section is extracted as polygon loops. Two
versions are emitted: the full outline, and one inset by the undulation depth
along the page-edge portion only (the spine tongue and the cavity walls are
left at full size, since they are structural). The band is then built in
OpenSCAD as a full-height extrusion of the inset outline plus a stack of thin
extrusions of the full outline -- the ridges. Ridge count follows the
thickness parameter, so the pitch stays constant as the book grows.
"""

import numpy as np


def slice_loops(V, F, z, tol=1e-4):
    """Cross-section at z, chained into closed loops of 2D points."""
    tri = V[F]
    lo, hi = tri[:, :, 2].min(1), tri[:, :, 2].max(1)
    t = tri[(lo < z) & (hi > z)]
    segs = []
    for f in t:
        d = f[:, 2] - z
        p = []
        for i in range(3):
            j = (i + 1) % 3
            if (d[i] > 0) != (d[j] > 0):
                w = d[i] / (d[i] - d[j])
                q = f[i] + w * (f[j] - f[i])
                p.append((q[0], q[1]))
        if len(p) == 2:
            segs.append(p)

    def key(p):
        return (round(p[0] / tol), round(p[1] / tol))

    adj = {}
    for a, b in segs:
        adj.setdefault(key(a), []).append((key(b), b))
        adj.setdefault(key(b), []).append((key(a), a))
    pos = {}
    for a, b in segs:
        pos[key(a)] = a
        pos[key(b)] = b

    loops, seen = [], set()
    for start in adj:
        if start in seen or len(adj[start]) < 2:
            continue
        loop, cur, prev = [pos[start]], start, None
        seen.add(start)
        while True:
            nxts = [k for k, _ in adj[cur] if k != prev]
            nxts = [k for k in nxts if k not in seen] or \
                   [k for k in nxts if k == key(loop[0])]
            if not nxts:
                break
            nxt = nxts[0]
            if nxt == key(loop[0]):
                break
            loop.append(pos[nxt])
            seen.add(nxt)
            prev, cur = cur, nxt
        if len(loop) >= 3:
            loops.append(np.array(loop))
    return loops


def simplify(P, min_edge):
    """Drop vertices closer together than min_edge.

    The block's corner fillets are tessellated down to 0.014 mm edges. Any
    inward offset larger than half such an edge flips it, so the loop is
    decimated to a scale comfortably above the offset distance first. The
    corner arcs span about 0.2 mm total, so collapsing them costs nothing
    visible."""
    out = [P[0]]
    for q in P[1:]:
        if np.hypot(*(q - out[-1])) >= min_edge:
            out.append(q)
    while len(out) > 3 and np.hypot(*(out[0] - out[-1])) < min_edge:
        out.pop()
    return np.array(out)


def signed_area(P):
    x, y = P[:, 0], P[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def inset_loop(P, depth, is_page_edge, blend=3.0):
    """Move page-edge vertices inward by `depth` along the vertex normal.

    Vertices outside the page-edge region are left alone, with a linear blend
    across `blend` mm of arc so the transition into the spine tongue has no
    step in it."""
    n = len(P)
    A = signed_area(P)
    sgn = 1.0 if A > 0 else -1.0
    nrm = np.zeros_like(P)
    for i in range(n):
        a, b, c = P[i - 1], P[i], P[(i + 1) % n]
        for u, v in ((a, b), (b, c)):
            e = v - u
            L = np.hypot(*e)
            if L > 1e-12:
                nrm[i] += np.array([e[1], -e[0]]) / L * sgn
    L = np.hypot(nrm[:, 0], nrm[:, 1])
    L[L < 1e-12] = 1.0
    nrm /= L[:, None]

    mask = np.array([1.0 if is_page_edge(p) else 0.0 for p in P])
    # blend the mask along the loop by arc length
    seg = np.hypot(*(np.roll(P, -1, 0) - P).T)
    s = np.concatenate([[0], np.cumsum(seg)])[:n]
    total = s[-1] + seg[-1]
    out = mask.copy()
    for i in range(n):
        if mask[i] == 1.0:
            continue
        d = np.minimum(np.abs(s - s[i]), total - np.abs(s - s[i]))
        near = (mask == 1.0) & (d < blend)
        if near.any():
            out[i] = max(0.0, 1.0 - d[near].min() / blend)
    return P - nrm * (depth * out)[:, None]


def build(V, F, z, depth, x_spine=-76.0):
    """Return (loops, inset_loops) for the cut cross-section at z."""
    loops = slice_loops(V, F, z)
    if not loops:
        raise RuntimeError(f"no cross-section at z={z}")
    areas = [abs(signed_area(P)) for P in loops]
    outer = int(np.argmax(areas))

    def page_edge(p):
        return p[0] > x_spine

    loops = [simplify(P, max(3.0 * depth, 0.5)) for P in loops]
    areas = [abs(signed_area(P)) for P in loops]
    outer = int(np.argmax(areas))
    ins = []
    for i, P in enumerate(loops):
        ins.append(inset_loop(P, depth, page_edge) if i == outer else P.copy())
    return loops, ins, outer


def emit_polygon(name, loops, prec=3):
    """OpenSCAD points + paths for a multi-loop polygon."""
    pts, paths, k = [], [], 0
    for P in loops:
        idx = list(range(k, k + len(P)))
        k += len(P)
        paths.append(idx)
        pts.extend(P.tolist())
    fmt = f"%.{prec}f"
    ps = ",".join("[" + fmt % p[0] + "," + fmt % p[1] + "]" for p in pts)
    hs = ",".join("[" + ",".join(str(i) for i in path) + "]" for path in paths)
    return f"{name}_PTS = [{ps}];\n{name}_PATHS = [{hs}];\n"


# ---------------------------------------------------------------------------
# Whole-block retexturing
# ---------------------------------------------------------------------------

def outer_skin_mask(V, F, x_spine=-76.0):
    """Vertices on the block's outer side wall (not the cavity, not the caps).

    The cavity wall sits only ~3 mm inside the outer wall, so radius alone
    cannot separate them. Vertex normals can: the outer skin faces away from
    the block's axis, the cavity wall faces toward it."""
    nrm = np.zeros_like(V)
    tri = V[F]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    L = np.linalg.norm(fn, axis=1, keepdims=True)
    fn = np.divide(fn, L, out=np.zeros_like(fn), where=L > 1e-12)
    for k in range(3):
        np.add.at(nrm, F[:, k], fn)
    L = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = np.divide(nrm, L, out=np.zeros_like(nrm), where=L > 1e-12)

    rad = V[:, :2].copy()
    Lr = np.linalg.norm(rad, axis=1, keepdims=True)
    rad = np.divide(rad, Lr, out=np.zeros_like(rad), where=Lr > 1e-12)

    outward = (nrm[:, 0] * rad[:, 0] + nrm[:, 1] * rad[:, 1]) > 0.35
    side = np.abs(nrm[:, 2]) < 0.7          # not a top/bottom cap
    return outward & side & (V[:, 0] > x_spine)


def strip_texture(V, F, x_spine=-76.0, window=0.6, bin_mm=0.75):
    """Remove the original irregular page lines, leaving the trough surface.

    The displacement that makes a page line is along the local surface
    normal, so each vertex is filtered along that axis only: vertices on an
    x-facing wall are binned by y and their x is min-filtered over a z
    window; vertices on a y-facing wall are binned by x and their |y| is
    filtered. Binning by polar angle does not work here -- on a 175x231
    rounded rectangle the radius varies by ~0.8 mm across a single angular
    bin, which swamps the 0.178 mm texture and leaves it half-intact.

    The regenerated ridges are added back on top of this surface.
    """
    V = V.copy()
    mask = outer_skin_mask(V, F, x_spine)
    idx = np.where(mask)[0]
    if len(idx) == 0:
        return V, mask

    nrm = np.zeros_like(V)
    tri = V[F]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    L = np.linalg.norm(fn, axis=1, keepdims=True)
    fn = np.divide(fn, L, out=np.zeros_like(fn), where=L > 1e-12)
    for k in range(3):
        np.add.at(nrm, F[:, k], fn)

    x_face = np.abs(nrm[idx, 0]) >= np.abs(nrm[idx, 1])
    for face_is_x in (True, False):
        sel = idx[x_face] if face_is_x else idx[~x_face]
        if len(sel) == 0:
            continue
        ax = 0 if face_is_x else 1          # axis carrying the displacement
        tg = 1 if face_is_x else 0          # tangential axis, used for bins
        val = V[sel, ax]
        sgn = np.sign(val)
        sgn[sgn == 0] = 1.0
        mag = val * sgn                      # distance from the block axis
        key = np.round(V[sel, tg] / bin_mm).astype(int) * 1000 + (sgn > 0)
        z = V[sel, 2]
        newmag = mag.copy()
        for k in np.unique(key):
            m = key == k
            zz, mm = z[m], mag[m]
            if len(zz) < 2:
                continue
            loc = np.where(m)[0]
            for i in range(len(zz)):
                w = np.abs(zz - zz[i]) <= window
                newmag[loc[i]] = mm[w].min()
        V[sel, ax] = newmag * sgn
    return V, mask


def outline_table(V, F, z_list, depth, x_spine=-76.0, min_edge=None):
    """Ridge cross-sections at each z: outline outset by `depth` on the page
    edge, cavity loops untouched. Outsetting cannot self-intersect the way
    insetting can, but the loops are still decimated first for consistency."""
    if min_edge is None:
        min_edge = max(3.0 * depth, 0.5)
    table = []
    for z in z_list:
        loops = slice_loops(V, F, z)
        if not loops:
            table.append(None)
            continue
        loops = [simplify(P, min_edge) for P in loops]
        loops = [P for P in loops if len(P) >= 3]
        if not loops:
            table.append(None)
            continue
        outer = int(np.argmax([abs(signed_area(P)) for P in loops]))
        out = []
        for i, P in enumerate(loops):
            if i == outer:
                out.append(inset_loop(P, -depth, lambda p: p[0] > x_spine))
            else:
                out.append(P.copy())
        table.append(out)
    return table


def emit_table(name, table, prec=3):
    """Emit a list of multi-loop polygons as parallel points/paths vectors."""
    pts_all, paths_all = [], []
    for loops in table:
        if loops is None:
            pts_all.append("[[0,0],[0,0],[0,0]]")
            paths_all.append("[[0,1,2]]")
            continue
        pts, paths, k = [], [], 0
        for P in loops:
            paths.append(list(range(k, k + len(P))))
            k += len(P)
            pts.extend(P.tolist())
        fmt = f"%.{prec}f"
        pts_all.append("[" + ",".join("[" + fmt % p[0] + "," + fmt % p[1] + "]"
                                      for p in pts) + "]")
        paths_all.append("[" + ",".join("[" + ",".join(str(i) for i in q) + "]"
                                        for q in paths) + "]")
    return (f"{name}_PTS = [{','.join(pts_all)}];\n"
            f"{name}_PATHS = [{','.join(paths_all)}];\n")
