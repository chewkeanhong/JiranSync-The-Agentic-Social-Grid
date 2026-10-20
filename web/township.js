/* The township layer: what makes the map read as City of Elmina rather than a field of
 * extruded polygons.
 *
 *   - Land cover from OpenStreetMap (data/landcover.geojson): the real parks, playing
 *     fields, grass, woodland, lakes and drains, laid on the DEM ground.
 *   - Trees. Illustrative, and only where the data says there is green: inside parks,
 *     woodland and grass, and along the verges of real streets. OSM does not map single
 *     trees here, so their positions are a deterministic visual estimate -- the same
 *     every load, never inside a building, a pitch or water.
 *   - Labels taken only from names in the data: parks, the lake, the river, schools,
 *     the mall, temples and halls, and the names of the major roads drawn along them.
 *
 * Nothing here moves a road or a building, and none of it feeds matching.
 */

const COVER_STYLE = {
  water:        {d3: [30, 82, 124, 235],  d2: [70, 132, 180, 255]},
  park:         {d3: [34, 82, 56, 225],   d2: [84, 140, 96, 255]},
  grass:        {d3: [42, 80, 54, 200],   d2: [104, 146, 104, 255]},
  wood:         {d3: [24, 64, 44, 230],   d2: [64, 116, 78, 255]},
  pitch:        {d3: [46, 112, 70, 240],  d2: [106, 174, 116, 255]},
  playground:   {d3: [92, 100, 66, 225],  d2: [160, 158, 104, 255]},
  construction: {d3: [74, 66, 54, 190],   d2: [138, 126, 104, 255]},
};
const WATER_LINE = {river: 9, drain: 3};
const TREE_GREENS = [[38, 92, 56], [46, 104, 60], [32, 80, 50], [56, 110, 62], [42, 96, 70]];

const township = {cover: [], waterways: [], pitches: [], trees: [], roadLabels: [], landmarks: []};

/* A tree crown: a faceted ellipsoid, 1 across and 1 tall, standing on z = 0 (8 sides,
 * 4 bands). Flat-shaded, so it reads as foliage catching the light rather than a cylinder. */
const TREE_CROWN = (() => {
  const seg = 8, bands = 4, ring = [];
  for (let b = 0; b <= bands; b++) {
    const phi = Math.PI * b / bands;               // 0 at the top, pi at the bottom
    const r = 0.5 * Math.sin(phi), z = 0.5 + 0.5 * Math.cos(phi);
    ring.push(Array.from({length: seg}, (_, i) => {
      const a = 2 * Math.PI * (i + (b % 2) * 0.5) / seg;
      return [r * Math.cos(a), r * Math.sin(a), z];
    }));
  }
  const tris = [];
  for (let b = 0; b < bands; b++) {
    for (let i = 0; i < seg; i++) {
      const a = ring[b][i], c = ring[b][(i + 1) % seg], d = ring[b + 1][i], e = ring[b + 1][(i + 1) % seg];
      tris.push([a, d, e], [a, e, c]);
    }
  }
  return meshFrom(tris);
})();

/* -------------------------------------------------------------------- geometry */

const TW_M = 6371000.0 * Math.PI / 180.0;
function twHash(a, b) {
  let h = 2166136261 ^ Math.round(a * 1e6);
  h = Math.imul(h ^ Math.round(b * 1e6), 16777619);
  h ^= h >>> 13; h = Math.imul(h, 2246822507); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function twInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function twBox(ring) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of ring) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}

/** A coarse grid of footprints and no-tree areas, so 15,000 tree tests stay cheap. */
function twIndex(rings, cell = 0.0004) {
  const grid = new Map();
  rings.forEach((ring, i) => {
    const [a, b, c, d] = twBox(ring);
    for (let x = Math.floor(a / cell); x <= Math.floor(c / cell); x++) {
      for (let y = Math.floor(b / cell); y <= Math.floor(d / cell); y++) {
        const k = `${x},${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  return (lon, lat) => (grid.get(`${Math.floor(lon / cell)},${Math.floor(lat / cell)}`) || [])
    .some((i) => twInRing(lon, lat, rings[i]));
}

function twCentroid(ring) {
  let x = 0, y = 0;
  const n = ring.length - 1 || 1;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}

/* ------------------------------------------------------------------ preparation */

hooks.ready.push((world) => {
  const lite = RENDER_QUALITY === 'lite';
  const features = world.landcover?.features || [];
  for (const f of features) {
    const cls = f.properties.class;
    if (f.geometry.type === 'LineString') {
      township.waterways.push({cls, path: onGround(f.geometry.coordinates, 0.7), flat: f.geometry.coordinates});
    } else if (COVER_STYLE[cls]) {
      const ring = f.geometry.coordinates[0];
      township.cover.push({cls, ring, poly: ring.map(([x, y]) => [x, y, groundAt(x, y) + 0.6]),
                           name: f.properties.name, area: f.properties.area_m2 || 0});
    }
  }
  // Largest first, so a pitch inside a park draws on top of it.
  township.cover.sort((a, b) => b.area - a.area);

  // -- trees -------------------------------------------------------------------------
  const footprints = world.buildings.features.map((f) => f.geometry.coordinates[0]);
  const inBuilding = twIndex(footprints);
  const noTrees = twIndex(township.cover.filter((c) => ['water', 'pitch', 'construction'].includes(c.cls))
    .map((c) => c.ring));
  const cosLat = Math.cos((world.centre?.lat || 3.18) * Math.PI / 180);
  const trees = [];
  const plant = (lon, lat, scale = 1) => {
    if (inBuilding(lon, lat) || noTrees(lon, lat)) return;
    const r = twHash(lon, lat);
    trees.push({lon, lat, z: groundAt(lon, lat), r: (2.0 + 1.6 * r) * scale,
                h: (3.2 + 2.6 * twHash(lat, lon)) * scale, c: TREE_GREENS[Math.floor(r * 997) % TREE_GREENS.length]});
  };
  const SPACING = {park: 11, wood: 7, grass: 17};
  for (const c of township.cover) {
    const step = SPACING[c.cls];
    if (!step) continue;
    const [a, b, cc, d] = twBox(c.ring);
    const dLat = step / TW_M, dLon = step / (TW_M * cosLat);
    for (let lon = a; lon <= cc; lon += dLon) {
      for (let lat = b; lat <= d; lat += dLat) {
        const jx = (twHash(lon, lat) - 0.5) * dLon * 0.8, jy = (twHash(lat, lon) - 0.5) * dLat * 0.8;
        if (twInRing(lon + jx, lat + jy, c.ring)) plant(lon + jx, lat + jy, c.cls === 'wood' ? 1.15 : 1);
      }
    }
  }
  // Street trees on the verges of real streets: a row each side, every ~20 m.
  const VERGE = {secondary: 22, tertiary: 20, residential: 24, unclassified: 26};
  for (const f of world.roads.features) {
    const every = VERGE[f.properties.highway];
    if (!every) continue;
    const half = (ROAD_CLASS[f.properties.highway] || ROAD_CLASS._).width / 2 + 2.4;
    const pts = f.geometry.coordinates;
    let carry = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const ex = (x1 - x0) * TW_M * cosLat, ey = (y1 - y0) * TW_M;
      const len = Math.hypot(ex, ey);
      if (len < 1) continue;
      const nx = -ey / len, ny = ex / len;
      for (let s = carry; s < len; s += every) {
        const t = s / len;
        for (const side of [1, -1]) {
          plant(x0 + (x1 - x0) * t + side * nx * half / (TW_M * cosLat),
                y0 + (y1 - y0) * t + side * ny * half / TW_M, 0.85);
        }
      }
      carry = (carry - len) % every;
      if (carry < 0) carry += every;
    }
  }
  const cap = lite ? 3500 : 14000;
  township.trees = trees.length > cap ? trees.filter((_, i) => i % Math.ceil(trees.length / cap) === 0) : trees;

  // -- road names --------------------------------------------------------------------
  const MAJOR = new Set(['motorway', 'secondary', 'tertiary']);
  const best = new Map();
  for (const f of world.roads.features) {
    const name = f.properties.name;
    if (!name || !(MAJOR.has(f.properties.highway) || /^(Persiaran|Lebuhraya)/.test(name))) continue;
    const pts = f.geometry.coordinates;
    for (let i = 0; i < pts.length - 1; i++) {
      const ex = (pts[i + 1][0] - pts[i][0]) * TW_M * cosLat, ey = (pts[i + 1][1] - pts[i][1]) * TW_M;
      const len = Math.hypot(ex, ey);
      if (!best.has(name) || len > best.get(name).len) {
        let angle = Math.atan2(ey, ex) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
        best.set(name, {name, len, angle, position: [...mid, groundAt(...mid) + 2.2]});
      }
    }
  }
  township.roadLabels = [...best.values()].filter((l) => l.len > 60).sort((a, b) => b.len - a.len).slice(0, 14);

  // -- landmarks: named places in the data -----------------------------------------
  const marks = [];
  for (const c of township.cover) {
    if (!c.name || /future|construction/i.test(c.name)) continue;
    const kind = c.cls === 'water' ? 'water' : ['park', 'wood', 'grass', 'playground'].includes(c.cls) ? 'park' : 'civic';
    const at = twCentroid(c.ring);
    marks.push({name: c.name, kind, lonlat: at, z: groundAt(...at) + 4, area: c.area});
  }
  const LANDMARK = /mall|pavilion|gallery|temple|dewan|tadika|pangsapuri|sekolah|school|arena/i;
  for (const f of world.buildings.features) {
    const p = f.properties;
    if (!p.name || !LANDMARK.test(p.name)) continue;
    const at = world.centroids?.[f.id] || twCentroid(f.geometry.coordinates[0]);
    const role = world.roles?.[f.id];
    const kind = /sekolah|school|tadika/i.test(p.name) ? 'school'
      : role === 'shop' || /mall|pavilion|gallery/i.test(p.name) ? 'shop' : 'civic';
    marks.push({name: p.name, kind, lonlat: at, z: (p.ground_elev || 0) + (p.height || 6) + 3, area: p.area_m2 || 0});
  }
  // One label per name, biggest first; no more than a dozen so the map stays readable.
  const seen = new Set();
  township.landmarks = marks.sort((a, b) => b.area - a.area)
    .filter((m) => !seen.has(m.name) && seen.add(m.name)).slice(0, 12);
  console.info(`township: ${township.cover.length} land-cover areas, ${township.trees.length} trees, ` +
               `${township.roadLabels.length} road names, ${township.landmarks.length} landmarks`);
});

/* ------------------------------------------------------------------------ layers */

hooks.ground.push((p, flat) => {
  const layers = [];
  if (!mapLayers.greenery) return layers;
  // Flat on the ground and painted in order, under the roads and buildings that follow.
  layers.push(new PolygonLayer({
    id: p('landcover'),
    data: township.cover,
    getPolygon: (c) => (flat ? c.ring : c.poly),
    filled: true,
    stroked: false,
    extruded: false,
    getFillColor: (c) => COVER_STYLE[c.cls][flat ? 'd2' : 'd3'],
    material: false,
    parameters: {depthTest: false, depthMask: false},
  }));
  layers.push(new PathLayer({
    id: p('landcover-edges'),
    data: township.cover.filter((c) => c.cls === 'pitch' || c.cls === 'water'),
    getPath: (c) => (flat ? c.ring : c.poly),
    getColor: (c) => (c.cls === 'pitch' ? [214, 236, 220, 120] : [110, 170, 214, 150]),
    getWidth: (c) => (c.cls === 'pitch' ? 0.8 : 1.6),
    widthUnits: 'meters',
    widthMinPixels: 0.5,
    parameters: {depthTest: false, depthMask: false},
  }));
  layers.push(new PathLayer({
    id: p('waterways'),
    data: township.waterways,
    getPath: (w) => (flat ? w.flat : w.path),
    getColor: (w) => (flat ? COVER_STYLE.water.d2 : [44, 104, 150, 230]),
    getWidth: (w) => WATER_LINE[w.cls] || 3,
    widthUnits: 'meters',
    widthMinPixels: 1,
    capRounded: true,
    jointRounded: true,
    parameters: {depthTest: false, depthMask: false},
  }));
  if (mapLayers.trees && township.trees.length) {
    if (flat) {
      layers.push(new ScatterplotLayer({
        id: p('trees'),
        data: township.trees,
        getPosition: (t) => [t.lon, t.lat],
        getRadius: (t) => t.r,
        radiusUnits: 'meters',
        getFillColor: (t) => [...t.c.map((v) => Math.min(255, v + 40)), 200],
        parameters: {depthTest: false},
      }));
    } else {
      layers.push(new ColumnLayer({
        id: p('tree-trunks'),
        data: township.trees,
        diskResolution: 5,
        radius: 0.35,
        extruded: true,
        getPosition: (t) => [t.lon, t.lat, t.z],
        getElevation: (t) => t.h * 0.45,
        getFillColor: [74, 58, 44],
        material: false,
      }));
      // A rounded, low-poly crown: one shared mesh, each tree scaled to its own size.
      layers.push(new deck.SimpleMeshLayer({
        id: p('tree-crowns'),
        data: township.trees,
        mesh: TREE_CROWN,
        getPosition: (t) => [t.lon, t.lat, t.z + t.h * 0.38],
        getScale: (t) => [t.r * 2, t.r * 2, t.h * 0.66],
        getOrientation: (t) => [0, (t.lon * 1e6) % 360, 0],
        getColor: (t) => t.c,
        material: {ambient: 0.5, diffuse: 0.6, shininess: 6, specularColor: [20, 30, 20]},
      }));
    }
  }
  return layers;
});

hooks.layers.push((p, flat) => {
  if (!mapLayers.labels || !township.roadLabels.length) return [];
  return [new TextLayer({
    id: p('road-names'),
    data: township.roadLabels,
    getText: (l) => l.name,
    getPosition: (l) => (flat ? l.position.slice(0, 2) : l.position),
    getAngle: (l) => l.angle,
    billboard: false,
    sizeUnits: 'meters',
    getSize: 9,
    sizeMinPixels: 9,
    sizeMaxPixels: 15,
    getColor: [206, 214, 228, 190],
    fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
    fontWeight: 600,
    fontSettings: {sdf: true},
    outlineWidth: 3,
    outlineColor: [8, 12, 22, 230],
    parameters: {depthTest: false},
  })];
});

/* ---------------------------------------------------------------------- markers */

const LANDMARK_STYLE = {
  park: ['sprout', '#34d399'], water: ['drop', '#38bdf8'], school: ['cap', '#a78bfa'],
  shop: ['store', '#f4577b'], civic: ['users', '#94a3b8'],
};

function landmarkMarkers() {
  if (!mapLayers.labels) return [];
  return township.landmarks.map((m, i) => {
    const [ic, color] = LANDMARK_STYLE[m.kind];
    return {
      key: `lm:${i}`, kind: 'place', lonlat: m.lonlat, z: m.z, cls: 'landmark',
      html: `<div class="pl lm" style="--c:${color}"><span class="pl-ic">${icon(ic, 12)}</span>` +
        `<span class="pl-name">${esc(m.name)}</span></div>`,
      title: `${m.name} · OpenStreetMap`,
    };
  });
}
