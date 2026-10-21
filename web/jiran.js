/* JiranSync app: the social grid on top of the township map.
 *
 * Plugs into web/app.js through `hooks`; the map core knows nothing about tasks or credits.
 * The server owns all state. This file keeps the client's view of it (who is signed in,
 * what is selected, which categories are shown), decides who appears on the map and in
 * what state, and wires the panels and cards in web/components/ to the HTTP API.
 *
 * Two ways in, from the account menu:
 *
 *   resident   your home, requests around you (placed on the street, not at a door),
 *              SDP events, shops and stations. Other neighbours are not on the map; the
 *              one helping you appears, face and route, only while the job runs.
 *   SDP admin  the operations view: every resident by name, every request and who took
 *              it, what each shop has collected, and the SDP events console.
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
  admin: false,           // SDP admin view rather than a resident's
  tenantStats: {},        // admin: tenant id -> {held_credits}
  eventSpot: null,        // admin: where a new event meets, {lon, lat, name}
  picking: false,         // admin: the next map click picks eventSpot
  profileFrom: null,      // the request whose offers a profile was opened from
};

const ADMIN_ID = 'sdp-admin';

const START_HOUR = 7.5;     // mirrors jiransync.grid.START_HOUR

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
const nameOf = (id) => resident(id)?.name || id;
const firstName = (id) => nameOf(id).split(' ')[0];
// The admin has no home on the map; everything measured "from you" is a resident's view.
const myHome = () => (jiran.admin ? null : resident(jiran.me));
const credits = (n) => `${n} Credit${Math.abs(n) === 1 ? '' : 's'}`;
const hubById = (id) => (world?.hubs || []).find((h) => h.id === id) || null;
const tenantById = (id) => (world?.tenants || []).find((t) => t.id === id) || null;
const communityEvents = () => state?.community || [];
const eventById = (id) => communityEvents().find((e) => e.id === id) || null;
const myEventSignup = (e) => (e?.signups || []).find((s) => s.resident === jiran.me) || null;

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
  if (skills.has('cleaning') || skills.has('gardening')) return 'community';
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

/** A resident sees open requests (not ones addressed to someone else) and their own jobs;
 *  who is helping whom elsewhere in the township is SDP's to see, not the neighbours'. */
function visibleTask(t) {
  if (jiran.admin) return true;
  if (t.requester === jiran.me || t.provider === jiran.me || t.invitee === jiran.me) return true;
  return t.status === 'open' && !t.invitee;
}

const pingedMe = (t) => t.status === 'open' && (t.pinged || []).includes(jiran.me);

/* Someone else's request is pinned to the street outside, not their front door: the
 * nearest point on a named road, worked out once per request. */
const streetPoints = new Map();
function streetPoint(t) {
  if (streetPoints.has(t.id)) return streetPoints.get(t.id);
  let best = [t.lon, t.lat], bestD = Infinity;
  const k = Math.cos(t.lat * Math.PI / 180);
  for (const r of world?.roads?.features || []) {
    for (const [x, y] of r.geometry.coordinates) {
      const d = ((x - t.lon) * k) ** 2 + (y - t.lat) ** 2;
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  // Only snap when the road is close; a pin a block away would point at the wrong house.
  if (distanceM([t.lon, t.lat], best) > 70) best = [t.lon, t.lat];
  streetPoints.set(t.id, best);
  return best;
}

/** Where a request's pin stands: exact for your own and for SDP, the street for others. */
function taskPoint(t) {
  if (jiran.admin || t.requester === jiran.me || t.provider === jiran.me) return [t.lon, t.lat];
  return streetPoint(t);
}
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
  const mover = movers.find((m) => (!m.done || m.leg === 'event') && (m.resident === id
    || (m.passenger === id && m.leg === 'ride')));
  if (mover) {
    const riding = mover.resident !== id;
    const task = mover.task_id ? taskById(mover.task_id) : null;
    let doing;
    if (riding) doing = `Riding with ${firstName(mover.resident)} to ${task?.dest_name || 'the station'}`;
    else if (mover.leg === 'pickup') doing = `Picking up ${firstName(mover.passenger)}`;
    else if (mover.leg === 'ride') doing = `Driving ${firstName(mover.passenger)} to ${task?.dest_name || 'the station'}`;
    else if (mover.leg === 'go') doing = `On the way to help ${firstName(task?.requester)}`;
    else if (mover.leg === 'event') {
      const ev = eventById(mover.event_id);
      doing = mover.done ? `Volunteering at ${ev?.title || 'an SDP event'}` : `Walking to ${ev?.title || 'an SDP event'}`;
      return {status: mover.done ? 'busy' : 'moving', lonlat: [mover.lon, mover.lat], mover, doing,
              mode: 'walk', event: ev};
    }
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

/** The neighbours a resident may see by face: whoever is helping them, or whom they are
 *  helping, while that job is under way. */
function myCounterparts() {
  const out = new Set();
  for (const t of liveTasks()) {
    if (!['in_progress', 'arrived'].includes(t.status)) continue;
    if (t.requester === jiran.me && t.provider) out.add(t.provider);
    if (t.provider === jiran.me && t.kind === 'ride') out.add(t.requester);
  }
  return out;
}

/** Who appears on the map. The admin sees everyone; a resident sees themself and the
 *  neighbour on their job, and nobody else. */
function peopleOnMap() {
  if (!state || !jiran.residents.length) return [];
  const out = new Map();
  const add = (id) => {
    if (out.has(id) || !resident(id)) return;
    const s = personState(id);
    if (s && !s.riding) out.set(id, s);
  };
  if (jiran.admin) {
    for (const r of jiran.residents) add(r.id);
    return [...out.entries()].map(([id, s]) => ({id, ...s}));
  }
  add(jiran.me);
  for (const id of myCounterparts()) add(id);
  return [...out.entries()].map(([id, s]) => ({id, ...s}));
}

/* ------------------------------------------------------------------ markers */

function isSelected(kind, id) { return inspected?.kind === kind && inspected?.id === id; }

function personMarker(p) {
  const r = resident(p.id);
  const you = p.id === jiran.me && !jiran.admin;
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
  const forMe = !jiran.admin && pingedMe(t);
  const [lon, lat] = taskPoint(t);
  return {
    key: `t:${t.id}`, kind: 'task',
    lonlat: [lon, lat], z: groundAt(lon, lat) + pinHeight(t),
    cls: `${matched ? 'matched' : ''} ${t.urgency >= 3 && !matched ? 'urgent' : ''} ${forMe ? 'for-you' : ''} ${isSelected('task', t.id) ? 'sel' : ''}`,
    html: `<div class="pt" style="--c:${cat.color}">
        <span class="pt-head">${icon(cat.icon, 17)}</span>
        <span class="pt-cr">${t.credits}</span>
        <span class="pt-who">${avatarSvg(t.requester)}</span>
        ${matched ? `<i class="pt-ok">${icon('check', 9)}</i>` : ''}
        ${forMe ? `<span class="pt-for">${icon('star', 10)}Good match for you</span>` : ''}
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
  const st = jiran.tenantStats[tenant.id];
  // A resident sees what the shop offers; SDP sees what it has collected.
  const sub = jiran.admin
    ? (st ? `<b class="gold">${st.held_credits} cr collected</b> · RM${st.held_credits * 2} to cash out` : 'Credits collected: …')
    : esc(shortOffer(tenant.offer)) +
      `${distFromMe(tenant.lon, tenant.lat) != null ? ` · ${fmtDist(distFromMe(tenant.lon, tenant.lat))}` : ''}`;
  return {
    key: `s:${tenant.id}`, kind: 'place',
    lonlat: [tenant.lon, tenant.lat],
    z: (b?.properties.ground_elev || 0) + (b?.properties.height || 8) + 2,
    cls: isSelected('tenant', tenant.id) ? 'sel' : '',
    // A local business, not a pin: what it offers for Jiran Credits and how far it is.
    html: `<div class="pl shop" style="--c:${cat.color}"><span class="pl-ic">${icon('store', 14)}</span>` +
      `<span class="pl-name">${esc(tenant.name)}<small>${sub}</small></span></div>`,
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
  if (jiran.admin) {
    return {
      body: `<div class="cd-actions"><button class="btn primary" data-act="host">${icon('flag', 16)}Host an SDP event here</button></div>`,
      actions: {host: () => {
        const [lon, lat] = world.centroids?.[id] || world.buildingById[id].geometry.coordinates[0][0];
        setEventSpot({lon, lat, name: placeName(id)});
      }},
    };
  }
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

/** An SDP event: a badge with when it is and how many have joined. */
function eventMarker(e) {
  const cat = CATEGORIES.community;
  const mine = myEventSignup(e);
  const live = e.status === 'live';
  return {
    key: `e:${e.id}`, kind: 'task',
    lonlat: [e.lon, e.lat], z: groundAt(e.lon, e.lat) + 22,
    cls: `event ${live ? 'live' : ''} ${mine && !jiran.admin ? 'going' : ''} ${isSelected('event', e.id) ? 'sel' : ''}`,
    html: `<div class="pe" style="--c:${cat.color}">
        <span class="pe-head">${icon('flag', 17)}</span>
        <span class="pe-cr">${e.credits}</span>
        <span class="pe-tag">${e.start_at == null ? 'Any time' : live ? 'Happening now' : esc(e.when)} · ${e.joined}/${e.slots}</span>
        ${mine && !jiran.admin ? `<i class="pt-ok">${icon('check', 9)}</i>` : ''}
        <span class="pt-label">SDP · ${esc(e.title)}</span>
      </div>`,
    title: `${e.title} · ${e.when} · ${credits(e.credits)} per volunteer`,
    data: e.id,
    onClick: (id) => openEvent(id),
  };
}

function syncMarkers() {
  if (!world || !state) return;
  // The spatial demo is its own demo state: only its people and labels are on the map.
  if (spatialActive()) { Markers.sync(spatialMarkers()); return; }
  const specs = [];
  // Residents can be hidden (Layers menu, or SDP's Residents chip). A resident still sees
  // themself and whoever is on their job; SDP hiding residents hides every face.
  for (const p of peopleOnMap()) {
    if (mapLayers.residents || (!jiran.admin && (p.id === jiran.me || p.status === 'moving' || p.status === 'busy'))) {
      specs.push(personMarker(p));
    }
  }
  if (jiran.admin && jiran.eventSpot) {
    const q = jiran.eventSpot;
    specs.push({key: 'spot', kind: 'place', lonlat: [q.lon, q.lat], z: groundAt(q.lon, q.lat) + 6, cls: 'dest',
                html: `<div class="pl" style="--c:${CATEGORIES.community.color}"><span class="pl-ic">${icon('flag', 13)}</span>` +
                  `<span class="pl-name">${esc(q.name)}<small>New event meets here</small></span></div>`});
  }
  specs.push(...landmarkMarkers());
  const d = jiran.draft?.task;
  if (d?.kind === 'ride' && !d.dest_id && d.dest_lon != null) {
    specs.push({key: 'dest', kind: 'place', lonlat: [d.dest_lon, d.dest_lat], z: groundAt(d.dest_lon, d.dest_lat) + 6,
                cls: 'dest', html: `<div class="pl" style="--c:${CATEGORIES.ride.color}"><span class="pl-ic">${icon('flag', 13)}</span>` +
                  `<span class="pl-name">${esc(d.dest_name)}<small>Ride destination</small></span></div>`});
  }
  for (const t of liveTasks()) {
    if (jiran.filter.has(catOf(t)) && visibleTask(t)) specs.push(taskMarker(t));
  }
  if (jiran.filter.has('community')) {
    for (const e of communityEvents()) if (['upcoming', 'live'].includes(e.status)) specs.push(eventMarker(e));
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

  // -- SDP: who took which request, an arc from the helper to the job ----------------
  if (jiran.admin && !flat) {
    const links = liveTasks().filter((t) => t.provider && ['reserved', 'in_progress', 'arrived'].includes(t.status))
      .map((t) => ({from: personState(t.provider)?.lonlat || [t.lon, t.lat], to: [t.lon, t.lat],
                    rgb: CATEGORIES[catOf(t)].rgb}))
      .filter((l) => distanceM(l.from, l.to) > 15);
    if (links.length) {
      layers.push(new deck.ArcLayer({
        id: p('admin-links'),
        data: links,
        getSourcePosition: (l) => [l.from[0], l.from[1], groundAt(...l.from) + 4],
        getTargetPosition: (l) => [l.to[0], l.to[1], groundAt(...l.to) + 4],
        getSourceColor: (l) => [...l.rgb, 240],
        getTargetColor: [...RGB.gold, 240],
        getWidth: 3,
        getHeight: 0.4,
        parameters: {depthTest: false},
        updateTriggers: {getSourcePosition: [state.t]},
      }));
    }
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
  const pins = liveTasks().filter((t) => jiran.filter.has(catOf(t)) && visibleTask(t))
    .map((t) => ({...t, at: taskPoint(t)}));
  if (!flat && pins.length) {
    layers.push(new LineLayer({
      id: p('task-stems'),
      data: pins,
      getSourcePosition: (t) => [t.at[0], t.at[1], groundAt(...t.at)],
      getTargetPosition: (t) => [t.at[0], t.at[1], groundAt(...t.at) + pinHeight(t)],
      getColor: (t) => [...CATEGORIES[catOf(t)].rgb, 170],
      getWidth: 2,
      updateTriggers: {getColor: [state.t], getSourcePosition: [jiran.admin], getTargetPosition: [jiran.admin]},
    }));
    layers.push(new ScatterplotLayer({
      id: p('task-feet'),
      data: pins,
      getPosition: (t) => [t.at[0], t.at[1], groundAt(...t.at) + 0.6],
      radiusUnits: 'meters',
      getRadius: 7,
      getFillColor: (t) => [...CATEGORIES[catOf(t)].rgb, 70],
      stroked: false,
      parameters: {depthMask: false},
      updateTriggers: {getFillColor: [state.t], getPosition: [jiran.admin]},
    }));
  }

  // -- event stems: SDP events stand a little taller than requests -------------------
  const evs = jiran.filter.has('community') ? communityEvents().filter((e) => ['upcoming', 'live'].includes(e.status)) : [];
  if (!flat && evs.length) {
    layers.push(new LineLayer({
      id: p('event-stems'),
      data: evs,
      getSourcePosition: (e) => [e.lon, e.lat, groundAt(e.lon, e.lat)],
      getTargetPosition: (e) => [e.lon, e.lat, groundAt(e.lon, e.lat) + 22],
      getColor: [...CATEGORIES.community.rgb, 190],
      getWidth: 2,
    }));
    layers.push(new ScatterplotLayer({
      id: p('event-feet'),
      data: evs,
      getPosition: (e) => [e.lon, e.lat, groundAt(e.lon, e.lat) + 0.6],
      radiusUnits: 'meters',
      getRadius: (e) => (e.status === 'live' ? 26 : 14),
      getFillColor: [...CATEGORIES.community.rgb, 60],
      stroked: true, lineWidthUnits: 'pixels', getLineWidth: 1.5,
      getLineColor: [...CATEGORIES.community.rgb, 160],
      parameters: {depthMask: false},
      updateTriggers: {getRadius: [state.t]},
    }));
  }

  // -- routes: who is going where --------------------------------------------------
  // SDP watches every trip; a resident sees only their own, and the one coming to them.
  const sel = selectedMoverId();
  const related = (m) => jiran.admin || m.resident === jiran.me || m.passenger === jiran.me
    || (m.task_id && taskById(m.task_id)?.requester === jiran.me);
  const travelling = (state.movers || []).filter((m) => m.route?.length > 1 && related(m));
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
    const tracks = (state.movers || []).filter(related)
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
  if (inspected.kind === 'task') { const t = taskById(inspected.id); return t ? taskPoint(t) : null; }
  if (inspected.kind === 'event') { const e = eventById(inspected.id); return e ? [e.lon, e.lat] : null; }
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
    // Who a request reaches is the requester's and SDP's to see, not every neighbour's.
    if (d?.candidates && t?.status === 'open' && (jiran.admin || t.requester === jiran.me)) {
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
    const living = jiran.residents.filter((r) => r.home_building === object.id
      && (jiran.admin || r.id === jiran.me));
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
    const living = jiran.residents.find((r) => r.home_building === info.object.id
      && (jiran.admin || r.id === jiran.me));
    if (living) { openResident(living.id); return true; }
  }
  return false;
});

/* ---------------------------------------------------------------- selection */

function openTask(id, fly = false) {
  jiran.profileFrom = null;
  const t = taskById(id);
  if (!t) return;
  const [lon, lat] = taskPoint(t);
  inspect('task', id, [lon, lat, groundAt(lon, lat) + pinHeight(t)]);
  loadTaskDetail(id);
  if (fly) focusOn([[lon, lat]], {maxZoom: 17});
  afterSelect();
}

function openEvent(id, fly = false) {
  jiran.profileFrom = null;
  const e = eventById(id);
  if (!e) return;
  inspect('event', id, [e.lon, e.lat, groundAt(e.lon, e.lat) + 22]);
  if (fly) focusOn([[e.lon, e.lat]], {maxZoom: 16.8});
  afterSelect();
}

/* SDP: where a new event meets. Picked from a building's card, a landmark, or the map. */
function setEventSpot(spot) {
  jiran.eventSpot = spot;
  jiran.picking = false;
  hooks.pickPoint = null;
  document.body.classList.remove('picking');
  closeInspector();
  jiran.view = 'events';
  renderLeft(true);
  syncMarkers();
  if (spot) focusOn([[spot.lon, spot.lat]], {maxZoom: 16.8});
}

function pickEventSpot() {
  jiran.picking = true;
  document.body.classList.add('picking');
  toast('Click the map where volunteers should meet');
  hooks.pickPoint = ([lon, lat]) => {
    const name = township.landmarks
      .map((m) => ({m, d: distanceM([lon, lat], m.lonlat)})).sort((a, b) => a.d - b.d)
      .find((q) => q.d < 160)?.m.name;
    setEventSpot({lon, lat, name: name ? `Near ${name}` : 'Picked on the map'});
    return true;
  };
}

function openResident(id, fly = false) {
  const s = personState(id);
  if (!s) return;
  inspect('resident', id, [...s.lonlat, groundAt(...s.lonlat) + 3]);
  if (fly) focusOn([s.lonlat], {maxZoom: 17});
  afterSelect();
}

function openTenant(id, fly = false) {
  jiran.profileFrom = null;
  const tenant = tenantById(id);
  if (!tenant) return;
  const b = world.buildingById[tenant.building];
  inspect('tenant', id, [tenant.lon, tenant.lat, (b?.properties.ground_elev || 0) + (b?.properties.height || 8)]);
  if (fly) focusOn([[tenant.lon, tenant.lat]], {maxZoom: 17.2});
  afterSelect();
}

function openHub(id, fly = false) {
  jiran.profileFrom = null;
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
  if (ins.kind === 'event') return eventCard(ins.id);
  return null;   // a plain building: the map core's own panel
};

/* -------------------------------------------------------------- data refresh */

async function refreshMe() {
  if (jiran.admin) { renderHeaderMe(); renderLeft(); refreshTenantStats(); return; }
  if (!jiran.me) return;
  try {
    jiran.meData = await api(`/api/me?resident=${encodeURIComponent(jiran.me)}`);
    renderHeaderMe();
    renderWallet();
    renderLeft();
  } catch (err) { /* transient */ }
}

/** SDP: what each shop has collected, for the map labels and the Merchants list. */
async function refreshTenantStats() {
  if (!jiran.admin) return;
  try {
    const list = await api('/api/tenants');
    jiran.tenantStats = Object.fromEntries(list.map((t) => [t.id, t]));
    syncMarkers();
    if (jiran.view === 'merchants') renderLeft(true);
  } catch (err) { /* transient */ }
}

async function refreshResidents() {
  jiran.residents = await api('/api/residents');
  jiran.byId = Object.fromEntries(jiran.residents.map((r) => [r.id, r]));
  if (!jiran.byId[jiran.me]) jiran.me = jiran.residents[0]?.id || null;
}

async function signIn(id) {
  const admin = id === ADMIN_ID;
  const switched = admin !== jiran.admin;
  jiran.admin = admin;
  if (!admin) {
    jiran.me = id;
    storageSet('jiransync.me', id);
  }
  storageSet('jiransync.admin', admin ? '1' : '0');
  document.body.classList.toggle('admin', admin);
  jiran.draft = null;
  jiran.eventSpot = null;
  if (switched) {
    jiran.view = admin ? 'live' : 'home';
    renderShell();
  }
  if (admin) setRight(false);
  else if (switched) setRight(window.innerWidth >= 1440);
  closeInspector();
  await refreshMe();
  renderAsk();
  renderLeft(true);
  syncMarkers();
  redraw();
  if (admin) { if (deckgl) resetCamera(); return; }
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
  const params = new URLSearchParams(location.search);
  jiran.admin = params.get('admin') === '1' || (params.get('admin') !== '0' && storageGet('jiransync.admin') === '1');
  document.body.classList.toggle('admin', jiran.admin);
  if (jiran.admin) jiran.view = 'live';
  const asked = params.get('dev');
  // Developer mode belongs to the SDP side; a resident never sees it.
  setDev(jiran.admin && (asked === '1' || (asked !== '0' && storageGet('jiransync.dev') === '1')));
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
  if (jiran.admin) setRight(false);
});

/* Tell the requester when a neighbour picks their request up -- by hand, or by the demo's
 * auto-accept. Remembered per task, so each change is announced once. */
const seenStatus = new Map();
const seenOffers = new Map();
function announceMatches(s) {
  if (jiran.admin) return;
  for (const t of s.tasks || []) {
    // A new offer on your request, or the requester choosing you.
    const offers = (t.offers || []).filter((o) => o.status === 'offered').map((o) => o.resident);
    const had = seenOffers.get(t.id);
    seenOffers.set(t.id, offers);
    if (had && t.requester === jiran.me) {
      const fresh = offers.filter((r) => !had.includes(r));
      if (fresh.length) toast(`${firstName(fresh[0])} offered to help with “${t.title}” — tap to choose`);
    }
    const before = seenStatus.get(t.id);
    seenStatus.set(t.id, t.status);
    if (before === 'open' && t.provider === jiran.me && t.requester !== jiran.me && t.offers_mode) {
      toast(`${firstName(t.requester)} chose you for “${t.title}”${t.status === 'reserved' ? ` · ${whenOf(t)}` : ''}`);
      continue;
    }
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
    if (!jiran.admin) setTimeout(frameNeighbourhood, 400);
  }
  // Keep a moving neighbour's card pinned to them.
  if (inspected?.kind === 'resident') {
    const p = personState(inspected.id);
    if (p) inspected.anchor = [...p.lonlat, groundAt(...p.lonlat) + 3];
  }
  if (fresh) {
    refreshMe();
    if (inspected?.kind === 'event') renderInspector(true);
    if (inspected?.kind === 'task') loadTaskDetail(inspected.id);
    // Balances and helping records change as jobs close, not only when people join.
    refreshResidents();
  } else {
    renderLeftLive();
  }
});
