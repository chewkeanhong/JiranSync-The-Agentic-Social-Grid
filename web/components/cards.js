/* Cards: what opens when you tap a request, a neighbour, a shop, a station or an SDP event.
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
// Help goes through offers: posted, neighbours offer, the requester chooses, it happens.
const OFFER_STEPS = ['Posted', 'Offers', 'Chosen', 'On the way', 'Done'];
function stepIndex(t) {
  if (t.offers_mode) {
    if (t.status === 'open') return (t.offers || []).some((o) => o.status === 'offered') ? 1 : 0;
    return {reserved: 2, in_progress: 3, arrived: 3, completed: 4}[t.status] ?? 0;
  }
  return {open: 0, reserved: 1, in_progress: 2, arrived: 2, completed: 3}[t.status] ?? 0;
}
function stepper(t) {
  const at = stepIndex(t);
  const steps = t.offers_mode ? OFFER_STEPS : TASK_STEPS;
  return `<ol class="steps">${steps.map((label, i) => {
    const done = i < at || (i === at && t.status === 'completed');
    const now = i === at && t.status !== 'completed';
    return `<li class="${done ? 'done' : ''} ${now ? 'now' : ''}"><i></i><span>${label}</span></li>`;
  }).join('')}</ol>`;
}

/* What connects a neighbour to you, as small tags: a past favour (gold), a new face
 * (green), an SDP event or a street you share (blue). */
function tieTags(ties) {
  return (ties || []).map((t) => {
    const cls = /^New to you/.test(t) ? 'new' : /helped/i.test(t) ? 'known' : 'shared';
    const ic = cls === 'new' ? 'sparkle' : cls === 'known' ? 'heart' : /going|volunteered/.test(t) ? 'flag' : 'home';
    return `<span class="tie ${cls}">${icon(ic, 11)}${esc(t)}</span>`;
  }).join('');
}

const offersOpen = (t) => (t.offers || []).filter((o) => o.status === 'offered');
const myOffer = (t) => (t.offers || []).find((o) => o.resident === jiran.me) || null;

/** Who the requester chooses from: the pinged neighbours from the moment it's posted
 *  ("asked", waiting for their reply) and everyone who offers, best fit marked. */
function offerList(id, t, d, actions) {
  const cards = (d.offer_cards || []).filter((c) => c.status === 'offered' || c.status === 'asked');
  if (!cards.length) {
    const pinged = t.pinged || [];
    return `<div class="offers-empty">${icon('clock', 16)}<div><b>Waiting for offers</b>
      <span>${pinged.length ? `We pinged ${pinged.map((p) => esc(firstName(p))).join(', ')} — anyone nearby can offer too.` : 'Neighbours nearby can offer to help.'}</span></div>
      ${pinged.length ? avatarStack(pinged, 24) : ''}</div>`;
  }
  const rows = cards.map((c) => {
    actions[`choose-${c.resident_id}`] = () => act(`/api/tasks/${id}/choose`, {actor: jiran.me, helper: c.resident_id},
      (o) => (o.status === 'reserved'
        ? `You chose ${firstName(c.resident_id)} — booked for ${dayTimeLabel(o.start_at)}, ${credits(o.credits)} held`
        : `You chose ${firstName(c.resident_id)} — ${credits(o.credits)} held, they're on the way`));
    actions[`see-${c.resident_id}`] = () => { jiran.profileFrom = id; openResident(c.resident_id, true); };
    return `<div class="offer ${c.recommended ? 'rec' : ''} ${c.status === 'asked' ? 'waiting' : ''}">
        <button class="offer-who" data-act="see-${c.resident_id}">${avatarHtml(c.resident_id, {size: 38, verified: true})}</button>
        <button class="offer-main" data-act="see-${c.resident_id}" title="See ${esc(c.name.split(' ')[0])}’s profile">
          <span class="offer-name"><b>${esc(c.name)}</b>${c.recommended ? `<span class="rec-tag">${icon('star', 11)}Recommended</span>` : ''}</span>
          <em>${esc((c.reasons || []).slice(0, 3).join(' · '))}</em>
          <span class="offer-more">View profile ${icon('chevronRight', 11)}</span>
        </button>
        ${c.status === 'offered'
          ? `<button class="btn sm ${c.recommended ? 'primary' : ''}" data-act="choose-${c.resident_id}">Choose</button>`
          : `<span class="asked">${icon('clock', 12)}Asked</span>`}
        ${c.ties?.length ? `<div class="ties">${tieTags(c.ties)}</div>` : ''}
      </div>`;
  }).join('');
  const n = offersOpen(t).length;
  return `<div class="rc-sec">${icon('users', 12)}Choose who helps · ${n} of ${cards.length} ready</div>
    <div class="offers">${rows}</div>
    <p class="offers-note">${n < cards.length ? 'You can choose someone as soon as they say yes. ' : ''}Nothing is paid until you choose.</p>`;
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
  const label = 'AI suggested reward';
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
  const mine = t.requester === jiran.me && !jiran.admin;
  const helping = t.provider === jiran.me && !jiran.admin;
  const dist = distFromMe(t.lon, t.lat);
  const hub = t.kind === 'ride' ? hubById(t.dest_id) : null;
  const actions = {};

  // -- what the AI noticed ---------------------------------------------------------
  let insight = '';
  const cands = d.candidates || [];
  const forMe = t.invitee === jiran.me && !jiran.admin;
  const booking = t.start_at != null;
  const offering = t.offers_mode && t.status === 'open';
  const mineOffer = !jiran.admin ? myOffer(t) : null;
  let offers = '';
  if (offering && mine) {
    offers = offerList(id, t, d, actions);
    insight = aiInsight(`<b>Recommended</b> is the best fit by skill, walking time, free time, reliability and who you know.`);
  } else if (offering && jiran.admin) {
    const n = offersOpen(t).length;
    insight = aiInsight(n
      ? `<b>${n} offer${n === 1 ? '' : 's'}</b> from ${offersOpen(t).map((o) => esc(firstName(o.resident))).join(', ')} — waiting for ${esc(firstName(t.requester))} to choose.`
      : `<b>Pinged ${(t.pinged || []).map((p) => esc(firstName(p))).join(', ') || 'nobody yet'}</b> — waiting for offers.`,
      avatarStack(n ? offersOpen(t).map((o) => o.resident) : (t.pinged || []), 24));
  } else if (offering && mineOffer?.status === 'offered') {
    insight = aiInsight(`<b>Offer sent.</b> Waiting for ${esc(firstName(t.requester))} to choose — your credits come when the job's done.`);
  } else if (t.offers_mode && mineOffer?.status === 'declined') {
    insight = aiInsight(`${esc(firstName(t.requester))} chose another neighbour this time — thank you for offering.`);
  } else if (t.status === 'open' && t.invitee) {
    insight = aiInsight(forMe
      ? `<b>${esc(firstName(t.requester))} asked you directly</b>${booking ? ` for <b>${esc(dayTimeLabel(t.start_at))}</b>, in your free time` : ''}.`
      : `<b>Asked ${mine ? '' : `by ${esc(firstName(t.requester))} `}only ${esc(firstName(t.invitee))}</b>${booking ? ` for ${esc(dayTimeLabel(t.start_at))}` : ''}. Waiting for them to confirm.`);
  } else if (t.status === 'reserved' && t.provider) {
    insight = aiInsight(`<b>Booked for ${esc(dayTimeLabel(t.start_at))}.</b> ${helping ? 'You’ll' : `${esc(firstName(t.provider))} will`} set off then. ${credits(t.credits)} held in escrow.`);
  } else if (t.status === 'open' && jiran.admin) {
    const pinged = (t.pinged || []);
    insight = aiInsight(pinged.length
      ? `<b>Pinged ${pinged.map((id) => esc(firstName(id))).join(', ')}</b> — the top matches by skill, walking time, free time and reliability.`
      : '<b>Waiting for a match.</b>', pinged.length ? avatarStack(pinged, 24) : '');
  } else if (t.status === 'open' && pingedMe(t)) {
    insight = aiInsight(`<b>You’re one of the best matches for this.</b> ${esc(firstName(t.requester))} asked the grid and JiranSync picked you.` +
      (t.offers_mode ? ' Offer to help, and they choose who comes.' : ''));
  } else if (t.status === 'open' && cands.length && mine) {
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
  if (offering && !mine && !jiran.admin) {
    if (mineOffer?.status === 'offered') {
      buttons.push(`<button class="btn ghost" data-act="withdraw">Withdraw offer</button>`);
      actions.withdraw = () => act(`/api/tasks/${id}/withdraw`, {actor: jiran.me}, 'Offer withdrawn');
    } else if (!mineOffer || mineOffer.status === 'withdrawn') {
      buttons.push(`<button class="btn primary" data-act="offer">${icon('heart', 16)}Offer to help · ${credits(t.credits)}</button>`);
      actions.offer = () => act(`/api/tasks/${id}/offer`, {actor: jiran.me},
        () => `Offer sent — ${firstName(t.requester)} will choose who helps`);
    }
  } else if (t.status === 'open' && !mine && !jiran.admin && (!t.invitee || forMe)) {
    const label = booking ? `Confirm for ${dayTimeLabel(t.start_at)}`
      : t.kind === 'ride' ? 'Offer this ride' : 'I can help';
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
  // A resident sees the neighbour on their own job; SDP sees anyone's.
  if (helper && helper !== jiran.me && (jiran.admin || mine)) {
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

  const who = `<div class="cd-person">${avatarHtml(t.requester, {size: 36, verified: resident(t.requester)?.verified})}
        <div><b>${esc(nameOf(t.requester))}${mine ? ' (you)' : ''}</b>${verifiedTag()}</div></div>`;

  const where = t.kind === 'ride'
    ? infoRow('route', `${mine ? 'Your home' : `${esc(firstName(t.requester))}’s home`} ${icon('arrowRight', 12)} ${esc(t.dest_name || 'station')}`) +
      (hub ? infoRow('car', `${hub.road_km} km · ~${Math.max(5, Math.round(hub.road_km / 30 * 60))} min drive`) : '')
    : infoRow('pin', mine ? 'At your home' : jiran.admin ? `At ${esc(firstName(t.requester))}’s home`
      : `${fmtDist(dist)} from you · ~${Math.max(1, Math.round((dist || 0) * 1.3 / 80))} min walk`);

  const html = `
    <div class="cd-top"><span class="cd-cat" style="--c:${cat.color}">${icon(cat.icon, 14)}${cat.label}</span>
      ${t.urgency >= 3 && t.status === 'open' ? `<span class="spill" style="--c:#f87171"><i></i>Urgent</span>` : ''}</div>
    <h3 class="cd-title">${esc(t.title)}</h3>
    ${who}
    <div class="cd-rows">${infoRow('clock', esc(whenOf(t)))}${where}</div>
    ${t.description && t.description.toLowerCase() !== t.title.toLowerCase() ? `<p class="cd-quote">“${esc(t.description)}”</p>` : ''}
    <div class="chips">${(t.skills || []).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
    ${t.status !== 'open' || mine || jiran.admin ? stepper(t) : ''}
    ${rewardBox(t, cardState.why.has(id))}
    ${offers}
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
  // Opened from the offers on your request: how they fit it, and choose them from here.
  const from = jiran.profileFrom && !jiran.admin ? taskById(jiran.profileFrom) : null;
  const offer = from && from.requester === jiran.me && from.status === 'open'
    ? (jiran.taskDetail.get(from.id)?.offer_cards || []).find((c) => c.resident_id === id) : null;
  let fit = '';
  if (offer) {
    fit = `<div class="rc-fit ${offer.recommended ? 'rec' : ''}">
        <div class="rc-sec">${icon('sparkle', 12)}Why ${esc(first)} fits “${esc(from.title)}”
          ${offer.recommended ? `<span class="rec-tag">${icon('star', 11)}Recommended</span>` : ''}</div>
        <em>${esc((offer.reasons || []).join(' · '))}</em>
        ${offer.ties?.length ? `<div class="ties">${tieTags(offer.ties)}</div>` : ''}
      </div>`;
    if (offer.status === 'offered') {
      buttons.push(`<button class="btn primary" data-act="choose">${icon('check', 16)}Choose ${esc(first)}</button>`);
      actions.choose = async () => {
        const out = await act(`/api/tasks/${from.id}/choose`, {actor: jiran.me, helper: id},
          (o) => (o.status === 'reserved'
            ? `You chose ${first} — booked for ${dayTimeLabel(o.start_at)}, ${credits(o.credits)} held`
            : `You chose ${first} — ${credits(o.credits)} held, they're on the way`));
        if (out) openTask(from.id);
      };
    } else {
      buttons.push(`<span class="asked">${icon('clock', 12)}Asked · waiting for ${esc(first)} to reply</span>`);
    }
    buttons.push(`<button class="btn" data-act="back">${icon('arrowRight', 15, 'flip')}Back to offers</button>`);
    actions.back = () => openTask(from.id);
  }
  const asks = [];
  if (!you && !jiran.admin && !offer && r.has_car && hub) asks.push({key: 'ride', icon: 'car', what: 'a ride', text: `Need a ride to ${hub.name}`});
  if (!you && !jiran.admin && !offer && skill) asks.push({key: 'ask', icon: 'wrench', what: `help with ${skill}`, text: `Need help with ${skill}`});
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
        <div class="rc-sub">${jiran.admin ? `${esc(r.unit || '')} · ${esc(r.id)}`
          : you ? esc(r.unit || '') : `${fmtDist(distFromMe(r.lon, r.lat)) || 'Nearby'} from you`}</div>
      </div>
    </div>
    ${fit}
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
  if (jiran.admin) return tenantAdminCard(t);
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
    ${aiInsight(`Spending credits here keeps business in Elmina — ${esc(t.name)} cashes every credit out with SDP at RM2.`)}
    <div class="cd-actions">${buttons.join('')}</div>`;
  return {html, actions, tone: 'commercial'};
}

function tenantAdminCard(t) {
  const st = jiran.tenantStats[t.id] || {};
  const held = st.held_credits ?? 0;
  const actions = {
    cashout: async () => {
      await act(`/api/tenants/${t.id}/cashout`, {}, (o) => `${t.name} cashed out ${credits(o.credits)} → RM${o.rm.toFixed(2)} from SDP`);
      refreshTenantStats();
    },
  };
  const html = `
    <div class="shop-hero" style="--c:${CATEGORIES.commercial.color}">${icon('store', 28)}</div>
    <div class="cd-top"><span class="cd-cat" style="--c:${CATEGORIES.commercial.color}">${icon('store', 14)}${esc(t.category)}</span>
      <span class="vtag">${icon('shield', 12)}SDP tenant</span></div>
    <h3 class="cd-title">${esc(t.name)}</h3>
    <div class="cd-rows">${infoRow('gift', esc(t.offer))}</div>
    <div class="reward-box"><div class="rb-top"><div><span class="rb-label">${icon('coin', 13)}Credits collected</span>
      <b class="rb-value">${credits(held)}</b><span class="rb-rm">RM${held * 2} of discounts given to residents</span></div></div></div>
    ${aiInsight(`<b>Worth RM${held * 2} to ${esc(t.name)}.</b> Residents paid with credits; SDP buys every one back at RM2, so a discount never costs the shop.`)}
    <div class="cd-actions"><button class="btn primary" data-act="cashout" ${held ? '' : 'disabled'}>${icon('swap', 16)}Cash out ${credits(held)} · RM${held * 2}</button></div>`;
  return {html, actions, tone: 'commercial'};
}

const SIGNUP_LABEL = {joined: ['Joined', 'open'], checked_in: ['Checked in (GPS)', 'completed'],
  paid: ['Paid', 'completed'], no_show: ['Didn’t turn up', 'cancelled']};

/** An SDP event. Residents join or leave; SDP sees every volunteer and runs the event. */
function eventCard(id) {
  const e = eventById(id);
  if (!e) return null;
  const cat = CATEGORIES.community;
  const mine = myEventSignup(e);
  const live = e.status === 'live';
  const ended = e.status === 'ended';
  const full = e.joined >= e.slots;
  const dist = distFromMe(e.lon, e.lat);
  const actions = {};
  const buttons = [];
  const hours = e.duration_min >= 60 ? `${+(e.duration_min / 60).toFixed(1)} h` : `${e.duration_min} min`;

  let insight = '';
  if (jiran.admin) {
    if (!ended) {
      if (e.status === 'upcoming') {
        buttons.push(`<button class="btn primary" data-act="start">${icon('flag', 16)}Start now</button>`);
        actions.start = () => act(`/api/community-events/${id}/start`, {}, (o) => `${o.title} has started — volunteers are on the way`);
      }
      buttons.push(`<button class="btn ${live ? 'primary' : ''}" data-act="end">${icon('coin', 16)}End & pay</button>`);
      actions.end = () => act(`/api/community-events/${id}/end`, {},
        (o) => `${o.title} ended — ${o.checked_in} volunteer${o.checked_in === 1 ? '' : 's'} paid ${credits(o.credits)} each`);
      buttons.push(`<button class="btn ghost" data-act="cancel">Cancel event</button>`);
      actions.cancel = () => act(`/api/community-events/${id}/cancel`, {}, 'Event cancelled');
    }
    insight = aiInsight(live
      ? `<b>${e.checked_in} of ${e.joined} checked in.</b> GPS checks volunteers in when they reach the venue. When the event ends, SDP pays everyone checked in.`
      : ended ? `<b>Ended.</b> ${e.checked_in} volunteer${e.checked_in === 1 ? '' : 's'} paid ${credits(e.credits)} each.`
      : `<b>${e.joined} of ${e.slots} places taken.</b> It starts by itself at ${esc(e.when)}; “Start now” opens it early for a demo.`);
  } else if (mine) {
    const going = {joined: live ? 'You’re on your way — GPS will check you in at the venue.' : `You’re going. We’ll remind you ${esc(e.when)}.`,
      checked_in: `<b>You’re checked in.</b> ${credits(e.credits)} lands in your wallet when the event ends.`,
      paid: `<b>Thank you!</b> ${credits(e.credits)} from SDP is in your wallet.`,
      no_show: 'You didn’t make it this time.'}[mine.status];
    insight = aiInsight(going);
    if (mine.status === 'joined') {
      buttons.push(`<button class="btn ghost" data-act="leave">Leave event</button>`);
      actions.leave = () => act(`/api/community-events/${id}/leave`, {actor: jiran.me}, 'You’ve left the event');
    }
  } else if (!ended) {
    insight = aiInsight(`Volunteer and earn <b>${credits(e.credits)}</b> from SDP — paid when GPS shows you were there.`);
    buttons.push(`<button class="btn primary" data-act="join" ${full ? 'disabled' : ''}>${icon('users', 16)}${full ? 'All places taken' : `Join · earn ${credits(e.credits)}`}</button>`);
    actions.join = () => act(`/api/community-events/${id}/join`, {actor: jiran.me},
      (o) => (o.status === 'live' ? `You’ve joined ${o.title} — head over now` : `You’re going to ${o.title} · ${o.when}`));
  }

  const going = jiran.admin
    ? `<div class="rc-sec">${icon('users', 12)}Volunteers</div>
       <div class="signups">${e.signups.map((s) => {
         const [label, cls] = SIGNUP_LABEL[s.status] || [s.status, ''];
         return `<button class="su" data-act="who-${s.resident}">${avatarHtml(s.resident, {size: 24})}<b>${esc(s.name)}</b><span class="st st-${cls}">${label}</span></button>`;
       }).join('') || '<p class="muted">Nobody has joined yet.</p>'}</div>`
    : e.joined ? `<div class="going">${icon('users', 16)}<span><b>${e.joined}</b> neighbour${e.joined === 1 ? '' : 's'} going</span></div>` : '';
  if (jiran.admin) for (const s of e.signups) actions[`who-${s.resident}`] = () => openResident(s.resident, true);

  const html = `
    <div class="cd-top"><span class="cd-cat" style="--c:${cat.color}">${icon('flag', 14)}SDP event</span>
      ${live ? `<span class="spill" style="--c:#34d399"><i></i>Happening now</span>` : ended ? `<span class="spill" style="--c:#7c8698"><i></i>Ended</span>` : ''}</div>
    <h3 class="cd-title">${esc(e.title)}</h3>
    <div class="cd-person"><span class="av sdp-av" style="width:36px;height:36px">${icon('megaphone', 18)}</span>
      <div><b>SDP Property Management</b><span class="vtag">${icon('shield', 12)}Official event</span></div></div>
    <div class="cd-rows">
      ${infoRow('clock', e.start_at == null ? 'Any time · one-off job' : `${esc(e.when)} · ${hours}`)}
      ${infoRow('pin', `${esc(e.place_name || 'In the township')}${dist != null ? ` · ${fmtDist(dist)} from you` : ''}`)}
    </div>
    ${e.description ? `<p class="cd-quote">${esc(e.description)}</p>` : ''}
    <div class="slots-bar"><div><span>${e.joined} of ${e.slots} places taken</span><b>${credits(e.credits)} each</b></div>
      <i style="--w:${Math.round(Math.min(1, e.joined / e.slots) * 100)}%"></i></div>
    ${going}
    ${insight}
    ${buttons.length ? `<div class="cd-actions">${buttons.join('')}</div>` : ''}`;
  return {html, actions, tone: 'community'};
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
