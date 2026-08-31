// gridfinity.js -- Gridfinity socket geometry and unit arithmetic.
//
// No DOM, like book.js, so the fit can be checked numerically under Node.
//
// Every number here is from the reference implementation
// (kennetek/gridfinity-rebuilt-openscad, src/core/standard.scad):
//
//   GRID_DIMENSIONS_MM  = [42, 42]         BASE_HEIGHT      = 7
//   BASE_TOP_DIMENSIONS = [41.5, 41.5]     BASE_TOP_RADIUS  = 7.5 / 2
//   BASE_PROFILE        = [[0,0], [0.8,0.8], [0.8,2.6], [2.95,4.75]]
//   BASE_BOTTOM_RADIUS  = BASE_TOP_RADIUS - 2.95 = 0.8
//
// BASE_PROFILE is (outward offset from the bottom, height), so the radius at
// each station is BASE_BOTTOM_RADIUS + offset and every ring is the SAME
// 34 x 34 core square offset by that radius:
//
//   z 0.00   r 0.80   35.6 mm   bottom of the foot
//   z 0.80   r 1.60   37.2 mm   top of the lower 45 deg chamfer
//   z 2.60   r 1.60   37.2 mm   top of the straight section
//   z 4.75   r 3.75   41.5 mm   the mouth, flush with the plate top
//
// A shared core is what makes the lofts exact: see `socket()`.

const TOP_DIM = 41.5;
const TOP_RADIUS = 7.5 / 2;

export const GRID = {
  pitch: 42,          // one grid unit, X and Y
  heightUnit: 7,      // one height unit, Z
  plateHeight: 4.75,  // BASE_PROFILE total height
  topDim: TOP_DIM,
  topRadius: TOP_RADIUS,
  core: TOP_DIM - 2 * TOP_RADIUS,             // 34
  rings: [[0, 0.8], [0.8, 1.6], [2.6, 1.6], [4.75, 3.75]],  // [z, radius]
  // 48 segments per full circle puts the chord sagitta on the 3.75 mm mouth
  // at 3.75*(1-cos(3.75 deg)) = 0.008 mm. Clipper's round join inscribes the
  // arc, so this is how much narrower than nominal a socket can come out.
  segments: 48,
};

export function createGridfinity(wasm) {
  const { Manifold, CrossSection } = wasm;

  const ring = (r) => CrossSection
    .square([GRID.core, GRID.core], true)
    .offset(r, 'Round', 2, GRID.segments);

  /**
   * The bin foot -- the solid a baseplate socket is the negative of.
   *
   * Built as a loft between the rings rather than a stack of steps. Each pair
   * is a convex hull, and for convex sections the hull's cross-section at a
   * height is the Minkowski average of the two ends. Both ends are the same
   * core square offset by their radius, so that average is the core square
   * offset by the interpolated radius -- exactly the 45 degree chamfer, with
   * no stair-stepping and no reliance on a tessellation density.
   *
   * `clearance` grows every ring, for printers that come out tight.
   */
  function socket(clearance = 0) {
    const at = (i) => {
      const [z, r] = GRID.rings[i];
      return { z, cs: ring(r + clearance) };
    };
    const segs = [];
    for (let i = 0; i < GRID.rings.length - 1; i++) {
      const a = at(i), b = at(i + 1);
      const h = b.z - a.z;
      segs.push(a.cs.isEmpty() || b.cs.isEmpty() ? null : Manifold.hull([
        Manifold.extrude(a.cs, h * 1e-3).translate([0, 0, a.z]),
        Manifold.extrude(b.cs, h * 1e-3).translate([0, 0, b.z - h * 1e-3]),
      ]));
    }
    // carry the mouth above the plate so the cut cannot land on a coincident
    // face with the plate's own top
    const top = GRID.rings[GRID.rings.length - 1];
    segs.push(Manifold.extrude(ring(top[1] + clearance), 1).translate([0, 0, top[0]]));
    return Manifold.union(segs.filter(Boolean));
  }

  /** Grid positions for a gx by gy block centred on (cx, cy). */
  function centres(gx, gy, cx = 0, cy = 0) {
    const out = [];
    for (let i = 0; i < gx; i++) {
      for (let j = 0; j < gy; j++) {
        out.push([cx + (i - (gx - 1) / 2) * GRID.pitch,
                  cy + (j - (gy - 1) / 2) * GRID.pitch]);
      }
    }
    return out;
  }

  /**
   * A baseplate filling `footprint`, with gx by gy sockets centred on it.
   *
   * The sockets are cut right through, so a bin's foot lands on whatever the
   * plate is sitting on rather than on the plate itself. That keeps the usable
   * depth equal to the full compartment depth: a bin of n height units needs
   * exactly n * 7 mm above the compartment floor, plate or no plate.
   */
  function baseplate(footprint, { gx, gy, cx = 0, cy = 0, clearance = 0 }) {
    if (gx < 1 || gy < 1) return null;
    const plate = Manifold.extrude(footprint, GRID.plateHeight);
    const s = socket(clearance);
    const cuts = centres(gx, gy, cx, cy).map(([x, y]) => s.translate([x, y, 0]));
    // one batched difference, never a chain -- see CLAUDE.md
    return Manifold.difference([plate, ...cuts]);
  }

  return { socket, baseplate, centres, ring };
}

/** How many whole units fit across an inner span. */
export const unitsAcross = (mm) => Math.max(0, Math.floor(mm / GRID.pitch + 1e-9));
