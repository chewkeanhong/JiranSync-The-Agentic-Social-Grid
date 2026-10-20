/* Panels: everything around the map.
 *
 *   header      logo, search, place, notifications, you + your credits
 *   rail        the app's sections
 *   left panel  Ask JiranSync + nearby requests / your tasks / community
 *   right panel your Jiran Credits, rewards near you, your recent activity
 *   map chrome  category filter, legend, map tools, developer bar (hidden by default)
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
  {id: 'community', icon: 'users', label: 'Community'},
  {id: 'credits', icon: 'coin', label: 'Credits'},
  {id: 'spatial', icon: 'layers', label: '3D Demo'},
];

const ASK_CHIPS = [
  {cat: 'ride', label: 'Ride', text: 'Need a ride to the MRT tomorrow 8am'},
  {cat: 'help', label: 'Help', text: 'Need someone to fix my leaking tap and help carry a new cabinet upstairs tonight'},
  {cat: 'tutoring', label: 'Learn', text: 'Can someone tutor my son in SPM maths on Saturday 10am?'},
  {cat: 'community', label: 'Garden', text: 'Water my garden and plants while I am away this weekend'},
];

function renderShell() {
  // Rail
  $('rail').innerHTML = RAIL.map((r) =>
    `<button class="rail-btn" data-rail="${r.id}" title="${r.label}">${icon(r.icon, 20)}<span>${r.label}</span></button>`).join('') +
    `<span class="rail-fill"></span>` +
    `<button class="rail-btn" data-rail="dev" title="Developer mode">${icon('settings', 18)}<span>Dev</span></button>`;
  for (const b of $('rail').querySelectorAll('[data-rail]')) b.onclick = () => railGo(b.dataset.rail);

  // Category filter
  renderCats();

  // Legend
  $('legend').innerHTML =
    Object.values(CATEGORIES).map((c) =>
      `<span class="lg" style="--c:${c.color}"><i>${icon(c.icon, 13)}</i>${c.short}</span>`).join('') +
    `<span class="lg-sep"></span>` +
    Object.values(STATUSES).map((s) =>
      `<span class="lg lg-dot" style="--c:${s.color}"><b></b>${s.label}</span>`).join('');

  // Map tools
  $('btn-view-reset').innerHTML = icon('compass', 18);
  $('btn-locate').innerHTML = icon('locate', 18);
  $('btn-zoom-in').innerHTML = icon('plus', 18);
  $('btn-zoom-out').innerHTML = icon('minus', 18);
  $('btn-locate').onclick = () => { if (myHome()) openResident(jiran.me, true); };
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
  wireSearch();
  wireClock();
  wireLayers();

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#notifs, #bell')) $('notifs').hidden = true;
    if (!e.target.closest('#me-menu, #me-btn')) $('me-menu').hidden = true;
    if (!e.target.closest('.search')) $('search-results').hidden = true;
  });

  setRight(window.innerWidth >= 1440);
  window.addEventListener('resize', () => { if (window.innerWidth >= 1440 && !jiran.rightOpen) setRight(true); });
  railActive();
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
  if (id === 'credits') { setRight(!jiran.rightOpen || window.innerWidth >= 1440); $('right').scrollTop = 0; return; }
  if (id !== 'spatial' && jiran.view === 'spatial') spatialExit();
  if (id === 'create') { jiran.view = 'home'; renderLeft(true); setTimeout(() => $('ask-text')?.focus(), 50); railActive('create'); return; }
  jiran.view = id;
  renderLeft(true);
  railActive();
  if (id === 'spatial') spatialEnter();
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
      `<i>${icon(c.icon, 15)}</i><span>${c.short}</span></button>`).join('');
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
    <div class="mm-list">${jiran.residents.map((r) => `
      <button class="mm-row ${r.id === jiran.me ? 'on' : ''}" data-who="${r.id}">
        ${avatarHtml(r.id, {size: 28})}<span><b>${esc(r.name)}</b>
        <em>${r.id === 'R001' ? 'Needs a ride to the MRT' : r.id === 'R002' ? 'Drives to the MRT' :
          esc((r.skills || []).slice(0, 2).join(', '))}</em></span>
        <span class="mm-cr">${r.balance}</span></button>`).join('')}</div>
    <button class="mm-row mm-dev" data-dev="1">${icon('settings', 16)}<span><b>Developer mode</b><em>${jiran.dev ? 'On' : 'Off'} — engine, sockets, SDP console</em></span></button>`;
  menu.hidden = false;
  for (const b of menu.querySelectorAll('[data-who]')) {
    b.onclick = () => { menu.hidden = true; signIn(b.dataset.who); };
  }
  menu.querySelector('[data-dev]').onclick = () => { menu.hidden = true; railGo('dev'); };
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
  const mine = new Set((jiran.meData?.tasks || []).map((t) => t.id));
  return (state?.events || []).filter((e) => e.actor === jiran.me || (e.task_id && mine.has(e.task_id)));
}

function seenKey() { return `jiransync.seen.${jiran.me}`; }

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
  for (const row of box.querySelectorAll('[data-task]')) row.onclick = () => { box.hidden = true; openTask(row.dataset.task, true); };
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
    for (const t of liveTasks()) {
      if (t.title.toLowerCase().includes(q) || (t.skills || []).some((s) => s.includes(q))) {
        const c = CATEGORIES[catOf(t)];
        results.push({html: `<span class="sr-ic" style="--c:${c.color}">${icon(c.icon, 15)}</span><span><b>${esc(t.title)}</b><em>${credits(t.credits)} · ${esc(whenOf(t))}</em></span>`,
                      go: () => openTask(t.id, true)});
      }
    }
    for (const r of jiran.residents) {
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
      : `<div class="empty-state small">${icon('search', 22)}<b>No matches</b><span>Try a skill like “plumbing”, a name, or “MRT”.</span></div>`;
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
  $('ask-go').onclick = () => { jiran.target = null; jiran.dest = null; askGrid(); };
  $('ask-text').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); jiran.target = null; jiran.dest = null; askGrid(); }
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
    ${LAYER_ROWS.map(([key, ic, label, sub]) => `
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
  closeInspector();
  jiran.view = 'home';
  renderLeft(true);
  railActive();
  $('ask-text').value = text;
  askGrid();
}

async function askGrid() {
  const text = $('ask-text').value.trim();
  if (text.length < 3) { toast('Tell the grid what you need first', false); $('ask-text').focus(); return; }
  jiran.drafting = true;
  jiran.draft = null;
  renderDraft();
  const button = $('ask-go');
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>Finding neighbours…`;
  try {
    const target = jiran.target ? {invitee: jiran.target.id, start_at: jiran.target.start_at ?? null} : {};
    if (jiran.dest) target.dest = {lon: jiran.dest.lon, lat: jiran.dest.lat, name: jiran.dest.name};
    jiran.draft = await api('/api/tasks/draft', {actor: jiran.me, text, ...target});
    syncMarkers();
    jiran.draftCredits = jiran.draft.valuation.suggested;
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
      <span class="cand-main"><b>${esc(c.name)}</b><em>${esc(c.reasons.slice(0, 3).join(' · '))}</em></span>
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
  const body = split ? d.subtasks.map((s) => {
    const sc = CATEGORIES[catOf({kind: 'help', skills: s.skills})];
    return `<div class="sub">
      <div class="sub-head"><span class="sr-ic" style="--c:${sc.color}">${icon(sc.icon, 15)}</span><b>${esc(s.title)}</b><span class="cr-pill">${credits(s.valuation.suggested)}</span></div>
      ${s.fallback ? `<div class="fallback">${icon('store', 15)}<div>${esc(s.fallback.message)}</div></div>`
        : (s.candidates[0] ? candidateRow(s.candidates[0], 0) : '<p class="muted">Nobody nearby has this skill yet.</p>')}
    </div>`;
  }).join('') : `
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
      <div class="cands">${d.candidates.slice(0, 4).map((c, i) => candidateRow(c, i)).join('')
        || '<p class="muted">Nobody in walking range matches yet.</p>'}</div>`}
      ${d.fallback ? `<div class="fallback">${icon('store', 15)}<div><b>${esc(d.fallback.name)}</b> can do this — residents get ${d.fallback.discount_pct}% off.</div></div>` : ''}`;
  el.hidden = false;
  el.innerHTML = `
    <div class="draft-card" style="--c:${cat.color}">
      <div class="dc-head"><span class="sr-ic" style="--c:${cat.color}">${icon(cat.icon, 17)}</span>
        <div><b>${esc(u.title)}</b><em>${esc(cat.label)}${d.invitee ? ` · ${esc(d.invitee.start_at != null ? dayTimeLabel(d.invitee.start_at) : 'Now')}`
          : u.when ? ` · ${esc(u.when)}` : ''}${u.kind === 'ride' && d.task.dest_name ? ` · to ${esc(d.task.dest_name)}` : ''}</em></div>
        <button class="icon-btn sm" id="d-discard" title="Discard">${icon('x', 15)}</button></div>
      <div class="insights">${draftInsights(d)}</div>
      ${body}
      <div class="dc-foot">
        <span class="${short ? 'bad' : 'muted'}">${short ? `You have ${d.available} free — not enough` : `You have ${credits(d.available)} free`}</span>
        <button class="btn primary" id="d-post" ${short ? 'disabled' : ''}>${d.invitee ? (d.invitee.start_at != null ? 'Send booking' : 'Send request') : 'Post request'} · <span id="d-cost">${credits(cost)}</span></button>
      </div>
    </div>`;
  const range = $('d-range');
  if (range) {
    range.oninput = () => {
      jiran.draftCredits = Number(range.value);
      $('d-credits').textContent = range.value;
      $('d-cost').textContent = credits(jiran.draftCredits);
      $('d-post').disabled = jiran.draftCredits > d.available;
    };
  }
  for (const b of el.querySelectorAll('[data-res]')) b.onclick = () => openResident(b.dataset.res, true);
  $('d-discard').onclick = () => { jiran.draft = null; jiran.target = null; jiran.dest = null; renderDraft(); redraw(); syncMarkers(); };
  $('d-post').onclick = postDraft;
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
  const sdp = t.requester === 'sdp';
  return `<button class="tcard ${t.urgency >= 3 && t.status === 'open' ? 'urgent' : ''} ${isSelected('task', t.id) ? 'sel' : ''}" data-task="${t.id}">
      <span class="tc-ic" style="--c:${cat.color}">${icon(cat.icon, 20)}</span>
      <span class="tc-main">
        <b>${esc(t.title)}</b>
        <em>${esc(whenOf(t))}</em>
        <em class="tc-meta">${sdp ? 'By SDP Management' : `${avatarHtml(t.requester, {size: 16})}${esc(firstName(t.requester))}`}
          ${dist != null && t.requester !== jiran.me ? ` · ${fmtDist(dist)} away` : ''}${extra}</em>
      </span>
      <span class="cr-pill">${credits(t.credits)}</span>
    </button>`;
}

function homeInsight() {
  const open = liveTasks().filter((t) => t.status === 'open' && t.requester !== jiran.me && t.kind !== 'bounty'
    && (!t.invitee || t.invitee === jiran.me));
  const near = open.filter((t) => (distFromMe(t.lon, t.lat) ?? 9e9) < 500);
  const available = jiran.residents.filter((r) => r.id !== jiran.me && personState(r.id)?.status === 'available'
    && (distFromMe(r.lon, r.lat) ?? 9e9) < 600);
  const moving = (state?.movers || []).filter((m) => !m.done).length;
  const parts = [];
  if (near.length) parts.push(`<b>${near.length} neighbour${near.length > 1 ? 's' : ''}</b> within 500 m could use a hand`);
  if (available.length) parts.push(`<b>${available.length}</b> nearby are free right now`);
  if (moving) parts.push(`<b>${moving}</b> on the move`);
  return parts.length ? aiInsight(parts.join(' · ') + '.') : '';
}

function renderLeft(force = false) {
  const body = $('left-body');
  if (!body) return;
  if (force) { for (const k of Object.keys(sigs)) if (k.startsWith('left')) delete sigs[k]; }
  $('ask-wrap').hidden = jiran.view !== 'home';
  if (jiran.view === 'home') renderNearby();
  else if (jiran.view === 'mine') renderMine();
  else if (jiran.view === 'community') renderCommunity();
  else if (jiran.view === 'spatial') renderSpatial();
  railActive();
}

/* Live sections that change with every snapshot, re-rendered only on change. */
function renderLeftLive() {
  if (jiran.view === 'home') renderNearby();
  else if (jiran.view === 'community') renderCommunity();
  renderBell();
}

function bindTaskRows(root) {
  for (const row of root.querySelectorAll('[data-task]')) row.onclick = () => openTask(row.dataset.task, true);
}

function renderNearby() {
  const all = liveTasks()
    .filter((t) => t.status === 'open' && t.requester !== jiran.me && t.kind !== 'bounty' && jiran.filter.has(catOf(t))
      && (!t.invitee || t.invitee === jiran.me))
    .sort((a, b) => (b.urgency - a.urgency) || ((distFromMe(a.lon, a.lat) ?? 0) - (distFromMe(b.lon, b.lat) ?? 0)));
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
    <div class="tlist">${shown.map((t) => taskCardRow(t)).join('') ||
      `<div class="empty-state">${icon('heart', 28)}<b>All quiet nearby</b><span>No open requests around you right now. Ask the grid, or check SDP bounties in Community.</span></div>`}</div>`;
  if (setHtml($('home-list'), list, 'left-home-list')) {
    bindTaskRows($('home-list'));
    const more = $('nearby-all');
    if (more) more.onclick = () => { jiran.showAllNearby = !jiran.showAllNearby; renderLeft(true); };
  }
}

function renderMine() {
  const tasks = (jiran.meData?.tasks || []).filter((t) => t.status !== 'cancelled' && t.kind !== 'bundle');
  const asked = tasks.filter((t) => t.requester === jiran.me);
  const helping = tasks.filter((t) => t.provider === jiran.me || (t.status === 'open' && t.invitee === jiran.me));
  const section = (title, list, empty, extra) => `
    <div class="sec-head"><h3>${title}</h3><span class="count">${list.length}</span></div>
    <div class="tlist">${list.map((t) => taskCardRow(t, extra(t))).join('') || `<p class="muted pad">${empty}</p>`}</div>`;
  const label = (t) => ` · <span class="st st-${t.status}">${{
    open: t.invitee ? (t.invitee === jiran.me ? 'Asked you directly' : `Waiting for ${firstName(t.invitee)}`) : 'Waiting for a match',
    reserved: `Booked · ${dayTimeLabel(t.start_at)}`, in_progress: 'On the way', arrived: 'Arrived', completed: 'Done',
  }[t.status] || t.status}</span>`;
  const html = `<div class="view-title"><h2>My tasks</h2><p>Your requests and the neighbours you’re helping.</p></div>` +
    section('My requests', asked, 'You haven’t asked for anything yet.', label) +
    section('I’m helping', helping, 'Offer help on a nearby request to earn credits.', label);
  if (setHtml($('left-body'), html, 'left-mine')) bindTaskRows($('left-body'));
}

function renderCommunity() {
  const bounties = liveTasks().filter((t) => t.kind === 'bounty' && t.status === 'open');
  const html = `<div class="view-title"><h2>Community</h2><p>SDP bounties and what’s happening in ${esc(world?.name || 'the township')}.</p></div>
    <div class="sec-head"><h3>SDP bounties</h3><span class="count">${bounties.length}</span></div>
    <div class="tlist">${bounties.map((t) => taskCardRow(t)).join('') || '<p class="muted pad">No bounties open.</p>'}</div>
    <div class="dev-only" id="sdp-console"></div>
    <div class="sec-head"><h3>Township activity</h3></div>
    <div class="feed">${(state?.events || []).slice(0, 25).map((e) => eventRow(e)).join('')}</div>`;
  if (setHtml($('left-body'), html, 'left-community')) {
    bindTaskRows($('left-body'));
    if (jiran.dev) renderSdpConsole();
  }
}

const EVENT_ICON = {posted: 'megaphone', accepted: 'heart', pickup: 'car', arrived: 'pin',
  completed: 'check', redeemed: 'gift', rebate: 'store', bounty: 'flag', no_show: 'alert',
  strike: 'alert', fraud: 'alert', cancelled: 'x', system: 'users', warning: 'alert'};

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
  return fresh;
}

async function renderSdpConsole() {
  const el = $('sdp-console');
  if (!el) return;
  let e, tenants;
  try { [e, tenants] = await Promise.all([api('/api/economy'), api('/api/tenants')]); } catch (err) { return; }
  el.innerHTML = `<div class="sec-head"><h3>SDP console</h3><span class="count">dev</span></div>
    <div class="dev-grid"><span>Issued <b>${e.issued}</b></span><span>Circulating <b>${e.circulating}</b></span>
      <span>Escrow <b>${e.in_escrow}</b></span><span>Books <b class="${e.ledger_sums_to_zero ? 'ok' : 'bad'}">${e.ledger_sums_to_zero ? 'balance' : 'ERROR'}</b></span></div>
    <div class="sdp-form"><input id="b-title" placeholder="New bounty, e.g. Photograph the broken swing" maxlength="80">
      <input id="b-credits" type="number" min="1" max="20" value="3"><button class="btn sm" id="b-post">Post</button></div>
    ${tenants.map((t) => `<div class="sdp-tenant"><span>${esc(t.name)}</span><em>${t.held_credits} cr · cap RM${t.rebate_cap_rm.toFixed(0)}</em>
      <button class="btn sm" data-rebate="${t.id}" ${t.held_credits ? '' : 'disabled'}>Rebate</button></div>`).join('')}`;
  $('b-post').onclick = async () => {
    const body = {title: $('b-title').value.trim(), credits: Number($('b-credits').value), skills: ['errands']};
    if (selectedBuilding) body.building = selectedBuilding; else Object.assign(body, {lon: world.centre.lon, lat: world.centre.lat});
    if (await act('/api/bounties', body, (o) => `Bounty posted: ${o.title}`)) renderSdpConsole();
  };
  for (const b of el.querySelectorAll('[data-rebate]')) {
    b.onclick = async () => {
      await act(`/api/tenants/${b.dataset.rebate}/rebate`, {}, (o) => `${o.credits} cr → RM${o.rebate_rm.toFixed(2)} off rent`);
      renderSdpConsole();
    };
  }
}

/* ------------------------------------------------------------- right panel */

function ledgerLine(e) {
  const t = e.task_id ? taskById(e.task_id) : null;
  const title = t?.title || e.task_id || '';
  const map = {
    seed: ['Welcome to JiranSync', 'Verified resident bonus', 'sparkle'],
    release: e.amount > 0 ? [t?.kind === 'bounty' ? 'SDP bounty reward' : 'Thanks for helping', title, 'heart'] : ['Paid', title, 'check'],
    escrow: ['Held for your request', title, 'clock'],
    refund: ['Refunded', title, 'swap'],
    redeem: ['Spent at a local shop', (e.memo || '').replace(/^RM[\d.]+ off at /, ''), 'gift'],
    bounty: ['SDP reward', title, 'flag'],
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
    `<div class="empty-state small">${icon('coin', 24)}<b>No activity yet</b><span>Help a neighbour to earn your first credits.</span></div>`);
}
