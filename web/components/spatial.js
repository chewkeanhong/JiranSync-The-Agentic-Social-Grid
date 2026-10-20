/* Spatial Intelligence Demo: two deterministic demo states, drawn on the live 3D map.
 *
 *   Vertical neighbour  -- 3D building geometry -> resident 3D position -> vertical
 *                          relationship -> matching engine -> best neighbour.
 *   Practical route     -- resident location -> road network + road conditions ->
 *                          routing -> travel time -> matching engine -> best match.
 *
 * The scenarios are computed by the server (jiransync/spatial_demo.py) from the real
 * terrain, road graph and matching engine; this file only renders them. Neither changes
 * the live community: entering the demo swaps the map's markers and overlays for the
 * scenario's, and leaving puts everything back.
 *
 * The demo tower is fictional and drawn only while its scenario is open. People inside it
 * stand at their real altitude (ground + floor x 3.2 m), projected through the same camera
 * as every other marker -- not floated over a flat footprint.
 */

const spatial = {
  active: false,
  scenario: 'vertical',
  data: null,
  loading: false,
  found: false,       // the user pressed Find; results and the cutaway are showing
  t0: 0,              // when Find was pressed, for the reveal animation
  asked: false,
};

const SP_COLORS = {
  you: [52, 211, 153], best: [251, 191, 36], other: [96, 165, 250], outside: [148, 163, 184],
  delayed: [248, 113, 113], clear: [52, 211, 153], works: [251, 146, 60],
};

function spatialActive() { return spatial.active; }
function spScenario() { return spatial.data?.[spatial.scenario] || null; }
function spSince() { return spatial.found ? performance.now() - spatial.t0 : 0; }
const spFirst = (name) => (name || '').split(' ')[0];

/* --------------------------------------------------------------- entering, leaving */

async function spatialEnter() {
  spatial.active = true;
  closeInspector();
  // The demo needs the width of the map; the credits panel comes back on exit.
  spatial.rightWas = jiran.rightOpen;
  if (jiran.rightOpen) setRight(false);
  if (!spatial.data && !spatial.loading) {
    spatial.loading = true;
    renderSpatial();
    try {
      spatial.data = await api('/api/demo/spatial');
    } catch (err) {
      toast(err.message, false);
    } finally {
      spatial.loading = false;
    }
  }
  spatialSelect(spatial.scenario);
}

function spatialExit() {
  if (!spatial.active) return;
  spatial.active = false;
  spatial.found = false;
  spatial.asked = false;
  if (spatial.rightWas) setRight(true);
  syncMarkers();
  redraw();
  resetCamera();
}

function spatialSelect(id) {
  spatial.scenario = id;
  spatial.found = false;
  spatial.asked = false;
  renderSpatial();
  syncMarkers();
  redraw();
  spatialFrame(false);
}

function spatialFind() {
  spatial.found = true;
  spatial.asked = false;
  spatial.t0 = performance.now();
  spatialFrame(true);
  renderSpatial();
  redraw();
  syncMarkers();
  // People appear once the cutaway has opened; keep the frames coming meanwhile.
  setTimeout(() => { syncMarkers(); renderSpatial(); }, 900);
}

function spatialAsk() {
  const s = spScenario();
  if (!s) return;
  spatial.asked = true;
  const best = s.people[0];
  toast(`Request sent to ${spFirst(best.name)} — demo scenario, no credits moved`);
  renderSpatial();
}

/* ------------------------------------------------------------------------ camera */

function spMetres(a, b) {
  const M = 6371000.0 * Math.PI / 180.0;
  return [(b[0] - a[0]) * M * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * M];
}

/** Put a 3D point (lon, lat, altitude) in the middle of the visible map -- between the
 *  side panels -- for a given zoom, pitch and bearing. Solved with deck.gl's own
 *  projection rather than by hand: aim the camera, see where the point lands, move the
 *  aim by the error, repeat. Converges in a few steps. */
function spVisible() {
  const W = window.innerWidth, H = window.innerHeight;
  const left = $('left')?.getBoundingClientRect().right || 0;
  const rightEl = $('right');
  const right = rightEl && !rightEl.classList.contains('closed') ? W - rightEl.getBoundingClientRect().left : 0;
  return {W, H, left, right: W - right};
}

function spSolve(point, {zoom, pitch, bearing}) {
  const {W, H, left, right} = spVisible();
  const want = [(left + right) / 2, H * 0.52];
  let aim = [point[0], point[1]];
  let vp = null;
  for (let i = 0; i < 6; i++) {
    vp = new deck.WebMercatorViewport({width: W, height: H, longitude: aim[0], latitude: aim[1],
                                       zoom, pitch, bearing});
    // Where the wanted screen spot sits on the horizontal plane at the point's altitude;
    // move the aim by however far that is from the point.
    const there = vp.unproject(want, {targetZ: point[2] || 0});
    aim = [aim[0] + point[0] - there[0], aim[1] + point[1] - there[1]];
  }
  vp = new deck.WebMercatorViewport({width: W, height: H, longitude: aim[0], latitude: aim[1],
                                     zoom, pitch, bearing});
  return {aim, vp};
}

function spCamera(point, {zoom, pitch, bearing, duration = 1600}) {
  const {aim} = spSolve(point, {zoom, pitch, bearing});
  setCamera({longitude: aim[0], latitude: aim[1], zoom, pitch, bearing}, duration);
}

function spatialFrame(close) {
  const s = spScenario();
  if (!s) return;
  if (s.id === 'vertical') {
    const t = s.tower;
    // Look square-on at the long face of the slab, from the side Priya's house is on, so
    // she stays in the shot beside the tower.
    const [ux, uy] = spMetres(t.polygon[1], t.polygon[0]);
    const along = Math.atan2(ux, uy) * 180 / Math.PI;
    const priya = s.people.find((p) => p.building !== t.id);
    // The tower's middle in the middle of the map, seen as square-on to its long face as
    // possible while Priya's house still lands in the visible part of the map.
    const mid = [t.centre[0], t.centre[1], t.base_elev + t.height * 0.5];
    const view = {zoom: close ? 18.3 : 17.5, pitch: close ? 60 : 55};
    const {H, left, right} = spVisible();
    let bearing = along + 90;
    search:
    for (const turn of [0, 15, -15, 30, -30, 45, -45, 60, -60]) {
      for (const face of [along + 90, along - 90]) {
        const b = face + turn;
        if (!priya) { bearing = b; break search; }
        const {vp} = spSolve(mid, {...view, bearing: b});
        const [x, y] = vp.project([priya.lon, priya.lat, priya.z + 1]);
        if (x > left + 70 && x < right - 150 && y > 90 && y < H - 90) { bearing = b; break search; }
      }
    }
    spCamera(mid, {...view, bearing, duration: close ? 1800 : 1400});
  } else {
    const pts = [[s.requester.lon, s.requester.lat], ...s.people.map((p) => [p.lon, p.lat]),
                 ...s.works.path];
    if (close) for (const p of s.people) pts.push(...p.route.path);
    const lons = pts.map((q) => q[0]), lats = pts.map((q) => q[1]);
    const centre = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
    const ground = pts.map((q) => [q[0], q[1], groundAt(q[0], q[1])]);
    const z0 = groundAt(...centre);
    const {H, left, right} = spVisible();
    const view = {pitch: 50, bearing: -12};
    // The closest view that keeps every point -- and the name tags beside them, ~170 px
    // wide -- inside the visible map.
    let zoom = 17.4;
    for (; zoom > 14.5; zoom -= 0.1) {
      const {vp} = spSolve([...centre, z0], {...view, zoom});
      if (ground.every((q) => {
        const [x, y] = vp.project(q);
        return x > left + 40 && x < right - 230 && y > 110 && y < H - 90;
      })) break;
    }
    spCamera([...centre, z0], {...view, zoom, duration: close ? 1600 : 1300});
  }
}

/* ------------------------------------------------------------------------ layers */

function spFloorRing(t, z) {
  const ring = t.polygon.map((c) => [c[0], c[1], z]);
  return [...ring, ring[0]];
}

function spatialLayers(p, flat) {
  if (!spatial.active || flat) return [];
  const s = spScenario();
  if (!s) return [];
  return s.id === 'vertical' ? verticalLayers(p, s) : routeLayers(p, s);
}

function verticalLayers(p, s) {
  const t = s.tower;
  const layers = [];
  const since = spSince();
  // 0 -> 1 as the shell turns to glass and the floors are cut open.
  const open = spatial.found ? Math.min(1, since / 1100) : 0;
  const poly = t.polygon.map((c) => [c[0], c[1], t.base_elev]);

  layers.push(new SolidPolygonLayer({
    id: p('sp-tower-shell'),
    data: [{poly}],
    getPolygon: (d) => d.poly,
    extruded: true,
    getElevation: t.height,
    getFillColor: [118, 150, 196, Math.round(235 - 205 * open)],
    material: {ambient: 0.5, diffuse: 0.55, shininess: 30},
    // Glass does not hide what is inside it.
    parameters: open > 0 ? {depthMask: false} : {},
    updateTriggers: {getFillColor: [open]},
  }));
  layers.push(new PolygonLayer({
    id: p('sp-tower-edges'),
    data: [{poly}],
    getPolygon: (d) => d.poly,
    extruded: true,
    filled: false,
    wireframe: true,
    getElevation: t.height,
    getLineColor: spatial.found ? [180, 210, 255, 200] : [200, 214, 240, 90],
    updateTriggers: {getLineColor: [spatial.found]},
  }));

  if (spatial.found) {
    // One slab per floor, revealed bottom to top. The three floors in the story glow.
    const role = {};
    role[s.requester.floor] = 'you';
    for (const q of s.people) if (q.building === t.id) role[q.floor] = q.id === s.best ? 'best' : 'other';
    const floors = [];
    for (let f = 0; f <= t.floors; f++) {
      if (f / t.floors > open * 1.05) continue;
      floors.push({f, z: t.base_elev + f * t.floor_height, role: role[f]});
    }
    layers.push(new SolidPolygonLayer({
      id: p('sp-floors'),
      data: floors,
      getPolygon: (d) => t.polygon.map((c) => [c[0], c[1], d.z]),
      extruded: true,
      getElevation: 0.35,
      getFillColor: (d) => (d.role ? [...SP_COLORS[d.role], 200] : [148, 163, 184, 60]),
      material: false,
      parameters: {depthMask: false},
      updateTriggers: {getFillColor: [floors.length]},
    }));
    layers.push(new PathLayer({
      id: p('sp-floor-lines'),
      data: floors,
      getPath: (d) => spFloorRing(t, d.z + 0.2),
      getColor: (d) => (d.role ? [...SP_COLORS[d.role], 255] : [190, 205, 230, 120]),
      getWidth: (d) => (d.role ? 2.5 : 1),
      widthUnits: 'pixels',
      parameters: {depthTest: false},
    }));

    if (since > 900) {
      const at = (q, lift = 1.0) => [q.lon, q.lat, q.z + lift];
      const best = s.people.find((q) => q.id === s.best);
      const links = s.people.map((q) => ({q, path: [at(s.requester), at(q)]}));
      // The vertical connection: Aisyah straight down to Daniel; fainter lines to the others.
      layers.push(new PathLayer({
        id: p('sp-links'),
        data: links,
        getPath: (d) => d.path,
        getColor: (d) => (d.q.id === best.id ? [...SP_COLORS.best, 255]
          : d.q.building === t.id ? [...SP_COLORS.other, 150] : [...SP_COLORS.outside, 130]),
        getWidth: (d) => (d.q.id === best.id ? 5 : 2),
        widthUnits: 'pixels',
        getDashArray: (d) => (d.q.id === best.id ? [0, 0] : [5, 4]),
        dashJustified: true,
        extensions: [new PathStyleExtension({dash: true})],
        parameters: {depthTest: false},
      }));
      // Priya's real house, outlined where it stands.
      const priya = s.people.find((q) => q.building !== t.id);
      const house = priya && world.buildingById?.[priya.building];
      if (house) {
        layers.push(new PolygonLayer({
          id: p('sp-priya-house'),
          data: [house],
          extruded: true,
          filled: false,
          wireframe: true,
          getPolygon: (b) => b._poly,
          getElevation: (b) => b.properties.height + 0.3,
          getLineColor: [...SP_COLORS.outside, 230],
          parameters: {depthTest: false},
        }));
      }
    }
  }
  return layers;
}

function routeLayers(p, s) {
  const layers = [];
  // The roadworks: a striped orange band on the real street, always visible in this scenario.
  layers.push(new PathLayer({
    id: p('sp-works'),
    data: [s.works],
    getPath: (w) => onGround(w.path, 2.2),
    getColor: [...SP_COLORS.works, 255],
    getWidth: 11,
    widthUnits: 'meters',
    widthMinPixels: 7,
    capRounded: true,
  }));
  layers.push(new PathLayer({
    id: p('sp-works-stripes'),
    data: [s.works],
    getPath: (w) => onGround(w.path, 2.4),
    getColor: [20, 20, 24, 255],
    getWidth: 11,
    widthUnits: 'meters',
    widthMinPixels: 7,
    getDashArray: [1.2, 1.2],
    dashJustified: false,
    extensions: [new PathStyleExtension({dash: true})],
  }));

  // "2D distance": straight lines from each driver to Aisyah.
  const me = [s.requester.lon, s.requester.lat];
  layers.push(new PathLayer({
    id: p('sp-crow'),
    data: s.people,
    getPath: (q) => onGround([[q.lon, q.lat], me], 6),
    getColor: [226, 232, 240, spatial.found ? 110 : 200],
    getWidth: 2,
    widthUnits: 'pixels',
    getDashArray: [6, 6],
    dashJustified: true,
    extensions: [new PathStyleExtension({dash: true})],
    parameters: {depthTest: false},
    updateTriggers: {getColor: [spatial.found]},
  }));

  if (spatial.found) {
    const grow = Math.min(1, spSince() / 1400);
    const cut = (path) => path.slice(0, Math.max(2, Math.ceil(path.length * grow)));
    if (s.onward) {
      layers.push(new PathLayer({
        id: p('sp-onward'),
        data: [s.onward],
        getPath: (r) => onGround(cut(r.path), 3),
        getColor: [...SP_COLORS.clear, 90],
        getWidth: 4,
        widthUnits: 'meters',
        widthMinPixels: 2,
        getDashArray: [4, 4],
        extensions: [new PathStyleExtension({dash: true})],
        updateTriggers: {getPath: [grow]},
      }));
      // Past the edge of the mapped roads: the last leg to the station's entrance.
      const end = s.onward.path[s.onward.path.length - 1];
      const entrance = stationEntrance(s.destination.id);
      if (entrance && grow >= 1) {
        layers.push(new deck.ArcLayer({
          id: p('sp-to-station'),
          data: [{from: [end[0], end[1], groundAt(...end) + 3], to: entrance}],
          getSourcePosition: (a) => a.from,
          getTargetPosition: (a) => a.to,
          getSourceColor: [...SP_COLORS.clear, 160],
          getTargetColor: [...CATEGORIES.transit.rgb, 220],
          getWidth: 3,
          getHeight: 0.25,
        }));
      }
    }
    layers.push(new PathLayer({
      id: p('sp-routes'),
      // The best route last, so it is on top where the two share a street.
      data: [...s.people].reverse(),
      getPath: (q) => onGround(cut(q.route.path), 3.4),
      getColor: (q) => [...(q.affected ? SP_COLORS.delayed : SP_COLORS.clear), 240],
      getWidth: (q) => (q.id === s.best ? 7 : 5),
      widthUnits: 'meters',
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
      parameters: {depthTest: false},
      updateTriggers: {getPath: [grow]},
    }));
  }
  return layers;
}

hooks.layers.push(spatialLayers);
{
  const before = hooks.animating;
  hooks.animating = () => before() || (spatial.active && spatial.found && spSince() < 2600);
}

/* ----------------------------------------------------------------------- markers */

function spPerson(key, q, {z, role, tag, side = 'right'}) {
  return {
    key: `sp:${key}`, kind: 'floor', fixed: true,
    lonlat: [q.lon, q.lat], z,
    cls: `fp-${role} fp-${side}`,
    html: `<div class="fp"><span class="fp-av">${avatarSvg(q.id)}</span><span class="fp-tag">${tag}</span></div>`,
  };
}

function spatialMarkers() {
  const s = spScenario();
  if (!s) return [];
  const out = [];
  if (s.id === 'vertical') {
    const t = s.tower;
    out.push({key: 'sp:tower', kind: 'floor', fixed: true, lonlat: t.centre, z: t.base_elev + t.height + 6,
              cls: 'fp-label', html: `<div class="fp-banner">${icon('layers', 13)}${esc(t.name)}<em>Demo building</em></div>`});
    const r = s.requester;
    out.push(spPerson('me', r, {z: r.z + 1.2, role: 'you', tag: `${esc(spFirst(r.name))} <b>YOU</b> · L${r.floor}`}));
    if (spatial.found && spSince() > 900) {
      for (const q of s.people) {
        const inside = q.building === t.id;
        const best = q.id === s.best;
        out.push(spPerson(q.id, q, {
          z: q.z + 1.2,
          role: best ? 'best' : inside ? 'other' : 'outside',
          side: best ? 'left' : 'right',
          tag: inside ? `${best ? '⭐ ' : ''}${esc(spFirst(q.name))} · L${q.floor}`
            : `${esc(spFirst(q.name))} · other building · ${Math.round(q.horizontal_m)} m`,
        }));
      }
      // Level labels at the tower's corner, at each storey in the story.
      const corner = t.polygon[2];
      const levels = new Set([r.floor, ...s.people.filter((q) => q.building === t.id).map((q) => q.floor)]);
      for (const f of levels) {
        out.push({key: `sp:lvl${f}`, kind: 'floor', fixed: true, lonlat: corner,
                  z: t.base_elev + f * t.floor_height + 1.2, cls: 'fp-level',
                  html: `<div class="fp-lvl">LEVEL ${f}</div>`});
      }
    }
  } else {
    const r = s.requester;
    out.push(spPerson('me', r, {z: groundAt(r.lon, r.lat) + 3, role: 'you', tag: `${esc(spFirst(r.name))} <b>YOU</b>`}));
    for (const q of s.people) {
      const best = spatial.found && q.id === s.best;
      out.push(spPerson(q.id, q, {
        z: groundAt(q.lon, q.lat) + 3,
        role: best ? 'best' : spatial.found && q.affected ? 'delayed' : 'other',
        tag: `${best ? '⭐ ' : ''}${esc(spFirst(q.name))} · ${q.crow_m} m`
          + (spatial.found ? ` · ${Math.round(q.route.min)} min` : ''),
      }));
    }
    const mid = s.works.path[Math.floor(s.works.path.length / 2)];
    out.push({key: 'sp:works', kind: 'floor', fixed: true, lonlat: mid, z: groundAt(...mid) + 8,
              cls: 'fp-label', html: `<div class="fp-banner works">🚧 ${esc(s.works.label)}<em>Demo road condition</em></div>`});
  }
  return out;
}

/* ------------------------------------------------------------------------- panel */

function spCheck(ok, text) {
  return `<span class="sp-check ${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x', 13)}${text}</span>`;
}

function renderSpatial() {
  const body = $('left-body');
  if (!body || jiran.view !== 'spatial') return;
  const s = spScenario();
  const choose = (id, title, sub, ic) => `
    <button class="sp-choice ${spatial.scenario === id ? 'on' : ''}" data-sp="${id}">
      <span class="sp-radio"></span>${icon(ic, 18)}<span><b>${title}</b><em>${sub}</em></span></button>`;
  let html = `<div class="view-title"><h2>Spatial Intelligence Demo</h2>
      <p>Two fixed demo states, computed from the real terrain, roads and matching engine. They don’t change the live community.</p></div>
    <div class="sp-choices">
      ${choose('vertical', 'Vertical neighbour', 'Who is closest in 3D space?', 'layers')}
      ${choose('route', 'Practical route', 'Who can actually reach you fastest?', 'route')}
    </div>`;
  if (spatial.loading || !s) {
    html += `<div class="skeleton"><i></i><i></i><i class="short"></i></div>`;
  } else if (s.id === 'vertical') {
    html += verticalPanel(s);
  } else {
    html += routePanel(s);
  }
  body.innerHTML = html;
  for (const b of body.querySelectorAll('[data-sp]')) b.onclick = () => spatialSelect(b.dataset.sp);
  $('sp-find')?.addEventListener('click', spatialFind);
  $('sp-ask')?.addEventListener('click', spatialAsk);
}

function verticalPanel(s) {
  const t = s.tower;
  const r = s.requester;
  const best = s.people.find((q) => q.id === s.best);
  const intro = `
    <div class="sp-scene">
      <div class="sp-req">${avatarHtml(r.id, {size: 34})}<div><b>${esc(r.name)}</b>
        <em>${esc(t.name)} · Level ${r.floor}</em></div></div>
      <p class="sp-quote">“${esc(s.text)}”</p>
      <button class="btn primary big" id="sp-find">${icon('locate', 17)}Find Nearest Neighbour</button>
    </div>`;
  if (!spatial.found) return intro;

  const inside = s.people.filter((q) => q.building === t.id);
  const top = Math.max(r.floor, ...inside.map((q) => q.floor));
  const rows = [];
  for (let f = top; f >= Math.min(r.floor, ...inside.map((q) => q.floor)); f--) {
    const who = inside.find((q) => q.floor === f);
    if (f === r.floor) rows.push(`<div class="fl you"><span>LEVEL ${f}</span><b>🟢 ${esc(spFirst(r.name))} <i>YOU</i></b></div>`);
    else if (who) rows.push(`<div class="fl ${who.id === s.best ? 'best' : ''}"><span>LEVEL ${f}</span><b>${who.id === s.best ? '⭐' : '👤'} ${esc(spFirst(who.name))}</b></div>`);
    else if (!rows.length || !rows[rows.length - 1].includes('fl gap')) rows.push('<div class="fl gap"><span>⋮</span></div>');
  }
  const outside = s.people.filter((q) => q.building !== t.id);
  const flatTie = s.flat_view.tied;

  return intro + `
    <div class="sp-msg"><p>2D sees distance.</p><p><b>JiranSync sees where people actually are.</b></p></div>
    <div class="sp-stack">${rows.join('')}
      ${outside.map((q) => `<div class="fl out"><span>OUTSIDE</span><b>${esc(spFirst(q.name))} · other building · ${Math.round(q.horizontal_m)} m</b></div>`).join('')}
    </div>

    <div class="sp-card">
      <div class="sp-kicker">3D SPATIAL MATCH</div>
      <div class="sp-best">⭐ Best neighbour</div>
      <div class="sp-who">${avatarHtml(best.id, {size: 44, verified: best.verified})}
        <div><b>${esc(best.name)}</b>${best.verified ? verifiedTag() : ''}</div></div>
      <div class="sp-grid">
        <div><span>${best.same_building ? 'Same building' : 'Other building'}</span><b>Level ${best.floor}</b></div>
        <div><span>You</span><b>Level ${r.floor}</b></div>
        <div><span>Vertical</span><b>${best.floors_apart} floor${best.floors_apart === 1 ? '' : 's'} away</b></div>
        <div><span>Horizontal</span><b>${Math.round(best.horizontal_m)} m</b></div>
      </div>
      <div class="sp-checks">${spCheck(best.available, 'Available')}${spCheck(best.compatible, 'Task compatible')}
        ${spCheck(true, `~${Math.round(best.access_s)} s door to door`)}</div>
      <div class="sp-score"><span>Match score</span><b>${Math.round(best.score * 100)}%</b><i style="--w:${Math.round(best.score * 100)}%"></i></div>
      ${spatial.asked
        ? `<div class="sp-sent">${icon('check', 15)}Request sent to ${esc(spFirst(best.name))}. Demo scenario: nothing posted, no credits moved.</div>`
        : `<button class="btn primary" id="sp-ask">${icon('heart', 16)}Ask ${esc(spFirst(best.name))}</button>`}
    </div>

    <div class="sp-msg small"><p>${esc(spFirst(best.name))} isn’t simply nearby.</p>
      <p><b>${esc(spFirst(best.name))} is ${best.floors_apart === 1 ? 'one floor' : `${best.floors_apart} floors`} away.</b></p></div>

    <div class="sec-title sp-sec">Why not the others</div>
    <div class="sp-compare">${s.people.map((q) => `
      <div class="cmp ${q.id === s.best ? 'best' : ''}">
        ${avatarHtml(q.id, {size: 30})}
        <div><b>${esc(spFirst(q.name))}</b>
          <em>${q.same_building ? `Same building · ${q.floors_apart} floor${q.floors_apart === 1 ? '' : 's'} away`
            : `Different building · ${Math.round(q.horizontal_m)} m away`}</em>
          <em>~${q.access_s < 90 ? `${Math.round(q.access_s)} s` : `${Math.round(q.access_s / 60)} min`} door to door · ${Math.round(q.score * 100)}% match</em></div>
        ${q.id === s.best ? '<span class="tag">BEST MATCH</span>' : ''}
      </div>`).join('')}
    </div>
    ${flatTie.length ? `<div class="sp-flat">${icon('pin', 15)}<div><b>What a flat 2D map sees:</b>
      ${s.flat_view.distances.map((d) => `${esc(spFirst(d.name))} ${Math.round(d.horizontal_m)} m`).join(' · ')}.
      ${flatTie.join(' and ')} are a tie. Only the building model knows who is one floor away.</div></div>` : ''}
    <p class="sp-note">${icon('alert', 13)}<span><b>Estimated floor position.</b> ${esc(t.name)} is a fictional building: no real
      building in the City of Elmina data is tall enough. Altitude = ground ${t.base_elev} m + floor × ${t.floor_height} m.
      ${s.assumptions.slice(1).map(esc).join(' ')}</span></p>`;
}

function routePanel(s) {
  const r = s.requester;
  const best = s.people.find((q) => q.id === s.best);
  const closest = s.people.find((q) => q.id === s.closest);
  const other = s.people.find((q) => q.id !== s.best);
  const intro = `
    <div class="sp-scene">
      <div class="sp-req">${avatarHtml(r.id, {size: 34})}<div><b>${esc(r.name)}</b>
        <em>Going to ${esc(s.destination.name)}</em></div></div>
      <p class="sp-quote">“${esc(s.text)}”</p>
      <div class="sp-works">🚧 <div><b>${esc(s.works.label)}</b> on ${esc(s.works.street)} (${s.works.length_m} m)
        <em>${esc(s.works.model)}</em></div></div>
      <button class="btn primary big" id="sp-find">${icon('route', 17)}Find Best Match</button>
    </div>`;
  if (!spatial.found) return intro;

  const card = (q) => `
    <div class="rc2 ${q.affected ? 'bad' : 'good'} ${q.id === s.best ? 'best' : ''}">
      <div class="rc2-head">${avatarHtml(q.id, {size: 30})}<b>${esc(spFirst(q.name))}</b>
        ${q.id === s.best ? '<span class="tag">BEST</span>' : ''}</div>
      <div class="rc2-row"><span>Straight line</span><b>${q.crow_m} m</b></div>
      <div class="rc2-row"><span>Road</span><b>${q.affected ? '🚧 Under repair' : '✓ Clear route'}</b></div>
      <div class="rc2-row"><span>Actual route</span><b>${q.route.km} km</b></div>
      <div class="rc2-row"><span>Est. time</span><b>${q.route.min} min</b></div>
      <div class="rc2-row"><span>Status</span><b class="st">${q.affected ? 'Delayed' : 'Clear'}</b></div>
    </div>`;
  return intro + `
    <div class="sp-cmp2">${s.people.map(card).join('')}</div>
    <div class="ai-note">${icon('sparkle', 15)}<div>
      <span class="ai-line">${esc(spFirst(closest.name))} is closer, but her route is affected by road repair:
        ${closest.route.min} min today against ${closest.normal_route ? closest.normal_route.min : '?'} min normally.</span>
      <span class="ai-line">${esc(spFirst(best.name))} is farther away, but his route is clear.</span>
      <span class="ai-line"><b>${esc(spFirst(best.name))} can reach you about ${Math.round(s.faster_by_min)} minutes faster.</b></span>
    </div></div>
    <div class="sp-card">
      <div class="sp-kicker">PRACTICAL ROUTE MATCH</div>
      <div class="sp-best">⭐ Best practical match</div>
      <div class="sp-who">${avatarHtml(best.id, {size: 44, verified: best.verified})}
        <div><b>${esc(best.name)}</b>${best.verified ? verifiedTag() : ''}</div></div>
      <div class="sp-checks">${spCheck(true, `${best.route.min} min to you`)}${spCheck(true, `Heading to ${esc(best.heading_to)}`)}
        ${spCheck(true, 'Available')}</div>
      <p class="sp-straight">Straight-line matching would have picked <b>${esc(spFirst(closest.name))}</b>.</p>
      ${spatial.asked
        ? `<div class="sp-sent">${icon('check', 15)}Request sent to ${esc(spFirst(best.name))}. Demo scenario: nothing posted, no credits moved.</div>`
        : `<button class="btn primary" id="sp-ask">${icon('car', 16)}Ask ${esc(spFirst(best.name))}</button>`}
    </div>
    <div class="sp-msg small"><p>JiranSync does not just ask who is closest.</p>
      <p><b>It asks who can actually reach you fastest.</b></p></div>
    <p class="sp-note">${icon('alert', 13)}<span>${s.assumptions.map(esc).join(' ')}</span></p>`;
}
