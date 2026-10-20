/* Resident avatars: a stable, illustrated face for every resident, generated from their id.
 *
 * There are no profile photos in the prototype, and initials alone read as accounts, not
 * people. Each resident instead gets a small flat portrait -- background, skin tone, hair
 * style and colour, clothing, the odd pair of glasses -- chosen by hashing their resident
 * id. The same id always draws the same face, on every refresh and on every client.
 */

const AVATAR_BG = ['#ffd6a5', '#caffbf', '#9bf6ff', '#bdb2ff', '#ffc6ff', '#fdffb6',
                   '#a0c4ff', '#ffadad', '#b9fbc0', '#f1c0e8', '#cfbaf0', '#90dbf4'];
const AVATAR_SKIN = ['#f7d7c4', '#eec1a0', '#d9a27e', '#c08562', '#a46a4a', '#7d4e35'];
const AVATAR_HAIR = ['#1f1a17', '#2e211b', '#4a3226', '#6b4a33', '#a0703e', '#2b2b38', '#7a7a80'];
const AVATAR_SHIRT = ['#2ec4a6', '#4f9dff', '#ff8a3d', '#a78bfa', '#f4577b', '#334155',
                      '#0ea5e9', '#22c55e', '#eab308', '#64748b'];

function hashId(id) {
  // FNV-1a, so neighbouring ids (R001, R002) land far apart.
  let h = 2166136261;
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickFrom(list, h, salt) {
  return list[(Math.imul(h ^ salt, 2654435761) >>> 0) % list.length];
}

const avatarCache = new Map();

/** An inline SVG portrait for a resident id. */
function avatarSvg(id) {
  if (avatarCache.has(id)) return avatarCache.get(id);
  const h = hashId(id);
  const bg = pickFrom(AVATAR_BG, h, 0x11);
  const skin = pickFrom(AVATAR_SKIN, h, 0x23);
  const hair = pickFrom(AVATAR_HAIR, h, 0x37);
  const shirt = pickFrom(AVATAR_SHIRT, h, 0x4b);
  const style = (Math.imul(h ^ 0x59, 2246822519) >>> 0) % 6;
  const glasses = ((h >>> 7) % 5) === 0;

  // Hair drawn behind the head (long styles) and in front of it (fringes, caps).
  const back = {
    1: `<path d="M18 31c0-9.5 6.2-15 14-15s14 5.5 14 15v15H18z" fill="${hair}"/>`,
    4: `<path d="M19 30c0-9 5.8-14 13-14s13 5 13 14v8c-2 2-4 2-5 0V30H24v8c-1 2-3 2-5 0z" fill="${hair}"/>`,
  }[style] || '';
  const front = [
    `<path d="M19.6 30.5c-.5-8.3 5.2-13.6 12.4-13.6s12.9 5.3 12.4 13.6c-2.4-4.6-6.6-6.6-12.4-6.6s-10 2-12.4 6.6z" fill="${hair}"/>`,
    `<path d="M19.4 31c-.6-8.6 5.2-14 12.6-14s13.2 5.4 12.6 14c-1.8-3.4-4.7-5.8-8.2-6.7-2.3 2.3-7 3.6-11.2 3.2-2.4.7-4.4 1.9-5.8 3.5z" fill="${hair}"/>`,
    `<circle cx="32" cy="14.2" r="5.2" fill="${hair}"/><path d="M19.8 30c-.2-8 5.4-12.9 12.2-12.9S44.4 22 44.2 30c-2.6-3.8-6.6-5.6-12.2-5.6S22.4 26.2 19.8 30z" fill="${hair}"/>`,
    `<g fill="${hair}"><circle cx="22" cy="24" r="4.6"/><circle cx="27" cy="19.5" r="4.8"/><circle cx="33" cy="18" r="5"/><circle cx="38.8" cy="20" r="4.8"/><circle cx="42.6" cy="24.8" r="4.3"/></g>`,
    `<path d="M20 29.5c.4-7.6 5.6-12 12-12s11.6 4.4 12 12c-3-3.6-7-5-12-5s-9 1.4-12 5z" fill="${hair}"/>`,
    `<path d="M19.5 26.5c.8-6.5 5.8-10 12.5-10s11.7 3.5 12.5 10z" fill="${shirt}"/><path d="M18 26.5h28.5c.8 0 .8 2.4 0 2.4H18c-.8 0-.8-2.4 0-2.4z" fill="${shirt}" opacity=".8"/>`,
  ][style];
  const eyes = glasses
    ? `<g fill="none" stroke="#1f2937" stroke-width="1.2"><circle cx="27.6" cy="32.4" r="2.9"/><circle cx="36.4" cy="32.4" r="2.9"/><path d="M30.5 32.4h3"/></g><circle cx="27.6" cy="32.6" r="1" fill="#1f2937"/><circle cx="36.4" cy="32.6" r="1" fill="#1f2937"/>`
    : `<circle cx="27.6" cy="32.6" r="1.25" fill="#1f2937"/><circle cx="36.4" cy="32.6" r="1.25" fill="#1f2937"/>`;

  const svg = `<svg viewBox="0 0 64 64" class="av-svg" aria-hidden="true">` +
    `<rect width="64" height="64" fill="${bg}"/>` +
    back +
    `<path d="M12 64c1.5-11 9.5-16.5 20-16.5S50.5 53 52 64z" fill="${shirt}"/>` +
    `<path d="M27.5 44.5h9v5.5c-2.6 2-6.4 2-9 0z" fill="${skin}"/>` +
    `<circle cx="32" cy="31.5" r="12.6" fill="${skin}"/>` +
    front + eyes +
    `<path d="M28.8 37.6c1.9 1.7 4.5 1.7 6.4 0" fill="none" stroke="#7c3a2d" stroke-width="1.3" stroke-linecap="round"/>` +
    `<circle cx="24.6" cy="36.4" r="1.7" fill="#f28b82" opacity=".35"/><circle cx="39.4" cy="36.4" r="1.7" fill="#f28b82" opacity=".35"/>` +
    `</svg>`;
  avatarCache.set(id, svg);
  return svg;
}

/** An avatar chip: portrait, optional status ring, optional verified badge. */
function avatarHtml(id, {size = 32, status = null, verified = false, cls = ''} = {}) {
  const ring = status && STATUSES[status] ? `--ring:${STATUSES[status].color};` : '';
  return `<span class="av ${ring ? 'has-ring' : ''} ${cls}" ` +
    `style="width:${size}px;height:${size}px;${ring}">` +
    avatarSvg(id) +
    (verified ? `<i class="av-verified" title="Verified resident">${icon('check', 8)}</i>` : '') +
    `</span>`;
}

/** A small overlapping stack of avatars, e.g. the neighbours a task pinged. */
function avatarStack(ids, size = 24, max = 4) {
  const shown = ids.slice(0, max);
  const more = ids.length - shown.length;
  return `<span class="av-stack">${shown.map((id) => avatarHtml(id, {size})).join('')}` +
    (more > 0 ? `<span class="av-more" style="width:${size}px;height:${size}px">+${more}</span>` : '') +
    `</span>`;
}
