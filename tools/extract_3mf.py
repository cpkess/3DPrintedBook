#!/usr/bin/env python3
"""
extract_3mf.py -- decompose a (Bambu/Orca) 3MF project into per-part meshes.

Handles the production extension (p:path components living in separate
/3D/Objects/*.model files), applies component transforms, and reads
Metadata/model_settings.config so positive bodies and negative parts
(text cuts, etc.) are separated instead of being welded into one blob.

Usage:
    python3 extract_3mf.py INPUT.3mf OUTDIR
    python3 extract_3mf.py INPUT.3mf OUTDIR --include-negatives

Writes binary STLs plus a manifest.json describing every part, its
transform, and (for text parts) the font metadata needed to rebuild it
parametrically.
"""

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

import numpy as np
from lxml import etree

CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
NS = {"c": CORE, "p": PROD}


# ---------------------------------------------------------------- transforms

def parse_3mf_transform(s):
    """3MF transform attr: 12 floats, column-major 3x3 then translation.

    Returns a 3x4 numpy array [R | t] such that world = R @ local + t.
    """
    if not s:
        return np.hstack([np.eye(3), np.zeros((3, 1))])
    v = [float(x) for x in s.split()]
    if len(v) != 12:
        raise ValueError(f"expected 12 floats in transform, got {len(v)}")
    # columns c0=v[0:3], c1=v[3:6], c2=v[6:9], t=v[9:12]
    R = np.array([v[0:3], v[3:6], v[6:9]]).T
    t = np.array(v[9:12])
    return np.hstack([R, t.reshape(3, 1)])


def apply(M34, V):
    return V @ M34[:, :3].T + M34[:, 3]


# ---------------------------------------------------------------- 3mf reading

class Project:
    def __init__(self, path):
        self.zf = zipfile.ZipFile(path)
        self.names = set(self.zf.namelist())
        self._cache = {}
        self.root_doc = self._xml("3D/3dmodel.model")
        self.settings = self._settings()

    def _xml(self, name):
        if name not in self._cache:
            self._cache[name] = etree.fromstring(self.zf.read(name))
        return self._cache[name]

    def _norm(self, p):
        return p.lstrip("/")

    def _settings(self):
        """object id -> {name, parts:[{id,name,subtype,text_info}]}"""
        out = {}
        if "Metadata/model_settings.config" not in self.names:
            return out
        cfg = self._xml("Metadata/model_settings.config")
        for obj in cfg.findall("object"):
            oid = obj.get("id")
            rec = {"name": None, "parts": []}
            for md in obj.findall("metadata"):
                if md.get("key") == "name":
                    rec["name"] = md.get("value")
            for part in obj.findall("part"):
                p = {
                    "id": part.get("id"),
                    "subtype": part.get("subtype"),
                    "name": None,
                    "text_info": None,
                }
                for md in part.findall("metadata"):
                    if md.get("key") == "name":
                        p["name"] = md.get("value")
                ti = part.find("text_info")
                if ti is not None:
                    p["text_info"] = dict(ti.attrib)
                rec["parts"].append(p)
            out[oid] = rec
        return out

    def mesh(self, doc_path, objectid):
        """Return (V, F) for objectid inside doc_path, or None if no mesh."""
        doc = self._xml(self._norm(doc_path))
        for obj in doc.iter(f"{{{CORE}}}object"):
            if obj.get("id") != str(objectid):
                continue
            m = obj.find("c:mesh", NS)
            if m is None:
                return None
            V = np.array(
                [[float(v.get("x")), float(v.get("y")), float(v.get("z"))]
                 for v in m.find("c:vertices", NS)],
                dtype=np.float64,
            )
            F = np.array(
                [[int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))]
                 for t in m.find("c:triangles", NS)],
                dtype=np.int64,
            )
            return V, F
        return None

    def top_objects(self):
        """Composite objects in 3dmodel.model, with resolved components."""
        out = []
        for obj in self.root_doc.iter(f"{{{CORE}}}object"):
            comps = obj.find("c:components", NS)
            if comps is None:
                continue
            entry = {"id": obj.get("id"), "components": []}
            for c in comps:
                entry["components"].append({
                    "path": c.get(f"{{{PROD}}}path"),
                    "objectid": c.get("objectid"),
                    "M": parse_3mf_transform(c.get("transform")),
                })
            out.append(entry)
        return out


# ---------------------------------------------------------------- STL output

def write_stl(path, V, F, name="mesh"):
    tri = V[F]                                   # (n,3,3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    L = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.divide(n, L, out=np.zeros_like(n), where=L > 1e-12)
    buf = bytearray()
    buf += name.encode("ascii", "replace")[:80].ljust(80, b"\0")
    buf += np.uint32(len(F)).tobytes()
    rec = np.zeros((len(F), 12), dtype=np.float32)
    rec[:, 0:3] = n
    rec[:, 3:12] = tri.reshape(len(F), 9)
    blob = np.zeros(len(F), dtype=[("d", "<f4", 12), ("a", "<u2")])
    blob["d"] = rec
    buf += blob.tobytes()
    Path(path).write_bytes(bytes(buf))


def slug(s):
    s = re.sub(r"\.stl$", "", s or "part", flags=re.I)
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower()
    return s or "part"


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("outdir")
    ap.add_argument("--include-negatives", action="store_true",
                    help="also export negative/cut parts as separate STLs")
    args = ap.parse_args()

    proj = Project(args.input)
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    manifest = []
    for obj in proj.top_objects():
        oid = obj["id"]
        cfg = proj.settings.get(oid, {})
        parts_cfg = cfg.get("parts", [])
        obj_name = cfg.get("name") or f"object_{oid}"

        for i, comp in enumerate(obj["components"]):
            got = proj.mesh(comp["path"], comp["objectid"])
            if got is None:
                print(f"  ! no mesh for {comp['path']}#{comp['objectid']}",
                      file=sys.stderr)
                continue
            V, F = got
            pcfg = parts_cfg[i] if i < len(parts_cfg) else {}
            subtype = pcfg.get("subtype", "normal_part")
            pname = pcfg.get("name") or f"{obj_name}_part{i}"
            negative = subtype != "normal_part"

            rec = {
                "object_id": oid,
                "object_name": obj_name,
                "part_index": i,
                "part_name": pname,
                "subtype": subtype,
                "source": f"{comp['path']}#{comp['objectid']}",
                "vertices": int(len(V)),
                "triangles": int(len(F)),
                "transform_3x4_rowmajor": comp["M"].tolist(),
                "local_bbox_min": V.min(0).tolist(),
                "local_bbox_max": V.max(0).tolist(),
            }
            if pcfg.get("text_info"):
                rec["text_info"] = pcfg["text_info"]

            if negative and not args.include_negatives:
                rec["exported"] = None
                manifest.append(rec)
                continue

            # positive bodies are written in the composite object's frame;
            # negatives are written in their own local frame so they can be
            # re-placed parametrically via the stored transform.
            Vw = V if negative else apply(comp["M"], V)
            fn = f"{slug(obj_name)}__{slug(pname)}.stl"
            write_stl(out / fn, Vw, F, name=pname)
            rec["exported"] = fn
            manifest.append(rec)
            print(f"  {fn}  ({len(F)} tris, {subtype})")

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nmanifest.json  ({len(manifest)} parts)")


if __name__ == "__main__":
    main()
