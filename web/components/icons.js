/* Icons: a small, self-contained stroke icon set (24x24, currentColor).
 *
 * Drawn for this app rather than pulled from a package, so the page stays offline and
 * dependency-free. `icon(name, size)` returns an inline <svg> string.
 */

const ICON_PATHS = {
  drop: '<path d="M12 3.5s6 6.4 6 10.8a6 6 0 0 1-12 0C6 9.9 12 3.5 12 3.5z"/>',
  briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.8A1.3 1.3 0 0 1 10.3 4.5h3.4A1.3 1.3 0 0 1 15 5.8v1.7"/><path d="M3.5 12.5h17"/>',
  car: '<path d="M5 16.5h14v-4.2L17.2 7.6A2 2 0 0 0 15.3 6H8.7a2 2 0 0 0-1.9 1.6L5 12.3z"/><path d="M5 12.3h14"/><circle cx="8" cy="16.8" r="1.7"/><circle cx="16" cy="16.8" r="1.7"/>',
  wrench: '<path d="M14.6 6.4a4 4 0 0 0-5.3 5.3L3.8 17.2a1.6 1.6 0 0 0 2.3 2.3l5.5-5.5a4 4 0 0 0 5.3-5.3l-2.4 2.4-2.3-.5-.5-2.3z"/>',
  cap: '<path d="M2.5 9.2 12 4.5l9.5 4.7L12 14z"/><path d="M6.5 11.3v4.6c3 2.2 8 2.2 11 0v-4.6"/><path d="M21.5 9.2v5.3"/>',
  sprout: '<path d="M12 20.5v-8"/><path d="M12 12.5c0-4.2 2.8-7 7.5-7 0 4.6-2.8 7-7.5 7z"/><path d="M12 14.5c0-3-2-5-5.5-5 0 3.1 2 5 5.5 5z"/>',
  store: '<path d="M4 9.5 5.6 4.5h12.8L20 9.5"/><path d="M4 9.5h16v1.2a2.7 2.7 0 0 1-5.3 0 2.7 2.7 0 0 1-5.4 0 2.7 2.7 0 0 1-5.3 0z"/><path d="M5.5 13v7.5h13V13"/><path d="M10 20.5v-4.5h4v4.5"/>',
  train: '<rect x="5.5" y="3" width="13" height="13" rx="3.5"/><path d="M5.5 10h13"/><path d="M9 13.2h.01M15 13.2h.01"/><path d="m8.5 19.5-1.5 2M15.5 19.5l1.5 2M8 16.5l.5 3h7l.5-3"/>',
  home: '<path d="m3.5 11 8.5-7 8.5 7"/><path d="M5.5 9.5v10.5h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  bell: '<path d="M6 16.5v-5a6 6 0 0 1 12 0v5l1.5 1.8h-15z"/><path d="M10 21h4"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  sparkle: '<path d="M11 3.5 12.8 8.7 18 10.5l-5.2 1.8L11 17.5l-1.8-5.2L4 10.5l5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.6 9.2c-.4-.9-1.4-1.5-2.6-1.5-1.5 0-2.6.8-2.6 1.9 0 2.6 5.3 1.4 5.3 4.4 0 1.2-1.2 2.1-2.7 2.1-1.3 0-2.3-.6-2.7-1.6"/><path d="M12 6v1.7M12 16.1v1.9"/>',
  list: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="m3.8 6.5 1.2 1.2 2-2.2M3.8 12l1.2 1.2 2-2.2M3.8 17.5l1.2 1.2 2-2.2"/>',
  users: '<circle cx="9" cy="8" r="3.3"/><path d="M3 19.5c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14c2.7 0 4.5 2 4.5 4.8"/>',
  gift: '<rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5.5 12.5v8h13v-8M12 8v12.5"/><path d="M12 8C10.5 4.5 7 4.3 7 6.4 7 7.6 9 8 12 8zM12 8c1.5-3.5 5-3.7 5-1.6C17 7.6 15 8 12 8z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  route: '<circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="5.5" r="2"/><path d="M8 18.5h8a3.2 3.2 0 0 0 0-6.5H8a3.2 3.2 0 0 1 0-6.5h8"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1.1 5.8L12 16.8l-5.3 2.8 1.1-5.8-4.3-4.1 5.9-.8z"/>',
  shield: '<path d="M12 3 19.5 6v5.8c0 4.5-3.2 7.9-7.5 9.2-4.3-1.3-7.5-4.7-7.5-9.2V6z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
  walk: '<circle cx="13.5" cy="4.5" r="1.8"/><path d="m10 21 1.8-5.5 2.4 2.2V21"/><path d="m7.5 12.5 2.8-3.8 3.7.8 1.8 3.3 2.7 1"/><path d="m11.8 15.5-1.5-6.8"/>',
  message: '<path d="M4.5 5h15v10.5H10l-4.5 4z"/>',
  megaphone: '<path d="M3.5 10.5v3a1 1 0 0 0 1 1H7l6 4V5.5l-6 4H4.5a1 1 0 0 0-1 1z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.8M12 18.7v2.8M2.5 12h2.8M18.7 12h2.8M5.3 5.3l2 2M16.7 16.7l2 2M5.3 18.7l2-2M16.7 7.3l2-2"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  locate: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4M12 16.8h.01"/>',
  swap: '<path d="M7 7h12l-3.5-3.5M17 17H5l3.5 3.5"/>',
  layers: '<path d="m12 3.5 9 4.8-9 4.8-9-4.8z"/><path d="m3 12.5 9 4.8 9-4.8"/>',
  heart: '<path d="M12 20s-7.5-4.5-7.5-10a4.3 4.3 0 0 1 7.5-2.8A4.3 4.3 0 0 1 19.5 10c0 5.5-7.5 10-7.5 10z"/>',
  flag: '<path d="M5.5 21V4.5"/><path d="M5.5 4.5h11l-2 4 2 4h-11"/>',
};

function icon(name, size = 18, cls = '') {
  const body = ICON_PATHS[name] || ICON_PATHS.sparkle;
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${body}</svg>`;
}

/* The six things that happen on the grid, one colour and one icon each. Everything that
 * shows a category -- map markers, cards, filters, the legend -- reads from here. */
const CATEGORIES = {
  ride:       {label: 'Ride / Carpool', short: 'Ride',      icon: 'car',    color: '#4f9dff', rgb: [79, 157, 255]},
  help:       {label: 'Help / Skills',  short: 'Help',      icon: 'wrench', color: '#ff8a3d', rgb: [255, 138, 61]},
  tutoring:   {label: 'Tutoring',       short: 'Tutoring',  icon: 'cap',    color: '#a78bfa', rgb: [167, 139, 250]},
  community:  {label: 'Community',      short: 'Community', icon: 'sprout', color: '#34d399', rgb: [52, 211, 153]},
  commercial: {label: 'Commercial',     short: 'Commercial', icon: 'store', color: '#f4577b', rgb: [244, 87, 123]},
  transit:    {label: 'Transit',        short: 'Transit',   icon: 'train',  color: '#38bdf8', rgb: [56, 189, 248]},
};

/* People's states. Shown as the ring round every avatar. */
const STATUSES = {
  available: {label: 'Available', color: '#34d399'},
  busy:      {label: 'On a task', color: '#f5b544'},
  moving:    {label: 'On the move', color: '#4f9dff'},
  offline:   {label: 'Offline',   color: '#7c8698'},
};
