/* Transit stations as 3D infrastructure, at their real coordinates.
 *
 * The hubs (data/places.json) are real stations outside the township's mapped area. Each
 * is drawn where it is, with its real surroundings from OpenStreetMap
 * (data/stations.geojson, scripts/fetch_station_context.py): the rail lines -- on viaduct
 * or at grade -- and the roads and buildings nearby. That context is display only; it
 * never joins the township's road graph, so routing is unchanged.
 *
 * The station itself is a simplified visualisation, not a survey of the real building:
 * an elevated Klang Valley MRT station (piers, concourse, platforms, a curved metal roof,
 * an entrance with stairs, a sign) laid along the real track where OSM has it, plus an
 * at-grade platform for a KTM line when the name and the data say there is one. Built
 * from a few shared meshes (architecture.js), so it costs a handful of draw calls.
 *
 * Trips still drive on the township's real roads to the gateway where those roads leave
 * the map; the last leg to the station entrance is drawn as an arc, because the roads in
 * between are not in the data.
 */

const STATIONS = {byHub: {}, boxes: [], roofs: [], ground: [], roads: [], rails: [], buildings: [],
                  piers: [], labels: [], picks: []};
const ST_M = 6371000.0 * Math.PI / 180.0;

/* A curved station roof: a shallow barrel vault, 1 x 1 in plan, 1 high, on z = 0. */
const MESH_VAULT = (() => {
  const n = 8, prof = [];
  for (let i = 0; i <= n; i++) prof.push([-0.5 + i / n, Math.sin(Math.PI * i / n)]);
  const tris = [];
  for (let i = 0; i < n; i++) {
    const [y0, z0] = prof[i], [y1, z1] = prof[i + 1];
    tris.push([[-0.5, y0, z0], [0.5, y0, z0], [0.5, y1, z1]], [[-0.5, y0, z0], [0.5, y1, z1], [-0.5, y1, z1]]);
  }
  for (const x of [-0.5, 0.5]) {
    for (let i = 0; i < n; i++) {
      const tri = [[x, 0, 0], [x, prof[i][0], prof[i][1]], [x, prof[i + 1][0], prof[i + 1][1]]];
      tris.push(x < 0 ? tri : [tri[0], tri[2], tri[1]]);
    }
  }
  return meshFrom(tris);
})();

/* Elevated MRT station, in metres relative to the ground under it. */
const MRT = {length: 140, deck: 12, concourse: [5.5, 10.0], roofZ: 18.5, roofRise: 3.6, width: 24};
const ST_COLOR = {
  concrete: [168, 168, 162], concreteDark: [128, 130, 128], glass: [96, 132, 154], roof: [198, 204, 210],
  platform: [186, 186, 180], train: [226, 230, 234], trainBand: [36, 44, 56], sign: [14, 150, 200],
  plaza: [104, 106, 108, 250], dropoff: [48, 50, 56, 250], parking: [70, 72, 78, 245], site: [30, 42, 38, 255],
};

/** Connections the station's own name states -- nothing more is claimed. */
function stationLines(hub) {
  const lines = [];
  if (/\bMRT\b/i.test(hub.name)) lines.push('MRT');
  if (/\bKTM\b/i.test(hub.name)) lines.push('KTM');
  if (/\bLRT\b/i.test(hub.name)) lines.push('LRT');
  return lines.length ? lines : ['Rail'];
}

function stLocal(st, u, v) {
  const c = Math.cos(st.angle), s = Math.sin(st.angle);
  return [st.centre[0] + (u * c - v * s) / st.k, st.centre[1] + (u * s + v * c) / ST_M];
}

function stNearestOnLines(lines, lon, lat, k) {
  let best = null;
  for (const line of lines) {
    const pts = line.geometry.coordinates;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = (pts[i][0] - lon) * k, ay = (pts[i][1] - lat) * ST_M;
      const bx = (pts[i + 1][0] - lon) * k, by = (pts[i + 1][1] - lat) * ST_M;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
      const px = ax + dx * t, py = ay + dy * t;
      const d = Math.hypot(px, py);
      if (!best || d < best.d) best = {d, angle: Math.atan2(dy, dx), at: [lon + px / k, lat + py / ST_M], line};
    }
  }
  return best;
}

/* ---------------------------------------------------------------------- build */

hooks.ready.push((world) => {
  const ctx = world.stations?.features || [];
  for (const hub of world.hubs || []) {
    const k = ST_M * Math.cos(hub.lat * Math.PI / 180);
    const mine = ctx.filter((f) => f.properties.hub === hub.id);
    const rails = mine.filter((f) => f.properties.kind === 'rail' && f.geometry.type === 'LineString');
    // The station lies along the real elevated main line nearest its coordinate -- not a
    // depot yard track. With no such track within 150 m it is centred on the coordinate,
    // east-west, and the card says it is not aligned to data.
    const mainline = rails.filter((f) => f.properties.elevated && !['yard', 'siding'].includes(f.properties.service));
    const onTrack = mainline.length ? stNearestOnLines(mainline, hub.lon, hub.lat, k) : null;
    const aligned = onTrack && onTrack.d < 150;
    const st = {
      hub, k, base: groundAt(hub.lon, hub.lat),
      centre: aligned ? onTrack.at : [hub.lon, hub.lat],
      angle: aligned ? onTrack.angle : 0,
      aligned, elevated: /\bMRT\b/i.test(hub.name) || mainline.length > 0,
      offset: onTrack ? Math.round(onTrack.d) : null,
      lines: stationLines(hub),
      osmLines: [...new Set(rails.map((f) => f.properties.name).filter(Boolean))].slice(0, 4),
    };
    // Which side of the track faces the street: the side with more road near it.
    const roads = mine.filter((f) => f.properties.kind === 'road');
    let side = 1;
    if (roads.length) {
      const near = (v) => {
        const [lon, lat] = stLocal(st, 0, v);
        return stNearestOnLines(roads, lon, lat, k)?.d ?? 1e9;
      };
      side = near(60) <= near(-60) ? 1 : -1;
    }
    st.side = side;
    st.entrance = [...stLocal(st, 0, side * 31), st.base];
    // The real at-grade KTM line nearest the station, for its platform.
    const ktmLines = rails.filter((f) => f.properties.railway === 'rail' && !f.properties.elevated);
    st.ktm = ktmLines.length ? stNearestOnLines(ktmLines, st.centre[0], st.centre[1], k) : null;
    STATIONS.byHub[hub.id] = st;
    buildStation(st);

    // -- the real surroundings ----------------------------------------------------------
    // Ground under the area, first in the list: these layers paint in order, so the
    // forecourt and car park drawn by buildStation go on top of it.
    STATIONS.ground.unshift({ring: [stLocal(st, -650, -650), stLocal(st, 650, -650), stLocal(st, 650, 650),
                                    stLocal(st, -650, 650)], z: st.base - 0.4, color: ST_COLOR.site});
    for (const f of roads) STATIONS.roads.push({path: f.geometry.coordinates, z: st.base + 0.3,
                                                 highway: f.properties.highway});
    // Viaduct only where OSM tags the track as a bridge; yards and KTM lines lie at grade.
    const myRails = rails.map((f) => ({path: f.geometry.coordinates, z: st.base, metro: f.properties.railway !== 'rail',
                                       elevated: !!f.properties.elevated}));
    STATIONS.rails.push(...myRails);
    for (const f of mine.filter((q) => q.properties.kind === 'building')) {
      const ring = f.geometry.coordinates[0];
      // Leave room for the station model itself: skip the station's own OSM footprint.
      if (f.properties.station || ['train_station', 'transportation'].includes(f.properties.building)) continue;
      const cx = ring.reduce((a, q) => a + q[0], 0) / ring.length, cy = ring.reduce((a, q) => a + q[1], 0) / ring.length;
      const du = ((cx - st.centre[0]) * k) * Math.cos(st.angle) + ((cy - st.centre[1]) * ST_M) * Math.sin(st.angle);
      const dv = -((cx - st.centre[0]) * k) * Math.sin(st.angle) + ((cy - st.centre[1]) * ST_M) * Math.cos(st.angle);
      if (Math.abs(du) < 90 && Math.abs(dv) < 60) continue;
      const kind = f.properties.building;
      const h = f.properties.height || (['house', 'terrace', 'detached'].includes(kind) ? 7 : kind === 'apartments' ? 30 : 10);
      STATIONS.buildings.push({poly: ring.map(([x, y]) => [x, y, st.base]), h,
                               color: kind === 'apartments' ? [150, 144, 134] : [128, 122, 114]});
    }
    // Viaduct piers under the real elevated track, every 30 m.
    for (const r of myRails.filter((q) => q.elevated)) {
      let carry = 0;
      for (let i = 0; i < r.path.length - 1; i++) {
        const [x0, y0] = r.path[i], [x1, y1] = r.path[i + 1];
        const len = Math.hypot((x1 - x0) * k, (y1 - y0) * ST_M);
        for (let s = carry; s < len; s += 30) {
          const t = s / len;
          STATIONS.piers.push({pos: [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, st.base],
                               yaw: Math.atan2((y1 - y0) * ST_M, (x1 - x0) * k) * 180 / Math.PI});
        }
        carry = (carry - len) % 30;
        if (carry < 0) carry += 30;
      }
    }
  }
  console.info(`stations: ${Object.keys(STATIONS.byHub).length} built, ${STATIONS.boxes.length} parts, ` +
               `${STATIONS.buildings.length} nearby buildings, ${STATIONS.rails.length} rail lines`);
});

function buildStation(st) {
  const yaw = st.angle * 180 / Math.PI;
  const box = (u, v, z, su, sv, sz, color, part = 'body') => STATIONS.boxes.push(
    {pos: [...stLocal(st, u, v), st.base + z], yaw, scale: [su, sv, sz], color, hub: st.hub.id, part});
  const S = st.side;
  if (st.elevated) {
    const L = MRT.length;
    // Piers carrying the concourse and platforms.
    for (let u = -L / 2 + 7; u <= L / 2 - 7; u += 14) {
      for (const v of [-7.5, 7.5]) box(u, v, 0, 1.6, 1.6, MRT.deck, ST_COLOR.concreteDark);
    }
    // Concourse: a glazed box slung under the platforms, then the platform deck.
    box(0, 0, MRT.concourse[0], 72, MRT.width - 2, MRT.concourse[1] - MRT.concourse[0], ST_COLOR.glass);
    box(0, 0, MRT.concourse[0] - 0.6, 74, MRT.width, 0.6, ST_COLOR.concrete);
    box(0, 0, MRT.deck - 1.4, L, 20, 1.4, ST_COLOR.concrete);
    // Side platforms either side of two tracks, with a low wall along the outer edge.
    for (const v of [-7.2, 7.2]) {
      box(0, v, MRT.deck, L - 6, 4.4, 1.0, ST_COLOR.platform);
      box(0, v + Math.sign(v) * 2.4, MRT.deck, L - 6, 0.3, 2.2, ST_COLOR.glass);
    }
    // Roof posts and the curved metal roof.
    for (let u = -L / 2 + 7; u <= L / 2 - 7; u += 14) {
      for (const v of [-9.6, 9.6]) box(u, v, MRT.deck + 1, 0.5, 0.5, MRT.roofZ - MRT.deck - 1, ST_COLOR.concreteDark);
    }
    STATIONS.roofs.push({pos: [...stLocal(st, 0, 0), st.base + MRT.roofZ], yaw,
                         scale: [L + 4, MRT.width + 4, MRT.roofRise], color: ST_COLOR.roof, hub: st.hub.id});
    // A train standing at the platform: four cars, white with a dark window band.
    for (let i = 0; i < 4; i++) {
      const u = -33 + i * 22;
      box(u, -2.2, MRT.deck, 21.2, 3.0, 3.7, ST_COLOR.train, 'train');
      box(u, -2.2, MRT.deck + 1.6, 21.3, 3.06, 1.0, ST_COLOR.trainBand, 'train');
    }
    // Street-level entrance block, a covered link bridge to the concourse, and stairs.
    box(0, S * 22, 0, 20, 12, 6.5, ST_COLOR.glass);
    box(0, S * 22, 6.5, 22, 14, 0.5, ST_COLOR.roof);
    box(0, S * 14, 6.6, 8, 6, 3.4, ST_COLOR.glass);
    for (let i = 0; i < 6; i++) {
      box(-14, S * (16 + 2.0 * i), 0, 4, 2.0, 6.4 - i * 1.05, ST_COLOR.concrete);
    }
    box(-14, S * 21, 6.6, 5, 12, 0.3, ST_COLOR.roof);
    // The station sign on the concourse, facing the street.
    box(0, S * (MRT.width / 2 + 0.2), MRT.concourse[0] + 0.9, 30, 0.5, 3.0, ST_COLOR.sign, 'sign');
    STATIONS.labels.push({hub: st.hub.id, text: st.hub.name, sub: st.lines.join(' · '),
                          pos: [...stLocal(st, 0, S * (MRT.width / 2 + 1.4)), st.base + MRT.concourse[0] + 2.4]});
    // Lamp posts along the plaza.
    for (let u = -40; u <= 40; u += 16) box(u, S * 38, 0, 0.25, 0.25, 6, [70, 74, 80], 'lamp');
    // Paved forecourt, the drop-off lay-by, and parking, on the street side.
    const g = (u0, v0, u1, v1) => [stLocal(st, u0, S * v0), stLocal(st, u1, S * v0), stLocal(st, u1, S * v1),
                                   stLocal(st, u0, S * v1)];
    STATIONS.ground.push({ring: g(-50, 12, 50, 36), z: st.base + 0.2, color: ST_COLOR.plaza});
    STATIONS.ground.push({ring: g(-50, 36, 50, 46), z: st.base + 0.25, color: ST_COLOR.dropoff});
    STATIONS.ground.push({ring: g(55, 14, 115, 50), z: st.base + 0.2, color: ST_COLOR.parking});
    for (let u = -36; u <= 36; u += 24) box(u, S * 37.5, 0, 8, 2.4, 2.8, ST_COLOR.roof, 'shelter');
  }
  // An at-grade KTM platform when the name says KTM: beside the real KTM track nearest the
  // station if the data has one within 250 m, otherwise parallel to the MRT, 40 m off.
  if (/\bKTM\b/i.test(st.hub.name)) {
    const k = st.ktm && st.ktm.d < 250 ? st.ktm : null;
    const frame = k ? {...st, centre: k.at, angle: k.angle} : st;
    const off = k ? 5 : -S * 40;
    const kyaw = frame.angle * 180 / Math.PI;
    const kbox = (u, v, z, su, sv, sz, color) => STATIONS.boxes.push(
      {pos: [...stLocal(frame, u, v), st.base + z], yaw: kyaw, scale: [su, sv, sz], color, hub: st.hub.id, part: 'ktm'});
    kbox(0, off, 0, 160, 6, 1.0, ST_COLOR.platform);
    for (let u = -70; u <= 70; u += 14) kbox(u, off, 1.0, 0.4, 0.4, 3.6, ST_COLOR.concreteDark);
    kbox(0, off, 4.6, 162, 8, 0.4, ST_COLOR.roof);
  }
  // The pickable footprint, for clicks and the flat plan.
  STATIONS.picks.push({hub: st.hub.id, ring: [stLocal(st, -MRT.length / 2, -MRT.width / 2), stLocal(st, MRT.length / 2, -MRT.width / 2),
                                              stLocal(st, MRT.length / 2, MRT.width / 2), stLocal(st, -MRT.length / 2, MRT.width / 2)],
                       z: st.base, h: MRT.roofZ + MRT.roofRise});
}

/** Where a trip to this hub ends: the station's street entrance. */
function stationEntrance(hubId) {
  return STATIONS.byHub[hubId]?.entrance || null;
}

/** The camera on the station, square to the track, from the street side. */
function viewStation(hubId) {
  const st = STATIONS.byHub[hubId];
  if (!st) return;
  // Look across the track at the street side: the entrance, stairs and sign face the camera.
  // st.angle is the track, anticlockwise from east; the street side is +v. Facing from the
  // street towards the track is the compass bearing of -v.
  const deg = st.angle * 180 / Math.PI;
  const bearing = st.side > 0 ? 180 - deg : -deg;
  const [lon, lat] = stLocal(st, 0, st.side * 12);
  // The station's middle -- not its foot -- in the middle of the visible map (spatial.js).
  spCamera([lon, lat, st.base + 9], {zoom: 17.6, pitch: 58, bearing, duration: 2600});
}

/* ---------------------------------------------------------------------- layers */

const ROAD_RGB = {motorway: [30, 32, 35], trunk: [30, 32, 35], primary: [32, 34, 37], secondary: [34, 36, 39]};

hooks.ground.push((p, flat) => {
  if (!Object.keys(STATIONS.byHub).length || !jiran?.filter?.has('transit')) return [];
  return [
    new PolygonLayer({
      id: p('station-ground'),
      data: STATIONS.ground,
      getPolygon: (g) => (flat ? g.ring : g.ring.map(([x, y]) => [x, y, g.z])),
      getFillColor: (g) => g.color,
      filled: true, stroked: false, extruded: false, material: false,
      parameters: {depthTest: false, depthMask: false},
    }),
    new PathLayer({
      id: p('station-roads'),
      data: STATIONS.roads,
      getPath: (r) => (flat ? r.path : r.path.map(([x, y]) => [x, y, r.z])),
      getColor: (r) => (flat ? [70, 84, 108] : ROAD_RGB[r.highway] || [44, 46, 50]),
      getWidth: (r) => (ROAD_CLASS[r.highway] || ROAD_CLASS._).width,
      widthUnits: 'meters', widthMinPixels: 0.6, capRounded: true, jointRounded: true,
      parameters: {depthTest: false, depthMask: false},
    }),
  ];
});

hooks.layers.push((p, flat) => {
  if (!Object.keys(STATIONS.byHub).length || !jiran?.filter?.has('transit')) return [];
  const sel = inspected?.kind === 'hub' ? inspected.id : null;
  if (flat) {
    return [new PolygonLayer({
      id: p('station-pick'),
      data: STATIONS.picks,
      getPolygon: (s) => s.ring,
      getFillColor: (s) => [...CATEGORIES.transit.rgb, s.hub === sel ? 200 : 140],
      getLineColor: [210, 240, 255, 220], getLineWidth: 2, lineWidthUnits: 'pixels',
      filled: true, stroked: true, pickable: true,
      updateTriggers: {getFillColor: [sel]},
    }), new PathLayer({
      id: p('station-rails'),
      data: STATIONS.rails,
      getPath: (r) => r.path, getColor: [120, 200, 230, 220], getWidth: 4, widthUnits: 'meters', widthMinPixels: 1.5,
    })];
  }
  const material = {ambient: 0.5, diffuse: 0.65, shininess: 40, specularColor: [70, 80, 90]};
  // Empty layers are left out: an extruded layer with no data draws -1 instances.
  return [
    // The real track: viaduct deck where OSM says elevated, ballast at grade otherwise.
    new PathLayer({
      id: p('station-rails'),
      data: STATIONS.rails,
      getPath: (r) => r.path.map(([x, y]) => [x, y, r.z + (r.elevated ? MRT.deck - 1.6 : 0.4)]),
      getColor: (r) => (r.elevated ? [150, 152, 150] : [96, 86, 76]),
      getWidth: (r) => (r.elevated ? 7 : 4), widthUnits: 'meters', widthMinPixels: 1.5,
    }),
    new deck.SimpleMeshLayer({
      id: p('station-piers'),
      data: STATIONS.piers,
      mesh: MESH_BOX,
      getPosition: (q) => q.pos, getOrientation: (q) => [0, q.yaw, 0],
      getScale: [2.2, 2.2, MRT.deck - 0.6], getColor: ST_COLOR.concreteDark, material,
    }),
    new SolidPolygonLayer({
      id: p('station-context'),
      data: STATIONS.buildings,
      getPolygon: (b) => b.poly, extruded: true, getElevation: (b) => b.h,
      getFillColor: (b) => b.color, material,
    }),
    new deck.SimpleMeshLayer({
      id: p('station-parts'),
      data: STATIONS.boxes,
      mesh: MESH_BOX,
      getPosition: (b) => b.pos, getOrientation: (b) => [0, b.yaw, 0], getScale: (b) => b.scale,
      getColor: (b) => (b.part === 'sign' ? ST_COLOR.sign : b.color),
      material, pickable: true,
    }),
    new deck.SimpleMeshLayer({
      id: p('station-roof'),
      data: STATIONS.roofs,
      mesh: MESH_VAULT,
      getPosition: (r) => r.pos, getOrientation: (r) => [0, r.yaw, 0], getScale: (r) => r.scale,
      getColor: (r) => (r.hub === sel ? [214, 236, 248] : r.color),
      material, pickable: true,
      updateTriggers: {getColor: [sel]},
    }),
    // The sign's lettering, on the cyan panel.
    new TextLayer({
      id: p('station-sign'),
      data: STATIONS.labels,
      getText: (l) => `${l.text}`,
      getPosition: (l) => l.pos,
      getSize: 1.6, sizeUnits: 'meters', sizeMinPixels: 0, sizeMaxPixels: 22,
      getColor: [255, 255, 255, 255],
      fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif', fontWeight: 800,
      fontSettings: {sdf: true}, outlineWidth: 1, outlineColor: [6, 90, 130, 255],
      billboard: true,
    }),
  ].filter((l) => l.props.data.length);
});

hooks.click.push((info) => {
  if (!info.layer.id.includes('station-')) return false;
  const hub = info.object?.hub;
  if (!hub) return false;
  openHub(hub);
  return true;
});
