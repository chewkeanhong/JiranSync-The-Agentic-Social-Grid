/* JiranSync facade rendering.
 *
 * Makes the extruded OSM footprints read as a city without changing a single vertex.
 * The footprint, the ground altitude and the height are still the data the raycaster
 * uses; what changes is how each pixel of a wall or roof is shaded:
 *
 *   - a storey/bay grid laid out in real metres on every facade (3-3.8 m storeys),
 *   - glass that reflects a blue-hour sky, brighter towards the top of a tower,
 *   - a seeded share of windows lit warm from inside,
 *   - balcony slabs on residential blocks, a lit shopfront along commercial podiums,
 *   - a crown light on the skyscrapers,
 *   - contact darkening where a wall meets the street, and distance haze.
 *
 * It is a deck.gl LayerExtension: a few lines injected into SolidPolygonLayer's shaders.
 * Lighting is already computed per vertex by deck.gl; this only adds detail on top, in
 * the fragment shader, at a cost of a hash and a few smoothsteps per pixel. When window
 * cells shrink below a couple of pixels the pattern fades to its average colour, so a
 * zoomed-out city does not shimmer.
 *
 * The material class rides in the fill colour's alpha channel (255 - class) and the
 * shader restores full opacity, so no extra attribute is needed. Class 0 means "draw flat":
 * status colours (dark, blocker, selected) are never patterned and read exactly as before.
 */

/* eslint-disable no-unused-vars */

const FACADE = {GLASS: 1, OFFICE: 2, RESIDENTIAL: 3, COMMERCIAL: 4, LOWRISE: 5, LANDED: 6, CIVIC: 7,
                SHOPLOT: 8, INDUSTRIAL: 9};

/* Base materials, muted and cool so the city keeps its dark-blue identity under
 * blue-hour light. Each building is jittered a few levels by a hash of its id, which both
 * breaks up uniform blocks and seeds its own window pattern. */
/* Many subtle materials rather than one blue tint: dark blue-grey glass, neutral and
 * warm concrete, warm residential render, grey-brown low-rise. Saturation stays low --
 * colour in this scene belongs to the windows, the network and the incident. */
const FACADE_TONE = {
  [FACADE.GLASS]:       [[54, 64, 80], [62, 70, 84], [50, 60, 74]],
  [FACADE.OFFICE]:      [[132, 134, 138], [146, 140, 132], [120, 126, 136]],
  [FACADE.RESIDENTIAL]: [[156, 144, 128], [148, 140, 130], [162, 150, 136]],
  [FACADE.COMMERCIAL]:  [[116, 120, 126], [128, 124, 118], [108, 114, 122]],
};
/* Malaysian landed housing: link and terrace houses in white and cream render. Their
 * roofs (clay tile or slate) are chosen in the shader, which knows a roof from a wall. */
const LANDED_TONES = [[196, 188, 172], [188, 182, 170], [204, 194, 176], [182, 176, 166],
                      [198, 186, 164], [176, 172, 168]];
/* Schools, surau, temples, halls: pale walls; the shader gives them a teal or clay roof. */
const CIVIC_TONES = [[184, 182, 172], [176, 180, 176], [190, 184, 170]];
/* Shop lots: painted render over the ground-floor shops; the shader adds the storefronts,
 * signboards and five-foot way. */
const SHOPLOT_TONES = [[178, 170, 156], [168, 164, 160], [186, 176, 158], [160, 158, 150]];
/* Factories and warehouses: profiled metal cladding. */
const INDUSTRIAL_TONES = [[132, 138, 142], [146, 148, 146], [120, 128, 134]];
const LOWRISE_TONES = [[132, 118, 104], [112, 112, 114], [142, 132, 116], [104, 104, 108],
                       [126, 114, 108], [118, 120, 112]];

const RESIDENTIAL_KINDS = new Set(['apartments', 'residential', 'house', 'dormitory', 'hotel']);
const LANDED_KINDS = new Set(['house', 'terrace', 'detached', 'semidetached_house', 'bungalow',
                              'townhouse', 'residential', 'yes']);
const COMMERCIAL_KINDS = new Set(['commercial', 'retail', 'mall', 'supermarket']);

function idHash(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

/** Material class and base colour from the building's visual type (architecture.js:
 *  buildingType, inferred from its OSM class, role, height and footprint). */
function facadeMaterial(feature, role) {
  const p = feature.properties;
  const h = p.height || 10;
  const kind = p.building || 'yes';
  const type = typeof buildingType === 'function' ? buildingType(feature, role) : null;
  let cls;
  if (h >= 150 || (kind === 'office' && h >= 80)) cls = FACADE.GLASS;
  else if (type === 'civic' || role === 'civic') cls = FACADE.CIVIC;
  else if (type === 'industrial') cls = FACADE.INDUSTRIAL;
  else if (type === 'shoplot') cls = FACADE.SHOPLOT;
  else if (type === 'commercial' || role === 'shop' || COMMERCIAL_KINDS.has(kind)) cls = FACADE.COMMERCIAL;
  else if (type === 'apartment' || type === 'condominium' || type === 'highrise') cls = FACADE.RESIDENTIAL;
  else if (type === 'landed_residential' || (h < 12 && role === 'home' && LANDED_KINDS.has(kind))) cls = FACADE.LANDED;
  else if (h < 12) cls = FACADE.LOWRISE;
  else if (RESIDENTIAL_KINDS.has(kind)) cls = FACADE.RESIDENTIAL;
  else if (COMMERCIAL_KINDS.has(kind)) cls = FACADE.COMMERCIAL;
  else cls = FACADE.OFFICE;

  const r = idHash(feature.id || '');
  const palette = cls === FACADE.LOWRISE ? LOWRISE_TONES : cls === FACADE.LANDED ? LANDED_TONES
    : cls === FACADE.CIVIC ? CIVIC_TONES : cls === FACADE.SHOPLOT ? SHOPLOT_TONES
    : cls === FACADE.INDUSTRIAL ? INDUSTRIAL_TONES : FACADE_TONE[cls];
  const base = palette[Math.floor(r * 997) % palette.length];
  const j = Math.round((r - 0.5) * 12);
  const tone = base.map((c) => Math.max(0, Math.min(255, c + j)));
  return {cls, tone};
}

/* GLSL. REF/MX/MY are baked in from the server's projection frame, so the window grid is
 * laid out in the same metres the raycaster measures in, and stays fixed to the facade as
 * the camera pans (positions are rebuilt from their 64-bit low parts, good to centimetres). */
function facadeShaders(originLon, originLat) {
  const M = 6371000.0 * Math.PI / 180.0;
  const mx = (M * Math.cos(originLat * Math.PI / 180)).toFixed(4);
  const my = M.toFixed(4);
  const ref = `vec2(${originLon.toFixed(7)}, ${originLat.toFixed(7)})`;

  const vsDecl = `
out float vFacadeU;
out float vFacadeH;
out float vFacadeTop;
out float vFacadeSide;
out vec4 vFacadeBase;
out float vFacadeDist;
`;
  const vsMain = `
{
  vec2 fDeg = (props.positions.xy - ${ref}) + props.positions64Low.xy;
  vec2 fM = fDeg * vec2(${mx}, ${my});
  vec2 fT = vec2(props.normal.y * ${mx}, -props.normal.x * ${my});
  float fL = length(fT);
  vFacadeSide = fL > 1e-7 ? 1.0 : 0.0;
  vFacadeU = fL > 1e-7 ? dot(fM, fT / fL) : fM.x;
  vFacadeH = props.elevations * elevationScale;
  vFacadeTop = elevations * elevationScale;
  vFacadeBase = isWireframe ? lineColors : fillColors;
  vFacadeDist = length(geometry.position.xyz - project_uCameraPosition)
                / max(project_uCommonUnitsPerMeter.z, 1e-9);
}
`;
  const fsDecl = `
in float vFacadeU;
in float vFacadeH;
in float vFacadeTop;
in float vFacadeSide;
in vec4 vFacadeBase;
in float vFacadeDist;

float facadeHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float facadeBox(vec2 f, vec2 lo, vec2 hi, vec2 aa) {
  vec2 a = smoothstep(lo - aa, lo + aa, f) * (1.0 - smoothstep(hi - aa, hi + aa, f));
  return a.x * a.y;
}

vec4 facadeShade(vec4 litColor) {
  float code = floor((1.0 - vFacadeBase.a) * 255.0 + 0.5);
  vec3 col = litColor.rgb;
  float h = vFacadeH;
  // Contact darkening: a wall meets the street in shadow.
  float ao = mix(0.5, 1.0, smoothstep(0.0, 14.0, h));

  if (code < 0.5 || code > 12.5) {
    // Status colours and overlays stay flat; only grounded.
    if (vFacadeSide > 0.5) col *= mix(0.72, 1.0, smoothstep(0.0, 10.0, h));
  } else if (vFacadeSide < 0.5) {
    // Roofs: matte concrete and plant, well below the walls -- at blue hour the sky is
    // dim overhead, so a roof must not read as the brightest surface in the scene.
    float seed = facadeHash(vFacadeBase.rg * 255.0 + code);
    if (code == 6.0) {
      // Landed homes: clay tile in two tones, and a share of grey slate.
      vec3 tile = seed < 0.42 ? vec3(0.50, 0.24, 0.16) : (seed < 0.74 ? vec3(0.58, 0.32, 0.20)
                                                                      : vec3(0.26, 0.28, 0.31));
      col = tile * (0.70 + 0.22 * facadeHash(vFacadeBase.gb * 97.0));
    } else if (code == 7.0) {
      // Civic: the teal and green roofs of schools and surau, or clay.
      col = (seed < 0.6 ? vec3(0.17, 0.38, 0.38) : vec3(0.48, 0.25, 0.17)) * 0.85;
    } else if (code == 9.0) {
      // Factory roof: profiled metal sheet, its ribs running down the slope.
      float rib = step(0.5, fract(vFacadeU / 1.0));
      col = vec3(0.40, 0.42, 0.44) * (0.82 + 0.10 * rib) * (0.9 + 0.1 * seed);
    } else {
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lum), col, 0.5) * (0.42 + 0.12 * seed);
      // Some roofs catch the city glow from below the skyline.
      col += vec3(0.05, 0.035, 0.02) * step(0.7, seed);
    }
  } else {
    float seed = facadeHash(vFacadeBase.rg * 255.0 + vFacadeBase.b * 31.0);
    // How lived-in this building is tonight: a quarter mostly dark, half medium, a
    // quarter bright. Variation between buildings is what makes a city read as alive.
    float mood = facadeHash(vec2(seed * 71.0, code));
    // Most buildings stay relatively dark: 45 % nearly dark, 40 % medium, 15 % busy.
    float busy = mood < 0.45 ? 0.15 : (mood < 0.85 ? 0.6 : 1.1);
    bool glass = code == 1.0;
    bool homes = code == 3.0;
    bool landed = code == 6.0;
    bool civic = code == 7.0;
    bool shoplot = code == 8.0;
    bool industrial = code == 9.0;
    bool low = code == 5.0 || landed;
    // Deterministic per building: four facade designs for apartments, from its id hash.
    float variant = floor(facadeHash(vec2(seed * 13.0, code + 7.0)) * 4.0);
    // Rows of link houses (6.5 m frontage) and shop lots (6.1 m) read as separate units.
    float unitW = landed ? 6.5 : (industrial ? 12.0 : 6.1);
    float unitId = floor(vFacadeU / unitW);
    float unitF = fract(vFacadeU / unitW);
    float unitSeed = facadeHash(vec2(unitId * 0.71 + 3.0, seed * 31.0));
    float lightK = dot(col, vec3(0.299, 0.587, 0.114)) / 0.70;
    float storey = homes ? 3.0 : (glass ? 3.8 : (civic ? 3.8 : (industrial ? 6.0 : (landed ? 3.2 : 3.5))));
    float bay = glass ? 1.5 : (homes ? (variant == 2.0 ? 2.6 : 3.4) : (landed ? 3.25
              : (shoplot ? 3.05 : (industrial ? 8.0 : (low ? 4.2 : 2.6)))));
    vec2 cell = vec2(vFacadeU / bay, h / storey);
    // Level of detail: as windows shrink on screen they are grouped 2x2, 4x4, ... so a
    // distant tower still shows warm lit clusters instead of shimmering or going flat.
    vec2 aa0 = fwidth(cell);
    float group = exp2(max(0.0, ceil(log2(max(max(aa0.x, aa0.y), 1e-4) / 0.22))));
    // Beyond 16x grouping the pattern fades to its average: no moire at the horizon.
    float lod = smoothstep(8.0, 16.0, group);
    float share = (homes ? 0.30 : (glass ? 0.20 : (low ? 0.24 : 0.22))) * busy;
    float up = clamp(h / max(vFacadeTop, 1.0), 0.0, 1.0);
    vec3 sky = mix(vec3(0.07, 0.09, 0.13), vec3(0.24, 0.30, 0.40), up);
    // Sky-lit from above: walls brighten gently with height, so tall reads tall.
    vec3 wall = (glass ? col * 0.72 : col) * mix(0.86, 1.10, up);
    if (landed) {
      // Each house in a row painted its own way, with a party wall between them.
      float k = floor(unitSeed * 6.0);
      vec3 tint = k < 1.0 ? vec3(0.86, 0.83, 0.76) : (k < 2.0 ? vec3(0.92, 0.91, 0.88)
                : (k < 3.0 ? vec3(0.74, 0.76, 0.74) : (k < 4.0 ? vec3(0.72, 0.77, 0.66)
                : (k < 5.0 ? vec3(0.88, 0.75, 0.62) : vec3(0.70, 0.75, 0.82)))));
      wall = tint * 0.62 * lightK * mix(0.88, 1.08, up);
      float edge = min(unitF, 1.0 - unitF) * unitW;
      wall *= 1.0 - 0.38 * (1.0 - smoothstep(0.10, 0.28, edge));
    } else if (homes && variant == 3.0) {
      // Two-tone: panels of three bays in a lighter render.
      wall *= mod(floor(vFacadeU / (bay * 3.0)), 2.0) > 0.5 ? vec3(1.10, 1.07, 1.02) : vec3(0.94);
    } else if (industrial) {
      // Profiled cladding, faded out where the ribs would shimmer.
      float rib = sin(6.2832 * vFacadeU / 0.8);
      wall *= 1.0 + 0.07 * rib * (1.0 - smoothstep(0.3, 0.8, fwidth(vFacadeU / 0.8)));
    }
    if (lod > 0.999) {
      // Fully faded: the average directly, without the per-window work.
      vec3 pane0 = mix(col * 0.5, sky, glass ? 0.78 : 0.42);
      float area0 = glass ? 0.81 : (homes ? 0.36 : 0.45);
      // Far low-rise reads as a simple dark silhouette.
      col = mix(wall, mix(pane0, vec3(0.9, 0.74, 0.56), share * 0.5), area0) * ao * (low ? 0.8 : 1.0);
    } else {
    cell /= group;
    vec2 id = floor(cell);
    vec2 f = fract(cell);
    // Derivatives must not be taken inside a divergent branch; the grouped cell's is
    // simply the ungrouped one divided by the (locally constant) group size.
    vec2 aa = aa0 / group;

    vec2 lo = glass ? vec2(0.05, 0.08) : (homes ? vec2(0.18, 0.30) : vec2(0.14, 0.22));
    vec2 hi = glass ? vec2(0.95, 0.97) : (homes ? vec2(0.82, 0.86) : vec2(0.86, 0.84));
    if (homes && variant == 2.0) {
      // Full-height balcony doors behind a railing.
      lo = vec2(0.16, 0.06); hi = vec2(0.84, 0.88);
    }
    if (landed) { lo = vec2(0.24, 0.34); hi = vec2(0.76, 0.80); }
    if (shoplot) { lo = vec2(0.20, 0.28); hi = vec2(0.80, 0.80); }
    float win = facadeBox(f, lo, hi, aa * 0.75);
    // The glass sits back from the wall: a darker reveal round each opening, and a sill.
    float inner = facadeBox(f, lo + vec2(0.05, 0.06), hi - vec2(0.05, 0.03), aa * 0.75);
    float reveal = max(win - inner, 0.0);
    float sill = facadeBox(f, vec2(lo.x - 0.02, lo.y - 0.05), vec2(hi.x + 0.02, lo.y), aa * 0.75) * (1.0 - win);
    float area = (hi.x - lo.x) * (hi.y - lo.y);

    // Glass reflects the blue-hour sky, more of it higher up the tower.
    vec3 pane = mix(col * 0.5, sky, glass ? 0.72 : 0.38);
    // Glass: vertical reflection bands, column by column, rather than a flat sheet.
    float streak = glass ? 0.78 + 0.42 * facadeHash(vec2(id.x * 0.61, seed)) : 1.0;
    pane *= streak * (0.88 + 0.24 * facadeHash(id * 0.37 + seed));

    // A seeded share of interiors lit warm.
    float lit = step(facadeHash(id + seed * 113.0), share) * step(1.0, id.y);
    // Towers: now and then a whole occupied floor, the way an office tower reads at dusk.
    if (glass || vFacadeTop > 90.0) {
      float floorLit = step(facadeHash(vec2(id.y * 0.83, seed * 17.0)), 0.07 * busy);
      lit = max(lit, floorLit * step(0.25, facadeHash(id + 3.1)));
    }
    // Soft warm white to muted amber, never saturated yellow.
    vec3 warm = mix(vec3(0.92, 0.70, 0.48), vec3(0.95, 0.88, 0.76), facadeHash(id * 1.7 + seed));
    // Grouped (distant) cells stand for several windows: dim them so a far facade glows
    // faintly instead of showing blocks of bright yellow.
    float dimFar = mix(1.0, 0.45, clamp(log2(group) / 3.0, 0.0, 1.0));
    float glow = (0.48 + 0.30 * facadeHash(id + 7.0)) * dimFar;
    vec3 windowCol = mix(pane, warm * glow, lit);

    if (homes) {
      // Balcony slabs: a lighter band at each floor line.
      wall = mix(wall, wall * 1.4, 1.0 - smoothstep(0.0, 0.10 + aa.y, f.y));
    }
    vec3 detailed = mix(wall, windowCol, inner);
    detailed = mix(detailed, wall * 0.48, reveal);
    detailed = mix(detailed, wall * 1.25, sill * 0.7);
    if (homes && variant != 1.0) {
      // Balcony railings: glass panels with a bright top rail, in front of each opening.
      float railZone = 1.0 - smoothstep(0.30 - aa.y, 0.30 + aa.y, f.y);
      float rail = 1.0 - smoothstep(0.0, aa.y * 1.5 + 0.01, abs(f.y - 0.30));
      detailed = mix(detailed, mix(detailed, sky * 0.9, 0.35), railZone * 0.7);
      detailed = mix(detailed, vec3(0.78, 0.80, 0.82) * lightK, rail * 0.75);
    }
    if (homes && variant == 1.0) {
      // Vertical fins in a warm accent every two bays.
      float fin = 1.0 - smoothstep(0.07, 0.07 + aa.x * 2.0, fract(vFacadeU / (bay * 2.0)));
      detailed = mix(detailed, vec3(0.66, 0.50, 0.36) * lightK, fin);
    }
    if (civic) {
      // Open corridors, as on a Malaysian school block: a slab and a railing each floor.
      float corridor = 1.0 - smoothstep(0.22 - aa.y, 0.22 + aa.y, f.y);
      detailed = mix(detailed, vec3(0.80, 0.82, 0.80) * lightK, corridor * 0.55);
      float stripe = 1.0 - smoothstep(0.0, aa.y * 1.5 + 0.01, abs(f.y - 0.22));
      detailed = mix(detailed, vec3(0.16, 0.44, 0.44), stripe * 0.8);
    }
    vec3 average = mix(wall, mix(pane, warm * 0.5, share), area);
    col = mix(detailed, average, lod);

    // Shopfronts: the ground floor of offices and commercial blocks is lit.
    if (code == 2.0 || code == 4.0) {
      float front = (1.0 - smoothstep(3.4, 4.2, h)) * smoothstep(0.6, 1.0, h);
      col = mix(col, vec3(0.95, 0.80, 0.60) * 0.6, front * 0.4);
    }
    col *= ao;
    }
    float nearK = 1.0 - lod;
    if (landed && h < 2.6) {
      // Car porch: an open, shaded bay; then the front door.
      float porch = step(0.06, unitF) * (1.0 - step(0.50, unitF));
      float door = step(0.60, unitF) * (1.0 - step(0.73, unitF)) * (1.0 - step(2.15, h));
      col = mix(col, vec3(0.07, 0.07, 0.08), porch * 0.85 * nearK);
      col = mix(col, vec3(0.32, 0.21, 0.14) * lightK, door * nearK);
    }
    if (shoplot) {
      float k = floor(unitSeed * 5.0);
      vec3 signCol = k < 1.0 ? vec3(0.66, 0.20, 0.17) : (k < 2.0 ? vec3(0.12, 0.46, 0.42)
                : (k < 3.0 ? vec3(0.78, 0.60, 0.18) : (k < 4.0 ? vec3(0.88, 0.88, 0.84)
                : vec3(0.18, 0.32, 0.62))));
      float pier = 1.0 - smoothstep(0.03, 0.05, min(unitF, 1.0 - unitF));
      if (h < 3.3) {
        // Storefronts, lit from inside, glazed in bays between the piers.
        vec3 store = mix(vec3(0.92, 0.74, 0.52), vec3(0.74, 0.84, 0.88), step(0.62, unitSeed));
        store *= 0.50 + 0.30 * facadeHash(vec2(unitId, 5.0));
        float mullion = step(0.46, abs(fract(vFacadeU / 2.03) - 0.5));
        store *= 1.0 - 0.55 * mullion;
        col = mix(store, vec3(0.10), pier * 0.8);
      } else if (h < 4.6) {
        // Signboards, one per shop, backlit.
        col = mix(signCol * (0.55 + 0.30 * unitSeed), vec3(0.12), pier * 0.6);
      }
    }
    if (homes && h < 3.8) {
      // Lobby and car-park podium: a darker glazed base with a warm entrance.
      float entrance = step(0.38, fract(vFacadeU / 24.0)) * (1.0 - step(0.62, fract(vFacadeU / 24.0)));
      col = mix(col, mix(vec3(0.16, 0.18, 0.20), vec3(0.80, 0.66, 0.48) * 0.7, entrance), 0.75);
    }
    if (industrial && h < 4.5) {
      // Roller shutters between the columns.
      float door = step(0.28, unitF) * (1.0 - step(0.72, unitF));
      float slat = 0.9 + 0.1 * step(0.5, fract(h / 0.12));
      col = mix(col, vec3(0.30, 0.32, 0.34) * slat, door * 0.85);
    }
    if (industrial) {
      // A clerestory band of high windows under the eaves.
      float band = step(vFacadeTop - 2.2, h) * (1.0 - step(vFacadeTop - 1.0, h));
      col = mix(col, vec3(0.30, 0.38, 0.46), band * 0.6);
    }
    // Parapet coping on flat-roofed blocks: a lighter band along the top.
    if (!landed && !industrial && vFacadeTop > 6.0) {
      col = mix(col, col * 1.35 + 0.03, (1.0 - smoothstep(0.7, 1.0, vFacadeTop - h)) * 0.8);
    }
    // A faint rim of sky light along every parapet: the silhouette separates from
    // whatever stands behind it.
    col += vec3(0.07, 0.08, 0.10) * (1.0 - smoothstep(0.0, 0.9, vFacadeTop - h));
    // Crown light along the top edge of the skyscrapers.
    if (vFacadeTop > 140.0) {
      col += vec3(0.50, 0.62, 0.80) * (1.0 - smoothstep(0.0, 1.8, vFacadeTop - h)) * 0.35;
    }
  }

  // Atmosphere: the foreground a touch crisper, the far city desaturating into a
  // cool blue-grey haze. Gentle -- the whole network must stay readable.
  // Foreground clear, middle normal, background darker and softer.
  col *= mix(1.06, 1.0, smoothstep(300.0, 900.0, vFacadeDist));
  col *= mix(1.0, 0.82, smoothstep(1400.0, 3600.0, vFacadeDist));
  float haze = clamp(1.0 - exp(-max(vFacadeDist - 1100.0, 0.0) / 4800.0), 0.0, 0.42);
  float grey = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(grey), haze * 0.6);
  col = mix(col, vec3(0.12, 0.14, 0.18), haze);
  // Opacity restored: the alpha channel only carried the material class.
  return vec4(col, 1.0);
}
`;
  return {
    inject: {
      'vs:#decl': vsDecl,
      'vs:#main-end': vsMain,
      'fs:#decl': fsDecl,
      // First in the chain: deck.gl's shadow module turns this same hook into a depth
      // write while drawing the shadow map, and picking replaces the colour with an id.
      // Both must see their own output, not the facade's.
      'fs:DECKGL_FILTER_COLOR': {order: -100, injection: 'color = facadeShade(color);'},
    },
  };
}

/** A LayerExtension instance for SolidPolygonLayer buildings, or null if unsupported. */
function makeFacadeExtension(originLon, originLat) {
  if (!deck.LayerExtension) return null;
  const shaders = facadeShaders(originLon, originLat);
  class FacadeExtension extends deck.LayerExtension {
    getShaders() { return shaders; }
  }
  FacadeExtension.extensionName = 'FacadeExtension';
  return new FacadeExtension();
}
