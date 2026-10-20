/* Map markers: people, tasks and places as HTML pinned to 3D positions.
 *
 * deck.gl draws the township; the things a resident cares about -- neighbours, requests,
 * shops, stations -- are DOM elements positioned over it every animation frame by
 * projecting their [lon, lat, altitude] through the live viewport. That buys real avatars,
 * icons, rings and CSS animation without a texture atlas, at the cost of a few dozen
 * transforms a frame.
 *
 * Moving people are interpolated between the 4 Hz snapshots so they glide rather than
 * step. Markers are depth-sorted by screen y, so nearer ones sit on top.
 */

/* Offsets, in marker widths, tried in order when a marker would land on another. */
const SPIRAL = [[0, 0], [1, 0], [-1, 0], [0.5, -0.9], [-0.5, -0.9], [0.5, 0.9], [-0.5, 0.9],
                [2, 0], [-2, 0], [1.5, -0.9], [-1.5, -0.9], [1.5, 0.9], [-1.5, 0.9], [0, -1.8], [0, 1.8]];

const Markers = {
  root: null,
  items: new Map(),       // key -> {el, from, to, t0, z, kind, data}
  running: false,
  scale: 1,

  init(root) {
    this.root = root;
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-marker]');
      if (!el) return;
      e.stopPropagation();
      const item = this.items.get(el.dataset.marker);
      if (item?.onClick) item.onClick(item.data);
    });
    // Keep the map's own click handling (deck.gl) from treating marker clicks as clicks
    // on empty ground, which would close the card the marker just opened.
    for (const type of ['pointerdown', 'pointerup']) {
      root.addEventListener(type, (e) => { if (e.target.closest('[data-marker]')) e.stopPropagation(); });
    }
    this.loop();
  },

  /** Replace the marker set. Each spec: {key, kind, lonlat, z, html, cls, onClick, data, glide}. */
  sync(specs) {
    const now = performance.now();
    const seen = new Set();
    for (const s of specs) {
      seen.add(s.key);
      let item = this.items.get(s.key);
      if (!item) {
        const el = document.createElement('div');
        el.className = `mk mk-${s.kind} mk-enter`;
        el.dataset.marker = s.key;
        this.root.appendChild(el);
        requestAnimationFrame(() => el.classList.remove('mk-enter'));
        item = {el, from: s.lonlat, to: s.lonlat, t0: now, html: ''};
        this.items.set(s.key, item);
      }
      if (s.glide && item.to && (item.to[0] !== s.lonlat[0] || item.to[1] !== s.lonlat[1])) {
        item.from = this.current(item, now);
        item.t0 = now;
      } else if (!s.glide) {
        item.from = s.lonlat;
      }
      item.to = s.lonlat;
      item.z = s.z || 0;
      item.kind = s.kind;
      item.fixed = !!s.fixed;
      item.data = s.data;
      item.onClick = s.onClick;
      const cls = `mk mk-${s.kind} ${s.cls || ''}`;
      if (item.el.className.replace(' mk-enter', '') !== cls) item.el.className = cls;
      if (item.html !== s.html) { item.el.innerHTML = s.html; item.html = s.html; }
      if (s.title) item.el.title = s.title;
    }
    for (const [key, item] of this.items) {
      if (!seen.has(key)) {
        item.el.classList.add('mk-leave');
        this.items.delete(key);
        setTimeout(() => item.el.remove(), 260);
      }
    }
  },

  current(item, now) {
    const f = Math.min(1, (now - item.t0) / 260);
    return [item.from[0] + (item.to[0] - item.from[0]) * f,
            item.from[1] + (item.to[1] - item.from[1]) * f];
  },

  /** Project every marker through the live viewport. Cheap enough to run every frame. */
  position() {
    if (!deckgl || !this.root) return;
    const viewport = deckgl.getViewports()[0];
    if (!viewport) return;
    const now = performance.now();
    // Markers grow a little as the camera comes in, and shrink when it pulls back.
    const scale = Math.max(0.62, Math.min(1.12, 0.62 + (viewport.zoom - 14.4) * 0.22));
    if (Math.abs(scale - this.scale) > 0.01) {
      this.scale = scale;
      this.root.style.setProperty('--mk-scale', scale.toFixed(3));
    }
    const W = viewport.width, H = viewport.height;
    const projected = [];
    for (const item of this.items.values()) {
      const [lon, lat] = this.current(item, now);
      const p = viewport.project([lon, lat, item.z]);
      const visible = Number.isFinite(p[0]) && p[0] > -60 && p[0] < W + 60 && p[1] > -60 && p[1] < H + 60;
      if (!visible) {
        if (item.el.style.display !== 'none') item.el.style.display = 'none';
        continue;
      }
      if (item.el.style.display === 'none') item.el.style.display = '';
      projected.push({item, x: p[0], y: p[1], rank: this.rank(item)});
    }

    // Declutter: when neighbours and requests crowd one street, fan the later ones out
    // round the first along a fixed spiral, so every face and pin stays clickable. The
    // order is fixed (selected, you, requests, people, places), so nothing jumps around.
    projected.sort((a, b) => a.rank - b.rank || a.y - b.y);
    const placed = [];
    const min = 34 * scale;
    for (const q of projected) {
      // Fixed markers sit exactly on their 3D point -- a resident on Level 7 directly
      // under one on Level 8 must not be nudged sideways to make room.
      if (q.item.fixed) {
        q.item.el.style.transform = `translate3d(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px, 0)`;
        q.item.el.style.zIndex = String(1000 + Math.round(q.y));
        continue;
      }
      // Places float above roofs and are labels, not dots; they only avoid each other.
      const others = q.item.kind === 'place' ? placed.filter((o) => o.place) : placed.filter((o) => !o.place);
      let x = q.x, y = q.y;
      for (let k = 0; k < SPIRAL.length; k++) {
        const cx = q.x + SPIRAL[k][0] * min, cy = q.y + SPIRAL[k][1] * min * (q.item.kind === 'place' ? 0.75 : 1);
        if (!others.some((o) => Math.abs(o.x - cx) < (q.item.kind === 'place' ? 120 * scale : min) &&
                                Math.abs(o.y - cy) < (q.item.kind === 'place' ? 26 * scale : min))) {
          x = cx; y = cy; break;
        }
      }
      placed.push({x, y, place: q.item.kind === 'place'});
      q.item.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      q.item.el.style.zIndex = String(1000 + Math.round(y) + (q.item.el.classList.contains('sel') ? 5000 : 0));
    }
  },

  rank(item) {
    const cls = item.el.classList;
    if (cls.contains('sel')) return 0;
    if (cls.contains('you')) return 1;
    return {task: 2, person: 3, place: 4}[item.kind] ?? 5;
  },

  loop() {
    const tick = () => {
      this.position();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
