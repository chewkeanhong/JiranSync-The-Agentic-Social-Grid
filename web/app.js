/* JiranSync map core.
 *
 * A renderer and nothing else. The server owns the clock and the model; this file turns
 * the township's static geometry and the pushed state into deck.gl layers. The JiranSync
 * UI (web/jiran.js) plugs in through `hooks` -- overlay layers, tooltips, clicks, the
 * inspector's content and per-snapshot rendering -- so the map never needs to know what a
 * task or a credit is.
 *
 * Everything is local: deck.gl is vendored, the geometry comes from our own GeoJSON, and
 * the roads are drawn rather than fetched as basemap tiles. The page works offline.
 */

const {DeckGL, MapView, PolygonLayer, PathLayer, ScatterplotLayer, ColumnLayer,
       TextLayer, PathStyleExtension, TripsLayer, LineLayer, SolidPolygonLayer} = deck;

/* ------------------------------------------------------------------ palette */

const C = {
  buildingLow:  [38, 48, 70],
  buildingHigh: [92, 112, 152],
  imputedTint:  [70, 78, 104],
  road:         [46, 58, 82],
};

/* Glyphs the 3D labels use beyond ASCII. The vendored deck.gl predates
 * `characterSet: 'auto'`, so anything outside the default atlas renders as a box. */
const LABEL_CHARSET = [
  '●', '·', '→', '↓', '×', '—', '★',
  ...Array.from({length: 95}, (_, n) => String.fromCharCode(32 + n)),
];

/* Extension points for web/jiran.js. Registered synchronously when that script loads,
 * which is before boot() finishes awaiting the world, so every hook is in place by the
 * first frame. */
const hooks = {
  ground: [],         // (p, flat) => Layer[]  -- on the ground, under the buildings
  layers: [],         // (p, flat) => Layer[]  -- overlays, drawn above the town
  tooltip: [],        // ({object, layer}) => {html} | null
  click: [],          // (info) => true if handled
  snapshot: [],       // (state) => void, after each WebSocket frame
  ready: [],          // (world) => void, once the township is loaded
  inspector: null,    // (inspected) => {kicker, name, sub, body, tone, actions} | null
  buildingTint: null, // (feature) => [r,g,b] | null -- recolour a building
  buildingExtras: null, // (id) => {body, actions} -- more for a building's panel
  tintKey: () => '',  // signature for buildingTint, so deck.gl knows when to recolour
  animating: () => false, // true while an overlay needs continuous frames
  dock: () => null,       // {x, y} to dock the card at a fixed spot instead of beside its object
};

/* Moving-entity history, kept client-side so TripsLayer has something to draw. The
 * server pushes positions, not tracks: storing the tail here turns dots stepping at 4 Hz
 * into people who visibly move. Capped so a long session cannot grow it without bound. */
const TRAIL_LENGTH = 90;
const trails = new Map();

function recordTrails(entities, t) {
  for (const e of entities || []) {
    let trail = trails.get(e.id);
    if (!trail) { trail = {path: [], timestamps: []}; trails.set(e.id, trail); }
    const last = trail.path[trail.path.length - 1];
    // Skip duplicate samples: someone standing still should not pile up vertices.
    if (!last || last[0] !== e.lon || last[1] !== e.lat) {
      trail.path.push([e.lon, e.lat]);
      trail.timestamps.push(t);
      if (trail.path.length > TRAIL_LENGTH) {
        trail.path.shift();
        trail.timestamps.shift();
      }
    }
  }
}

/* -------------------------------------------------------------------- state */

let world = null;            // static payload from /api/world
let state = null;            // latest snapshot from the WebSocket
let deckgl = null;

/* '2d' -- a flat, north-up plan of the township
 * '3d' -- the extruded township at blue hour */
let viewMode = '3d';
let facadeExtension = null;  // web/facade.js shader, attached to the 3D buildings

/* Rendering tier. 'high' draws the full city: facade shader, street lighting, kerbs and
 * lane markings. 'lite' is the same data and the same layers without those per-pixel
 * passes, for software WebGL (SwiftShader, llvmpipe, Windows' Basic Render Driver) --
 * where the GPU work lands on the CPU the simulation runs on, and the headless browser
 * in scripts/verify_ui.py slowed the scenario clock to a quarter of its speed. Any real
 * GPU gets 'high'. ?quality=high or ?quality=lite overrides the detection. */
const RENDER_QUALITY = (() => {
  const asked = new URLSearchParams(location.search).get('quality');
  if (asked === 'high' || asked === 'lite') return asked;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(name) ? 'lite' : 'high';
  } catch (err) {
    return 'high';
  }
})();

/* Building shadows on the ground, projected once from each footprint and height along
 * the sun direction (see buildingShadow). deck.gl's own shadow-map pass was tried and
 * rejected: at city scale it laid a uniform grey wash over every surface instead of
 * casting building-shaped shadows, and cost four times the frame time in software.
 * ?shadows=0 turns the projected shadows off. */
const SHADOWS = new URLSearchParams(location.search).get('shadows') !== '0';

/* Where the light comes from. The sun's direction drives both the facade shading
 * (cityLighting) and the shadow projection, so the two always agree. Low and from the
 * west-southwest: blue hour, long shadows running east-northeast. */
const SUN_DIRECTION = [1.0, 0.45, -0.8];
let selectedBuilding = null; // building id open in the inspection panel

/* What the map draws, switched from the Layers menu. Data layers only change what is
 * shown, never what the matching engine or the server knows. */
const mapLayers = {buildings: true, terrain: true, greenery: true, trees: true, labels: true,
                   residents: true};
const currentView = {};      // last camera per view id, so transitions start from it

/* ------------------------------------------------------------------ helpers */

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function clockText(seconds) {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* A faint tint per OSM building class, so blocks, housing and low commercial lots read
 * as different kinds of city without competing with the status colours. Kept within a
 * dozen levels of the base ramp: this is material, not information. */
const KIND_TINT = {
  office: [-4, 2, 14], commercial: [-2, 8, 8], retail: [8, 4, -4], mall: [8, 4, -4],
  apartments: [12, 6, -6], residential: [12, 6, -6], house: [14, 8, -6],
  hotel: [10, 0, 10], hospital: [4, 10, 6], school: [8, 8, -2], university: [8, 8, -2],
  industrial: [2, 0, -8], warehouse: [2, 0, -8], train_station: [0, 6, 4],
  parking: [-6, -6, -6], government: [6, 6, 6], civic: [6, 6, 6],
};

function shade(c, k) {
  const out = [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];
  if (c.length > 3) out.push(c[3]);
  return out;
}

/** Buildings read as a height field: taller is lighter, so the skyline is legible. */
function buildingColor(feature, mode) {
  const colour = baseBuildingColor(feature, mode);
  // The inspected building keeps its meaning (orange blocker, red dark, ...) and is
  // lifted towards white, so it stands out without pretending to be something else.
  if (feature.id === selectedBuilding) {
    return colour.map((c, i) => (i < 3 ? Math.round(c + (255 - c) * 0.38) : c));
  }
  return colour;
}

/* The flat plan: homes, shops and civic buildings read apart, as on a masterplan. */
const PLAN_TINT = {
  home: [92, 98, 116], shop: [150, 86, 108], civic: [70, 130, 128], transit: [56, 140, 170],
};

function baseBuildingColor(feature, mode) {
  const tint = hooks.buildingTint?.(feature);
  if (tint) return tint;

  if (mode !== '2d' && feature._mat) {
    // Facade material from the building's own OSM class and height (web/facade.js). The
    // class rides in alpha for the facade shader; overlay tints above carry none and so
    // are drawn flat. Without the shader there are no windows or night shading, so the
    // same material is drawn darker and a little cooler -- a town at dusk, not cardboard.
    return facadeExtension
      ? [...feature._mat.tone, 255 - feature._mat.cls]
      : feature._mat.tone.map((c, i) => Math.round(c * 0.44 + [6, 9, 16][i]));
  }

  const role = world?.roles?.[feature.id];
  if (mode === '2d' && PLAN_TINT[role]) return PLAN_TINT[role];
  const h = feature.properties.height || 10;
  const t = Math.min(1, Math.log1p(h) / Math.log1p(300));
  const base = feature.properties.height_source === 'imputed' ? C.imputedTint : C.buildingLow;
  const kind = KIND_TINT[feature.properties.building] || [0, 0, 0];
  return [
    Math.round(base[0] + (C.buildingHigh[0] - base[0]) * t + kind[0]),
    Math.round(base[1] + (C.buildingHigh[1] - base[1]) * t + kind[1]),
    Math.round(base[2] + (C.buildingHigh[2] - base[2]) * t + kind[2]),
  ];
}

/* ------------------------------------------------------------------ ground */

/* The DEM grid, kept so anything drawn on the ground can be put on *this* ground.
 *
 * The raycaster works in altitude above sea level: a building's base is its DEM ground
 * elevation and a ray to it ends at that altitude plus a fraction of its height. The
 * scene has to be drawn in the same frame or a ray will visibly miss the wall it hit by
 * the 20-60 m of relief under the city. */
let terrainGrid = null;

/** Ground altitude at a lon/lat, bilinear on the DEM -- jiransync.terrain.Terrain._sample. */
function groundAt(lon, lat) {
  const g = terrainGrid;
  if (!g) return 0;
  const M = 6371000.0 * Math.PI / 180.0;
  const x = (lon - g.origin_lon) * M * Math.cos(g.origin_lat * Math.PI / 180);
  const y = (lat - g.origin_lat) * M;
  const fx = Math.min(Math.max((x - g.min_x) / g.cell_m, 0), g.nx - 1.0000001);
  const fy = Math.min(Math.max((y - g.min_y) / g.cell_m, 0), g.ny - 1.0000001);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, g.nx - 1), y1 = Math.min(y0 + 1, g.ny - 1);
  const tx = fx - x0, ty = fy - y0, e = g.elevations, n = g.nx;
  return (1 - tx) * (1 - ty) * e[y0 * n + x0] + tx * (1 - ty) * e[y0 * n + x1]
       + (1 - tx) * ty * e[y1 * n + x0] + tx * ty * e[y1 * n + x1];
}

/** A lon/lat path lifted onto the ground, plus a small clearance against z-fighting. */
function onGround(path, lift = 1.5) {
  return path.map((c) => [c[0], c[1], groundAt(c[0], c[1]) + lift]);
}


/* Street hierarchy. Widths are metres on the ground, so they scale with the city. */
/* `colour` is the asphalt, `kerb` the lighter verge drawn under it, `glow` the alpha of
 * the warm street-light spill (arterials only). `lift` styles the flat 2D pane. */
const ROAD_CLASS = {
  motorway:      {width: 18, colour: [24, 26, 29], kerb: [52, 53, 56], glow: 34, lamp: 24, pool: 13, lift: 34},
  motorway_link: {width: 9,  colour: [26, 28, 31], kerb: [50, 51, 54], glow: 24, lamp: 28, pool: 10, lift: 24},
  primary:       {width: 14, colour: [26, 28, 31], kerb: [52, 53, 56], glow: 30, lamp: 28, pool: 11, lift: 30},
  primary_link:  {width: 8,  colour: [28, 30, 33], kerb: [48, 49, 52], glow: 20, lamp: 32, pool: 9, lift: 20},
  secondary:     {width: 11, colour: [28, 30, 33], kerb: [50, 51, 54], glow: 24, lamp: 32, pool: 9, lift: 22},
  secondary_link: {width: 7, colour: [30, 32, 35], kerb: [46, 47, 50], glow: 16, lamp: 36, pool: 8, lift: 16},
  tertiary:      {width: 8,  colour: [31, 33, 36], kerb: [46, 47, 50], glow: 16, lamp: 38, pool: 7, lift: 14},
  residential:   {width: 6,  colour: [42, 44, 48], kerb: [56, 56, 60], lift: 6},
  unclassified:  {width: 6,  colour: [42, 44, 48], kerb: [56, 56, 60], lift: 6},
  service:       {width: 3.5, colour: [40, 42, 46], kerb: [50, 50, 54], lift: 0},
  _:             {width: 4,  colour: [40, 42, 46], kerb: [52, 52, 56], lift: 0},
};

/** The ground shadow of one building: the convex hull of its footprint and the same
 *  footprint pushed along the sun's ground direction by height x (horizontal / vertical)
 *  of the light. Same footprint, same height, same sun as the lighting -- computed once. */
function buildingShadow(f) {
  const h = f.properties.height || 0;
  if (h < 4) return null;
  const M = 6371000.0 * Math.PI / 180.0;
  const ring = f.geometry.coordinates[0];
  const lat0 = ring[0][1] * Math.PI / 180;
  const [dx, dy, dz] = SUN_DIRECTION;
  const reach = h * Math.hypot(dx, dy) / Math.abs(dz);
  const norm = Math.hypot(dx, dy);
  const offLon = (dx / norm) * reach / (M * Math.cos(lat0));
  const offLat = (dy / norm) * reach / M;
  const points = [];
  for (const [lon, lat] of ring) {
    points.push([lon, lat], [lon + offLon, lat + offLat]);
  }
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  // Taller buildings throw a slightly firmer shadow; none is ever black.
  const alpha = Math.round(40 + 40 * Math.min(1, h / 150));
  return {polygon: hull.map(([lon, lat]) => [lon, lat, groundAt(lon, lat) + 1.6]), alpha};
}

/** Andrew's monotone chain. Fine in lon/lat at this scale: only ordering matters. */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Lamp positions at even spacing along each arterial's own geometry (draped paths). */
function streetLightsAlong(features) {
  const out = [];
  for (const f of features) {
    const cls = ROAD_CLASS[f.properties.highway];
    const path = f._path;
    let carry = cls.lamp * 0.5;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = distanceM(a, b);
      while (carry <= len) {
        const t = len > 0 ? carry / len : 0;
        out.push({position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                             a[2] + (b[2] - a[2]) * t + 0.4],
                  pool: cls.lamp * 0.5, strength: cls.pool >= 11 ? 15 : 11});
        carry += cls.lamp;
      }
      carry -= len;
    }
  }
  return out;
}

/* Projection origin of the twin's metre frame, set from /api/world. */
let frameOrigin = null;

/** Metres between two lon/lat points in the server's own frame (jiransync.geo.LocalFrame). */
function distanceM(a, b) {
  const M = 6371000.0 * Math.PI / 180.0;
  const lat0 = (frameOrigin?.origin_lat ?? a[1]) * Math.PI / 180;
  const dx = (b[0] - a[0]) * M * Math.cos(lat0);
  const dy = (b[1] - a[1]) * M;
  return Math.hypot(dx, dy);
}

/* ------------------------------------------------------------------- layers */

/** Build one pane's worth of layers.
 *
 * Layer ids are prefixed with the view they belong to, and `layerFilter` on the deck
 * instance routes them: '2d-buildings' only ever draws in the 2D viewport. That is what
 * lets both panes read from one simulation without either knowing the other exists.
 */
/* Terrain mesh, built once from the baked Copernicus grid.
 *
 * Drawn as flat grid cells shaded by elevation rather than an extruded surface: the
 * buildings already sit at their true ground height, so extruding the ground too would
 * double the relief visually. This is here to make the DEM *legible* -- a judge asking
 * "is the elevation data real?" should be able to see the valley. */
let terrainCells = null;

function buildTerrainCells(grid) {
  const {nx, ny, cell_m, min_x, min_y, elevations, min_elev, max_elev} = grid;
  const span = Math.max(1e-6, max_elev - min_elev);
  const cells = [];
  // Every other cell in each direction: at 30 m the full grid is more polygons than the
  // relief justifies, and 60 m still reads as a smooth surface.
  for (let j = 0; j < ny - 2; j += 2) {
    for (let i = 0; i < nx - 2; i += 2) {
      const z = elevations[j * nx + i];
      const x0 = min_x + i * cell_m, y0 = min_y + j * cell_m;
      const x1 = x0 + 2 * cell_m, y1 = y0 + 2 * cell_m;
      // Each corner at its own DEM altitude, so the cells join into one continuous
      // surface instead of a staircase of flat tiles -- roads and building bases are
      // placed on the same surface and must not disappear under a step.
      const corners = [
        elevations[j * nx + i], elevations[j * nx + i + 2],
        elevations[(j + 2) * nx + i + 2], elevations[(j + 2) * nx + i],
      ];
      // Fade the sheet out toward its own boundary. The DEM is a rectangle and the
      // world is not: drawn at uniform alpha it reads as a slab of floating paper with
      // the city standing on it. Dissolving the last ~15% into the background makes it
      // read as ground receding into the dark, which is what it is.
      const u = (i / (nx - 1)) * 2 - 1;       // -1..1 across the grid
      const v = (j / (ny - 1)) * 2 - 1;
      const edge = Math.max(Math.abs(u), Math.abs(v));
      const fade = Math.min(1, Math.max(0, (0.97 - edge) / 0.28));
      cells.push({
        polygon: [[x0, y0, corners[0]], [x1, y0, corners[1]],
                  [x1, y1, corners[2]], [x0, y1, corners[3]]],
        t: (z - min_elev) / span,
        grain: Math.round((Math.sin(i * 12.9898 + j * 78.233) * 43758.5453 % 1) * 5),
        alpha: fade,
        elev: z,
      });
    }
  }
  return cells;
}

/* Local metres -> lon/lat, mirroring jiransync.geo.LocalFrame so the mesh lands exactly
 * under the buildings. Uses the same spherical constant the server does. */
function metresToLonLat(x, y, originLon, originLat) {
  const M = 6371000.0 * Math.PI / 180.0;
  return [x / (M * Math.cos(originLat * Math.PI / 180)) + originLon, y / M + originLat];
}

function paneLayers(mode) {
  if (!world) return [];
  const p = (id) => `${mode}-${id}`;
  const flat = mode === '2d';
  const layers = [];

  // Ground first, so everything else draws over it.
  //
  // Depth testing stays ON here, unlike the road and route layers: the terrain is a real
  // surface at real altitude and buildings must occlude it. Painting it depth-free put a
  // lit sheet of paper over the whole city.
  if (!flat && terrainCells?.length && mapLayers.terrain) {
    layers.push(new PolygonLayer({
      id: p('terrain'),
      data: terrainCells,
      getPolygon: (c) => c.lonlat,
      extruded: false,
      filled: true,
      stroked: false,
      // Low ground cool and dark, high ground barely lighter. Deliberately a narrow
      // ramp: this is ground, and it must never compete with the outage red or the
      // building massing in front of it.
      // Urban ground at blue hour: dark slate with a faint warm cast, a little texture
      // per 60 m cell so open ground reads as surface rather than void, and the DEM's
      // relief still carried by brightness.
      getFillColor: (c) => [
        18 + 10 * c.t + c.grain,
        30 + 14 * c.t + c.grain,
        30 + 10 * c.t + c.grain,
        Math.round(255 * c.alpha),
      ],
      // Unlit. With the scene's DirectionalLight applied, one flank of the grid caught
      // a warm highlight and the ground looked like it was under a sunset -- a
      // hypsometric ramp has to mean elevation, not incident angle.
      material: false,
      pickable: false,
    }));
  }

  // Land cover -- parks, fields, water -- lies on the ground under roads and buildings.
  for (const make of hooks.ground) {
    try {
      layers.push(...(make(p, flat) || []));
    } catch (err) {
      console.error('ground layer failed', err);
    }
  }

  // Roads by class: arterials wide and lit, service lanes thin and dim, so the street
  // hierarchy -- and the routes neighbours actually take -- is legible from the air. In
  // 3D they lie on the DEM and are depth-tested, so buildings stand in front of them rather
  // than having the street grid painted across their facades.
  if (!flat) {
    // Kerb / verge: a lighter edge a few metres wider than the carriageway. Streets
    // only: the ~2,250 service lanes are too narrow to show one, and skipping them
    // drops two thirds of this layer's geometry.
    layers.push(new PathLayer({
      id: p('road-kerb'),
      data: world.streets,
      getPath: (f) => f._path,
      getColor: (f) => (ROAD_CLASS[f.properties.highway] || ROAD_CLASS._).kerb,
      getWidth: (f) => (ROAD_CLASS[f.properties.highway] || ROAD_CLASS._).width + 2.4,
      widthUnits: 'meters',
      widthMinPixels: 0.8,
      capRounded: true,
      jointRounded: true,
    }));
  }
  // Carriageway surface. Same data and widths as before; asphalt rather than lines.
  layers.push(new PathLayer({
    id: p('roads'),
    data: world.roads.features,
    getPath: (f) => (flat ? f.geometry.coordinates : f._path2),
    getColor: (f) => {
      const cls = ROAD_CLASS[f.properties.highway] || ROAD_CLASS._;
      return flat ? [58 + cls.lift, 72 + cls.lift, 98 + cls.lift] : cls.colour;
    },
    getWidth: (f) => (ROAD_CLASS[f.properties.highway] || ROAD_CLASS._).width,
    widthUnits: 'meters',
    widthMinPixels: 0.6,
    capRounded: true,
    jointRounded: true,
    parameters: flat ? {depthTest: false} : {},
  }));
  if (!flat && SHADOWS && world.shadows?.length && mapLayers.buildings) {
    // Ground shadows: a soft blue-black, translucent, depth-tested so a building's own
    // mass hides the part of its shadow that lies under it.
    layers.push(new SolidPolygonLayer({
      id: p('building-shadows'),
      data: world.shadows,
      getPolygon: (q) => q.polygon,
      getFillColor: (q) => [6, 9, 16, q.alpha],
      extruded: false,
      material: false,
      parameters: {depthMask: false},
    }));
  }
  if (!flat && world.streetLights?.length) {
    // Street lighting as pools, not a neon tube: a soft warm disc on the asphalt at each
    // lamp position along the arterials, spaced like real columns (24-38 m by class).
    layers.push(new ScatterplotLayer({
      id: p('street-light-pools'),
      data: world.streetLights,
      radiusUnits: 'meters',
      getPosition: (q) => q.position,
      getRadius: (q) => q.pool,
      getFillColor: (q) => [255, 176, 98, q.strength],
      radiusMaxPixels: 40,
      stroked: false,
      parameters: {depthMask: false},
    }));
    layers.push(new ScatterplotLayer({
      id: p('street-lamps'),
      data: world.streetLights,
      radiusUnits: 'meters',
      getPosition: (q) => q.position,
      getRadius: 0.9,
      radiusMaxPixels: 2.5,
      getFillColor: [255, 214, 168, 120],
    }));
  }
  if (!flat) {
    // Lane marking: a dashed centre line on the multi-lane roads.
    layers.push(new PathLayer({
      id: p('road-marking'),
      data: world.majorRoads,
      getPath: (f) => f._path3,
      getColor: [200, 192, 168, 80],
      getWidth: 0.35,
      widthUnits: 'meters',
      widthMinPixels: 0.5,
      getDashArray: [6, 7],
      dashJustified: false,
      extensions: [new PathStyleExtension({dash: true})],
    }));
  }

  // One layer for the whole city: 2,000 footprints tessellate once into a single draw
  // call, which is cheaper than any per-building object would be. Each footprint stands
  // on its own DEM ground altitude, the same base the server uses.
  //
  // In 3D the footprints are drawn by SolidPolygonLayer directly, so the facade shader
  // (web/facade.js) can be attached to exactly this geometry and nothing else. Same
  // footprints, same ground altitude, same heights: only the shading of each pixel changes.
  const BuildingLayer = flat || !facadeExtension ? PolygonLayer : SolidPolygonLayer;
  if (mapLayers.buildings) layers.push(new BuildingLayer({
    id: p('buildings'),
    data: world.buildings.features,
    extruded: !flat,
    wireframe: false,
    filled: true,
    getPolygon: (f) => (flat ? f.geometry.coordinates : f._poly),
    // Under a pitched roof the walls stop at the eaves; the roof (architecture.js) carries
    // the building up to its recorded height. In the flat plan every footprint is a slab.
    getElevation: (f) => (flat ? f.properties.height : f._eave ?? f.properties.height) || 10,
    getFillColor: (f) => buildingColor(f, mode),
    material: flat
      ? null
      : {ambient: 0.42, diffuse: 0.6, shininess: 48, specularColor: [70, 84, 112]},
    extensions: !flat && facadeExtension ? [facadeExtension] : [],
    pickable: true,
    autoHighlight: !flat,
    highlightColor: [255, 255, 255, 46],
    // deck.gl caches accessor output; these tell it when colour actually changed.
    updateTriggers: {getFillColor: [mode, selectedBuilding, hooks.tintKey()]},
  }));

  // Roof outlines on the tall blocks that shape the skyline, which is what makes the massing
  // read as buildings rather than as a field of blocks. Only above 60 m: a wireframe on
  // every shophouse would be 2,000 outlines of noise.
  if (!flat && world.skyline?.length && mapLayers.buildings) {
    layers.push(new PolygonLayer({
      id: p('skyline-edges'),
      data: world.skyline,
      extruded: true,
      filled: false,
      wireframe: true,
      getPolygon: (f) => f._poly,
      getElevation: (f) => f.properties.height,
      getLineColor: [170, 180, 200, 18],
      pickable: false,
    }));
  }

  layers.push(...selectionLayers(p, flat));
  for (const make of hooks.layers) {
    try {
      layers.push(...(make(p, flat) || []));
    } catch (err) {
      // An overlay bug must never take the town down with it.
      console.error('overlay layer failed', err);
    }
  }
  return layers;
}

/* ---------------------------------------------------------- selection */

/* The one building the inspection panel is talking about gets a crisp outline drawn
 * through everything -- and nothing else does. */
function selectionLayers(p, flat) {
  const layers = [];
  const f = selectedBuilding && world.buildingById?.[selectedBuilding];
  if (f) {
    if (flat) {
      layers.push(new PathLayer({
        id: p('selected-outline'),
        data: f.geometry.coordinates,
        getPath: (ring) => ring,
        getColor: [235, 242, 255, 255],
        getWidth: 2.5,
        widthUnits: 'pixels',
        parameters: {depthTest: false},
      }));
    } else {
      layers.push(new PolygonLayer({
        id: p('selected-outline'),
        data: [f],
        extruded: true,
        filled: false,
        wireframe: true,
        getPolygon: (b) => b._poly,
        getElevation: (b) => b.properties.height + 0.4,
        getLineColor: [225, 236, 255, 235],
        parameters: {depthTest: false},
      }));
      // A soft footprint halo so the base reads even when the camera looks down on it.
      layers.push(new PolygonLayer({
        id: p('selected-halo'),
        data: [f],
        extruded: false,
        filled: false,
        stroked: true,
        getPolygon: (b) => b._poly,
        getLineColor: [140, 190, 255, 150],
        getLineWidth: 6,
        lineWidthUnits: 'pixels',
        parameters: {depthTest: false},
      }));
    }
  }
  return layers;
}

function buildLayers() {
  return paneLayers(viewMode);
}

/* Redraw continuously only while something is moving -- a pulsing pin, an animating
 * trip. Otherwise the map repaints at the socket's 4 Hz and the GPU idles. */
let animating = false;
let lastAnimFrame = 0;
function ensureAnimation() {
  if (animating) return;
  animating = true;
  const tick = (now) => {
    const live = hooks.animating();
    if (!live || !deckgl) { animating = false; if (deckgl) deckgl.setProps({layers: buildLayers()}); return; }
    if (now - lastAnimFrame > 33) {          // ~30 fps is plenty for a pulse
      lastAnimFrame = now;
      deckgl.setProps({layers: buildLayers()});
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Ask for a redraw now, e.g. after an overlay's data changed outside a snapshot. */
function redraw() {
  if (deckgl) deckgl.setProps({layers: buildLayers()});
  if (hooks.animating()) ensureAnimation();
}

/** The viewport layout for the current mode. */
function currentViews() {
  // Keyboard navigation is off so typing in the side panels never pans the camera.
  const common = {controller: {dragRotate: true, inertia: 320, keyboard: false}};
  return [new MapView({id: viewMode, x: 0, y: 0, width: '100%', height: '100%', ...common})];
}

function currentViewState() {
  const c = world.centre;
  const base = {longitude: c.lon, latitude: c.lat};
  if (viewMode === '2d') return {'2d': {...base, pitch: 0, bearing: 0, zoom: 15.0}};
  // Aim a little up-screen of the centre (along the view bearing), so the far side of the
  // township clears the side panels while the town still fills the frame.
  const bearing = -24, ahead = 170;
  const M = 6371000.0 * Math.PI / 180.0;
  const rad = bearing * Math.PI / 180;
  return {'3d': {...base, pitch: 55, bearing, zoom: 15.6,
                 latitude: base.latitude + ahead * Math.cos(rad) / M,
                 longitude: base.longitude
                   + ahead * Math.sin(rad) / (M * Math.cos(base.latitude * Math.PI / 180))}};
}

/** Switch mode, rebuild the viewport, and update the chrome around it. */
function setViewMode(mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  for (const b of ['2d', '3d']) $(`btn-view-${b}`)?.classList.toggle('on', b === mode);
  document.body.classList.remove('mode-2d', 'mode-3d');
  document.body.classList.add(`mode-${mode}`);
  deckgl.setProps({views: currentViews(), initialViewState: currentViewState(),
                   layers: buildLayers()});
}

/* Hover is a glance, not a report. Overlays answer first; a building falls back to its
 * name, role and height. */
const ROLE_LABEL = {home: 'Home', shop: 'Shop-lot', civic: 'Community', transit: 'Transit',
                    other: 'Building'};

function tooltip(info) {
  if (!info.object) return null;
  for (const hook of hooks.tooltip) {
    const answer = hook(info);
    if (answer) return {className: 'tt', ...answer};
  }
  if (info.layer.id.endsWith('-buildings')) {
    const f = info.object, p = f.properties;
    const role = ROLE_LABEL[world.roles?.[f.id]] || 'Building';
    return {className: 'tt', html:
      `<div class="tt-name">${esc(p.name || role)}</div>` +
      `<div class="tt-row">${role} · ${(p.height || 0).toFixed(0)} m</div>`};
  }
  return null;
}

/* What the inspection panel is showing: {kind, id, viewId, anchor?}. `kind` is
 * 'building' for the map's own panel; overlays may open their own kinds. */
let inspected = null;

function selectBuilding(id, viewId = null) {
  selectedBuilding = id;
  inspected = id ? {kind: 'building', id, viewId} : null;
  afterSelection();
}

/** Open the inspector on an overlay object. `anchor` is [lon, lat, z]. */
function inspect(kind, id, anchor, viewId = null) {
  selectedBuilding = null;
  inspected = {kind, id, anchor, viewId};
  afterSelection();
}

function closeInspector() {
  selectBuilding(null);
}

function afterSelection() {
  renderInspector(true);
  if (deckgl) deckgl.setProps({layers: buildLayers()});
}

/* ------------------------------------------------------------------ camera */

/** Zoom at which a radius of `extentM` metres fills about half the shorter screen side. */
function zoomFor(extentM, lat) {
  const width = window.innerWidth;
  const px = Math.min(width, window.innerHeight) * 0.5;
  const z = Math.log2(78271.517 * Math.cos(lat * Math.PI / 180) * px / Math.max(extentM, 110));
  return Math.max(14.3, Math.min(17.4, z));
}

/** One smooth move to a target camera, in whichever views are showing. */
function setCamera({longitude, latitude, zoom, pitch = 56, bearing = -18}, duration = 1700) {
  const motion = {
    transitionDuration: duration,
    transitionEasing: easeInOut,
    transitionInterpolator: new deck.LinearInterpolator(),
  };
  // Take the short way round: from bearing 170 to -170 is 20 degrees, not 340.
  const from = currentView['3d']?.bearing;
  if (from != null) bearing = from + ((((bearing - from) % 360) + 540) % 360) - 180;
  const tilted = {longitude, latitude, zoom, pitch, bearing, ...motion};
  const flat = {longitude, latitude, zoom, pitch: 0, bearing: 0, ...motion};
  if (viewMode === '2d') {
    deckgl.setProps({initialViewState: {'2d': flat}});
  } else {
    deckgl.setProps({initialViewState: {'3d': tilted}});
  }
}

/** Frame a set of lon/lat points, looking along `bearing`. */
function fitPoints(points, {bearing = -18, pitch = 56, duration, maxZoom = 17.4} = {}) {
  if (!points.length) return;
  const lons = points.map((q) => q[0]), lats = points.map((q) => q[1]);
  const centre = [(Math.min(...lons) + Math.max(...lons)) / 2,
                  (Math.min(...lats) + Math.max(...lats)) / 2];
  const extent = Math.max(...points.map((q) => distanceM(centre, q)));
  setCamera({longitude: centre[0], latitude: centre[1],
             zoom: Math.min(maxZoom, zoomFor(extent * 1.15, centre[1])), pitch, bearing},
            duration);
}

function flyTo(coords, zoom) {
  setCamera({longitude: coords[0], latitude: coords[1], zoom: zoom ?? 16.2}, 1600);
}

/** Back to the opening shot of the whole township. */
function resetCamera() {
  const v = currentViewState();
  const view = v['3d'] || v['2d'];
  setCamera({longitude: view.longitude, latitude: view.latitude, zoom: view.zoom,
             pitch: view.pitch ?? 56, bearing: view.bearing ?? -18}, 1400);
}

/* ---------------------------------------------------------------- inspector */

/* The map's own panel: what a building is. Overlays add what is happening there. */
function buildingPanel(id) {
  const f = world.buildingById[id];
  if (!f) return null;
  const p = f.properties;
  const role = ROLE_LABEL[world.roles?.[id]] || 'Building';
  // Overlays may add to a building's panel -- JiranSync offers a ride there.
  const extra = hooks.buildingExtras?.(id) || {};
  return {
    kicker: role,
    name: esc(p.name || `${role} ${id.replace(/^b/, '#')}`),
    sub: `${(p.height || 0).toFixed(0)} m · ${fmt(Math.round(p.area_m2 || 0))} m² footprint`
      + (p.height_source === 'imputed' ? ' · height estimated' : '')
      + (f._type ? ` · visual type: ${TYPE_LABEL[f._type] || f._type}` : ''),
    body: extra.body || '',
    actions: extra.actions,
    tone: 'calm',
  };
}

let inspectorHtml = '';
let inspectorSize = {w: 300, h: 260};

/** Rebuild the panel's content, only when it actually changed -- the snapshot arrives four
 *  times a second and a button replaced mid-click would swallow the click. */
function renderInspector(force = false) {
  const el = $('inspector');
  if (!inspected || !world) {
    el.hidden = true;
    $('insp-leader').style.display = 'none';
    inspectorHtml = '';
    return;
  }
  const panel = hooks.inspector?.(inspected)
    || (inspected.kind === 'building' ? buildingPanel(inspected.id) : null);
  if (!panel) { closeInspector(); return; }
  // Overlays may supply a whole card (`html`); otherwise the standard head + body.
  const html = panel.html
    ? `<button class="insp-x" data-act="close" title="Close (Esc)">&times;</button>${panel.html}`
    : `
    <div class="insp-head">
      <span class="insp-kicker">${panel.kicker}</span>
      <button class="insp-x" data-act="close" title="Close (Esc)">&times;</button>
    </div>
    <div class="insp-name">${panel.name}</div>
    <div class="insp-sub">${panel.sub}</div>
    ${panel.body}`;
  if (!force && html === inspectorHtml && !el.hidden) return;
  inspectorHtml = html;
  el.className = `insp tone-${panel.tone}${panel.html ? ' card' : ''}`;
  el.innerHTML = html;
  el.hidden = false;
  el.querySelector('[data-act="close"]').onclick = closeInspector;
  for (const button of el.querySelectorAll('[data-act]')) {
    if (button.dataset.act !== 'close' && panel.actions?.[button.dataset.act]) {
      button.onclick = panel.actions[button.dataset.act];
    }
  }
  inspectorSize = {w: el.offsetWidth, h: el.offsetHeight};
  positionInspector();
}

/** Where the inspected object is, in 3D: the roof of a building, or an overlay's anchor. */
function inspectedAnchor() {
  if (inspected.anchor) return inspected.anchor;
  const f = world.buildingById[inspected.id];
  const c = world.centroids?.[inspected.id];
  return f && c ? [c[0], c[1], (f.properties.ground_elev || 0) + f.properties.height] : null;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* Put the panel beside its object without leaving the screen or sitting on the HUD: try
 * above-right, above-left, below-right, below-left of the anchor; take the first that fits
 * inside the viewport and clears the side panels and the story card; failing that, the
 * first that fits; failing that, clamp. Runs after every deck.gl frame, so the panel and
 * its leader follow the object while the camera moves. */
function positionInspector() {
  const el = $('inspector');
  const svg = $('insp-leader');
  if (!inspected || el.hidden || !deckgl) return;
  const anchor = inspectedAnchor();
  const id = viewMode;
  const viewport = deckgl.getViewports().find((v) => v.id === id);
  if (!anchor || !viewport) return;

  const [px, py] = viewport.project(id === '2d' ? anchor.slice(0, 2) : anchor);
  const vx = viewport.x || 0, vy = viewport.y || 0;
  const ax = px + vx, ay = py + vy;
  const {w, h} = inspectorSize;
  const W = window.innerWidth, H = window.innerHeight;
  const bounds = {x: 10, y: 64, w: W - 20, h: H - 64 - 38};
  const visible = Number.isFinite(ax) && Number.isFinite(ay)
    && ax >= vx && ax <= vx + viewport.width && ay >= 0 && ay <= H;

  // Everything the user reads or clicks: the panels, the bars and the map controls.
  const obstacles = [...document.querySelectorAll(
    '.panel:not(.closed), .topbar, .rail, .cats, .legend, .map-tools, .toast:not([hidden])')]
    .filter((n) => n && !n.hidden && n.offsetParent !== null)
    .map((n) => {
      const r = n.getBoundingClientRect();
      return {x: r.left, y: r.top, w: r.width, h: r.height};
    });

  const gap = 34;
  const candidates = [
    {x: ax + gap, y: ay - h - gap},
    {x: ax - gap - w, y: ay - h - gap},
    {x: ax + gap, y: ay + gap},
    {x: ax - gap - w, y: ay + gap},
  ].map((c) => ({...c, w, h}));
  const inside = (c) => c.x >= bounds.x && c.y >= bounds.y
    && c.x + c.w <= bounds.x + bounds.w && c.y + c.h <= bounds.y + bounds.h;
  // Area of the HUD a candidate would cover; the first free spot wins, otherwise the one
  // that covers least of it.
  const covered = (c) => obstacles.reduce((sum, o) => sum + (rectsOverlap(c, o)
    ? (Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x))
      * (Math.min(c.y + c.h, o.y + o.h) - Math.max(c.y, o.y)) : 0), 0);
  const fitting = visible ? candidates.filter(inside) : [];
  const docked = hooks.dock();
  let spot = docked ? {...docked, w, h} : (fitting.find((c) => covered(c) === 0)
    || fitting.sort((a, b) => covered(a) - covered(b))[0] || null);
  if (!spot) {
    // Off screen, or nowhere fits: dock as near the anchor as the screen allows.
    const base = visible ? candidates[0] : {x: bounds.x + bounds.w - w, y: bounds.y + 160, w, h};
    spot = {...base,
            x: Math.min(Math.max(base.x, bounds.x), bounds.x + bounds.w - w),
            y: Math.min(Math.max(base.y, bounds.y), bounds.y + bounds.h - h)};
  }
  el.style.transform = `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px)`;

  if (!visible) { svg.style.display = 'none'; return; }
  // Leader from the anchor to the nearest point on the panel's edge.
  const ex = Math.min(Math.max(ax, spot.x), spot.x + w);
  const ey = Math.min(Math.max(ay, spot.y), spot.y + h);
  svg.style.display = '';
  const line = svg.querySelector('line');
  line.setAttribute('x1', ax); line.setAttribute('y1', ay);
  line.setAttribute('x2', ex); line.setAttribute('y2', ey);
  for (const c of svg.querySelectorAll('circle')) {
    c.setAttribute('cx', ax); c.setAttribute('cy', ay);
  }
}

/* ---------------------------------------------------------------- snapshots */

/* A clock that runs backwards means the server restarted: forget the trails. */
let lastT = -1;

function render() {
  if (!state) return;
  if (state.t < lastT - 0.5) trails.clear();
  lastT = state.t;
  for (const hook of hooks.snapshot) {
    try { hook(state); } catch (err) { console.error('snapshot hook failed', err); }
  }
  renderInspector();
  deckgl.setProps({layers: buildLayers()});
  if (hooks.animating()) ensureAnimation();
}

/* ------------------------------------------------------------------ startup */

/** Resolve once the document has finished loading and the browser has laid it out.
 *
 * deck.gl reads the container's size when it creates its canvas. Constructing it while
 * the page is still loading -- which is what happens if boot() reaches it before layout
 * settles -- yields a canvas that reports the right dimensions but never paints: the
 * scene is silently blank while the HUD, being plain DOM, looks perfectly healthy.
 * Waiting for load plus one frame costs nothing and removes the race.
 */
function pageReady() {
  return new Promise((resolve) => {
    const settle = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (document.readyState === 'complete') settle();
    else window.addEventListener('load', settle, {once: true});
  });
}

async function boot() {
  await pageReady();
  world = await (await fetch('/api/world')).json();
  world.roads = await (await fetch('/api/roads')).json();

  frameOrigin = world.frame || null;
  const roles = Object.values(world.roles || {});
  const homes = roles.filter((r) => r === 'home').length;
  const shops = roles.filter((r) => r === 'shop').length;
  if ($('aoi')) {
    $('aoi').textContent = `${world.name || 'Township'} · ${fmt(world.buildings.features.length)} buildings` +
      ` · ${fmt(homes)} homes · ${fmt(shops)} shop-lots`;
  }
  world.buildingById = Object.fromEntries(world.buildings.features.map((f) => [f.id, f]));

  // Terrain is optional: a repo without a baked DEM should still boot, just flat.
  try {
    const grid = await (await fetch('/api/terrain')).json();
    if (grid && grid.elevations) {
      terrainGrid = grid;
      // Each corner carries its own altitude, so the ground is one continuous surface at
      // the same elevation the buildings are extruded from rather than at zero.
      terrainCells = buildTerrainCells(grid).map((c) => ({
        ...c,
        lonlat: c.polygon.map(([x, y, z]) => {
          const [lon, lat] = metresToLonLat(x, y, grid.origin_lon, grid.origin_lat);
          return [lon, lat, z];
        }),
      }));
      console.info(`terrain: ${terrainCells.length} cells from ${grid.source}`);
    }
  } catch (err) {
    console.info('no terrain grid available, drawing flat ground');
  }

  // Put the city on its ground, once. Every footprint is extruded from its own DEM
  // elevation -- the base the raycaster uses -- and roads and transport links are draped
  // over the same surface, so nothing floats above or sinks below what the rays see.
  for (const f of world.buildings.features) {
    const base = f.properties.ground_elev || 0;
    f._poly = f.geometry.coordinates.map((ring) => ring.map((c) => [c[0], c[1], base]));
  }
  world.skyline = world.buildings.features.filter((f) => (f.properties.height || 0) >= 25);
  // Facade materials: derived once from each building's OSM class and height.
  for (const f of world.buildings.features) f._mat = facadeMaterial(f, world.roles?.[f.id]);
  if (RENDER_QUALITY === 'high' && frameOrigin && typeof makeFacadeExtension === 'function') {
    facadeExtension = makeFacadeExtension(frameOrigin.origin_lon, frameOrigin.origin_lat);
  }
  document.body.dataset.quality = RENDER_QUALITY;
  console.info(`render quality: ${RENDER_QUALITY}${facadeExtension ? ' (facade shader on)' : ''}`);
  // Roads in three stacked passes (kerb, surface, marking), each a few centimetres above
  // the last so they never fight for the same depth.
  for (const f of world.roads.features) {
    f._path = onGround(f.geometry.coordinates, 1.0);
    f._path2 = f._path.map(([x, y, z]) => [x, y, z + 0.25]);
    f._path3 = f._path.map(([x, y, z]) => [x, y, z + 0.5]);
  }
  const lite = RENDER_QUALITY === 'lite';
  world.majorRoads = lite ? [] : world.roads.features.filter(
    (f) => ROAD_CLASS[f.properties.highway]?.glow);
  world.streets = lite ? [] : world.roads.features.filter((f) => f.properties.highway !== 'service');
  world.streetLights = streetLightsAlong(world.roads.features.filter(
    (f) => ROAD_CLASS[f.properties.highway]?.lamp));
  world.shadows = SHADOWS
    ? world.buildings.features.map(buildingShadow).filter(Boolean) : [];

  for (const hook of hooks.ready) hook(world);
  document.body.classList.add(`mode-${viewMode}`);

  deckgl = new DeckGL({
    container: 'map',
    views: currentViews(),
    initialViewState: currentViewState(),
    // Route each layer to the pane it was built for.
    layerFilter: ({layer, viewport}) => layer.id.startsWith(viewport.id + '-'),
    layers: buildLayers(),
    getTooltip: tooltip,
    // Remember where the camera is, so the next move starts from it and turns the short
    // way round. Returning nothing leaves deck.gl in charge of the view.
    onViewStateChange: ({viewId, viewState}) => { currentView[viewId] = viewState; },
    // Keep the panel and its leader pinned to the object through every camera move.
    onAfterRender: () => positionInspector(),
    // Transparent, so the blue-hour sky gradient behind the canvas (style.css, #map)
    // shows above the horizon and through the faded edge of the terrain.
    parameters: {clearColor: [0, 0, 0, 0]},
    effects: [cityLighting()],
  });

  bindMapClicks();
  connect();
}

/* Click opens the inspection panel; clicking the same object again, or empty ground,
 * closes it. Overlays get first refusal on every click.
 *
 * Detected here rather than with deck.gl's onClick. Its tap recogniser times a press by
 * when each event is *processed*, so while the map is animating on a slow GPU the down
 * and the up land a frame apart and every click is rejected as a long press. The
 * browser's own event timestamps do not have that problem; deck.gl is then only asked
 * what is under the pointer. */
function bindMapClicks() {
  const el = $('map');
  let press = null;
  el.addEventListener('pointerdown', (e) => {
    press = e.button === 0 ? {x: e.clientX, y: e.clientY, t: e.timeStamp} : null;
  });
  el.addEventListener('pointerup', (e) => {
    const down = press;
    press = null;
    if (!down || e.button !== 0 || !deckgl) return;
    // A drag (orbit, pan) or a long press is not a click.
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.timeStamp - down.t > 700) return;
    const rect = el.getBoundingClientRect();
    const info = deckgl.pickObject({x: e.clientX - rect.left, y: e.clientY - rect.top, radius: 2});
    handleMapClick(info);
  });
}

function handleMapClick(info) {
  if (!info?.object || !info.layer) { if (inspected) closeInspector(); return; }
  for (const hook of hooks.click) if (hook(info)) return;
  const viewId = info.viewport?.id || null;
  if (info.layer.id.endsWith('-buildings')) {
    selectBuilding(selectedBuilding === info.object.id ? null : info.object.id, viewId);
  }
}

/* Blue hour. A cool sky ambient, a low warm sun from the west raking the facades, and a
 * weak cool fill from the opposite side so walls in shade are dark but not black. */
function cityLighting() {
  const effect = new deck.LightingEffect({
    // Lifted a touch for projectors, which crush the darkest tones.
    ambient: new deck.AmbientLight({color: [170, 180, 204], intensity: 1.3}),
    sun: new deck.DirectionalLight({
      color: [255, 204, 166], intensity: 1.85, direction: SUN_DIRECTION,
    }),
    fill: new deck.DirectionalLight({
      color: [130, 150, 200], intensity: 0.45, direction: [-0.6, -0.9, -0.55],
    }),
  });
  return effect;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.onopen = () => {
    $('conn').textContent = 'live';
    $('conn').className = 'conn live';
    // The server ignores inbound content; this just keeps the socket from idling out.
    setInterval(() => socket.readyState === 1 && socket.send('.'), 15000);
  };
  socket.onmessage = (ev) => {
    state = JSON.parse(ev.data);
    render();
  };
  socket.onclose = () => {
    $('conn').textContent = 'reconnecting';
    $('conn').className = 'conn lost';
    setTimeout(connect, 1500);   // survive a server restart
  };
}

/* ----------------------------------------------------------------- controls */

$('btn-view-reset')?.addEventListener('click', resetCamera);
$('btn-view-2d')?.addEventListener('click', () => setViewMode('2d'));
$('btn-view-3d')?.addEventListener('click', () => setViewMode('3d'));
window.addEventListener('resize', () => positionInspector());

window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (typing || e.metaKey || e.ctrlKey) return;
  if (e.key === 'Escape' && inspected) closeInspector();
  else if (e.key === 'v') resetCamera();
});

boot();
