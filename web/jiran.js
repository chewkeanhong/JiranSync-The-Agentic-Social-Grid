/* JiranSync app: the social grid on top of the township map.
 *
 * Plugs into web/app.js through `hooks`; the map core knows nothing about tasks or credits.
 * The server owns all state. This file keeps the client's view of it (who is signed in,
 * what is selected, which categories are shown), decides who appears on the map and in
 * what state, and wires the panels and cards in web/components/ to the HTTP API.
 *
 *   components/icons.js    icon set, categories, resident states
 *   components/avatar.js   stable generated portraits per resident id
 *   components/markers.js  HTML markers pinned to 3D positions
 *   components/cards.js    task / resident / shop / station cards (the floating card)
 *   components/panels.js   header, ask the grid, lists, wallet, activity, search, legend
 */

/* -------------------------------------------------------------------- state */

const jiran = {
  me: null,               // signed-in resident id
  residents: [],
  byId: {},
  meData: null,           // /api/me
  draft: null,            // /api/tasks/draft result being shown
  draftCredits: null,
  drafting: false,
  view: 'home',           // left panel section
  taskDetail: new Map(),  // id -> /api/tasks/{id}
  agent: null,
  lastEventId: 0,
  filter: new Set(Object.keys(CATEGORIES)),
  dev: false,
  framed: false,
  showAllNearby: false,
  rightOpen: false,
};

const START_HOUR = 7.5;     // mirrors jiransync.grid.START_HOUR
const PEOPLE_ON_MAP = 15;   // neighbours shown besides the ones doing something

/* ------------------------------------------------------------------ helpers */

function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* private mode */ } }

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  };
  const r = await fetch(path, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = data.error || (Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail)
      || `Something went wrong (${r.status})`;
    throw new Error(message);
  }
  return data;
}

function toast(message, ok = true) {
  const el = $('toast');
  el.innerHTML = `${icon(ok ? 'check' : 'alert', 16)}<span>${esc(message)}</span>`;
  el.className = `toast ${ok ? 'ok' : 'bad'}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.hidden = true; }, 260); },
                           ok ? 3200 : 5200);
}

async function act(path, body, success) {
  try {
    const out = await api(path, body);
    if (success) toast(typeof success === 'function' ? success(out) : success);
    await refreshMe();
    return out;
  } catch (err) {
    toast(err.message, false);
    return null;
  }
}

const resident = (id) => jiran.byId[id] || null;
const nameOf = (id) => (id === 'sdp' ? 'SDP Property Management' : resident(id)?.name || id);
const firstName = (id) => (id === 'sdp' ? 'SDP' : nameOf(id).split(' ')[0]);
const myHome = () => resident(jiran.me);
const credits = (n) => `${n} Credit${Math.abs(n) === 1 ? '' : 's'}`;
const hubById = (id) => (world?.hubs || []).find((h) => h.id === id) || null;
const tenantById = (id) => (world?.tenants || []).find((t) => t.id === id) || null;

function simClock(t) {
  const m = START_HOUR * 60 + t / 60;
  const hm = m % 1440;
  return `${String(Math.floor(hm / 60)).padStart(2, '0')}:${String(Math.floor(hm % 60)).padStart(2, '0')}`;
}

function fmtDist(m) {
  if (m == null || !Number.isFinite(m)) return '';
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

function distFromMe(lon, lat) {
  const home = myHome();
  return home ? distanceM([home.lon, home.lat], [lon, lat]) : null;
}

/** The category a task belongs to, for its icon, colour and filter. */
function catOf(t) {
  if (!t) return 'help';
  if (t.kind === 'ride') return 'ride';
  const skills = new Set(t.skills || []);
  if (t.kind === 'bounty' || skills.has('cleaning') || skills.has('gardening')) return 'community';
  if (skills.has('tutoring')) return 'tutoring';
  return 'help';
}

/* The township clock. The server's demo clock counts seconds from Monday 07:30. */
const CLOCK_START_MIN = 7.5 * 60;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SLOT_RANGE = {morning: [7, 12], afternoon: [12, 18], evening: [18, 22]};

const minuteOf = (demoT) => CLOCK_START_MIN + demoT / 60;
const nowMinute = () => minuteOf(state?.clock?.now ?? 0);
const hhmm = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;

/** "Today 18:00", "Tomorrow 07:00", "Thu 12:00" -- relative to the township clock. */
function dayTimeLabel(demoT) {
  const m = minuteOf(demoT);
  const diff = Math.floor(m / 1440) - Math.floor(nowMinute() / 1440);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : DAY_NAMES[Math.floor(m / 1440) % 7];
  return `${day} ${hhmm(m)}`;
}

function freeNow(r) {
  const slot = state?.clock?.slot;
  return !!slot && (r?.availability || []).includes(slot);
}

/** The next start of each of a neighbour's free slots, soonest first: what they can be booked for. */
function bookableSlots(r) {
  const now = nowMinute();
  const today = Math.floor(now / 1440) * 1440;
  return Object.keys(SLOT_RANGE).filter((s) => (r?.availability || []).includes(s)).map((slot) => {
    let start = today + SLOT_RANGE[slot][0] * 60;
    if (start <= now) start += 1440;
    const startAt = (start - CLOCK_START_MIN) * 60;
    return {slot, start_at: startAt, label: dayTimeLabel(startAt)};
  }).sort((a, b) => a.start_at - b.start_at);
}

function whenOf(t) {
  if (t.start_at != null) return dayTimeLabel(t.start_at);
  if (t.when) return t.when;
  if (t.slot) return t.slot[0].toUpperCase() + t.slot.slice(1);
  return 'Flexible';
}

function liveTasks() { return (state?.tasks || []).filter((t) => t.status !== 'completed'); }
function taskById(id) {
  const live = (state?.tasks || []).find((t) => t.id === id);
  const detail = jiran.taskDetail.get(id);
  const mine = jiran.meData?.tasks?.find((t) => t.id === id);
  return live || detail || mine ? {...(mine || {}), ...(detail || {}), ...(live || {})} : null;
}

/* ------------------------------------------------------------- people state */

/** Where a resident is and what they are doing, from the latest snapshot. */
function personState(id) {
  const r = resident(id);
  if (!r) return null;
  const movers = state?.movers || [];
  const mover = movers.find((m) => !m.done && (m.resident === id
    || (m.passenger === id && m.leg === 'ride')));
  if (mover) {
    const riding = mover.resident !== id;
    const task = mover.task_id ? taskById(mover.task_id) : null;
    let doing;
    if (riding) doing = `Riding with ${firstName(mover.resident)} to ${task?.dest_name || 'the station'}`;
    else if (mover.leg === 'pickup') doing = `Picking up ${firstName(mover.passenger)}`;
    else if (mover.leg === 'ride') doing = `Driving ${firstName(mover.passenger)} to ${task?.dest_name || 'the station'}`;
    else if (mover.leg === 'go') doing = `On the way to help ${firstName(task?.requester)}`;
    else doing = mover.mode === 'drive' ? 'Driving to the station' : 'Out and about';
    return {status: 'moving', lonlat: [mover.lon, mover.lat], mover, riding, task, doing,
            mode: mover.mode};
  }
  const working = liveTasks().find((t) => t.provider === id && (t.status === 'arrived' || t.status === 'in_progress'));
  if (working) {
    return {status: 'busy', lonlat: [working.lon, working.lat], task: working,
            doing: `Helping with ${working.title.toLowerCase()}`};
  }
  const free = freeNow(r);
  const next = free ? null : bookableSlots(r)[0];
  return {status: free ? 'available' : 'offline', lonlat: [r.lon, r.lat],
          doing: free ? 'Available now' : `Not free now · next free ${next ? next.label : 'time not listed'}`};
}

/** Who appears on the map: everyone doing something, you, and the nearest neighbours. */
function peopleOnMap() {
  if (!state || !jiran.residents.length) return [];
  const out = new Map();
  const add = (id) => {
    if (out.has(id) || !resident(id)) return;
    const s = personState(id);
    if (s && !s.riding) out.set(id, s);
  };
  for (const m of state.movers || []) if (!m.done) add(m.resident);
  for (const t of liveTasks()) if (t.provider) add(t.provider);
  add(jiran.me);
  // Requesters are represented by their task's pin, standing at their door.
  const asking = new Set(liveTasks().filter((t) => t.status === 'open').map((t) => t.requester));
  const home = myHome();
  const near = jiran.residents
    .filter((r) => !out.has(r.id) && !asking.has(r.id))
    .map((r) => ({r, d: home ? distanceM([home.lon, home.lat], [r.lon, r.lat]) : 0}))
    .sort((a, b) => a.d - b.d);
  for (const {r} of near) {
    if (out.size >= PEOPLE_ON_MAP) break;
    add(r.id);
  }
  return [...out.entries()].map(([id, s]) => ({id, ...s}));
}

/* ------------------------------------------------------------------ markers */

function isSelected(kind, id) { return inspected?.kind === kind && inspected?.id === id; }

function personMarker(p) {
  const r = resident(p.id);
  const you = p.id === jiran.me;
  const passenger = p.mover?.leg === 'ride' && p.mover.passenger ? p.mover.passenger : null;
  const badge = p.status === 'moving'
    ? icon(p.mode === 'drive' ? 'car' : 'walk', 11)
    : p.status === 'busy' ? icon('wrench', 11) : '';
  const label = you ? 'You' : r.name.split(' ')[0];
  return {
    key: `p:${p.id}`, kind: 'person',
    lonlat: p.lonlat, z: groundAt(...p.lonlat) + 3,
    glide: p.status === 'moving',
    cls: `s-${p.status} ${you ? 'you' : ''} ${isSelected('resident', p.id) ? 'sel' : ''}`,
    html: `<div class="pp">
        <span class="pp-av">${avatarSvg(p.id)}</span>
        ${r.verified ? `<i class="pp-ver">${icon('check', 8)}</i>` : ''}
        ${badge ? `<i class="pp-act">${badge}</i>` : ''}
        ${you ? `<i class="pp-home">${icon('home', 10)}</i>` : ''}
        ${passenger ? `<span class="pp-pass">${avatarSvg(passenger)}</span>` : ''}
        <span class="pp-name">${esc(label)}${passenger ? ` + ${esc(firstName(passenger))}` : ''}</span>
      </div>`,
    title: `${r.name} · ${STATUSES[p.status].label}`,
    data: p.id,
    onClick: (id) => openResident(id),
  };
}

function taskMarker(t) {
  const cat = CATEGORIES[catOf(t)];
  const matched = t.status !== 'open';
  return {
    key: `t:${t.id}`, kind: 'task',
    lonlat: [t.lon, t.lat], z: groundAt(t.lon, t.lat) + pinHeight(t),
    cls: `${matched ? 'matched' : ''} ${t.urgency >= 3 && !matched ? 'urgent' : ''} ${isSelected('task', t.id) ? 'sel' : ''}`,
    html: `<div class="pt" style="--c:${cat.color}">
        <span class="pt-head">${icon(cat.icon, 17)}</span>
        <span class="pt-cr">${t.credits}</span>
        ${t.requester !== 'sdp' ? `<span class="pt-who">${avatarSvg(t.requester)}</span>` : `<span class="pt-who sdp">${icon('megaphone', 10)}</span>`}
        ${matched ? `<i class="pt-ok">${icon('check', 9)}</i>` : ''}
        <span class="pt-label">${esc(t.title)}</span>
      </div>`,
    title: `${t.title} · ${credits(t.credits)}`,
    data: t.id,
    onClick: (id) => openTask(id),
  };
}

function tenantMarker(tenant) {
  const b = world.buildingById[tenant.building];
  const cat = CATEGORIES.commercial;
  return {
    key: `s:${tenant.id}`, kind: 'place',
    lonlat: [tenant.lon, tenant.lat],
    z: (b?.properties.ground_elev || 0) + (b?.properties.height || 8) + 2,
    cls: isSelected('tenant', tenant.id) ? 'sel' : '',
    // A local business, not a pin: what it offers for Jiran Credits and how far it is.
    html: `<div class="pl shop" style="--c:${cat.color}"><span class="pl-ic">${icon('store', 14)}</span>` +
      `<span class="pl-name">${esc(tenant.name)}<small>${esc(shortOffer(tenant.offer))}` +
      `${distFromMe(tenant.lon, tenant.lat) != null ? ` · ${fmtDist(distFromMe(tenant.lon, tenant.lat))}` : ''}</small></span></div>`,
    title: `${tenant.name} · ${tenant.offer}`,
    data: tenant.id,
    onClick: (id) => openTenant(id),
  };
}

/** "RM2 off any drink per credit" -> "RM2 off per credit": short enough for a map tag. */
/* ---------------------------------------------------------------- ride anywhere */

/** A name a resident would use for a building: its own, else what it is and its street. */
function placeName(id) {
  const f = world.buildingById[id];
  if (!f) return 'a place in Elmina';
  if (f.properties.name) return f.properties.name;
  const [lon, lat] = world.centroids?.[id] || f.geometry.coordinates[0][0];
  let street = null, best = Infinity;
  const k = Math.cos(lat * Math.PI / 180);
  for (const r of world.roads.features) {
    if (!r.properties.name) continue;
    for (const [x, y] of r.geometry.coordinates) {
      const d = ((x - lon) * k) ** 2 + (y - lat) ** 2;
      if (d < best) { best = d; street = r.properties.name; }
    }
  }
  const what = TYPE_LABEL[f._type] || 'Building';
  return street ? `${what} on ${street}` : what;
}

function rideTo(id) {
  const [lon, lat] = world.centroids?.[id] || world.buildingById[id].geometry.coordinates[0][0];
  const name = placeName(id);
  askFor(`Need a ride to ${name}`, null, {lon, lat, name, building: id});
}

hooks.buildingExtras = (id) => {
  if (!jiran.me || resident(jiran.me)?.home_building === id) return null;
  return {
    body: `<div class="cd-actions"><button class="btn primary" data-act="ride">${icon('car', 16)}Get a ride here</button></div>`,
    actions: {ride: () => rideTo(id)},
  };
};

function shortOffer(offer) {
  const m = /^(RM\s?\d+)\s+off\b/i.exec(offer || '');
  if (m) return `${m[1]} off per credit`;
  return (offer || 'Accepts Jiran Credits').replace(/\s+on .*$/i, '').slice(0, 30);
}

function hubMarker(hub) {
  const cat = CATEGORIES.transit;
  return {
    key: `h:${hub.id}`, kind: 'place',
    lonlat: hub.gateway, z: groundAt(...hub.gateway) + 6,
    cls: `hub mini ${isSelected('hub', hub.id) ? 'sel' : ''}`,
    html: `<div class="pl" style="--c:${cat.color}"><span class="pl-ic">${icon('train', 14)}</span>` +
      `<span class="pl-name">${esc(hub.name)}<em>${hub.road_km} km ${icon('arrowRight', 10)}</em>` +
      `<small>Tap to view the 3D station</small></span></div>`,
    title: `${hub.name} · ${hub.road_km} km away -- click to fly to the 3D station`,
    data: hub.id,
    onClick: (id) => openHub(id, true),
  };
}

function pinHeight(t) { return 16 + Math.min(10, t.credits) * 2.2; }

function syncMarkers() {
  if (!world || !state) return;
  // The spatial demo is its own demo state: only its people and labels are on the map.
  if (spatialActive()) { Markers.sync(spatialMarkers()); return; }
  const specs = [];
  // Residents can be hidden from the Layers menu; you and anyone on a job stay.
  for (const p of peopleOnMap()) {
    if (mapLayers.residents || p.id === jiran.me || p.status === 'moving' || p.status === 'busy') {
      specs.push(personMarker(p));
    }
  }
  specs.push(...landmarkMarkers());
  const d = jiran.draft?.task;
  if (d?.kind === 'ride' && !d.dest_id && d.dest_lon != null) {
    specs.push({key: 'dest', kind: 'place', lonlat: [d.dest_lon, d.dest_lat], z: groundAt(d.dest_lon, d.dest_lat) + 6,
                cls: 'dest', html: `<div class="pl" style="--c:${CATEGORIES.ride.color}"><span class="pl-ic">${icon('flag', 13)}</span>` +
                  `<span class="pl-name">${esc(d.dest_name)}<small>Ride destination</small></span></div>`});
  }
  for (const t of liveTasks()) {
    if (jiran.filter.has(catOf(t))) specs.push(taskMarker(t));
  }
  if (jiran.filter.has('commercial')) for (const t of world.tenants || []) specs.push(tenantMarker(t));
  if (jiran.filter.has('transit')) for (const h of world.hubs || []) if (h.gateway) specs.push(hubMarker(h));
  Markers.sync(specs);
}

/* ------------------------------------------------------------- deck overlays */

const RGB = {
  ride: CATEGORIES.ride.rgb, walk: [46, 196, 166], gold: [242, 193, 78],
  transit: CATEGORIES.transit.rgb,
};

function selectedMoverId() {
  if (inspected?.kind === 'task') return `m:${inspected.id}`;
  if (inspected?.kind === 'resident') {
    const m = (state?.movers || []).find((x) => !x.done && x.resident === inspected.id);
    return m?.id || null;
  }
  return null;
}

function overlayLayers(p, flat) {
  if (!world || !state || spatialActive()) return [];
  const layers = [];
  const now = performance.now();

  // -- stations off the map ------------------------------------------------------
  const hubs = jiran.filter.has('transit') ? (world.hubs || []).filter((h) => h.gateway) : [];
  if (hubs.length && !flat) {
    layers.push(new deck.ArcLayer({
      id: p('hub-arcs'),
      data: hubs,
      getSourcePosition: (h) => [...h.gateway, groundAt(...h.gateway) + 2],
      getTargetPosition: (h) => stationEntrance(h.id) || [h.lon, h.lat, 0],
      getSourceColor: [...RGB.transit, 200],
      getTargetColor: [...RGB.transit, 0],
      getWidth: 2.5,
      getHeight: 0.3,
    }));
  }

  // -- who a request would reach: arcs from neighbours' homes ------------------------
  const rays = matchRays();
  if (rays.length) {
    layers.push(new deck.ArcLayer({
      id: p('match-rays'),
      data: rays,
      getSourcePosition: (r) => [r.from[0], r.from[1], groundAt(...r.from) + 4],
      getTargetPosition: (r) => [r.to[0], r.to[1], groundAt(...r.to) + 4],
      getSourceColor: (r) => [...RGB.walk, Math.round(110 + 140 * r.score)],
      getTargetColor: [...RGB.gold, 230],
      getWidth: (r) => 1.5 + 2.5 * r.score,
      getHeight: 0.35,
      parameters: {depthTest: false},
      updateTriggers: {getSourceColor: [rays.length], getWidth: [rays.length]},
    }));
  }

  // -- the thin stem under each floating task pin ---------------------------------
  const pins = liveTasks().filter((t) => jiran.filter.has(catOf(t)));
  if (!flat && pins.length) {
    layers.push(new LineLayer({
      id: p('task-stems'),
      data: pins,
      getSourcePosition: (t) => [t.lon, t.lat, groundAt(t.lon, t.lat)],
      getTargetPosition: (t) => [t.lon, t.lat, groundAt(t.lon, t.lat) + pinHeight(t)],
      getColor: (t) => [...CATEGORIES[catOf(t)].rgb, 170],
      getWidth: 2,
      updateTriggers: {getColor: [state.t]},
    }));
    layers.push(new ScatterplotLayer({
      id: p('task-feet'),
      data: pins,
      getPosition: (t) => [t.lon, t.lat, groundAt(t.lon, t.lat) + 0.6],
      radiusUnits: 'meters',
      getRadius: 7,
      getFillColor: (t) => [...CATEGORIES[catOf(t)].rgb, 70],
      stroked: false,
      parameters: {depthMask: false},
      updateTriggers: {getFillColor: [state.t]},
    }));
  }

  // -- routes: who is going where --------------------------------------------------
  const sel = selectedMoverId();
  const travelling = (state.movers || []).filter((m) => m.route?.length > 1);
  if (travelling.length) {
    layers.push(new PathLayer({
      id: p('route-glow'),
      data: travelling,
      getPath: (m) => (flat ? m.route : onGround(m.route, 2.2)),
      getColor: (m) => [...(m.mode === 'drive' ? RGB.ride : RGB.walk), m.id === sel ? 90 : 35],
      getWidth: (m) => (m.id === sel ? 16 : 10),
      widthMinPixels: 4,
      capRounded: true, jointRounded: true,
      parameters: {depthTest: false},
      updateTriggers: {getPath: [state.t], getColor: [sel], getWidth: [sel]},
    }));
    layers.push(new PathLayer({
      id: p('routes'),
      data: travelling,
      getPath: (m) => (flat ? m.route : onGround(m.route, 2.5)),
      getColor: (m) => [...(m.mode === 'drive' ? RGB.ride : RGB.walk), m.id === sel ? 255 : (sel ? 110 : 200)],
      getWidth: (m) => (m.id === sel ? 5 : 3.5),
      widthMinPixels: 2,
      capRounded: true, jointRounded: true,
      parameters: {depthTest: false},
      updateTriggers: {getPath: [state.t], getColor: [sel], getWidth: [sel]},
    }));
    // The selected route flows: a bright pulse runs along it towards the destination.
    const chosen = travelling.find((m) => m.id === sel);
    if (chosen && TripsLayer && !flat) {
      const path = onGround(chosen.route, 3);
      const stamps = [0];
      for (let i = 1; i < path.length; i++) stamps.push(stamps[i - 1] + distanceM(path[i - 1], path[i]));
      const total = Math.max(1, stamps[stamps.length - 1]);
      layers.push(new TripsLayer({
        id: p('route-flow'),
        data: [{path, stamps}],
        getPath: (d) => d.path,
        getTimestamps: (d) => d.stamps,
        getColor: [255, 255, 255],
        opacity: 0.9,
        widthMinPixels: 4,
        trailLength: Math.min(160, total * 0.35),
        currentTime: ((now / 1000) * 220) % (total + 160),
        capRounded: true, jointRounded: true,
        parameters: {depthTest: false},
      }));
    }
  }
  if (!flat && TripsLayer) {
    const tracks = (state.movers || [])
      .map((m) => ({id: m.id, mode: m.mode, ...(trails.get(m.id) || {path: [], timestamps: []})}))
      .filter((t) => t.path.length > 1);
    if (tracks.length) {
      layers.push(new TripsLayer({
        id: p('trails'),
        data: tracks,
        getPath: (t) => onGround(t.path, 2),
        getTimestamps: (t) => t.timestamps,
        getColor: (t) => (t.mode === 'drive' ? RGB.ride : RGB.walk),
        opacity: 0.45,
        widthMinPixels: 3,
        trailLength: 70,
        currentTime: state.t,
        capRounded: true, jointRounded: true,
        parameters: {depthTest: false},
      }));
    }
  }

  // -- a soft halo on the ground under whatever is selected ------------------------
  const focus = selectionPoint();
  if (focus) {
    const pulse = (Math.sin(now / 380) + 1) / 2;
    layers.push(new ScatterplotLayer({
      id: p('sel-halo'),
      data: [focus],
      getPosition: (q) => [q[0], q[1], groundAt(q[0], q[1]) + 0.8],
      radiusUnits: 'meters',
      getRadius: 16 + 8 * pulse,
      filled: true, stroked: true,
      getFillColor: [255, 255, 255, 18],
      getLineColor: [255, 255, 255, Math.round(120 + 80 * (1 - pulse))],
      lineWidthUnits: 'pixels', getLineWidth: 1.5,
      parameters: {depthTest: false},
      updateTriggers: {getRadius: [pulse], getLineColor: [pulse]},
    }));
  }
  return layers;
}

function selectionPoint() {
  if (!inspected) return null;
  if (inspected.kind === 'task') { const t = taskById(inspected.id); return t ? [t.lon, t.lat] : null; }
  if (inspected.kind === 'resident') return personState(inspected.id)?.lonlat || null;
  if (inspected.kind === 'tenant') { const t = tenantById(inspected.id); return t ? [t.lon, t.lat] : null; }
  if (inspected.kind === 'hub') return stationEntrance(inspected.id)?.slice(0, 2) || hubById(inspected.id)?.gateway || null;
  return null;
}

/* Arcs for whichever matching question is on screen: the draft being written, or the
 * open task being inspected. Each runs from a candidate's home to the task. */
function matchRays() {
  if (jiran.draft) {
    const home = myHome();
    if (!home) return [];
    const cands = jiran.draft.subtasks?.length
      ? jiran.draft.subtasks.flatMap((s) => s.candidates)
      : jiran.draft.candidates;
    return (cands || []).slice(0, 6).map((c) => ({from: [c.lon, c.lat], to: [home.lon, home.lat],
                                                  score: Math.min(1, c.score)}));
  }
  if (inspected?.kind === 'task') {
    const d = jiran.taskDetail.get(inspected.id);
    const t = taskById(inspected.id);
    if (d?.candidates && t?.status === 'open') {
      return d.candidates.slice(0, 5).map((c) => ({from: [c.lon, c.lat], to: [t.lon, t.lat],
                                                   score: Math.min(1, c.score)}));
    }
  }
  return [];
}

hooks.layers.push(overlayLayers);
// Keep frames coming while a selection's halo pulses and its route flows.
hooks.animating = () => !!inspected && inspected.kind !== 'building';

const tenantByBuilding = () => Object.fromEntries((world?.tenants || []).map((t) => [t.building, t]));
hooks.buildingTint = (f) => {
  const tenant = tenantByBuilding()[f.id];
  if (tenant && jiran.filter.has('commercial')) {
    return isSelected('tenant', tenant.id) ? [232, 120, 146] : [150, 86, 108];
  }
  const home = myHome();
  if (home && home.home_building === f.id) return [46, 196, 166];
  return null;
};
hooks.tintKey = () => `${jiran.me}|${jiran.filter.has('commercial')}|${inspected?.kind === 'tenant' ? inspected.id : ''}`;

/* ------------------------------------------------------- tooltips and clicks */

hooks.tooltip.push(({object, layer}) => {
  if (layer.id.endsWith('-buildings')) {
    const tenant = tenantByBuilding()[object.id];
    if (tenant) {
      return {html: `<div class="tt-name">${esc(tenant.name)}</div><div class="tt-row">${esc(tenant.offer)}</div>`};
    }
    const living = jiran.residents.filter((r) => r.home_building === object.id);
    if (living.length) {
      return {html: `<div class="tt-name">${living.map((r) => esc(r.name.split(' ')[0])).join(', ')}</div>` +
        `<div class="tt-row">${living.some((r) => r.id === jiran.me) ? 'Your home' : 'Neighbour’s home'}</div>`};
    }
  }
  return null;
});

hooks.click.push((info) => {
  if (info.layer.id.endsWith('-buildings')) {
    const tenant = tenantByBuilding()[info.object.id];
    if (tenant) { openTenant(tenant.id); return true; }
    const living = jiran.residents.find((r) => r.home_building === info.object.id);
    if (living) { openResident(living.id); return true; }
  }
  return false;
});

/* ---------------------------------------------------------------- selection */

function openTask(id, fly = false) {
  const t = taskById(id);
  if (!t) return;
  inspect('task', id, [t.lon, t.lat, groundAt(t.lon, t.lat) + pinHeight(t)]);
  loadTaskDetail(id);
  if (fly) focusOn([[t.lon, t.lat]], {maxZoom: 17});
  afterSelect();
}

function openResident(id, fly = false) {
  const s = personState(id);
  if (!s) return;
  inspect('resident', id, [...s.lonlat, groundAt(...s.lonlat) + 3]);
  if (fly) focusOn([s.lonlat], {maxZoom: 17});
  afterSelect();
}

function openTenant(id, fly = false) {
  const tenant = tenantById(id);
  if (!tenant) return;
  const b = world.buildingById[tenant.building];
  inspect('tenant', id, [tenant.lon, tenant.lat, (b?.properties.ground_elev || 0) + (b?.properties.height || 8)]);
  if (fly) focusOn([[tenant.lon, tenant.lat]], {maxZoom: 17.2});
  afterSelect();
}

function openHub(id, fly = false) {
  const hub = hubById(id);
  if (!hub?.gateway) return;
  // The card points at the station itself when it is built; otherwise at the gateway.
  const at = stationEntrance(id);
  inspect('hub', id, at ? [at[0], at[1], at[2] + 24] : [...hub.gateway, groundAt(...hub.gateway) + 6]);
  if (fly) { if (at) viewStation(id); else focusOn([hub.gateway], {maxZoom: 16.4}); }
  afterSelect();
}

function afterSelect() {
  syncMarkers();
  redraw();
  ensureAnimation();
}

async function loadTaskDetail(id) {
  try {
    const d = await api(`/api/tasks/${id}`);
    jiran.taskDetail.set(id, d);
    renderInspector(true);
    redraw();
  } catch (err) { /* the task may have gone; the card says so */ }
}

/* With the right panel open, the card docks over it -- the column a resident already looks
 * at for details -- instead of covering the map. The leader line still points at the object. */
hooks.dock = () => {
  const panel = $('right');
  if (!panel || panel.classList.contains('closed') || !inspected || inspected.kind === 'building') return null;
  const r = panel.getBoundingClientRect();
  return {x: r.left, y: r.top};
};

hooks.inspector = (ins) => {
  if (ins.kind === 'task') return taskCard(ins.id);
  if (ins.kind === 'resident') return residentCard(ins.id);
  if (ins.kind === 'tenant') return tenantCard(ins.id);
  if (ins.kind === 'hub') return hubCard(ins.id);
  return null;   // a plain building: the map core's own panel
};

/* -------------------------------------------------------------- data refresh */

async function refreshMe() {
  if (!jiran.me) return;
  try {
    jiran.meData = await api(`/api/me?resident=${encodeURIComponent(jiran.me)}`);
    renderHeaderMe();
    renderWallet();
    renderLeft();
  } catch (err) { /* transient */ }
}

async function refreshResidents() {
  jiran.residents = await api('/api/residents');
  jiran.byId = Object.fromEntries(jiran.residents.map((r) => [r.id, r]));
  if (!jiran.byId[jiran.me]) jiran.me = jiran.residents[0]?.id || null;
}

async function signIn(id) {
  jiran.me = id;
  storageSet('jiransync.me', id);
  jiran.draft = null;
  closeInspector();
  await refreshMe();
  renderAsk();
  syncMarkers();
  redraw();
  const home = myHome();
  if (home && deckgl) frameNeighbourhood();
}

/* Frame points in the part of the map the panels leave visible, not the whole window:
 * the camera centre is shifted so the points sit in the middle of the open map area. */
function focusOn(points, {maxZoom = 17.2, minZoom = 14.6, bearing = -24, pitch = 56, duration = 1500} = {}) {
  if (!points.length || !deckgl) return;
  const W = window.innerWidth, H = window.innerHeight;
  const left = $('left')?.getBoundingClientRect().right || 0;
  const rightEl = $('right');
  const right = rightEl && !rightEl.classList.contains('closed') ? W - rightEl.getBoundingClientRect().left : 0;
  const lons = points.map((q) => q[0]), lats = points.map((q) => q[1]);
  const centre = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const extent = Math.max(90, ...points.map((q) => distanceM(centre, q)));
  const px = Math.min(W - left - right, H - 180) * 0.42;
  const cosLat = Math.cos(centre[1] * Math.PI / 180);
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.log2(78271.517 * cosLat * px / extent)));
  // Move the camera left (in screen terms) by half the difference in panel cover.
  const shiftPx = (left - right) / 2;
  const mpp = 156543.03 * cosLat / Math.pow(2, zoom);
  const b = bearing * Math.PI / 180;
  const shiftM = shiftPx * mpp;
  const east = -Math.cos(b) * shiftM, north = Math.sin(b) * shiftM;
  const M = 6371000.0 * Math.PI / 180.0;
  setCamera({longitude: centre[0] + east / (M * cosLat), latitude: centre[1] + north / M,
             zoom, pitch, bearing}, duration);
}

/* A first view of the neighbourhood around you: people, requests, a shop. */
function frameNeighbourhood() {
  const home = myHome();
  if (!home) return;
  const pts = [[home.lon, home.lat]];
  for (const t of liveTasks()) {
    if (distanceM([home.lon, home.lat], [t.lon, t.lat]) < 380) pts.push([t.lon, t.lat]);
  }
  // Wide enough to read as a township: your street, the requests around it, and the two
  // nearest real landmarks -- a park, the lake, a school -- with the roads between.
  const near = (township.landmarks || [])
    .map((m) => ({m, d: distanceM([home.lon, home.lat], m.lonlat)}))
    .filter((q) => q.d < 900).sort((a, b) => a.d - b.d).slice(0, 2);
  for (const {m} of near) pts.push(m.lonlat);
  focusOn(pts, {maxZoom: 16.6, minZoom: 15.4, pitch: 58, duration: 1800});
}

function setDev(on) {
  jiran.dev = on;
  document.body.classList.toggle('dev', on);
  storageSet('jiransync.dev', on ? '1' : '0');
  renderInspector(true);
  renderLeft(true);
}

/* ----------------------------------------------------------------- wiring */

hooks.ready.push(async () => {
  jiran.me = storageGet('jiransync.me') || 'R001';
  const asked = new URLSearchParams(location.search).get('dev');
  setDev(asked === '1' || (asked !== '0' && storageGet('jiransync.dev') === '1'));
  Markers.init($('markers'));
  renderShell();
  // While a card is open and docked, the right column steps back behind it.
  const card = $('inspector');
  new MutationObserver(() => {
    document.body.classList.toggle('card-open', !card.hidden && card.classList.contains('card'));
  }).observe(card, {attributes: true, attributeFilter: ['hidden', 'class']});
  renderAsk();
  try {
    jiran.agent = await api('/api/agent');
    renderDevBar();
  } catch (err) { /* optional */ }
  await refreshResidents();
  await refreshMe();
  renderAsk();
});

/* Tell the requester when a neighbour picks their request up -- by hand, or by the demo's
 * auto-accept. Remembered per task, so each change is announced once. */
const seenStatus = new Map();
function announceMatches(s) {
  for (const t of s.tasks || []) {
    const before = seenStatus.get(t.id);
    seenStatus.set(t.id, t.status);
    if (before !== 'open' || t.requester !== jiran.me || !t.provider) continue;
    if (t.status === 'reserved') toast(`${firstName(t.provider)} confirmed your booking for ${whenOf(t)}`);
    else if (t.status === 'in_progress') toast(`${firstName(t.provider)} accepted “${t.title}” and is on the way`);
  }
}

hooks.snapshot.push((s) => {
  renderClock();
  announceMatches(s);
  recordTrails(s.movers, s.t);
  const fresh = renderActivity();
  syncMarkers();
  renderDevBar();
  if (!jiran.framed && jiran.residents.length) {
    jiran.framed = true;
    setTimeout(frameNeighbourhood, 400);
  }
  // Keep a moving neighbour's card pinned to them.
  if (inspected?.kind === 'resident') {
    const p = personState(inspected.id);
    if (p) inspected.anchor = [...p.lonlat, groundAt(...p.lonlat) + 3];
  }
  if (fresh) {
    refreshMe();
    if (inspected?.kind === 'task') loadTaskDetail(inspected.id);
    // Balances and helping records change as jobs close, not only when people join.
    refreshResidents();
  } else {
    renderLeftLive();
  }
});
