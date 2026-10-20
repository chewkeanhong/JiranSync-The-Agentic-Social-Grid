/* Architecture: turns extruded OSM footprints into recognisable Malaysian township
 * buildings, without moving a vertex or changing a height.
 *
 * 1. A *visual* building type for every footprint (buildingType). OSM tags here rarely say
 *    more than "house" or "yes", so the type is inferred conservatively from the OSM class,
 *    the role the server derived (home / shop / civic), height, and footprint size. It
 *    drives drawing only -- it is never treated as real-world data, and the building card
 *    labels it "visual type".
 *
 * 2. Instanced detail, a few thousand copies of three tiny shared meshes (deck.gl
 *    SimpleMeshLayer), so the whole township costs a handful of draw calls:
 *      - pitched clay or slate roofs on landed houses (gable along a terrace row, one per
 *        house; hipped or gabled on detached houses) and on low civic blocks;
 *      - car-porch canopies and front fences on the street side of each house;
 *      - awnings over the five-foot way in front of shop lots;
 *      - lift motor rooms, water tanks, air-con plant and roof planters on flat roofs.
 *    Where a house gets a pitched roof, its walls stop at the eaves and the ridge reaches
 *    the building's recorded height, so the overall height stays exactly the data's.
 *
 * 3. Ground: paved driveways and porches, the five-foot way, and the parking apron round
 *    apartment blocks, drawn flat on the ground under the roads.
 *
 * Everything is derived deterministically from each building's id and geometry: the same
 * building looks the same on every load.
 */

const ARCH = {roofs: [], boxes: [], aprons: [], counts: {}};
const ARCH_M = 6371000.0 * Math.PI / 180.0;

/* ------------------------------------------------------------------ classification */

const INDUSTRIAL_KINDS = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'storage_tank']);
const CIVIC_BUILDINGS = new Set(['school', 'kindergarten', 'university', 'college', 'mosque', 'temple',
                                 'church', 'public', 'civic', 'government', 'community_centre', 'hospital']);

/** Visual building type: landed_residential, apartment, condominium, highrise, shoplot,
 *  commercial, civic, industrial or other. Conservative inference -- see the file header. */
function buildingType(f, role) {
  if (f._type) return f._type;
  const p = f.properties;
  const kind = p.building || 'yes';
  const h = p.height || 8;
  const area = p.area_m2 || 0;
  let type;
  if (role === 'civic' || CIVIC_BUILDINGS.has(kind)) type = 'civic';
  else if (role === 'transit') type = 'other';
  else if (INDUSTRIAL_KINDS.has(kind) || (role !== 'shop' && area > 2500 && h < 14)) type = 'industrial';
  else if (role === 'shop' || ['retail', 'commercial', 'office'].includes(kind)) {
    type = h < 20 && area < 4000 ? 'shoplot' : 'commercial';
  } else if (kind === 'apartments' || (role === 'home' && h >= 12)) {
    type = h >= 45 ? 'highrise' : h >= 24 ? 'condominium' : 'apartment';
  } else if (role === 'home') type = 'landed_residential';
  else type = 'other';
  f._type = type;
  return type;
}

const TYPE_LABEL = {
  landed_residential: 'Landed house', apartment: 'Apartment block', condominium: 'Condominium',
  highrise: 'High-rise residential', shoplot: 'Shop lot', commercial: 'Commercial building',
  civic: 'Civic building', industrial: 'Industrial / warehouse', other: 'Building',
};

/* ------------------------------------------------------------------------ geometry */

function archHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

/** Minimum-area bounding rectangle of a footprint, in metres about its own centre:
 *  {centre [lon,lat], angle (rad, anticlockwise from east, along the long side), L, W, fill}. */
function footprintRect(ring) {
  const lon0 = ring[0][0], lat0 = ring[0][1];
  const k = ARCH_M * Math.cos(lat0 * Math.PI / 180);
  const pts = ring.slice(0, -1).map(([lon, lat]) => [(lon - lon0) * k, (lat - lat0) * ARCH_M]);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const a = Math.atan2(by - ay, bx - ax);
    const c = Math.cos(a), s = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of pts) {
      const u = x * c + y * s, v = -x * s + y * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const areaR = (u1 - u0) * (v1 - v0);
    if (!best || areaR < best.areaR) best = {areaR, a, u0, u1, v0, v1};
  }
  if (!best) return null;
  let {a} = best;
  let L = best.u1 - best.u0, W = best.v1 - best.v0;
  const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
  const cx = cu * Math.cos(a) - cv * Math.sin(a), cy = cu * Math.sin(a) + cv * Math.cos(a);
  if (W > L) { [L, W] = [W, L]; a += Math.PI / 2; }
  // How much of the rectangle the footprint fills: near 1 for a box, low for an L or a U.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return {centre: [lon0 + cx / k, lat0 + cy / ARCH_M], angle: a, L, W, k,
          fill: Math.abs(area / 2) / Math.max(best.areaR, 1e-6)};
}

/** A point `u` metres along and `v` metres across a rectangle, as [lon, lat]. */
function rectPoint(r, u, v) {
  const c = Math.cos(r.angle), s = Math.sin(r.angle);
  return [r.centre[0] + (u * c - v * s) / r.k, r.centre[1] + (u * s + v * c) / ARCH_M];
}

/** Nearest street to a point, in metres, from a coarse grid of road vertices. */
function makeRoadDistance(roads) {
  const cell = 0.0005;
  const grid = new Map();
  for (const f of roads) {
    if (['motorway', 'motorway_link'].includes(f.properties.highway)) continue;
    const pts = f.geometry.coordinates;
    for (let i = 0; i < pts.length - 1; i++) {
      // Densify, so a long straight street still has a vertex near every house.
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.00008));
      for (let j = 0; j <= n; j++) {
        const x = x0 + (x1 - x0) * j / n, y = y0 + (y1 - y0) * j / n;
        const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(x, y);
      }
    }
  }
  return (lon, lat) => {
    const gx = Math.floor(lon / cell), gy = Math.floor(lat / cell);
    const k = ARCH_M * Math.cos(lat * Math.PI / 180);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const v = grid.get(`${gx + dx},${gy + dy}`);
        if (!v) continue;
        for (let i = 0; i < v.length; i += 2) {
          best = Math.min(best, Math.hypot((v[i] - lon) * k, (v[i + 1] - lat) * ARCH_M));
        }
      }
    }
    return best;
  };
}

/* ---------------------------------------------------------------------- meshes */

function meshFrom(tris) {
  // Flat-shaded triangles: each carries its own face normal.
  const pos = [], nor = [];
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    n = n.map((x) => x / l);
    pos.push(...a, ...b, ...c);
    nor.push(...n, ...n, ...n);
  }
  return {attributes: {POSITION: {value: new Float32Array(pos), size: 3},
                       NORMAL: {value: new Float32Array(nor), size: 3}}};
}

/* Unit meshes: 1 x 1 in plan, 1 high, centred in plan, standing on z = 0. Each instance is
 * scaled to metres and turned to its footprint. */
const MESH_GABLE = meshFrom([
  [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0, 1]], [[-0.5, -0.5, 0], [0.5, 0, 1], [-0.5, 0, 1]],
  [[0.5, 0.5, 0], [-0.5, 0.5, 0], [-0.5, 0, 1]], [[0.5, 0.5, 0], [-0.5, 0, 1], [0.5, 0, 1]],
  [[0.5, -0.5, 0], [0.5, 0.5, 0], [0.5, 0, 1]], [[-0.5, 0.5, 0], [-0.5, -0.5, 0], [-0.5, 0, 1]],
]);
const MESH_HIP = meshFrom([
  [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.25, 0, 1]], [[-0.5, -0.5, 0], [0.25, 0, 1], [-0.25, 0, 1]],
  [[0.5, 0.5, 0], [-0.5, 0.5, 0], [-0.25, 0, 1]], [[0.5, 0.5, 0], [-0.25, 0, 1], [0.25, 0, 1]],
  [[0.5, -0.5, 0], [0.5, 0.5, 0], [0.25, 0, 1]], [[-0.5, 0.5, 0], [-0.5, -0.5, 0], [-0.25, 0, 1]],
]);
const BOX_FACES = [];
{
  const c = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  BOX_FACES.push([[...c[0], 1], [...c[1], 1], [...c[2], 1]], [[...c[0], 1], [...c[2], 1], [...c[3], 1]]);
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    BOX_FACES.push([[...a, 0], [...b, 0], [...b, 1]], [[...a, 0], [...b, 1], [...a, 1]]);
  }
}
const MESH_BOX = meshFrom(BOX_FACES);

/* Clay tile in three tones and a grey slate -- one palette per terrace row, with each house
 * a shade apart, the way a row weathers. */
const ROOF_TILE = [[122, 62, 46], [138, 78, 56], [106, 56, 44], [78, 82, 90], [96, 64, 54]];
const AWNING = [[150, 52, 46], [36, 112, 102], [182, 140, 52], [62, 92, 150], [196, 196, 188], [120, 64, 110]];

/* ----------------------------------------------------------------- construction */

hooks.ready.push((world) => {
  const roadDistance = makeRoadDistance(world.roads.features);
  const deg = (r) => r * 180 / Math.PI;
  const add = (list, item) => list.push(item);
  if (RENDER_QUALITY === 'lite') return;   // software rendering: keep the plain massing

  for (const f of world.buildings.features) {
    const role = world.roles?.[f.id];
    const type = buildingType(f, role);
    ARCH.counts[type] = (ARCH.counts[type] || 0) + 1;
    const p = f.properties;
    const h = p.height || 8;
    const ground = p.ground_elev || 0;
    const r = footprintRect(f.geometry.coordinates[0]);
    if (!r || r.L < 3) continue;
    const seed = archHash(f.id);
    const yaw = deg(r.angle);
    // The street side: whichever long face is nearer a road.
    const front = roadDistance(...rectPoint(r, 0, r.W / 2)) <= roadDistance(...rectPoint(r, 0, -r.W / 2)) ? 1 : -1;
    const frontGap = roadDistance(...rectPoint(r, 0, front * r.W / 2));

    if ((type === 'landed_residential' || (type === 'civic' && h < 16)) && r.fill > 0.78 && r.W > 3.5) {
      // -- pitched roof; the walls now stop at the eaves -----------------------------------
      let rise = Math.min(3.0, Math.max(1.4, r.W * (type === 'civic' ? 0.22 : 0.3)));
      rise = Math.min(rise, Math.max(1.0, h - 2.8));
      f._eave = h - rise;
      const terrace = type === 'landed_residential' && r.L > 13;
      const units = terrace ? Math.max(2, Math.round(r.L / 6.5)) : 1;
      const u = r.L / units;
      const palette = type === 'civic' ? [[44, 104, 102], [52, 116, 110], [128, 66, 46]] : ROOF_TILE;
      const base = palette[Math.floor(seed * 997) % palette.length];
      const hip = !terrace && (type === 'civic' || archHash(f.id + 'h') < 0.6);
      for (let i = 0; i < units; i++) {
        const along = -r.L / 2 + u * (i + 0.5);
        const jitter = Math.round((archHash(f.id + i) - 0.5) * 16);
        const ends = (i === 0 ? 0.35 : 0) + (i === units - 1 ? 0.35 : 0);
        const shift = (i === 0 ? -0.175 : 0) + (i === units - 1 ? 0.175 : 0);
        add(ARCH.roofs, {
          pos: [...rectPoint(r, along + shift, 0), ground + f._eave],
          yaw, scale: [u + ends + (units === 1 ? 0.6 : 0), r.W + 0.9, rise],
          color: base.map((c) => Math.max(0, Math.min(255, c + jitter))), hip,
        });
        if (type !== 'landed_residential') continue;
        // -- car porch, driveway and front fence, if the house is set back from the road --
        const depth = Math.min(5.5, frontGap - 2.5);
        if (depth < 3.0) continue;
        const porchAlong = along - u * 0.17;
        add(ARCH.boxes, {pos: [...rectPoint(r, porchAlong, front * (r.W / 2 + depth / 2)), ground + 2.55],
                         yaw, scale: [u * 0.56, depth, 0.22], color: [138, 136, 130], kind: 'porch'});
        add(ARCH.boxes, {pos: [...rectPoint(r, along, front * (r.W / 2 + depth + 0.1)), ground],
                         yaw, scale: [u * 0.97, 0.16, 1.15], color: [128, 126, 120], kind: 'fence'});
        const q = (a, b) => rectPoint(r, a, front * b);
        add(ARCH.aprons, {ring: [q(along - u / 2, r.W / 2), q(along + u / 2, r.W / 2),
                                 q(along + u / 2, r.W / 2 + depth), q(along - u / 2, r.W / 2 + depth)],
                          color: [78, 80, 84, 235]});
      }
    } else if (['apartment', 'condominium', 'highrise'].includes(type)) {
      // -- rooftop plant and the parking apron ---------------------------------------------
      const top = ground + h;
      add(ARCH.boxes, {pos: [...rectPoint(r, r.L * 0.22, 0), top], yaw,
                       scale: [Math.min(7, r.L * 0.22), Math.min(5, r.W * 0.45), 3.2], color: [150, 150, 148]});
      add(ARCH.boxes, {pos: [...rectPoint(r, -r.L * 0.22, r.W * 0.12), top], yaw,
                       scale: [3.2, 3.2, 2.4], color: [118, 140, 158]});
      if (seed < 0.4) {
        // A roof garden on some blocks.
        add(ARCH.boxes, {pos: [...rectPoint(r, -r.L * 0.05, -r.W * 0.22), top], yaw,
                         scale: [r.L * 0.4, r.W * 0.28, 0.6], color: [58, 108, 66]});
      }
      const pad = 6;
      add(ARCH.aprons, {ring: [rectPoint(r, -r.L / 2 - pad, -r.W / 2 - pad), rectPoint(r, r.L / 2 + pad, -r.W / 2 - pad),
                               rectPoint(r, r.L / 2 + pad, r.W / 2 + pad), rectPoint(r, -r.L / 2 - pad, r.W / 2 + pad)],
                        color: [62, 64, 70, 230]});
    } else if (type === 'shoplot') {
      // -- awnings over the five-foot way, one per shop; tanks on the roof ----------------
      const units = Math.max(1, Math.round(r.L / 6.1));
      const u = r.L / units;
      for (let i = 0; i < units; i++) {
        const along = -r.L / 2 + u * (i + 0.5);
        const c = AWNING[Math.floor(archHash(f.id + 'a' + i) * 997) % AWNING.length];
        add(ARCH.boxes, {pos: [...rectPoint(r, along, front * (r.W / 2 + 1.1)), ground + 3.25],
                         yaw, scale: [u * 0.96, 2.2, 0.28], color: c});
        if (i % 2 === 0) {
          add(ARCH.boxes, {pos: [...rectPoint(r, along, -front * r.W * 0.3), ground + h], yaw,
                           scale: [1.6, 1.6, 1.4], color: [120, 138, 156]});
        }
      }
      add(ARCH.aprons, {ring: [rectPoint(r, -r.L / 2, front * r.W / 2), rectPoint(r, r.L / 2, front * r.W / 2),
                               rectPoint(r, r.L / 2, front * (r.W / 2 + 2.4)), rectPoint(r, -r.L / 2, front * (r.W / 2 + 2.4))],
                        color: [96, 92, 86, 240]});
    } else if (type === 'commercial' || type === 'industrial') {
      // -- air-con plant and vents along the roof -----------------------------------------
      const n = Math.min(8, Math.max(2, Math.floor((p.area_m2 || 0) / 700)));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        add(ARCH.boxes, {pos: [...rectPoint(r, t * r.L * 0.8, (archHash(f.id + i) - 0.5) * r.W * 0.5), ground + h],
                         yaw, scale: [type === 'industrial' ? 2 : 3.2, type === 'industrial' ? 2 : 2.2, 1.6],
                         color: [128, 132, 136]});
      }
    }
  }
  console.info('architecture:', JSON.stringify(ARCH.counts),
               `${ARCH.roofs.length} roofs, ${ARCH.boxes.length} details, ${ARCH.aprons.length} aprons`);
});

/* ------------------------------------------------------------------------ layers */

function archZoom() { return currentView['3d']?.zoom ?? 16; }

hooks.ground.push((p, flat) => {
  if (flat || !mapLayers.buildings || !ARCH.aprons.length) return [];
  return [new PolygonLayer({
    id: p('arch-aprons'),
    data: ARCH.aprons,
    getPolygon: (a) => a.ring.map(([x, y]) => [x, y, groundAt(x, y) + 0.7]),
    getFillColor: (a) => a.color,
    filled: true, stroked: false, extruded: false, material: false,
    parameters: {depthTest: false, depthMask: false},
  })];
});

hooks.layers.push((p, flat) => {
  if (flat || !mapLayers.buildings) return [];
  const close = archZoom() >= 15.4;
  const material = {ambient: 0.45, diffuse: 0.7, shininess: 20, specularColor: [40, 40, 40]};
  return [
    new deck.SimpleMeshLayer({
      id: p('arch-roofs-gable'),
      data: ARCH.roofs.filter((r) => !r.hip),
      mesh: MESH_GABLE,
      getPosition: (r) => r.pos, getOrientation: (r) => [0, r.yaw, 0], getScale: (r) => r.scale,
      getColor: (r) => r.color, material,
    }),
    new deck.SimpleMeshLayer({
      id: p('arch-roofs-hip'),
      data: ARCH.roofs.filter((r) => r.hip),
      mesh: MESH_HIP,
      getPosition: (r) => r.pos, getOrientation: (r) => [0, r.yaw, 0], getScale: (r) => r.scale,
      getColor: (r) => r.color, material,
    }),
    // Porches, fences, awnings and roof plant only matter up close: far away they are a
    // pixel each, so the layer is skipped.
    new deck.SimpleMeshLayer({
      id: p('arch-details'),
      data: ARCH.boxes,
      visible: close,
      mesh: MESH_BOX,
      getPosition: (b) => b.pos, getOrientation: (b) => [0, b.yaw, 0], getScale: (b) => b.scale,
      getColor: (b) => b.color, material,
    }),
  ];
});
