/* Cards: what opens when you tap a request, a neighbour, a shop or a station.
 *
 * Each returns {html, actions, tone} for the map core's floating card (app.js
 * renderInspector). Actions are keyed by the `data-act` of their button. Every button does
 * something real through the API; nothing here is decoration.
 */

function statusPill(status) {
  const s = STATUSES[status];
  return `<span class="spill" style="--c:${s.color}"><i></i>${s.label}</span>`;
}

function infoRow(iconName, html) {
  return `<div class="cd-row">${icon(iconName, 15)}<span>${html}</span></div>`;
}

function aiInsight(html, extra = '') {
  return `<div class="ai-note">${icon('sparkle', 15)}<div>${html}${extra}</div></div>`;
}

function verifiedTag() {
  return `<span class="vtag">${icon('shield', 12)}Verified resident</span>`;
}

const TASK_STEPS = ['Posted', 'Matched', 'On the way', 'Done'];
function stepIndex(t) {
  return {open: 0, reserved: 1, in_progress: 2, arrived: 2, completed: 3}[t.status] ?? 0;
}
function stepper(t) {
  const at = stepIndex(t) + (t.status === 'in_progress' || t.status === 'arrived' ? 0 : 0);
  const matched = t.status !== 'open';
  return `<ol class="steps">${TASK_STEPS.map((label, i) => {
    const done = i < at || (i === 1 && matched) || (i === at && t.status === 'completed');
    const now = i === at && t.status !== 'completed';
    return `<li class="${done ? 'done' : ''} ${now ? 'now' : ''}"><i></i><span>${label}</span></li>`;
  }).join('')}</ol>`;
}

/* "3 Credits" and, behind a toggle, how the AI got there. */
function rewardBox(t, open = false) {
  const v = t.valuation || {};
  const rows = [];
  if (v.time_credits != null) {
    rows.push([`Time (${t.est_minutes} min)`, `${v.time_credits.toFixed(1)}`]);
    if (v.capital_credits > 0) rows.push([`Fuel &amp; travel (RM${v.capital_rm.toFixed(2)})`, `${v.capital_credits.toFixed(1)}`]);
    if (v.skill_multiplier > 1) rows.push(['Skill needed', `×${v.skill_multiplier}`]);
    if (v.urgency_multiplier > 1) rows.push(['Urgency', `×${v.urgency_multiplier}`]);
  }
  const label = t.kind === 'bounty' ? 'SDP reward' : 'AI suggested reward';
  return `<div class="reward-box">
      <div class="rb-top"><div><span class="rb-label">${icon('sparkle', 13)}${label}</span>
        <b class="rb-value">${credits(t.credits)}</b><span class="rb-rm">≈ RM${t.credits * 2} at local shops</span></div>
        ${rows.length ? `<button class="link" data-act="why">${open ? 'Hide' : 'How it’s calculated'}</button>` : ''}</div>
      ${open && rows.length ? `<div class="rb-rows">${rows.map(([k, val]) => `<div><span>${k}</span><b>${val}</b></div>`).join('')}
        <div class="rb-total"><span>Rounded</span><b>${credits(t.credits)}</b></div></div>` : ''}
    </div>`;
}

const cardState = {why: new Set()};

function taskCard(id) {
  const t = taskById(id);
  if (!t) return null;
  const catKey = catOf(t);
  const cat = CATEGORIES[catKey];
  const d = jiran.taskDetail.get(id) || {};
  const mine = t.requester === jiran.me;
  const helping = t.provider === jiran.me;
  const sdp = t.requester === 'sdp';
  const dist = distFromMe(t.lon, t.lat);
  const hub = t.kind === 'ride' ? hubById(t.dest_id) : null;
  const actions = {};

  // -- what the AI noticed ---------------------------------------------------------
  let insight = '';
  const cands = d.candidates || [];
  const forMe = t.invitee === jiran.me;
  const booking = t.start_at != null;
  if (t.status === 'open' && t.invitee) {
    insight = aiInsight(forMe
      ? `<b>${esc(firstName(t.requester))} asked you directly</b>${booking ? ` for <b>${esc(dayTimeLabel(t.start_at))}</b>, in your free time` : ''}.`
      : `<b>Asked ${mine ? '' : `by ${esc(firstName(t.requester))} `}only ${esc(firstName(t.invitee))}</b>${booking ? ` for ${esc(dayTimeLabel(t.start_at))}` : ''}. Waiting for them to confirm.`);
  } else if (t.status === 'reserved' && t.provider) {
    insight = aiInsight(`<b>Booked for ${esc(dayTimeLabel(t.start_at))}.</b> ${helping ? 'You’ll' : `${esc(firstName(t.provider))} will`} set off then. ${credits(t.credits)} held in escrow.`);
  } else if (t.status === 'open' && cands.length) {
    const heading = cands.filter((c) => c.direction);
    if (t.kind === 'ride' && heading.length) {
      insight = aiInsight(`<b>${heading.length} neighbour${heading.length > 1 ? 's are' : ' is'} heading to ${esc(t.dest_name)}</b>` +
        `${t.slot ? ` in the ${t.slot}` : ''}. ${esc(firstName(heading[0].resident_id))} is the best match.`,
        avatarStack(heading.map((c) => c.resident_id), 24));
    } else {
      const best = cands[0];
      insight = aiInsight(`<b>${esc(best.name.split(' ')[0])} is the closest suitable match</b>` +
        (best.walk_min ? ` · ${Math.max(1, Math.round(best.walk_min))} min walk` : '') +
        `. ${cands.length} neighbour${cands.length > 1 ? 's' : ''} pinged.`,
        avatarStack(cands.map((c) => c.resident_id), 24));
    }
  } else if (t.status === 'in_progress' && t.provider) {
    insight = aiInsight(`<b>${helping ? 'You’re' : `${esc(firstName(t.provider))} is`} on the way.</b> ${credits(t.credits)} held safely in escrow until it’s done.`);
  } else if (t.status === 'arrived') {
    insight = aiInsight(`<b>${helping ? 'You’ve' : `${esc(firstName(t.provider))} has`} arrived</b> — confirmed by GPS.`);
  } else if (t.status === 'completed') {
    insight = aiInsight(`<b>Done.</b> ${credits(t.credits)} went to ${helping ? 'you' : esc(firstName(t.provider))}.`);
  }
  if (d.fallback && t.status === 'open') {
    insight += `<div class="fallback">${icon('store', 15)}<div><b>${esc(d.fallback.name)}</b> can help — ` +
      `JiranSync residents get ${d.fallback.discount_pct}% off.</div></div>`;
  }

  // -- what you can do -------------------------------------------------------------
  const buttons = [];
  if (t.status === 'open' && !mine && (!t.invitee || forMe)) {
    const label = booking ? `Confirm for ${dayTimeLabel(t.start_at)}`
      : {ride: 'Offer this ride', bounty: 'Take this bounty'}[t.kind] || 'I can help';
    buttons.push(`<button class="btn primary" data-act="accept">${icon(booking ? 'clock' : t.kind === 'ride' ? 'car' : 'heart', 16)}${label} · ${credits(t.credits)}</button>`);
    actions.accept = () => act(`/api/tasks/${id}/accept`, {actor: jiran.me},
      (o) => (o.status === 'reserved'
        ? `Booked for ${dayTimeLabel(o.start_at)} — ${credits(o.credits)} held in escrow`
        : `You're matched! ${credits(o.credits)} held in escrow — head over.`));
  }
  if (mine && t.status === 'arrived' && t.kind === 'help') {
    buttons.push(`<button class="btn primary" data-act="confirm">${icon('check', 16)}Confirm it's done</button>`);
    actions.confirm = () => act(`/api/tasks/${id}/complete`, {actor: jiran.me},
      (o) => `Thanks sent — ${credits(o.credits)} to ${firstName(o.provider)}`);
  }
  const helper = t.provider || t.invitee;
  if (helper && helper !== jiran.me) {
    buttons.push(`<button class="btn" data-act="who">${avatarHtml(helper, {size: 20})}See ${esc(firstName(helper))}</button>`);
    actions.who = () => openResident(helper, true);
  }
  if (mine && ['open', 'reserved', 'in_progress', 'arrived'].includes(t.status)) {
    buttons.push(`<button class="btn ghost" data-act="cancel">Cancel request</button>`);
    actions.cancel = () => act(`/api/tasks/${id}/cancel`, {actor: jiran.me}, 'Request cancelled — credits returned');
  }
  if (jiran.dev && t.status === 'in_progress') {
    buttons.push(`<button class="btn ghost dev-only" data-act="ghost">Simulate no-show</button>`);
    actions.ghost = () => act(`/api/tasks/${id}/ghost`, {}, 'Helper frozen — escrow refunds in about 30 s');
  }
  actions.why = () => {
    if (cardState.why.has(id)) cardState.why.delete(id); else cardState.why.add(id);
    renderInspector(true);
  };

  const who = sdp
    ? `<div class="cd-person">${`<span class="av sdp-av" style="width:36px;height:36px">${icon('megaphone', 18)}</span>`}
        <div><b>SDP Property Management</b><span class="vtag">${icon('shield', 12)}Official bounty</span></div></div>`
    : `<div class="cd-person">${avatarHtml(t.requester, {size: 36, verified: resident(t.requester)?.verified})}
        <div><b>${esc(nameOf(t.requester))}${mine ? ' (you)' : ''}</b>${verifiedTag()}</div></div>`;

  const where = t.kind === 'ride'
    ? infoRow('route', `${mine ? 'Your home' : `${esc(firstName(t.requester))}’s home`} ${icon('arrowRight', 12)} ${esc(t.dest_name || 'station')}`) +
      (hub ? infoRow('car', `${hub.road_km} km · ~${Math.max(5, Math.round(hub.road_km / 30 * 60))} min drive`) : '')
    : infoRow('pin', mine ? 'At your home' : `${fmtDist(dist)} from you · ~${Math.max(1, Math.round((dist || 0) * 1.3 / 80))} min walk`);

  const html = `
    <div class="cd-top"><span class="cd-cat" style="--c:${cat.color}">${icon(cat.icon, 14)}${t.kind === 'bounty' ? 'SDP Bounty' : cat.label}</span>
      ${t.urgency >= 3 && t.status === 'open' ? `<span class="spill" style="--c:#f87171"><i></i>Urgent</span>` : ''}</div>
    <h3 class="cd-title">${esc(t.title)}</h3>
    ${who}
    <div class="cd-rows">${infoRow('clock', esc(whenOf(t)))}${where}</div>
    ${t.description && t.description.toLowerCase() !== t.title.toLowerCase() ? `<p class="cd-quote">“${esc(t.description)}”</p>` : ''}
    <div class="chips">${(t.skills || []).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
    ${t.status !== 'open' || mine ? stepper(t) : ''}
    ${rewardBox(t, cardState.why.has(id))}
    ${insight}
    ${buttons.length ? `<div class="cd-actions">${buttons.join('')}</div>` : ''}`;
  return {html, actions, tone: catKey};
}

const SLOT_HOURS = {morning: '7am–12pm', afternoon: '12–6pm', evening: '6–10pm'};

function freeTimes(r) {
  const slots = Object.keys(SLOT_HOURS).filter((k) => (r.availability || []).includes(k));
  if (!slots.length) return 'No free times set';
  return 'Free ' + slots.map((k) => `<b>${k[0].toUpperCase()}${k.slice(1)}</b> ${SLOT_HOURS[k]}`).join(' · ');
}

function carLine(r, hub) {
  if (!r.has_car) return 'No car';
  if (!hub) return '<b>Owns a car</b>';
  const min = Math.max(5, Math.round(hub.road_km / 30 * 60));
  return `<b>Owns a car</b> · drives to <b>${esc(hub.name)}</b> regularly (${hub.road_km} km, ~${min} min)`;
}

function experienceBlock(r) {
  const e = r.experience || {jobs: 0};
  if (!e.jobs) return '<div class="rc-exp muted">No completed jobs yet. New helper on the grid.</div>';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `<div class="rc-exp">Helped <b>${plural(e.neighbours, 'neighbour')}</b> in <b>${plural(e.jobs, 'job')}</b>
      · earned <b class="gold">${plural(e.credits, 'credit')}</b></div>
    <div class="chips">${e.for.map(([what, n]) => `<span class="chip">${esc(what)}${n > 1 ? ` ×${n}` : ''}</span>`).join('')}</div>`;
}

function residentCard(id) {
  const r = resident(id);
  const s = personState(id);
  if (!r || !s) return null;
  const you = id === jiran.me;
  const hub = hubById(r.commute);
  const actions = {};
  const buttons = [];
  const first = r.name.split(' ')[0];
  const skill = (r.skills || []).find((k) => k !== 'driving');
  const asks = [];
  if (!you && r.has_car && hub) asks.push({key: 'ride', icon: 'car', what: 'a ride', text: `Need a ride to ${hub.name}`});
  if (!you && skill) asks.push({key: 'ask', icon: 'wrench', what: `help with ${skill}`, text: `Need help with ${skill}`});
  const free = freeNow(r);
  let booking = '';
  if (free) {
    // In their free time: ask them for right now.
    for (const a of asks) {
      buttons.push(`<button class="btn ${buttons.length ? '' : 'primary'}" data-act="${a.key}">${icon(a.icon, 16)}Ask for ${esc(a.what)} now</button>`);
      actions[a.key] = () => askFor(a.text, {id});
    }
  } else if (asks.length) {
    // Outside it: they can only be booked for one of their own free slots.
    const slots = bookableSlots(r);
    booking = `<div class="rc-book">
      <p><b>${esc(first)} isn’t free right now.</b> ${slots.length ? 'Book a time in their free hours:' : 'They haven’t listed any free time.'}</p>
      ${slots.length ? asks.map((a) => `<div class="sub-lbl">${icon(a.icon, 13)}Book ${esc(a.what)}</div>
        <div class="slots">${slots.map((s, i) => `<button class="btn" data-act="${a.key}-${i}">${esc(s.label)}</button>`).join('')}</div>`).join('') : ''}
    </div>`;
    for (const a of asks) {
      slots.forEach((s, i) => { actions[`${a.key}-${i}`] = () => askFor(a.text, {id, start_at: s.start_at}); });
    }
  }
  if (s.task) {
    buttons.push(`<button class="btn" data-act="task">${icon('list', 16)}View task</button>`);
    actions.task = () => openTask(s.task.id, true);
  }
  const doingIcon = s.status === 'moving' ? (s.mode === 'drive' ? 'car' : 'walk')
    : s.status === 'busy' ? 'wrench' : s.status === 'available' ? 'check' : 'clock';
  const html = `
    <div class="rc-head">
      ${avatarHtml(id, {size: 64, status: s.status, verified: r.verified, cls: s.status === 'moving' ? 'pulse' : ''})}
      <div>
        <h3 class="cd-title">${esc(r.name)}${you ? ' <em>(you)</em>' : ''}</h3>
        ${r.verified ? verifiedTag() : ''}
        <div class="rc-sub">${esc(r.unit || '')} · ${fmtDist(distFromMe(r.lon, r.lat)) || 'nearby'}${you ? '' : ' from you'}</div>
      </div>
    </div>
    <div class="rc-doing" style="--c:${STATUSES[s.status].color}">${icon(doingIcon, 16)}<span>${esc(s.doing)}</span>${s.status === 'available' ? '' : statusPill(s.status)}</div>
    <div class="cd-rows">
      ${infoRow('briefcase', r.occupation ? esc(r.occupation) : '<span class="muted">Occupation not shared</span>')}
      ${infoRow('car', carLine(r, hub))}
      ${infoRow('clock', freeTimes(r))}
    </div>
    <div class="rc-sec">Can help with</div>
    <div class="chips">${(r.skills || []).map((k) => `<span class="chip">${esc(k)}</span>`).join('') || '<span class="muted">No skills listed yet</span>'}</div>
    <div class="rc-traits">
      <div><div class="rc-sec">${icon('star', 12)}Strengths</div>
        <ul class="rc-list good">${(r.strengths || []).map((k) => `<li>${esc(k)}</li>`).join('') || '<li class="muted">None listed</li>'}</ul></div>
      <div><div class="rc-sec">${icon('alert', 12)}Weaknesses</div>
        <ul class="rc-list weak">${(r.weaknesses || []).map((k) => `<li>${esc(k)}</li>`).join('') || '<li class="muted">None listed</li>'}</ul></div>
    </div>
    <div class="rc-sec">${icon('heart', 12)}Helping experience</div>
    ${experienceBlock(r)}
    <div class="rc-trust">
      <div><span>Reliability</span><b>${Math.round(r.reliability * 100)}%</b><i style="--w:${Math.round(r.reliability * 100)}%"></i></div>
      <div><span>Jiran Credits</span><b class="gold">${r.balance}</b></div>
    </div>
    ${booking}
    ${buttons.length ? `<div class="cd-actions">${buttons.join('')}</div>` : ''}`;
  return {html, actions, tone: s.status};
}

function tenantCard(id) {
  const t = tenantById(id);
  if (!t) return null;
  const bal = jiran.meData?.balance ?? 0;
  const actions = {};
  const buttons = [1, 3].map((n) => {
    actions[`r${n}`] = () => act(`/api/tenants/${id}/redeem`, {actor: jiran.me, credits: n},
      (o) => `RM${o.discount_rm.toFixed(2)} off at ${o.tenant} — enjoy!`);
    return `<button class="btn ${n === 1 ? 'primary' : ''}" data-act="r${n}" ${bal < n ? 'disabled' : ''}>` +
      `${icon('gift', 16)}Redeem ${n} · RM${n * 2} off</button>`;
  });
  const html = `
    <div class="shop-hero" style="--c:${CATEGORIES.commercial.color}">${icon('store', 28)}</div>
    <div class="cd-top"><span class="cd-cat" style="--c:${CATEGORIES.commercial.color}">${icon('store', 14)}${esc(t.category)}</span>
      <span class="vtag">${icon('shield', 12)}SDP tenant</span></div>
    <h3 class="cd-title">${esc(t.name)}</h3>
    <div class="cd-rows">${infoRow('gift', esc(t.offer))}${infoRow('pin', `${fmtDist(distFromMe(t.lon, t.lat))} from you`)}</div>
    <div class="reward-box"><div class="rb-top"><div><span class="rb-label">${icon('coin', 13)}Your credits here</span>
      <b class="rb-value">RM${bal * 2}</b><span class="rb-rm">${credits(bal)} · 1 credit = RM2 off</span></div></div></div>
    ${aiInsight(`Spending credits here keeps business in Elmina — ${esc(t.name)} gets up to 5% off its rent from SDP.`)}
    <div class="cd-actions">${buttons.join('')}</div>`;
  return {html, actions, tone: 'commercial'};
}

function hubCard(id) {
  const hub = hubById(id);
  if (!hub) return null;
  const drivers = jiran.residents.filter((r) => r.commute === id && r.has_car);
  const st = typeof STATIONS !== 'undefined' ? STATIONS.byHub[id] : null;
  const actions = {
    ride: () => askFor(`Need a ride to ${hub.name} tomorrow morning`),
    view: () => viewStation(id),
  };
  const lines = st ? st.lines : [];
  const html = `
    <div class="cd-top"><span class="cd-cat" style="--c:${CATEGORIES.transit.color}">${icon('train', 14)}Transit hub</span></div>
    <h3 class="cd-title">${esc(hub.name)}</h3>
    <div class="cd-rows">${infoRow('car', `≈ ${hub.road_km} km from Elmina by road · ~${Math.max(5, Math.round(hub.road_km / 30 * 60))} min drive <em class="muted">(estimate)</em>`)}
      ${lines.length ? infoRow('train', `Connections: <b>${lines.join(' · ')}</b>`) : ''}
      ${st?.osmLines?.length ? infoRow('route', `Lines in OpenStreetMap: ${st.osmLines.map(esc).join(', ')}`) : ''}
      ${infoRow('pin', st?.elevated ? 'Elevated station, outside the mapped township' : 'Outside the mapped township')}</div>
    <p class="cd-note">${icon('alert', 12)}<span>The 3D station is a simplified visualisation, not an architectural survey.
      ${st?.aligned ? `It stands on the real elevated track from OpenStreetMap${st.offset > 15 ? `, ${st.offset} m from the station point in the township data` : ''}.`
        : 'No track data near it, so it is centred on the station point.'}</span></p>
    ${drivers.length ? aiInsight(`<b>${drivers.length} neighbours drive here regularly.</b> Share a ride instead of driving alone.`,
      avatarStack(drivers.map((r) => r.id), 26, 6)) : ''}
    <div class="cd-actions"><button class="btn primary" data-act="ride">${icon('car', 16)}Plan route · request a ride</button>
      ${st ? `<button class="btn" data-act="view">${icon('locate', 16)}View station</button>` : ''}</div>`;
  return {html, actions, tone: 'transit'};
}
