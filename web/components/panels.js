/* Panels: everything around the map.
 *
 *   header      logo, search, place, notifications, you + your credits
 *   rail        the app's sections: a resident's, or SDP admin's
 *   left panel  resident: Ask JiranSync + nearby requests / your tasks / community
 *               admin:    live requests / merchants / SDP events / the economy
 *   right panel your Jiran Credits, rewards near you, your recent activity (residents)
 *   map chrome  category filter, legend, map tools, developer bar (admin only)
 *
 * Lists re-render only when their content signature changes, so a button is never
 * replaced under the pointer by the 4 Hz snapshot.
 */

const sigs = {};
function setHtml(el, html, key) {
  if (!el) return false;
  if (sigs[key || el.id] === html) return false;
  sigs[key || el.id] = html;
  el.innerHTML = html;
  return true;
}

/* -------------------------------------------------------------------- shell */

const RAIL = [
  {id: 'home', icon: 'home', label: 'Home'},
  {id: 'create', icon: 'plus', label: 'Ask'},
  {id: 'mine', icon: 'list', label: 'My tasks'},
  {id: 'community', icon: 'flag', label: 'Community'},
  {id: 'credits', icon: 'coin', label: 'Credits'},
];

const ADMIN_RAIL = [
  {id: 'live', icon: 'sparkle', label: 'Live'},
  {id: 'merchants', icon: 'store', label: 'Merchants'},
  {id: 'events', icon: 'flag', label: 'Events'},
  {id: 'economy', icon: 'coin', label: 'Economy'},
  {id: 'spatial', icon: 'layers', label: '3D Demo'},
];

const ASK_CHIPS = [
  {cat: 'ride', label: 'Ride', text: 'Need a ride to the MRT tomorrow 8am'},
  {cat: 'help', label: 'Help', text: 'Need someone to fix my leaking tap and help carry a new cabinet upstairs tonight'},
  {cat: 'tutoring', label: 'Learn', text: 'Can someone tutor my son in SPM maths on Saturday 10am?'},
  {cat: 'community', label: 'Babysit', text: 'Look after my baby for an hour tomorrow evening'},
];

function renderShell() {
  // Rail
  $('rail').innerHTML = (jiran.admin ? ADMIN_RAIL : RAIL).map((r) =>
    `<button class="rail-btn" data-rail="${r.id}" title="${r.label}">${icon(r.icon, 20)}<span>${r.label}</span></button>`).join('') +
    `<span class="rail-fill"></span>` +
    (jiran.admin ? `<button class="rail-btn" data-rail="dev" title="Developer mode">${icon('settings', 18)}<span>Dev</span></button>` : '');
  for (const b of $('rail').querySelectorAll('[data-rail]')) b.onclick = () => railGo(b.dataset.rail);

  // Category filter
  renderCats();

  // Legend: SDP reads people by status; a resident sees neighbours only as dots.
  $('legend').innerHTML =
    Object.values(CATEGORIES).map((c) =>
      `<span class="lg" style="--c:${c.color}"><i>${icon(c.icon, 13)}</i>${c.short}</span>`).join('') +
    `<span class="lg-sep"></span>` +
    (jiran.admin
      ? Object.values(STATUSES).map((s) =>
        `<span class="lg lg-dot" style="--c:${s.color}"><b></b>${s.label}</span>`).join('')
      : `<span class="lg" style="--c:${CATEGORIES.community.color}"><i>${icon('flag', 13)}</i>SDP event</span>`);

  // Map tools
  $('btn-view-reset').innerHTML = icon('compass', 18);
  $('btn-locate').innerHTML = icon('locate', 18);
  $('btn-zoom-in').innerHTML = icon('plus', 18);
  $('btn-zoom-out').innerHTML = icon('minus', 18);
  $('btn-locate').onclick = () => { if (myHome()) openResident(jiran.me, true); else resetCamera(); };
  $('btn-zoom-in').onclick = () => zoomBy(0.8);
  $('btn-zoom-out').onclick = () => zoomBy(-0.8);

  // Header
  $('search-ic').innerHTML = icon('search', 18);
  $('place-ic').innerHTML = icon('pin', 16);
  $('place-chev').innerHTML = icon('compass', 14);
  $('place-name').textContent = world?.name || 'Township';
  $('place-pill').onclick = () => { closeInspector(); resetCamera(); };
  $('bell').innerHTML = icon('bell', 20) + '<i class="dot" id="bell-dot" hidden></i>';
  $('bell').onclick = toggleNotifs;
  $('me-btn').onclick = toggleMeMenu;
  $('right-toggle').onclick = () => setRight(!jiran.rightOpen);
  $('right-close').innerHTML = icon('x', 16);
  $('right-close').onclick = () => setRight(false);
  railActive();
  if (renderShell.wired) return;
  renderShell.wired = true;
  wireSearch();
  wireClock();
  wireLayers();

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#notifs, #bell')) $('notifs').hidden = true;
    if (!e.target.closest('#me-menu, #me-btn')) $('me-menu').hidden = true;
    if (!e.target.closest('.search')) $('search-results').hidden = true;
  });

  setRight(!jiran.admin && window.innerWidth >= 1440);
  window.addEventListener('resize', () => {
    if (!jiran.admin && window.innerWidth >= 1440 && !jiran.rightOpen) setRight(true);
  });
}

function zoomBy(dz) {
  const v = currentView[viewMode];
  if (!v) return;
  setCamera({longitude: v.longitude, latitude: v.latitude, zoom: Math.max(13.5, Math.min(18.5, v.zoom + dz)),
             pitch: v.pitch, bearing: v.bearing}, 450);
}

function setRight(open) {
  jiran.rightOpen = open;
  document.body.classList.toggle('right-open', open);
  $('right').classList.toggle('closed', !open);
  setTimeout(() => positionInspector(), 320);
}

function railGo(id) {
  if (id === 'dev') { setDev(!jiran.dev); toast(jiran.dev ? 'Developer mode on' : 'Developer mode off'); return; }
  if (id === 'credits') { showWallet(); return; }
  if (id !== 'spatial' && jiran.view === 'spatial') spatialExit();
  if (id === 'create') { jiran.view = 'home'; renderLeft(true); setTimeout(() => $('ask-text')?.focus(), 50); railActive('create'); return; }
  jiran.view = id;
  renderLeft(true);
  railActive();
  if (id === 'spatial') spatialEnter();
}

/* Credits is the right-hand panel, not a page: open it if it is closed, bring the wallet
 * to the top, and light it up so the click visibly lands even when it was already open. */
function showWallet() {
  setRight(true);
  $('right').scrollTo({top: 0, behavior: 'smooth'});
  const card = $('wallet').querySelector('.wallet-card');
  if (card) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
  railActive('credits');
  clearTimeout(showWallet.timer);
  showWallet.timer = setTimeout(() => railActive(), 1600);
}

function railActive(force) {
  for (const b of document.querySelectorAll('.rail-btn')) {
    b.classList.toggle('on', b.dataset.rail === (force || jiran.view));
  }
  document.querySelector('.rail-btn[data-rail="dev"]')?.classList.toggle('on', jiran.dev);
}

function renderCats() {
  const all = jiran.filter.size === Object.keys(CATEGORIES).length;
  $('cats').innerHTML = `<button class="cat ${all ? 'on' : ''}" data-cat="all">${icon('layers', 15)}<span>All</span></button>` +
    Object.entries(CATEGORIES).map(([k, c]) =>
      `<button class="cat ${jiran.filter.has(k) && !all ? 'on' : ''}" data-cat="${k}" style="--c:${c.color}">` +
      `<i>${icon(c.icon, 15)}</i><span>${c.short}</span></button>`).join('') +
    // SDP can take the people off the map and look at the requests on their own.
    (jiran.admin ? `<span class="cat-sep"></span><button class="cat people ${mapLayers.residents ? 'on' : ''}" data-people
      aria-pressed="${mapLayers.residents}" title="Show or hide residents on the map">${icon('users', 15)}<span>Residents</span></button>` : '');
  const people = $('cats').querySelector('[data-people]');
  if (people) {
    people.onclick = () => {
      mapLayers.residents = !mapLayers.residents;
      renderCats();
      syncMarkers();
      redraw();
      toast(mapLayers.residents ? 'Residents shown on the map' : 'Residents hidden — requests, events and shops only');
    };
  }
  for (const b of $('cats').querySelectorAll('[data-cat]')) {
    b.onclick = () => {
      const k = b.dataset.cat;
      const allKeys = Object.keys(CATEGORIES);
      if (k === 'all') jiran.filter = new Set(allKeys);
      else if (jiran.filter.size === allKeys.length) jiran.filter = new Set([k]);
      else if (jiran.filter.has(k)) { jiran.filter.delete(k); if (!jiran.filter.size) jiran.filter = new Set(allKeys); }
      else jiran.filter.add(k);
      renderCats();
      syncMarkers();
      redraw();
      renderLeft(true);
    };
  }
}

/* ------------------------------------------------------------------- header */

let shownBalance = null;
function renderHeaderMe() {
  if (jiran.admin) {
    $('me-avatar').innerHTML = `<span class="av sdp-av" style="width:38px;height:38px">${icon('shield', 19)}</span>`;
    $('me-name').textContent = 'SDP Admin';
    const sub = $('me-credits');
    delete sub.dataset.value;
    sub.classList.add('admin-sub');
    sub.textContent = 'Township operations';
    return;
  }
  $('me-credits').classList.remove('admin-sub');
  const m = jiran.meData;
  if (!m) return;
  $('me-avatar').innerHTML = avatarHtml(m.id, {size: 38, status: personState(m.id)?.status, verified: m.verified});
  $('me-name').textContent = m.name;
  countTo($('me-credits'), m.balance, (n) => credits(n));
}

/* Credit balances count up or down to their new value, and flash when they change. */
function countTo(el, to, fmtFn) {
  if (!el) return;
  const from = Number(el.dataset.value ?? to);
  el.dataset.value = to;
  if (from === to) { el.textContent = fmtFn(to); return; }
  el.classList.remove('bump-up', 'bump-down');
  void el.offsetWidth;
  el.classList.add(to > from ? 'bump-up' : 'bump-down');
  const t0 = performance.now();
  const step = (now) => {
    const f = Math.min(1, (now - t0) / 650);
    el.textContent = fmtFn(Math.round(from + (to - from) * (1 - Math.pow(1 - f, 3))));
    if (f < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function toggleMeMenu() {
  const menu = $('me-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = `
    <div class="mm-head">Demo: view JiranSync as</div>
    <button class="mm-row mm-admin ${jiran.admin ? 'on' : ''}" data-who="${ADMIN_ID}">
      <span class="av sdp-av" style="width:28px;height:28px">${icon('shield', 15)}</span>
      <span><b>SDP Admin</b><em>Township operations · events · merchants</em></span></button>
    <div class="mm-sub">Residents</div>
    <div class="mm-list">${jiran.residents.map((r) => `
      <button class="mm-row ${!jiran.admin && r.id === jiran.me ? 'on' : ''}" data-who="${r.id}">
        ${avatarHtml(r.id, {size: 28})}<span><b>${esc(r.name)}</b>
        <em>${r.id === 'R001' ? 'Needs a ride to the MRT' : r.id === 'R002' ? 'Drives to the MRT' :
          esc((r.skills || []).slice(0, 2).join(', '))}</em></span>
        <span class="mm-cr">${r.balance}</span></button>`).join('')}</div>
    ${jiran.admin ? `<button class="mm-row mm-dev" data-dev="1">${icon('settings', 16)}<span><b>Developer mode</b><em>${jiran.dev ? 'On' : 'Off'} — AI engine, connection, no-show button</em></span></button>` : ''}`;
  menu.hidden = false;
  for (const b of menu.querySelectorAll('[data-who]')) {
    b.onclick = () => { menu.hidden = true; signIn(b.dataset.who); };
  }
  const dev = menu.querySelector('[data-dev]');
  if (dev) dev.onclick = () => { menu.hidden = true; railGo('dev'); };
  menu.querySelector('.mm-row.on')?.scrollIntoView({block: 'center'});
}

function renderDevBar() {
  if (!jiran.dev) return;
  const s = state?.stats;
  const engine = jiran.agent ? (jiran.agent.engine === 'claude' ? `Claude · ${jiran.agent.model}` : 'rule engine') : '—';
  setHtml($('devbar-info'), `<span>${state?.clock ? `${state.clock.day} ${state.clock.time}` : ''}</span>` +
    `<span>AI: ${esc(engine)}</span>` +
    (s ? `<span>${s.open} open · ${s.active} active · ${s.completed} done · ${s.moving} moving · ${s.circulating} cr</span>` : ''));
}

/* ----------------------------------------------------------- notifications */

function myEvents() {
  if (jiran.admin) return state?.events || [];
  const mine = new Set((jiran.meData?.tasks || []).map((t) => t.id));
  for (const e of communityEvents()) if (myEventSignup(e)) mine.add(e.id);
  return (state?.events || []).filter((e) => e.actor === jiran.me || (e.task_id && mine.has(e.task_id)));
}

function seenKey() { return `jiransync.seen.${jiran.admin ? ADMIN_ID : jiran.me}`; }

/** A feed row points at a request (T…) or an SDP event (E…). */
function openFeedItem(id) {
  if (eventById(id)) openEvent(id, true); else openTask(id, true);
}

function renderBell() {
  const seen = Number(storageGet(seenKey()) || 0);
  const unread = myEvents().filter((e) => e.id > seen).length;
  const dot = $('bell-dot');
  if (dot) { dot.hidden = !unread; dot.textContent = unread > 9 ? '9+' : String(unread || ''); }
}

function toggleNotifs() {
  const box = $('notifs');
  if (!box.hidden) { box.hidden = true; return; }
  const events = myEvents();
  box.innerHTML = `<div class="dd-head">Notifications</div>` + (events.length
    ? events.slice(0, 12).map((e) => eventRow(e)).join('')
    : `<div class="empty-state small">${icon('bell', 26)}<b>All caught up</b><span>Updates about your requests and jobs appear here.</span></div>`);
  box.hidden = false;
  for (const row of box.querySelectorAll('[data-task]')) row.onclick = () => { box.hidden = true; openFeedItem(row.dataset.task); };
  if (events[0]) storageSet(seenKey(), String(events[0].id));
  renderBell();
}

/* ------------------------------------------------------------------- search */

function wireSearch() {
  const input = $('search');
  const box = $('search-results');
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { box.hidden = true; return; }
    const results = [];
    for (const e of communityEvents()) {
      if (`${e.title} ${e.place_name} sdp event`.toLowerCase().includes(q)) {
        results.push({html: `<span class="sr-ic" style="--c:${CATEGORIES.community.color}">${icon('flag', 15)}</span><span><b>${esc(e.title)}</b><em>SDP event · ${esc(e.when)}</em></span>`,
                      go: () => openEvent(e.id, true)});
      }
    }
    for (const t of liveTasks()) {
      if (!visibleTask(t)) continue;
      if (t.title.toLowerCase().includes(q) || (t.skills || []).some((s) => s.includes(q))) {
        const c = CATEGORIES[catOf(t)];
        results.push({html: `<span class="sr-ic" style="--c:${c.color}">${icon(c.icon, 15)}</span><span><b>${esc(t.title)}</b><em>${credits(t.credits)} · ${esc(whenOf(t))}</em></span>`,
                      go: () => openTask(t.id, true)});
      }
    }
    for (const r of jiran.admin ? jiran.residents : []) {
      if (r.name.toLowerCase().includes(q) || (r.skills || []).some((s) => s.includes(q))) {
        results.push({html: `${avatarHtml(r.id, {size: 28})}<span><b>${esc(r.name)}</b><em>${esc((r.skills || []).slice(0, 3).join(', '))}</em></span>`,
                      go: () => openResident(r.id, true)});
      }
    }
    for (const t of world?.tenants || []) {
      if (`${t.name} ${t.category}`.toLowerCase().includes(q)) {
        results.push({html: `<span class="sr-ic" style="--c:${CATEGORIES.commercial.color}">${icon('store', 15)}</span><span><b>${esc(t.name)}</b><em>${esc(t.offer)}</em></span>`,
                      go: () => openTenant(t.id, true)});
      }
    }
    for (const h of world?.hubs || []) {
      if (`${h.name} ${(h.aliases || []).join(' ')} station mrt`.toLowerCase().includes(q)) {
        results.push({html: `<span class="sr-ic" style="--c:${CATEGORIES.transit.color}">${icon('train', 15)}</span><span><b>${esc(h.name)}</b><em>${h.road_km} km away</em></span>`,
                      go: () => openHub(h.id, true)});
      }
    }
    for (const f of world?.buildings?.features || []) {
      const n = f.properties.name;
      if (n && n.toLowerCase().includes(q) && results.length < 12) {
        results.push({html: `<span class="sr-ic">${icon('pin', 15)}</span><span><b>${esc(n)}</b><em>Place</em></span>`,
                      go: () => { focusOn([world.centroids[f.id]], {maxZoom: 17.2}); selectBuilding(f.id); }});
      }
    }
    box.innerHTML = results.length
      ? results.slice(0, 9).map((r, i) => `<button class="sr" data-i="${i}">${r.html}</button>`).join('')
      : `<div class="empty-state small">${icon('search', 22)}<b>No matches</b><span>Try a skill like “plumbing”, “clean-up”, or “MRT”.</span></div>`;
    box.hidden = false;
    box._results = results;
    for (const b of box.querySelectorAll('[data-i]')) {
      b.onclick = () => { box.hidden = true; input.value = ''; results[Number(b.dataset.i)].go(); };
    }
  };
  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && box._results?.length) { box.hidden = true; input.value = ''; box._results[0].go(); }
    if (e.key === 'Escape') { box.hidden = true; input.blur(); }
  });
}

/* ------------------------------------------------------------ ask the grid */

function renderAsk() {
  const el = $('ask');
  if (!el) return;
  const me = myHome();
  el.innerHTML = `
    <div class="ask-head"><span class="ask-kicker">${icon('sparkle', 14)}Ask the grid</span></div>
    <h2 class="ask-title">What do you need help with${me ? `, ${esc(me.name.split(' ')[0])}` : ''}?</h2>
    <div class="ask-box">
      <textarea id="ask-text" rows="2" maxlength="2000" placeholder="e.g. Need a ride to the MRT tomorrow at 8am"></textarea>
    </div>
    <div class="ask-chips">${ASK_CHIPS.map((c, i) => {
      const cat = CATEGORIES[c.cat];
      return `<button class="qchip" data-q="${i}" style="--c:${cat.color}">${icon(cat.icon, 14)}${c.label}</button>`;
    }).join('')}</div>
    <button class="btn primary big" id="ask-go">${icon('sparkle', 17)}Ask JiranSync</button>`;
  for (const b of el.querySelectorAll('[data-q]')) {
    b.onclick = () => { $('ask-text').value = ASK_CHIPS[Number(b.dataset.q)].text; $('ask-text').focus(); };
  }
  // Typing your own request asks the whole grid, not the neighbour a card picked.
  $('ask-go').onclick = () => { jiran.target = null; jiran.dest = null; jiran.draftOpts = {}; askGrid(); };
  $('ask-text').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); jiran.target = null; jiran.dest = null; jiran.draftOpts = {}; askGrid(); }
  });
  renderDraft();
}

/* -------------------------------------------------------------- map layers */

const LAYER_ROWS = [
  ['buildings', 'home', 'Buildings', 'OSM footprints · heights'],
  ['terrain', 'layers', 'Terrain', 'Copernicus DEM'],
  ['greenery', 'sprout', 'Parks & water', 'OSM land cover'],
  ['trees', 'sprout', 'Trees', 'Illustrative'],
  ['labels', 'pin', 'Place & road names', 'OSM names'],
  ['residents', 'users', 'Residents', 'Neighbours at home'],
];

function renderLayersMenu() {
  const dd = $('layers-dd');
  dd.innerHTML = `<h4>Map layers</h4>
    ${LAYER_ROWS.filter(([key]) => key !== 'residents' || jiran.admin).map(([key, ic, label, sub]) => `
      <label class="lyr"><span class="lyr-ic">${icon(ic, 15)}</span><span><b>${label}</b><em>${sub}</em></span>
        <input type="checkbox" data-layer="${key}" ${mapLayers[key] ? 'checked' : ''}><i class="sw"></i></label>`).join('')}
    <p>Tasks, shops and transit: use the filter bar above the map.</p>`;
  for (const box of dd.querySelectorAll('[data-layer]')) {
    box.onchange = () => {
      mapLayers[box.dataset.layer] = box.checked;
      redraw();
      syncMarkers();
    };
  }
}

function wireLayers() {
  $('btn-layers').innerHTML = icon('layers', 18);
  $('btn-layers').onclick = (ev) => {
    ev.stopPropagation();
    const dd = $('layers-dd');
    if (dd.hidden) renderLayersMenu();
    dd.hidden = !dd.hidden;
  };
  $('layers-dd').onclick = (ev) => ev.stopPropagation();
  document.addEventListener('click', () => { $('layers-dd').hidden = true; });
}

/* --------------------------------------------------------------- the clock */

const SLOT_TAGS = {
  morning: ['Morning', '#fbbf24'], afternoon: ['Afternoon', '#fb923c'],
  evening: ['Evening', '#a78bfa'], night: ['Night', '#94a3b8'],
};
const CLOCK_PRESETS = [['Morning', '08:00'], ['Afternoon', '14:00'], ['Evening', '19:00'], ['Night', '23:00']];
const clockPick = {day: 0, time: '08:00'};

function renderClock() {
  const c = state?.clock;
  if (!c || !$('clock-time')) return;
  $('clock-time').textContent = c.time;
  $('clock-day').textContent = c.day;
  const [label, color] = SLOT_TAGS[c.slot || 'night'];
  const tag = $('clock-slot');
  tag.textContent = label;
  tag.style.setProperty('--c', color);
}

function renderClockMenu() {
  const dd = $('clock-dd');
  dd.innerHTML = `
    <h4>Township clock</h4>
    <p>Set the time for a demo. Neighbours can only be asked for help right now during their own free slots;
      outside them, you can book them for later.</p>
    <span class="lbl">Day</span>
    <div class="seg">${DAY_NAMES.map((d, i) => `<button data-day="${i}" class="${i === clockPick.day ? 'on' : ''}">${d}</button>`).join('')}</div>
    <span class="lbl">Time</span>
    <div class="presets">${CLOCK_PRESETS.map(([name, t]) => `<button data-time="${t}">${name}<i>${t}</i></button>`).join('')}</div>
    <span class="lbl">Exact time</span>
    <input type="time" id="clock-input" value="${clockPick.time}" aria-label="Exact time">
    <button class="btn primary" id="clock-set">${icon('clock', 16)}Set to ${DAY_NAMES[clockPick.day]} ${clockPick.time}</button>
    <span class="lbl">Demo</span>
    <label class="lyr"><span class="lyr-ic">${icon('sparkle', 15)}</span>
      <span><b>Best match accepts automatically</b><em>No need to switch residents</em></span>
      <input type="checkbox" id="auto-accept" ${state?.demo?.auto_accept ? 'checked' : ''}><i class="sw"></i></label>`;
  for (const b of dd.querySelectorAll('[data-day]')) b.onclick = () => { clockPick.day = Number(b.dataset.day); renderClockMenu(); };
  for (const b of dd.querySelectorAll('[data-time]')) b.onclick = () => { clockPick.time = b.dataset.time; renderClockMenu(); };
  $('clock-input').onchange = (ev) => { if (ev.target.value) { clockPick.time = ev.target.value; renderClockMenu(); } };
  $('auto-accept').onchange = (ev) => act('/api/demo/auto-accept', {on: ev.target.checked},
    (o) => (o.auto_accept ? 'Demo: the best match will accept new requests' : 'Auto-accept off'));
  $('clock-set').onclick = async () => {
    const out = await act('/api/clock', {day: clockPick.day, time: clockPick.time},
      (c) => `Clock set to ${c.day} ${c.time}`);
    if (out) toggleClockMenu(false);
  };
}

function toggleClockMenu(open) {
  const dd = $('clock-dd');
  open = open ?? dd.hidden;
  if (open) {
    clockPick.day = state?.clock?.day_index ?? 0;
    clockPick.time = state?.clock?.time || '08:00';
    renderClockMenu();
  }
  dd.hidden = !open;
  $('clock-pill').setAttribute('aria-expanded', String(open));
}

function wireClock() {
  $('clock-ic').innerHTML = icon('clock', 17);
  $('clock-pill').onclick = (ev) => { ev.stopPropagation(); toggleClockMenu(); };
  $('clock-dd').onclick = (ev) => ev.stopPropagation();
  document.addEventListener('click', () => { if (!$('clock-dd').hidden) toggleClockMenu(false); });
  renderClock();
}

/** Start a request from elsewhere: a neighbour's card, a station.
 *  `target` asks one neighbour directly: {id} for now, {id, start_at} to book a later slot. */
function askFor(text, target = null, dest = null) {
  jiran.target = target;
  jiran.dest = dest;
  jiran.draftOpts = {};
  closeInspector();
  jiran.view = 'home';
  renderLeft(true);
  railActive();
  $('ask-text').value = text;
  askGrid();
}

async function askGrid(quiet = false) {
  const text = $('ask-text').value.trim();
  if (text.length < 3) { toast('Tell the grid what you need first', false); $('ask-text').focus(); return; }
  jiran.drafting = !quiet;
  if (!quiet) { jiran.draft = null; renderDraft(); }
  const button = $('ask-go');
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>Finding neighbours…`;
  try {
    const target = jiran.target ? {invitee: jiran.target.id, start_at: jiran.target.start_at ?? null} : {};
    if (jiran.dest) target.dest = {lon: jiran.dest.lon, lat: jiran.dest.lat, name: jiran.dest.name};
    jiran.draft = await api('/api/tasks/draft', {actor: jiran.me, text, ...target, ...(jiran.draftOpts || {})});
    syncMarkers();
    jiran.draftCredits = jiran.draft.valuation.suggested;
    if (quiet) return;
    closeInspector();
    const home = myHome();
    const pts = (jiran.draft.subtasks?.length ? jiran.draft.subtasks.flatMap((s) => s.candidates)
      : jiran.draft.candidates).slice(0, 5).map((c) => [c.lon, c.lat]);
    // A ride to a place in town: keep where it goes in the frame too.
    const t = jiran.draft.task;
    if (t.kind === 'ride' && !t.dest_id && t.dest_lon != null) pts.push([t.dest_lon, t.dest_lat]);
    if (home) focusOn([[home.lon, home.lat], ...pts], {maxZoom: 16.9});
  } catch (err) {
    toast(err.message, false);
  } finally {
    jiran.drafting = false;
    button.disabled = false;
    button.innerHTML = `${icon('sparkle', 17)}Ask JiranSync`;
    renderDraft();
    redraw();
  }
}

function candidateRow(c, rank) {
  return `<button class="cand" data-res="${c.resident_id}">
      ${avatarHtml(c.resident_id, {size: 34, status: personState(c.resident_id)?.status, verified: true})}
      <span class="cand-main"><b>${esc(c.name)}</b><em>${esc(c.reasons.slice(0, 3).join(' · '))}</em>
        ${c.ties?.length ? `<span class="ties">${tieTags(c.ties)}</span>` : ''}</span>
      <span class="cand-score"><i style="--w:${Math.round(Math.min(1, c.score) * 100)}%"></i>${rank === 0 ? '<em>Best match</em>' : ''}</span>
    </button>`;
}

function draftInsights(d) {
  const u = d.understanding;
  const notes = [];
  if (u.kind === 'ride') {
    const heading = d.candidates.filter((c) => c.direction);
    if (heading.length) notes.push(`<b>${heading.length} neighbour${heading.length > 1 ? 's are' : ' is'} heading to ${esc(d.task.dest_name)}</b>${u.slot ? ` in the ${u.slot}` : ''}.`);
  } else if (d.subtasks?.length > 1) {
    notes.push(`Split into <b>${d.subtasks.length} smaller jobs</b> so each goes to the right neighbour.`);
  }
  // "Help me" alone: the grid can't tell who to ask. Say so, kindly.
  const words = ($('ask-text')?.value || '').trim().split(/\s+/).length;
  if (u.kind === 'help' && (u.skills || []).join() === 'errands' && words <= 4) {
    notes.push('<b>Say what the help is</b> — “carry a cabinet”, “fix a tap”, “babysit” — so JiranSync pings neighbours with the right skill.');
  }
  if (!d.subtasks?.length && d.candidates[0]) {
    notes.push(`<b>${esc(d.candidates[0].name.split(' ')[0])}</b> is the closest suitable match.`);
  }
  if (!d.subtasks?.length) {
    const v = d.valuation;
    const why = [`${u.est_minutes} min of time`];
    if (v.capital_rm > 0) why.push('travel cost');
    if (v.skill_multiplier > 1) why.push('skill');
    if (v.urgency_multiplier > 1) why.push('urgency');
    notes.push(`Suggested <b>${credits(v.suggested)}</b> based on ${why.join(', ')}.`);
  }
  // One quiet card, a line per finding -- the AI helping, not chatting.
  return notes.length ? aiInsight(notes.map((n) => `<span class="ai-line">${n}</span>`).join('')) : '';
}

function renderDraft() {
  const el = $('draft');
  if (!el) return;
  if (jiran.drafting) {
    el.hidden = false;
    el.innerHTML = `<div class="skeleton"><i></i><i></i><i class="short"></i></div>
      <div class="skeleton"><i></i><i class="short"></i></div>`;
    return;
  }
  const d = jiran.draft;
  if (!d) { el.hidden = true; el.innerHTML = ''; return; }
  const u = d.understanding;
  const catKey = catOf({kind: u.kind, skills: u.skills});
  const cat = CATEGORIES[catKey];
  const split = d.subtasks?.length > 1;
  const cost = split ? d.cost : jiran.draftCredits;
  const short = cost > d.available;
  const v = d.valuation;
  const asksWhen = u.kind === 'help' && !d.invitee && !split;
  const body = split ? d.subtasks.map((s) => {
    const sc = CATEGORIES[catOf({kind: 'help', skills: s.skills})];
    return `<div class="sub">
      <div class="sub-head"><span class="sr-ic" style="--c:${sc.color}">${icon(sc.icon, 15)}</span><b>${esc(s.title)}</b><span class="cr-pill">${credits(s.valuation.suggested)}</span></div>
      ${s.fallback ? `<div class="fallback">${icon('store', 15)}<div>${esc(s.fallback.message)}</div></div>`
        : (s.candidates[0] ? candidateRow(s.candidates[0], 0) : '<p class="muted">Nobody nearby has this skill yet.</p>')}
    </div>`;
  }).join('') : `
      ${asksWhen ? draftFields(d) : ''}
      <div class="reward-box">
        <div class="rb-top"><div><span class="rb-label">${icon('sparkle', 13)}AI suggested reward</span>
          <b class="rb-value"><span id="d-credits">${jiran.draftCredits}</span> Credits</b>
          <span class="rb-rm">≈ RM${jiran.draftCredits * 2} · you can adjust it</span></div></div>
        <input type="range" id="d-range" min="${v.low}" max="${v.high}" step="1" value="${jiran.draftCredits}" aria-label="Reward in credits">
        <div class="rb-ends"><span>${v.low}</span><span>${v.high}</span></div>
      </div>
      ${d.invitee ? `
      <div class="sec-title">${d.invitee.start_at != null ? 'Booking' : 'Asking'} only ${esc(d.invitee.name.split(' ')[0])}</div>
      <div class="cands">${d.candidates[0] ? candidateRow(d.candidates[0], 0)
        : `<button class="cand" data-res="${d.invitee.id}">${avatarHtml(d.invitee.id, {size: 32})}<span class="cand-main"><b>${esc(d.invitee.name)}</b><em>Asked directly</em></span></button>`}</div>
      <p class="muted">${d.invitee.start_at != null
        ? `For <b>${esc(dayTimeLabel(d.invitee.start_at))}</b>. They confirm, your credits are held, and the job starts at that time.`
        : 'They’re free right now. Nobody else will be pinged.'}</p>` : `
      <div class="sec-title">Neighbours we’ll ping</div>
      <div class="cands">${d.candidates.slice(0, 3).map((c, i) => candidateRow(c, i)).join('')
        || '<p class="muted">Nobody in walking range matches yet.</p>'}</div>
      ${u.kind === 'help' ? `<p class="muted">They — or anyone nearby — offer to help, and <b>you choose who comes</b>. Nothing is paid until you choose.</p>` : ''}`}
      ${d.fallback ? `<div class="fallback">${icon('store', 15)}<div><b>${esc(d.fallback.name)}</b> can do this — residents get ${d.fallback.discount_pct}% off.</div></div>` : ''}`;
  el.hidden = false;
  el.innerHTML = `
    <div class="draft-card" style="--c:${cat.color}">
      <div class="dc-head"><span class="sr-ic" style="--c:${cat.color}">${icon(cat.icon, 17)}</span>
        <div><b>${esc(u.title)}</b><em>${esc(cat.label)}${d.invitee ? ` · ${esc(d.invitee.start_at != null ? dayTimeLabel(d.invitee.start_at) : 'Now')}`
          : d.task.start_at != null ? ` · ${esc(dayTimeLabel(d.task.start_at))}` : u.when ? ` · ${esc(u.when)}` : ''}${u.kind === 'ride' && d.task.dest_name ? ` · to ${esc(d.task.dest_name)}` : ''}</em></div>
        <button class="icon-btn sm" id="d-discard" title="Discard">${icon('x', 15)}</button></div>
      <div class="insights">${draftInsights(d)}</div>
      ${body}
      <div class="dc-foot">
        <span class="${short || d.needs_when ? 'bad' : 'muted'}">${d.needs_when ? 'Pick when you need help' : short ? `You have ${d.available} free — not enough` : `You have ${credits(d.available)} free`}</span>
        <button class="btn primary" id="d-post" ${short || d.needs_when ? 'disabled' : ''}>${d.invitee ? (d.invitee.start_at != null ? 'Send booking' : 'Send request') : 'Post request'} · <span id="d-cost">${credits(cost)}</span></button>
      </div>
    </div>`;
  const range = $('d-range');
  if (range) {
    range.oninput = () => {
      jiran.draftCredits = Number(range.value);
      $('d-credits').textContent = range.value;
      $('d-cost').textContent = credits(jiran.draftCredits);
      $('d-post').disabled = jiran.draftCredits > d.available || d.needs_when;
    };
  }
  if (asksWhen) wireDraftFields(d);
  for (const b of el.querySelectorAll('[data-res]')) b.onclick = () => openResident(b.dataset.res, true);
  $('d-discard').onclick = () => { jiran.draft = null; jiran.target = null; jiran.dest = null; renderDraft(); redraw(); syncMarkers(); };
  $('d-post').onclick = postDraft;
}

/* When and how long: what neighbours need before they can say yes. Filled in from what the
 * AI read in the request; when it couldn't tell, the resident has to pick a day. */
const DURATIONS = [30, 60, 90, 120, 180, 240];
const fmtMinutes = (m) => (m < 60 ? `${m} min` : `${+(m / 60).toFixed(1)} h`);

function draftFields(d) {
  const u = d.understanding;
  const today = Math.floor(nowMinute() / 1440);
  let day = '', time = '19:00';
  if (d.task.start_at != null) {
    const m = minuteOf(d.task.start_at);
    day = String(Math.floor(m / 1440) - today);
    time = hhmm(m);
  } else if (u.start_choice === 'asap') {
    day = 'asap';
  }
  const days = Array.from({length: 7}, (_, i) =>
    [String(i), i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DAY_NAMES[(today + i) % 7]]);
  const minutes = u.est_minutes;
  const durations = DURATIONS.includes(minutes) ? DURATIONS : [...DURATIONS, minutes].sort((a, b) => a - b);
  return `<div class="dfields ev-form ${d.needs_when ? 'needs' : ''}">
      <div class="fl"><span>When${d.needs_when ? ' <i class="req">· required</i>' : ''}</span>
        <div class="dwhen">
          <select id="d-day" aria-label="Day">
            ${day === '' ? '<option value="" selected>Pick a day…</option>' : ''}
            <option value="asap" ${day === 'asap' ? 'selected' : ''}>As soon as possible</option>
            ${days.map(([v, label]) => `<option value="${v}" ${v === day ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <input type="time" id="d-time" value="${time}" aria-label="Time" ${day === '' || day === 'asap' ? 'hidden' : ''}>
        </div></div>
      <div class="fl"><span>How long</span>
        <select id="d-mins" aria-label="How long">${durations.map((m) =>
          `<option value="${m}" ${m === minutes ? 'selected' : ''}>${fmtMinutes(m)}</option>`).join('')}</select></div>
    </div>`;
}

function wireDraftFields(d) {
  const redraft = () => {
    const day = $('d-day').value;
    const opts = {minutes: Number($('d-mins').value)};
    if (day === 'asap') opts.asap = true;
    else if (day !== '') {
      const [hh, mm] = ($('d-time').value || '19:00').split(':').map(Number);
      const start = (Math.floor(nowMinute() / 1440) + Number(day)) * 1440 + hh * 60 + mm;
      opts.when_at = (start - CLOCK_START_MIN) * 60;
    }
    jiran.draftOpts = opts;
    askGrid(true);
  };
  $('d-day').onchange = redraft;
  $('d-time').onchange = redraft;
  $('d-mins').onchange = redraft;
}

async function postDraft() {
  const d = jiran.draft;
  if (!d) return;
  $('d-post').disabled = true;
  const split = d.subtasks?.length > 1;
  const out = await act('/api/tasks', {
    actor: jiran.me, understanding: d.understanding,
    credits: split ? null : jiran.draftCredits,
    description: $('ask-text').value.trim(),
  }, (o) => (d.invitee
    ? `${d.invitee.start_at != null ? 'Booking request' : 'Request'} sent to ${d.invitee.name.split(' ')[0]}`
    : o.created[0].kind === 'help' && o.created.length === 1
    ? `Posted! ${o.created[0].pinged.map((c) => c.name.split(' ')[0]).join(', ') || 'Neighbours'} pinged — choose from the offers as they come in`
    : o.created.length > 1
    ? `Posted as ${o.created.length} jobs — neighbours notified`
    : `Posted! ${o.created[0].pinged.map((c) => c.name.split(' ')[0]).join(', ') || 'Neighbours'} notified`
      + (state?.demo?.auto_accept && o.created[0].pinged[0] ? ` — ${o.created[0].pinged[0].name.split(' ')[0]} will accept shortly` : '')));
  if (!out) { if ($('d-post')) $('d-post').disabled = false; return; }
  jiran.draft = null;
  jiran.target = null;
  jiran.dest = null;
  $('ask-text').value = '';
  syncMarkers();
  renderDraft();
  const first = out.created[0];
  setTimeout(() => openTask(first.id, true), 350);
}

/* --------------------------------------------------------------- left panel */

function taskCardRow(t, extra = '') {
  const cat = CATEGORIES[catOf(t)];
  const dist = distFromMe(t.lon, t.lat);
  const forMe = !jiran.admin && pingedMe(t);
  return `<button class="tcard ${t.urgency >= 3 && t.status === 'open' ? 'urgent' : ''} ${forMe ? 'for-you' : ''} ${isSelected('task', t.id) ? 'sel' : ''}" data-task="${t.id}">
      <span class="tc-ic" style="--c:${cat.color}">${icon(cat.icon, 20)}</span>
      <span class="tc-main">
        <b>${esc(t.title)}</b>
        <em>${esc(whenOf(t))}${forMe ? ` · <span class="for-you-tag">${icon('star', 11)}Good match for you</span>` : ''}</em>
        <em class="tc-meta">${avatarHtml(t.requester, {size: 16})}${esc(firstName(t.requester))}
          ${dist != null && t.requester !== jiran.me ? ` · ${fmtDist(dist)} away` : ''}${extra}</em>
      </span>
      <span class="cr-pill">${credits(t.credits)}</span>
    </button>`;
}

/* The nearby list marks requests you've already offered on. */
function offeredTag(t) {
  return !jiran.admin && myOffer(t)?.status === 'offered' ? ' · <span class="st st-completed">Offer sent</span>' : '';
}

/** An SDP event in a list: when, where, places taken, and whether you're going. */
function eventCardRow(e) {
  const cat = CATEGORIES.community;
  const mine = myEventSignup(e);
  const dist = distFromMe(e.lon, e.lat);
  const live = e.status === 'live';
  const full = e.joined >= e.slots;
  const tag = jiran.admin
    ? `${e.joined}/${e.slots} joined${live ? ` · ${e.checked_in} checked in` : ''}`
    : mine ? `<span class="st st-completed">${mine.status === 'joined' ? 'You’re going' : mine.status === 'checked_in' ? 'Checked in' : 'Done'}</span>`
    : full ? 'Full' : `${e.slots - e.joined} place${e.slots - e.joined === 1 ? '' : 's'} left`;
  return `<button class="tcard ecard ${live ? 'live' : ''} ${isSelected('event', e.id) ? 'sel' : ''}" data-event="${e.id}">
      <span class="tc-ic" style="--c:${cat.color}">${icon('flag', 20)}</span>
      <span class="tc-main">
        <b>${esc(e.title)}</b>
        <em>${e.start_at == null ? 'Any time' : live ? '<span class="live-dot"></span>Happening now' : esc(e.when)} · ${esc(e.place_name || 'Elmina')}${dist != null ? ` · ${fmtDist(dist)}` : ''}</em>
        <em class="tc-meta">${tag}</em>
      </span>
      <span class="cr-pill">${credits(e.credits)}</span>
    </button>`;
}

function bindEventRows(root) {
  for (const row of root.querySelectorAll('[data-event]')) row.onclick = () => openEvent(row.dataset.event, true);
}

function homeInsight() {
  const open = liveTasks().filter((t) => t.status === 'open' && t.requester !== jiran.me
    && (!t.invitee || t.invitee === jiran.me));
  const near = open.filter((t) => (distFromMe(t.lon, t.lat) ?? 9e9) < 500);
  const forMe = open.filter(pingedMe);
  const active = jiran.residents.filter((r) => r.id !== jiran.me && ['available', 'moving', 'busy'].includes(personState(r.id)?.status)
    && (distFromMe(r.lon, r.lat) ?? 9e9) < 800);
  const parts = [];
  if (forMe.length) parts.push(`<b>${forMe.length} request${forMe.length > 1 ? 's' : ''}</b> picked you as a good match`);
  else if (near.length) parts.push(`<b>${near.length} neighbour${near.length > 1 ? 's' : ''}</b> within 500 m could use a hand`);
  if (active.length) parts.push(`<b>${active.length}</b> neighbours active nearby`);
  const next = communityEvents().find((e) => ['upcoming', 'live'].includes(e.status) && e.start_at != null);
  if (next) parts.push(`next SDP event: <b>${esc(next.title)}</b>, ${next.status === 'live' ? 'happening now' : esc(next.when)}`);
  return parts.length ? aiInsight(parts.join(' · ') + '.') : '';
}

function renderLeft(force = false) {
  const body = $('left-body');
  if (!body) return;
  if (force) { for (const k of Object.keys(sigs)) if (k.startsWith('left')) delete sigs[k]; }
  $('ask-wrap').hidden = jiran.admin || jiran.view !== 'home';
  if (jiran.admin) {
    if (!['live', 'merchants', 'events', 'economy', 'spatial'].includes(jiran.view)) jiran.view = 'live';
  } else if (!['home', 'mine', 'community'].includes(jiran.view)) jiran.view = 'home';
  if (jiran.view === 'home') renderNearby();
  else if (jiran.view === 'mine') renderMine();
  else if (jiran.view === 'community') renderCommunity();
  else if (jiran.view === 'live') renderAdminLive();
  else if (jiran.view === 'merchants') renderMerchants();
  else if (jiran.view === 'events') renderAdminEvents();
  else if (jiran.view === 'economy') renderEconomy();
  else if (jiran.view === 'spatial') renderSpatial();
  railActive();
}

/* Live sections that change with every snapshot, re-rendered only on change. */
function renderLeftLive() {
  if (jiran.view === 'home') renderNearby();
  else if (jiran.view === 'community') renderCommunity();
  else if (jiran.view === 'live') renderAdminLive();
  else if (jiran.view === 'events') renderEventList();
  renderBell();
}

function bindTaskRows(root) {
  for (const row of root.querySelectorAll('[data-task]')) row.onclick = () => openTask(row.dataset.task, true);
}

function renderNearby() {
  const all = liveTasks()
    .filter((t) => t.status === 'open' && t.requester !== jiran.me && jiran.filter.has(catOf(t))
      && (!t.invitee || t.invitee === jiran.me))
    .sort((a, b) => (pingedMe(b) - pingedMe(a)) || (b.urgency - a.urgency)
      || ((distFromMe(a.lon, a.lat) ?? 0) - (distFromMe(b.lon, b.lat) ?? 0)));
  const shown = jiran.showAllNearby ? all : all.slice(0, 5);
  // A stable frame, then the insight line and the list filled separately: the insight's
  // numbers change every few seconds and must not re-animate the cards under it.
  if (setHtml($('left-body'), '<div id="home-insight"></div><div id="home-list"></div>', 'left-home')) {
    delete sigs['left-home-insight'];
    delete sigs['left-home-list'];
  }
  setHtml($('home-insight'), homeInsight(), 'left-home-insight');
  const list = `
    <div class="sec-head"><h3>Nearby for you</h3>${all.length > 5 ? `<button class="link" id="nearby-all">${jiran.showAllNearby ? 'Show less' : `View all ${all.length}`}</button>` : ''}</div>
    <div class="tlist">${shown.map((t) => taskCardRow(t, offeredTag(t))).join('') ||
      `<div class="empty-state">${icon('heart', 28)}<b>All quiet nearby</b><span>No open requests around you right now. Ask the grid, or join an SDP event in Community.</span></div>`}</div>`;
  if (setHtml($('home-list'), list, 'left-home-list')) {
    bindTaskRows($('home-list'));
    const more = $('nearby-all');
    if (more) more.onclick = () => { jiran.showAllNearby = !jiran.showAllNearby; renderLeft(true); };
  }
}

function renderMine() {
  const tasks = (jiran.meData?.tasks || []).filter((t) => t.status !== 'cancelled' && t.kind !== 'bundle');
  const asked = tasks.filter((t) => t.requester === jiran.me);
  const helping = tasks.filter((t) => t.provider === jiran.me || (t.status === 'open' && t.invitee === jiran.me)
    || (t.status === 'open' && myOffer(taskById(t.id) || t)?.status === 'offered'));
  const section = (title, list, empty, extra) => `
    <div class="sec-head"><h3>${title}</h3><span class="count">${list.length}</span></div>
    <div class="tlist">${list.map((t) => taskCardRow(t, extra(t))).join('') || `<p class="muted pad">${empty}</p>`}</div>`;
  const offerLabel = (t) => {
    const live = taskById(t.id) || t;
    if (t.requester !== jiran.me) return 'Offer sent';
    const n = offersOpen(live).length;
    return n ? `${n} offer${n === 1 ? '' : 's'} · choose one` : 'Waiting for offers';
  };
  const label = (t) => ` · <span class="st st-${t.status}">${{
    open: t.offers_mode ? offerLabel(t)
      : t.invitee ? (t.invitee === jiran.me ? 'Asked you directly' : `Waiting for ${firstName(t.invitee)}`) : 'Waiting for a match',
    reserved: `Booked · ${dayTimeLabel(t.start_at)}`, in_progress: 'On the way', arrived: 'Arrived', completed: 'Done',
  }[t.status] || t.status}</span>`;
  const html = `<div class="view-title"><h2>My tasks</h2><p>Your requests and the neighbours you’re helping.</p></div>` +
    section('My requests', asked, 'You haven’t asked for anything yet.', label) +
    section('I’m helping', helping, 'Offer help on a nearby request to earn credits.', label);
  if (setHtml($('left-body'), html, 'left-mine')) bindTaskRows($('left-body'));
}

/* A resident's Community: SDP events to join, then what neighbours have been doing, with
 * nobody named. */
function renderCommunity() {
  const events = communityEvents().filter((e) => ['upcoming', 'live'].includes(e.status));
  const stats = state?.stats || {};
  const joined = events.filter((e) => myEventSignup(e)).length;
  const html = `<div class="view-title"><h2>Community</h2><p>SDP events and what neighbours are doing in ${esc(world?.name || 'the township')}.</p></div>
    <div class="stat-row">
      <div class="stat"><b>${stats.week_favours ?? 0}</b><span>favours done this week</span></div>
      <div class="stat"><b>${events.length}</b><span>SDP events open</span></div>
      <div class="stat"><b>${joined}</b><span>you’ve joined</span></div>
    </div>
    <div class="sec-head"><h3>SDP events</h3><span class="count">${events.length}</span></div>
    <div class="tlist">${events.map(eventCardRow).join('') || '<p class="muted pad">No SDP events right now.</p>'}</div>
    <div class="sec-head"><h3>Community highlights</h3></div>
    <div class="feed">${(state?.highlights || []).map(highlightRow).join('') ||
      '<p class="muted pad">Nothing yet — be the first to help.</p>'}</div>`;
  if (setHtml($('left-body'), html, 'left-community')) bindEventRows($('left-body'));
}

const HIGHLIGHT_ICON = {completed: 'heart', event: 'megaphone', event_live: 'flag', event_paid: 'users'};
function highlightRow(h) {
  return `<div class="ev ev-${h.kind}"><span class="ev-ic ev-${h.kind}">${icon(HIGHLIGHT_ICON[h.kind] || 'sparkle', 15)}</span>
    <span class="ev-text">${esc(h.public)}<em>${simClock(h.t)}</em></span></div>`;
}

/* ------------------------------------------------------------ SDP admin views */

function statTiles(tiles) {
  return `<div class="stat-row">${tiles.map(([n, label, cls]) =>
    `<div class="stat ${cls || ''}"><b>${n}</b><span>${label}</span></div>`).join('')}</div>`;
}

const ADMIN_STATUS = {open: 'Waiting for a match', reserved: 'Booked', in_progress: 'On the way',
  arrived: 'Helper arrived', completed: 'Done'};

/** One request as SDP sees it: who asked, who was pinged, who took it. */
function adminTaskRow(t) {
  const cat = CATEGORIES[catOf(t)];
  const pinged = (t.pinged || []).map(firstName).join(', ');
  return `<button class="arow" data-task="${t.id}">
      <span class="sr-ic" style="--c:${cat.color}">${icon(cat.icon, 15)}</span>
      <span class="arow-main"><b>${esc(t.title)}</b>
        <span class="arow-who">${avatarHtml(t.requester, {size: 18})}${esc(firstName(t.requester))}
          ${icon('arrowRight', 12)}
          ${t.provider ? `${avatarHtml(t.provider, {size: 18})}${esc(firstName(t.provider))}`
            : offersOpen(t).length ? `${avatarStack(offersOpen(t).map((o) => o.resident), 18)}<em class="muted">offered</em>`
            : `<em class="muted">${pinged ? `pinged ${esc(pinged)}` : 'nobody yet'}</em>`}</span>
        <em class="st st-${t.status}">${t.status === 'open' && t.offers_mode
          ? (offersOpen(t).length ? `${offersOpen(t).length} offer${offersOpen(t).length === 1 ? '' : 's'} · waiting for ${esc(firstName(t.requester))} to choose` : 'Waiting for offers')
          : ADMIN_STATUS[t.status] || t.status}${t.status === 'open' && t.invitee ? ` · asked ${esc(firstName(t.invitee))}` : ''}</em></span>
      <span class="cr-pill">${t.credits}</span>
    </button>`;
}

function renderAdminLive() {
  const s = state?.stats || {};
  const tasks = liveTasks().sort((a, b) => b.created_t - a.created_t);
  const active = tasks.filter((t) => t.status !== 'open');
  const open = tasks.filter((t) => t.status === 'open');
  if (setHtml($('left-body'), `<div class="view-title"><h2>Live</h2><p>Every request in ${esc(world?.name || 'the township')}, who was pinged and who took it.</p></div>
      <div id="admin-tiles"></div><div id="admin-tasks"></div>
      <div class="sec-head"><h3>Township activity</h3><span class="count">all names</span></div>
      <div class="feed" id="admin-feed"></div>`, 'left-live')) {
    for (const k of ['left-live-tiles', 'left-live-tasks', 'left-live-feed']) delete sigs[k];
  }
  setHtml($('admin-tiles'), statTiles([[s.residents ?? 0, 'residents'], [open.length, 'open requests'],
    [active.length, 'matched now'], [s.moving ?? 0, 'on the move']]), 'left-live-tiles');
  if (setHtml($('admin-tasks'), `
      <div class="sec-head"><h3>Matched and on the way</h3><span class="count">${active.length}</span></div>
      <div class="alist">${active.map(adminTaskRow).join('') || '<p class="muted pad">No jobs under way.</p>'}</div>
      <div class="sec-head"><h3>Waiting for a match</h3><span class="count">${open.length}</span></div>
      <div class="alist">${open.map(adminTaskRow).join('') || '<p class="muted pad">Nothing waiting.</p>'}</div>`, 'left-live-tasks')) {
    bindTaskRows($('admin-tasks'));
  }
  if (setHtml($('admin-feed'), (state?.events || []).slice(0, 30).map((e) => eventRow(e)).join(''), 'left-live-feed')) {
    for (const row of $('admin-feed').querySelectorAll('[data-task]')) row.onclick = () => openFeedItem(row.dataset.task);
  }
}

function renderMerchants() {
  const list = (world?.tenants || []).map((t) => ({...t, ...(jiran.tenantStats[t.id] || {})}));
  const total = list.reduce((n, t) => n + (t.held_credits || 0), 0);
  const html = `<div class="view-title"><h2>Merchants</h2><p>SDP tenants accepting Jiran Credits: 1 credit = RM2 off. Shops cash their credits out with SDP at the same RM2.</p></div>
    ${statTiles([[list.length, 'shops'], [total, 'credits collected', 'gold'], [`RM${total * 2}`, 'discounts given']])}
    <div class="alist">${list.map((t) => `
      <div class="mrow" data-tenant="${t.id}">
        <span class="rw-ic">${icon('store', 18)}</span>
        <span class="arow-main"><b>${esc(t.name)}</b><em>${esc(t.category)}</em>
          <em><b class="gold">${t.held_credits ?? '…'} cr</b> collected · RM${(t.held_credits ?? 0) * 2} to cash out</em></span>
        <button class="btn sm gold" data-cashout="${t.id}" ${t.held_credits ? '' : 'disabled'} title="SDP pays RM2 for each credit">Cash out</button>
      </div>`).join('')}</div>`;
  if (setHtml($('left-body'), html, 'left-merchants')) {
    for (const row of $('left-body').querySelectorAll('[data-tenant]')) {
      row.onclick = (e) => { if (!e.target.closest('[data-cashout]')) openTenant(row.dataset.tenant, true); };
    }
    for (const b of $('left-body').querySelectorAll('[data-cashout]')) {
      b.onclick = async () => {
        await act(`/api/tenants/${b.dataset.cashout}/cashout`, {},
          (o) => `${credits(o.credits)} cashed out → RM${o.rm.toFixed(2)} from SDP`);
        refreshTenantStats();
      };
    }
  }
}

/* -- SDP events: the organiser form and the events SDP is running ---------------- */

const EVENT_DURATIONS = [30, 60, 90, 120, 180];

/** A number field with its own − and + buttons, in place of the browser's spinner. */
function numberStepper(id, value, min, max, disabled = false) {
  return `<div class="stepper ${disabled ? 'off' : ''}">
      <button type="button" data-step="-1" data-for="${id}" ${disabled ? 'disabled' : ''} aria-label="Less">${icon('minus', 15)}</button>
      <input id="${id}" type="number" min="${min}" max="${max}" value="${value}" ${disabled ? 'disabled' : ''}>
      <button type="button" data-step="1" data-for="${id}" ${disabled ? 'disabled' : ''} aria-label="More">${icon('plus', 15)}</button>
    </div>`;
}
const eventForm = {title: '', description: '', day: 0, time: '09:00', anytime: false,
                   duration: 90, slots: 8, credits: 3};

function renderAdminEvents() {
  const now = nowMinute();
  const today = Math.floor(now / 1440);
  const days = Array.from({length: 7}, (_, i) => {
    const d = today + i;
    return [i, i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DAY_NAMES[d % 7]];
  });
  const spot = jiran.eventSpot;
  const marks = township.landmarks.filter((m) => m.kind === 'park' || m.kind === 'water' || m.kind === 'civic');
  const f = eventForm;
  const html = `<div class="view-title"><h2>SDP events</h2><p>Host a community event. Volunteers join, GPS checks them in at the venue, and SDP pays everyone who turned up.</p></div>
    <div class="ev-form">
      <label class="fl"><span>Title</span><input id="ef-title" maxlength="80" placeholder="e.g. Eco Lake clean-up" value="${esc(f.title)}"></label>
      <label class="fl"><span>What volunteers do</span><textarea id="ef-desc" rows="2" maxlength="600" placeholder="Gloves and bags provided. Meet at the lakeside path.">${esc(f.description)}</textarea></label>
      <div class="fl"><span>Where</span>
        <div class="where">
          <select id="ef-place">
            <option value="">${spot ? esc(spot.name) : 'Choose a place…'}</option>
            ${marks.map((m, i) => `<option value="${i}">${esc(m.name)}</option>`).join('')}
          </select>
          <button class="btn sm" id="ef-pick">${icon('locate', 14)}Pick on map</button>
        </div>
        <em class="hint">${spot ? `${icon('check', 12)} Meets at <b>${esc(spot.name)}</b>` : 'Or click any building and choose “Host an SDP event here”.'}</em>
      </div>
      <div class="fl"><span>When</span>
        <label class="chk"><input type="checkbox" id="ef-any" ${f.anytime ? 'checked' : ''}> Any time — a one-off job for one volunteer</label>
        <div class="when" ${f.anytime ? 'hidden' : ''}>
          <select id="ef-day">${days.map(([i, label]) => `<option value="${i}" ${i === f.day ? 'selected' : ''}>${label}</option>`).join('')}</select>
          <input type="time" id="ef-time" value="${f.time}">
          <select id="ef-dur">${EVENT_DURATIONS.map((m) => `<option value="${m}" ${m === f.duration ? 'selected' : ''}>${m < 60 ? `${m} min` : `${m / 60} h`}</option>`).join('')}</select>
        </div>
      </div>
      <div class="two">
        <div class="fl"><span>Volunteers</span>${numberStepper('ef-slots', f.anytime ? 1 : f.slots, 1, 50, f.anytime)}</div>
        <div class="fl"><span>Credits each</span>${numberStepper('ef-credits', f.credits, 1, 20)}</div>
      </div>
      <button class="btn primary big" id="ef-post">${icon('flag', 16)}Publish event</button>
    </div>
    <div id="admin-events"></div>`;
  setHtml($('left-body'), html, 'left-events');
  delete sigs['left-events-list'];
  renderEventList();
  const keep = () => {
    f.title = $('ef-title').value; f.description = $('ef-desc').value;
    f.day = Number($('ef-day').value); f.time = $('ef-time').value || f.time;
    f.duration = Number($('ef-dur').value); f.slots = Number($('ef-slots').value) || 1;
    f.credits = Number($('ef-credits').value) || 1; f.anytime = $('ef-any').checked;
  };
  for (const id of ['ef-title', 'ef-desc', 'ef-day', 'ef-time', 'ef-dur', 'ef-slots', 'ef-credits']) $(id).onchange = keep;
  $('ef-any').onchange = () => { keep(); renderLeft(true); };
  for (const b of $('left-body').querySelectorAll('[data-step]')) {
    b.onclick = () => {
      const input = $(b.dataset.for);
      const v = (Number(input.value) || 0) + Number(b.dataset.step);
      input.value = Math.max(Number(input.min), Math.min(Number(input.max), v));
      keep();
    };
  }
  $('ef-place').onchange = (ev) => {
    const m = marks[Number(ev.target.value)];
    if (m) { keep(); setEventSpot({lon: m.lonlat[0], lat: m.lonlat[1], name: m.name}); }
  };
  $('ef-pick').onclick = () => { keep(); pickEventSpot(); };
  $('ef-post').onclick = async () => {
    keep();
    if (!jiran.eventSpot) { toast('Choose where the event meets first', false); return; }
    const [hh, mm] = f.time.split(':').map(Number);
    const startMinute = (today + f.day) * 1440 + hh * 60 + mm;
    const body = {
      title: f.title.trim(), description: f.description.trim(), place_name: jiran.eventSpot.name,
      lon: jiran.eventSpot.lon, lat: jiran.eventSpot.lat,
      start_at: f.anytime ? null : (startMinute - CLOCK_START_MIN) * 60,
      duration_min: f.anytime ? 30 : f.duration, slots: f.anytime ? 1 : f.slots, credits: f.credits,
    };
    const out = await act('/api/community-events', body, (o) => `Published: ${o.title} · ${o.when}`);
    if (!out) return;
    Object.assign(eventForm, {title: '', description: ''});
    jiran.eventSpot = null;
    renderLeft(true);
    syncMarkers();
    setTimeout(() => openEvent(out.id, true), 300);
  };
}

function renderEventList() {
  const el = $('admin-events');
  if (!el) return;
  const all = communityEvents();
  const running = all.filter((e) => ['upcoming', 'live'].includes(e.status));
  const ended = all.filter((e) => e.status === 'ended');
  const html = `<div class="sec-head"><h3>Running and upcoming</h3><span class="count">${running.length}</span></div>
    <div class="tlist">${running.map(eventCardRow).join('') || '<p class="muted pad">No events yet. Publish one above.</p>'}</div>
    ${ended.length ? `<div class="sec-head"><h3>Just ended</h3><span class="count">${ended.length}</span></div>
      <div class="tlist">${ended.map(eventCardRow).join('')}</div>` : ''}`;
  if (setHtml(el, html, 'left-events-list')) bindEventRows(el);
}

async function renderEconomy() {
  let e;
  try { e = await api('/api/economy'); } catch (err) { return; }
  if (jiran.view !== 'economy') return;
  const html = `<div class="view-title"><h2>Economy</h2><p>Every Jiran Credit is a row in a double-entry ledger. Only SDP creates credits; neighbours helping each other only move them.</p></div>
    ${statTiles([[e.issued, 'issued by SDP'], [e.circulating, 'with residents'], [e.in_escrow, 'held in escrow']])}
    ${statTiles([[e.held_by_tenants, 'collected by shops', 'gold'], [e.returned_to_sdp, 'cashed out by shops'], [e.paid_for_events, 'paid for SDP events']])}
    <div class="ledger-check ${e.ledger_sums_to_zero ? 'ok' : 'bad'}">${icon(e.ledger_sums_to_zero ? 'shield' : 'alert', 18)}
      <span><b>${e.ledger_sums_to_zero ? 'The books balance' : 'Ledger error'}</b>
      <em>${e.ledger_sums_to_zero ? 'Every credit issued is accounted for: wallets, escrow, shops and the treasury sum to zero.' : 'The ledger does not sum to zero.'}</em></span></div>
    <div class="rules">
      <div>${icon('sparkle', 15)}<span><b>${e.seed_grant} credits</b> welcome grant for each verified resident</span></div>
      <div>${icon('flag', 15)}<span><b>SDP events</b> pay volunteers who are GPS checked in</span></div>
      <div>${icon('heart', 15)}<span><b>Helping a neighbour</b> moves credits through escrow</span></div>
      <div>${icon('store', 15)}<span><b>1 credit = RM${e.rm_per_credit}</b> off at SDP shops, and shops cash out at RM${e.rm_per_credit}</span></div>
    </div>`;
  setHtml($('left-body'), html, 'left-economy');
}

const EVENT_ICON = {posted: 'megaphone', accepted: 'heart', pickup: 'car', arrived: 'pin',
  completed: 'check', redeemed: 'gift', cashout: 'store', no_show: 'alert',
  strike: 'alert', fraud: 'alert', cancelled: 'x', system: 'users', warning: 'alert',
  event: 'flag', joined: 'users', left: 'x', event_live: 'flag', checked_in: 'pin', event_paid: 'coin',
  offered: 'heart', withdrawn: 'x', chosen: 'star', expired: 'clock'};

function eventRow(e) {
  const lead = e.actor && resident(e.actor)
    ? avatarHtml(e.actor, {size: 30})
    : `<span class="ev-ic ev-${e.kind}">${icon(EVENT_ICON[e.kind] || 'sparkle', 15)}</span>`;
  return `<button class="ev ev-${e.kind}" ${e.task_id ? `data-task="${e.task_id}"` : ''}>
      ${lead}<span class="ev-text">${esc(e.text)}<em>${simClock(e.t)}</em></span></button>`;
}

/* Returns true when a new event arrived since the last snapshot. */
function renderActivity() {
  const top = state?.events?.[0]?.id || 0;
  if (top === jiran.lastEventId) return false;
  const fresh = jiran.lastEventId > 0 && top > jiran.lastEventId;
  jiran.lastEventId = top;
  renderBell();
  if (jiran.view === 'community') renderCommunity();
  if (jiran.view === 'live') renderAdminLive();
  return fresh;
}

/* ------------------------------------------------------------- right panel */

function ledgerLine(e) {
  const t = e.task_id ? taskById(e.task_id) : null;
  const title = t?.title || e.task_id || '';
  const map = {
    seed: ['Welcome to JiranSync', 'Verified resident bonus', 'sparkle'],
    release: e.amount > 0 ? ['Thanks for helping', title, 'heart'] : ['Paid', title, 'check'],
    escrow: ['Held for your request', title, 'clock'],
    refund: ['Refunded', title, 'swap'],
    redeem: ['Spent at a local shop', (e.memo || '').replace(/^RM[\d.]+ off at /, ''), 'gift'],
    event: ['SDP event reward', (e.memo || '').replace(/^SDP event: /, ''), 'flag'],
  };
  const [head, sub, ic] = map[e.kind] || [e.memo || e.kind, '', 'coin'];
  return `<div class="lrow"><span class="lr-ic ${e.amount > 0 ? 'in' : 'out'}">${icon(ic, 15)}</span>
    <span class="lr-main"><b>${esc(head)}</b><em>${esc(sub)}</em></span>
    <span class="lr-amt ${e.amount > 0 ? 'in' : 'out'}">${e.amount > 0 ? '+' : ''}${e.amount}</span></div>`;
}

function renderWallet() {
  const m = jiran.meData;
  if (!m) return;
  const status = personState(m.id)?.status;
  setHtml($('wallet'), `
    <div class="wallet-card">
      <div class="wc-top"><span>Your Jiran Credits</span>${icon('coin', 22)}</div>
      <div class="wc-bal"><b id="wc-num" data-value="${m.balance}">${m.balance}</b><span>Credits</span></div>
      <div class="wc-rm">≈ RM${m.balance * 2} to spend at SDP shops</div>
      <div class="wc-stats">
        <div><span>Available</span><b>${Math.max(0, m.balance - m.committed)}</b></div>
        <div><span>In escrow</span><b>${m.escrow}</b></div>
        <div><span>Reliability</span><b>${Math.round(m.reliability * 100)}%</b></div>
      </div>
      ${m.suspended ? `<div class="wc-warn">${icon('alert', 14)}Account paused: ${esc(m.flagged || 'too many no-shows')}</div>` : ''}
    </div>`, 'wallet-' + m.id);
  countTo($('wc-num'), m.balance, (n) => String(n));
  if (status) $('me-avatar').innerHTML = avatarHtml(m.id, {size: 38, status, verified: m.verified});

  const tenants = [...(world?.tenants || [])].sort((a, b) =>
    (distFromMe(a.lon, a.lat) ?? 0) - (distFromMe(b.lon, b.lat) ?? 0));
  if (setHtml($('rewards'), tenants.map((t) => `
      <div class="rw" data-tenant="${t.id}">
        <span class="rw-ic">${icon('store', 18)}</span>
        <span class="rw-main"><b>${esc(t.name)}</b><em>${esc(t.offer)}</em><em class="rw-d">${fmtDist(distFromMe(t.lon, t.lat))}</em></span>
        <button class="btn sm gold" data-redeem="${t.id}" ${m.balance < 1 ? 'disabled' : ''} title="Redeem 1 credit for RM2 off">Use 1</button>
      </div>`).join(''), 'rewards-' + m.balance)) {
    for (const row of $('rewards').querySelectorAll('[data-tenant]')) {
      row.onclick = (e) => { if (!e.target.closest('[data-redeem]')) openTenant(row.dataset.tenant, true); };
    }
    for (const b of $('rewards').querySelectorAll('[data-redeem]')) {
      b.onclick = () => act(`/api/tenants/${b.dataset.redeem}/redeem`, {actor: jiran.me, credits: 1},
        (o) => `RM${o.discount_rm.toFixed(2)} off at ${o.tenant}`);
    }
  }
  setHtml($('my-activity'), m.ledger.slice(0, 8).map(ledgerLine).join('') ||
    `<div class="empty-state small">${icon('coin', 24)}<b>No activity yet</b><span>Help a neighbour or join an SDP event to earn credits.</span></div>`);
}
