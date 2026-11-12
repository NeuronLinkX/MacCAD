/**
 * @file studio.js
 * @brief Studio: ready-made materials for solids and ready-made scenes (a backdrop picture, a floor
 *        with a soft shadow, and the light the shiny materials reflect).
 *
 * The pictures are drawn here with the canvas (simple stylised illustrations, no photo files), so
 * the app stays small and nothing is downloaded.
 *
 * A material is stored on the solid as `e.mat` (a key of MATERIALS), a colour as `e.paint`
 * ('#rrggbb'); the scene is a view setting (`app.settings.scene`). Every part can carry its own
 * finish and colour: the PAINT and MATERIAL commands, the Studio window, and LOOK (a whole model
 * in one go, see LOOKS below).
 */

/* ============================================================================================
 * 1. MATERIALS
 * ========================================================================================== */

// metal 0..1: metals have no diffuse colour and reflect with their own colour; rough 0..1: how blurred the reflection is; refl: reflection strength;
// color: a fixed colour (null = the object's own colour); glass: see-through with strong reflection at grazing angles;
// coat 0..1: a clear lacquer over the colour (a sharp, bright reflection of the room on top of the paint); glow 0..1: the colour lights itself
export const MATERIALS = {
  plastic: {
    label: 'Glossy plastic',
    metal: 0,
    rough: 0.28,
    refl: 0.45,
    color: null,
    glass: false,
  },
  matte: { label: 'Matte plastic', metal: 0, rough: 0.85, refl: 0.12, color: null, glass: false },
  glass: {
    label: 'Clear glass',
    metal: 0,
    rough: 0.04,
    refl: 1,
    color: [0.82, 0.93, 0.97],
    glass: true,
  },
  aluminum: {
    label: 'Aluminum',
    metal: 1,
    rough: 0.3,
    refl: 1,
    color: [0.8, 0.81, 0.84],
    glass: false,
  },
  chrome: {
    label: 'Chrome',
    metal: 1,
    rough: 0.04,
    refl: 1,
    color: [0.93, 0.94, 0.96],
    glass: false,
  },
  steel: { label: 'Steel', metal: 1, rough: 0.22, refl: 1, color: [0.52, 0.55, 0.6], glass: false },
  gold: { label: 'Gold', metal: 1, rough: 0.18, refl: 1, color: [0.96, 0.78, 0.36], glass: false },
  rubber: {
    label: 'Black rubber',
    metal: 0,
    rough: 0.95,
    refl: 0.05,
    color: [0.08, 0.08, 0.09],
    glass: false,
  },
  paint: {
    label: 'Car paint',
    metal: 0,
    rough: 0.16,
    refl: 0.3,
    color: null,
    glass: false,
    coat: 1,
  },
  metallic: {
    label: 'Metallic paint',
    metal: 0.7,
    rough: 0.24,
    refl: 0.95,
    color: null,
    glass: false,
    coat: 0.8,
  },
  brushed: {
    label: 'Brushed metal',
    metal: 1,
    rough: 0.55,
    refl: 0.8,
    color: [0.74, 0.75, 0.78],
    glass: false,
  },
  titanium: {
    label: 'Titanium',
    metal: 1,
    rough: 0.34,
    refl: 0.9,
    color: [0.56, 0.54, 0.52],
    glass: false,
  },
  copper: {
    label: 'Copper',
    metal: 1,
    rough: 0.2,
    refl: 1,
    color: [0.93, 0.52, 0.36],
    glass: false,
  },
  brass: {
    label: 'Brass',
    metal: 1,
    rough: 0.26,
    refl: 1,
    color: [0.85, 0.68, 0.32],
    glass: false,
  },
  anodized: {
    label: 'Black anodized',
    metal: 1,
    rough: 0.38,
    refl: 0.85,
    color: [0.16, 0.17, 0.2],
    glass: false,
  },
  glow: { label: 'Glow', metal: 0, rough: 0.5, refl: 0.1, color: null, glass: false, glow: 1 },
};
export const DEFAULT_MATERIAL = 'plastic'; // what a solid without e.mat looks like while a scene is on
export const materialOf = (e) => MATERIALS[e && e.mat] || null;

/* ============================================================================================
 * 2. SCENES
 * ========================================================================================== */

// sky / hor / gnd: the environment the shiny materials reflect (above, at the horizon, below); key: direction and colour of the main light.
// ground: the floor the model stands on (colour, pattern 0 none / 1 planks / 2 T-slots / 3 water / 4 concrete).
export const SCENES = {
  none: { label: 'None (plain background)', plain: true },
  white: {
    label: 'White studio',
    dark: false,
    sky: [1, 1, 1],
    hor: [0.22, 0.24, 0.28],
    gnd: [0.9, 0.9, 0.92],
    key: { dir: [-0.45, -0.55, 0.7], col: [1, 1, 1] },
    ground: { col: [0.97, 0.97, 0.98], pat: 0 },
    bg: [1, 1, 1],
  },
  study: {
    label: 'Study',
    dark: false,
    sky: [0.95, 0.85, 0.7],
    hor: [0.42, 0.3, 0.2],
    gnd: [0.4, 0.27, 0.16],
    key: { dir: [-0.8, -0.3, 0.5], col: [1, 0.9, 0.72] },
    ground: { col: [0.58, 0.38, 0.22], pat: 1 },
    bg: [0.7, 0.57, 0.4],
  },
  sea: {
    label: 'Sea',
    dark: false,
    sky: [0.6, 0.8, 0.98],
    hor: [0.9, 0.95, 1],
    gnd: [0.1, 0.32, 0.48],
    key: { dir: [0.5, -0.5, 0.7], col: [1, 0.97, 0.9] },
    ground: { col: [0.1, 0.38, 0.55], pat: 3 },
    bg: [0.55, 0.75, 0.92],
  },
  factory: {
    label: 'Factory floor',
    dark: true,
    sky: [0.8, 0.82, 0.86],
    hor: [0.3, 0.32, 0.36],
    gnd: [0.4, 0.4, 0.42],
    key: { dir: [-0.2, -0.3, 0.9], col: [0.95, 0.97, 1] },
    ground: { col: [0.52, 0.53, 0.55], pat: 4 },
    bg: [0.4, 0.43, 0.48],
  },
  machining: {
    label: 'Machining table',
    dark: true,
    sky: [0.55, 0.6, 0.66],
    hor: [0.18, 0.2, 0.24],
    gnd: [0.6, 0.63, 0.68],
    key: { dir: [-0.5, -0.4, 0.75], col: [1, 1, 1] },
    ground: { col: [0.64, 0.67, 0.72], pat: 2 },
    bg: [0.15, 0.17, 0.2],
  },
};
export const SCENE_IDS = Object.keys(SCENES);
export const sceneOf = (id) => (SCENES[id] && !SCENES[id].plain ? SCENES[id] : null);

/* ============================================================================================
 * 3. COLOURS OF SINGLE PARTS (e.paint)
 * ========================================================================================== */

export const COLORS = {
  orange: '#f0661c',
  black: '#17181b',
  blue: '#1f5fbf',
  red: '#c8281e',
  yellow: '#f2c230',
  green: '#2f8f5b',
  white: '#f1f2f4',
  grey: '#7d828c',
  silver: '#c5c9d0',
  brown: '#6b4630',
};
/** A colour in the form "#rrggbb". */
const HEX6 = /^#[0-9a-f]{6}$/i;

/** Colour parsing and reading. */
export class ColorTools {
  /**
   * A colour typed by the user: a name from COLORS, #rgb / #rrggbb, or "r,g,b" (0..255).
   * @param {string} text
   * @returns {string|null} '#rrggbb', or null when it is not a colour
   */
  static parse(text) {
    const t = String(text == null ? '' : text)
      .trim()
      .toLowerCase();
    if (!t) return null;
    if (COLORS[t]) return COLORS[t];
    let m = /^#?([0-9a-f]{6})$/.exec(t);
    if (m) return '#' + m[1];
    m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
    if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    m = /^(\d{1,3})[\s,;]+(\d{1,3})[\s,;]+(\d{1,3})$/.exec(t);
    if (m && [m[1], m[2], m[3]].every((v) => +v <= 255))
      return '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('');
    return null;
  }

  /** @returns {string|null} the paint colour of a solid ('#rrggbb' in lower case), or null. */
  static paintOf(e) {
    return e && typeof e.paint === 'string' && HEX6.test(e.paint) ? e.paint.toLowerCase() : null;
  }

  /** @returns {number[]} "#rrggbb" as [r, g, b] in 0..1. */
  static hexRgb(hex) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  }
}

/* ============================================================================================
 * 4. LOOKS: A FINISH AND A COLOUR FOR EVERY PART OF A MODEL IN ONE GO
 * ========================================================================================== */

// ------------------------------------------------------------------ looks: a finish and a colour for every part of a model in one go
// The parts are ranked by size (the diagonal of the box around them). tiers: the biggest `upTo` share of the parts gets the first entry, the next share the second, and so on.
// An entry with several choices (pick) gives the parts of one layer the same choice, so the layers stay recognisable.
// Entries: { mat, paint } where paint is a name from COLORS / a hex colour, or null to keep the part's own colour.
export const LOOKS = {
  industrial: {
    label: 'Industrial orange',
    note: 'Big castings orange, mid-size parts black or blue, the small ones in steel.',
    tiers: [
      { upTo: 0.18, pick: [{ mat: 'paint', paint: 'orange' }] },
      {
        upTo: 0.62,
        pick: [
          { mat: 'anodized' },
          { mat: 'paint', paint: 'blue' },
          { mat: 'paint', paint: 'black' },
        ],
      },
      { upTo: 1, pick: [{ mat: 'steel' }] },
    ],
  },
  racing: {
    label: 'Racing red',
    note: 'Red body, black trim, chrome small parts.',
    tiers: [
      { upTo: 0.25, pick: [{ mat: 'paint', paint: 'red' }] },
      { upTo: 0.65, pick: [{ mat: 'rubber' }, { mat: 'anodized' }] },
      { upTo: 1, pick: [{ mat: 'chrome' }] },
    ],
  },
  graphite: {
    label: 'Graphite and steel',
    note: 'Titanium-grey housings, brushed metal and black anodized inside, chrome small parts.',
    tiers: [
      { upTo: 0.3, pick: [{ mat: 'titanium' }] },
      { upTo: 0.7, pick: [{ mat: 'brushed' }, { mat: 'anodized' }] },
      { upTo: 1, pick: [{ mat: 'chrome' }] },
    ],
  },
  silver: {
    label: 'Satin silver',
    note: 'Everything in aluminum, small parts in steel.',
    tiers: [
      { upTo: 0.7, pick: [{ mat: 'aluminum' }] },
      { upTo: 1, pick: [{ mat: 'steel' }] },
    ],
  },
  clay: {
    label: 'White clay',
    note: 'One matte white for every part: shapes only, as in a design review.',
    tiers: [{ upTo: 1, pick: [{ mat: 'matte', paint: 'white' }] }],
  },
  layers: {
    label: 'Colour by layer',
    note: 'Each layer gets its own paint colour.',
    byLayer: [
      'orange',
      'blue',
      'red',
      'green',
      'yellow',
      'silver',
      'black',
      'brown',
      'grey',
      'white',
    ].map((c) => ({ mat: 'paint', paint: c })),
  },
};
export const LOOK_IDS = Object.keys(LOOKS);
/** Chooses a finish and a colour for every part of a model (the LOOK command). */
export class LookPlanner {
  /** @private A stable number for a text (FNV-1a). */
  static hashStr(s) {
    let h = 2166136261;
    for (const ch of String(s)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Plans a look. Pure, so it can be tested without a drawing.
   * @param {{id: number, size: number, layer?: string}[]} items the parts
   * @param {string} lookId a key of LOOKS
   * @returns {{id: number, mat: string, paint: string|null}[]} paint is '#rrggbb' or null
   */
  static plan(items, lookId) {
    const L = LOOKS[lookId];
    if (!L || !items.length) return [];
    const hex = (c) => (c ? ColorTools.parse(c) : null);
    if (L.byLayer) {
      const names = [...new Set(items.map((x) => x.layer || '0'))].sort();
      const at = new Map(names.map((n, i) => [n, L.byLayer[i % L.byLayer.length]]));
      return items.map((x) => {
        const r = at.get(x.layer || '0');
        return { id: x.id, mat: r.mat, paint: hex(r.paint) };
      });
    }
    const order = [...items].sort((a, b) => b.size - a.size || a.id - b.id);
    const n = order.length;
    const out = new Map();
    order.forEach((x, i) => {
      const share = i / n;
      const tier = L.tiers.find((t) => share <= t.upTo) || L.tiers[L.tiers.length - 1];
      const r =
        tier.pick[
          tier.pick.length > 1 ? LookPlanner.hashStr(x.layer || '0') % tier.pick.length : 0
        ];
      out.set(x.id, { id: x.id, mat: r.mat, paint: hex(r.paint) });
    });
    return items.map((x) => out.get(x.id));
  }
}

/* ============================================================================================
 * 5. BACKDROP PICTURES (canvas, 1280 x 800)
 * ========================================================================================== */

/** Picture size. */
const W = 1280;
const H = 800;

/** @returns {Function} a random number generator that gives the same series for a seed (the same picture every time). */
const rng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** @returns {CanvasGradient} a vertical gradient. stops = [[position, colour], ...] */
const lin = (ctx, y0, y1, stops) => {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  stops.forEach(([t, c]) => g.addColorStop(t, c));
  return g;
};

/** @returns {CanvasGradient} a radial gradient. */
const rad = (ctx, x, y, r0, r1, stops) => {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(([t, c]) => g.addColorStop(t, c));
  return g;
};

/** Darkens the corners of the picture. */
const vignette = (ctx, k = 0.55) => {
  ctx.fillStyle = rad(ctx, W / 2, H * 0.52, H * 0.35, H * 0.95, [
    [0, 'rgba(0,0,0,0)'],
    [1, `rgba(0,0,0,${k})`],
  ]);
  ctx.fillRect(0, 0, W, H);
};

/** The scene pictures: how they are painted, a cache, small pictures for the Studio window. */
export class ScenePictures {
  /** The painters, one per scene id: `painters.white(ctx)`. They draw the whole 1280 x 800 picture. */

  static painters = {
    white(ctx) {
      ctx.fillStyle = rad(ctx, W / 2, H * 0.45, 40, H * 0.9, [
        [0, '#ffffff'],
        [0.6, '#f4f5f8'],
        [1, '#d9dce3'],
      ]);
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = lin(ctx, H * 0.55, H, [
        [0, 'rgba(255,255,255,0)'],
        [1, 'rgba(200,204,214,0.55)'],
      ]);
      ctx.fillRect(0, H * 0.55, W, H * 0.45);
    },
    study(ctx) {
      const r = rng(7);
      ctx.fillStyle = lin(ctx, 0, H * 0.7, [
        [0, '#dccaa9'],
        [1, '#b99f78'],
      ]);
      ctx.fillRect(0, 0, W, H);
      // wainscot
      ctx.fillStyle = '#8c6e4b';
      ctx.fillRect(0, H * 0.5, W, H * 0.2);
      ctx.strokeStyle = 'rgba(40,25,10,0.35)';
      ctx.lineWidth = 3;
      for (let x = 40; x < W; x += 150) ctx.strokeRect(x, H * 0.53, 120, H * 0.14);
      // window with daylight
      ctx.fillStyle = '#6a4a2e';
      ctx.fillRect(80, 90, 330, 400);
      ctx.fillStyle = lin(ctx, 100, 480, [
        [0, '#fffdf0'],
        [1, '#bfdcf5'],
      ]);
      ctx.fillRect(98, 108, 294, 364);
      ctx.fillStyle = '#6a4a2e';
      ctx.fillRect(240, 108, 10, 364);
      ctx.fillRect(98, 280, 294, 10);
      ctx.fillStyle = rad(ctx, 245, 290, 20, 620, [
        [0, 'rgba(255,245,200,0.55)'],
        [1, 'rgba(255,245,200,0)'],
      ]);
      ctx.fillRect(0, 0, W, H);
      // picture frame
      ctx.fillStyle = '#4a3322';
      ctx.fillRect(500, 150, 170, 120);
      ctx.fillStyle = '#c9d8c2';
      ctx.fillRect(512, 162, 146, 96);
      ctx.fillStyle = '#7d9b78';
      ctx.beginPath();
      ctx.moveTo(512, 258);
      ctx.lineTo(570, 200);
      ctx.lineTo(615, 240);
      ctx.lineTo(658, 210);
      ctx.lineTo(658, 258);
      ctx.fill();
      // bookshelf
      ctx.fillStyle = '#4e3420';
      ctx.fillRect(740, 40, 460, 500);
      const pal = [
        '#b23a3a',
        '#2f5d8a',
        '#d2a73c',
        '#3f7d57',
        '#7a4a8c',
        '#c9c3b2',
        '#a0522d',
        '#2d3b4e',
      ];
      for (let s = 0; s < 4; s += 1) {
        const y0 = 60 + s * 120;
        ctx.fillStyle = '#2b1b10';
        ctx.fillRect(752, y0, 436, 108);
        let x = 756;
        while (x < 1180) {
          const w = 14 + r() * 22;
          const h = 66 + r() * 34;
          ctx.fillStyle = pal[(r() * pal.length) | 0];
          ctx.fillRect(x, y0 + 108 - h, w, h);
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.fillRect(x + 2, y0 + 108 - h, 2, h);
          x += w + 1.5;
        }
        ctx.fillStyle = '#5c3d25';
        ctx.fillRect(748, y0 + 108, 444, 12);
      }
      // desk top in front
      ctx.fillStyle = lin(ctx, H * 0.66, H, [
        [0, '#a87646'],
        [1, '#6a4425'],
      ]);
      ctx.fillRect(0, H * 0.66, W, H * 0.34);
      ctx.strokeStyle = 'rgba(40,22,8,0.35)';
      ctx.lineWidth = 2;
      for (let i = 1; i < 7; i += 1) {
        const y = H * 0.66 + Math.pow(i / 7, 1.6) * H * 0.34;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,230,180,0.18)';
      ctx.fillRect(0, H * 0.66, W, 6);
      vignette(ctx, 0.5);
    },
    sea(ctx) {
      const r = rng(11);
      const hy = H * 0.56;
      ctx.fillStyle = lin(ctx, 0, hy, [
        [0, '#4f9fe0'],
        [1, '#d6ecf8'],
      ]);
      ctx.fillRect(0, 0, W, hy);
      ctx.fillStyle = rad(ctx, W * 0.72, hy - 90, 5, 420, [
        [0, 'rgba(255,252,230,1)'],
        [0.12, 'rgba(255,245,200,0.7)'],
        [1, 'rgba(255,245,200,0)'],
      ]);
      ctx.fillRect(0, 0, W, hy);
      for (let i = 0; i < 9; i += 1) {
        const cx = r() * W;
        const cy = 70 + r() * 220;
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        for (let k = 0; k < 7; k += 1) {
          ctx.beginPath();
          ctx.ellipse(
            cx + k * 34 - 100,
            cy + (r() - 0.5) * 16,
            60 + r() * 50,
            18 + r() * 12,
            0,
            0,
            7,
          );
          ctx.fill();
        }
      }
      ctx.fillStyle = lin(ctx, hy, H, [
        [0, '#4aa2cf'],
        [0.5, '#1c6d9c'],
        [1, '#0a3f66'],
      ]);
      ctx.fillRect(0, hy, W, H - hy);
      for (let i = 0; i < 260; i += 1) {
        const t = Math.pow(r(), 1.7);
        const y = hy + 6 + t * (H - hy - 10);
        const x = r() * W;
        const len = 12 + t * 110;
        ctx.strokeStyle = `rgba(255,255,255,${0.1 + t * 0.22})`;
        ctx.lineWidth = 1 + t * 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + len / 2, y - 2 - t * 6, x + len, y);
        ctx.stroke();
      }
      ctx.fillStyle = rad(ctx, W * 0.72, hy + 120, 5, 260, [
        [0, 'rgba(255,248,220,0.7)'],
        [1, 'rgba(255,248,220,0)'],
      ]);
      ctx.fillRect(W * 0.4, hy, W * 0.6, H - hy);
      ctx.fillStyle = '#f4f6f8';
      ctx.beginPath();
      ctx.moveTo(300, hy - 2);
      ctx.lineTo(300, hy - 56);
      ctx.lineTo(340, hy - 2);
      ctx.fill();
      ctx.fillStyle = '#e8eaee';
      ctx.beginPath();
      ctx.moveTo(296, hy - 2);
      ctx.lineTo(296, hy - 44);
      ctx.lineTo(268, hy - 2);
      ctx.fill();
      ctx.fillStyle = '#3a4a5a';
      ctx.fillRect(262, hy - 2, 84, 6);
      vignette(ctx, 0.25);
    },
    factory(ctx) {
      const r = rng(23);
      const hy = H * 0.52;
      const vx = W / 2;
      ctx.fillStyle = lin(ctx, 0, hy, [
        [0, '#23272d'],
        [0.5, '#4a515b'],
        [1, '#79828e'],
      ]);
      ctx.fillRect(0, 0, W, hy);
      // roof trusses
      ctx.strokeStyle = 'rgba(15,18,22,0.7)';
      ctx.lineWidth = 5;
      for (let i = -4; i <= 4; i += 1) {
        ctx.beginPath();
        ctx.moveTo(vx + i * 40, hy);
        ctx.lineTo(vx + i * 330, -40);
        ctx.stroke();
      }
      ctx.lineWidth = 3;
      for (let k = 0; k < 4; k += 1) {
        const y = hy - 60 - k * 90;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      // ceiling lamps
      for (let k = 0; k < 4; k += 1)
        for (let i = -3; i <= 3; i += 1) {
          const t = 0.2 + k * 0.2;
          const x = vx + i * 180 * t * 1.6;
          const y = hy - 330 * (1 - t * 0.8) + k * 6;
          const w = 70 * t + 18;
          const hh = 12 * t + 5;
          ctx.fillStyle = rad(ctx, x, y, 2, w * 2.2, [
            [0, 'rgba(255,255,235,0.55)'],
            [1, 'rgba(255,255,235,0)'],
          ]);
          ctx.fillRect(x - w * 2.2, y - w * 2.2, w * 4.4, w * 4.4);
          ctx.fillStyle = '#fffff0';
          ctx.fillRect(x - w / 2, y - hh / 2, w, hh);
        }
      // roller door and columns
      ctx.fillStyle = '#6f7a86';
      ctx.fillRect(70, hy - 250, 280, 250);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      for (let x = 76; x < 350; x += 14) {
        ctx.beginPath();
        ctx.moveTo(x, hy - 250);
        ctx.lineTo(x, hy);
        ctx.stroke();
      }
      ctx.fillStyle = '#2f5f9e';
      ctx.fillRect(560, hy - 150, 150, 150);
      ctx.fillStyle = '#f2c200';
      ctx.fillRect(560, hy - 150, 150, 10);
      ctx.fillStyle = 'rgba(180,215,255,0.5)';
      ctx.fillRect(580, hy - 120, 110, 60);
      ctx.fillStyle = '#e0a800';
      ctx.fillRect(900, hy - 190, 220, 190);
      ctx.fillStyle = '#3b4048';
      ctx.fillRect(918, hy - 160, 90, 100);
      ctx.fillStyle = '#3b6fb5';
      ctx.fillRect(1180, 0, 34, hy);
      ctx.fillRect(40, 0, 34, hy);
      // concrete floor with perspective lines
      ctx.fillStyle = lin(ctx, hy, H, [
        [0, '#8f949b'],
        [1, '#62666d'],
      ]);
      ctx.fillRect(0, hy, W, H - hy);
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 2;
      for (let i = -8; i <= 8; i += 1) {
        ctx.beginPath();
        ctx.moveTo(vx + i * 12, hy);
        ctx.lineTo(vx + i * 330, H);
        ctx.stroke();
      }
      for (let k = 1; k < 7; k += 1) {
        const y = hy + Math.pow(k / 7, 1.8) * (H - hy);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,205,0,0.9)';
      ctx.beginPath();
      ctx.moveTo(vx - 200 - 10, hy);
      ctx.lineTo(vx - 200 + 10, hy);
      ctx.lineTo(vx - 1250, H);
      ctx.lineTo(vx - 1360, H);
      ctx.fill();
      for (let i = 0; i < 6; i += 1) {
        const x = r() * W;
        ctx.fillStyle = rad(ctx, x, hy + 60 + r() * 120, 2, 120, [
          [0, 'rgba(255,255,240,0.22)'],
          [1, 'rgba(255,255,240,0)'],
        ]);
        ctx.fillRect(x - 130, hy, 260, H - hy);
      }
      vignette(ctx, 0.5);
    },
    machining(ctx) {
      const r = rng(41);
      const hy = H * 0.6;
      const vx = W * 0.5;
      ctx.fillStyle = lin(ctx, 0, hy, [
        [0, '#171b21'],
        [1, '#3a424d'],
      ]);
      ctx.fillRect(0, 0, W, hy);
      // machine tool
      ctx.fillStyle = '#c9ced6';
      ctx.fillRect(520, 90, 600, hy - 90);
      ctx.fillStyle = '#1f6fb5';
      ctx.fillRect(520, 90, 600, 40);
      ctx.fillStyle = '#12161c';
      ctx.fillRect(570, 160, 340, 230);
      ctx.fillStyle = 'rgba(160,200,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(570, 160);
      ctx.lineTo(760, 160);
      ctx.lineTo(620, 390);
      ctx.lineTo(570, 390);
      ctx.fill();
      ctx.fillStyle = '#2d3540';
      ctx.fillRect(950, 160, 130, 130);
      ctx.fillStyle = '#3ad17a';
      for (let i = 0; i < 6; i += 1)
        ctx.fillRect(962 + (i % 3) * 38, 175 + Math.floor(i / 3) * 40, 26, 26);
      // pegboard with tools
      ctx.fillStyle = '#242a32';
      ctx.fillRect(60, 120, 400, 300);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 6;
      for (let i = 0; i < 9; i += 1) {
        const x = 90 + i * 40;
        const h = 60 + r() * 120;
        ctx.beginPath();
        ctx.moveTo(x, 150);
        ctx.lineTo(x, 150 + h);
        ctx.stroke();
      }
      ctx.fillStyle = rad(ctx, 200, 60, 10, 520, [
        [0, 'rgba(255,250,235,0.65)'],
        [1, 'rgba(255,250,235,0)'],
      ]);
      ctx.fillRect(0, 0, W, hy + 80);
      // steel table
      ctx.fillStyle = lin(ctx, hy, H, [
        [0, '#a7adb6'],
        [0.5, '#80868f'],
        [1, '#575d66'],
      ]);
      ctx.fillRect(0, hy, W, H - hy);
      ctx.lineWidth = 1;
      for (let i = 0; i < 260; i += 1) {
        ctx.strokeStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${0.04 + r() * 0.07})`;
        const y = hy + r() * (H - hy);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y + (r() - 0.5) * 3);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(20,24,30,0.85)';
      ctx.lineWidth = 9;
      for (let i = -6; i <= 6; i += 1) {
        ctx.beginPath();
        ctx.moveTo(vx + i * 14, hy);
        ctx.lineTo(vx + i * 330, H);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 2;
      for (let i = -6; i <= 6; i += 1) {
        ctx.beginPath();
        ctx.moveTo(vx + i * 14 + 5, hy);
        ctx.lineTo(vx + i * 330 + 22, H);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(0, hy, W, 4);
      vignette(ctx, 0.45);
    },
  };
  /** Finished backdrops by scene id. */
  static cache = new Map();

  /**
   * The backdrop of a scene as a canvas (cached); soft focus like a photograph taken with a wide aperture.
   * @param {string} id a scene id
   * @returns {HTMLCanvasElement|null} null for a scene without a picture
   */
  static backdrop(id) {
    const PAINT = ScenePictures.painters;
    if (!PAINT[id]) return null;
    const cache = ScenePictures.cache;
    if (cache.has(id)) return cache.get(id);
    const raw = document.createElement('canvas');
    raw.width = W;
    raw.height = H;
    PAINT[id](raw.getContext('2d'));
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const o = out.getContext('2d');
    o.filter = 'blur(2px)';
    o.drawImage(raw, 0, 0);
    o.filter = 'none';
    cache.set(id, out);
    return out;
  }

  /** A small picture of a scene for the Studio window. */
  static thumb(id, w = 150, h = 94) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    const b = ScenePictures.backdrop(id);
    if (b) x.drawImage(b, 0, 0, w, h);
    else {
      x.fillStyle = '#000';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = '#555';
      x.beginPath();
      x.moveTo(0, 0);
      x.lineTo(w, h);
      x.moveTo(w, 0);
      x.lineTo(0, h);
      x.stroke();
    }
    return c;
  }

  /**
   * A small ball painted like the material (for the Studio window).
   * @param {string|null} key a key of MATERIALS (null = the default look)
   * @param {number[]} [base] the colour shown for materials that take the part's own colour
   * @param {number} [size] picture size in pixels
   */
  static swatch(key, base = [0.62, 0.66, 0.74], size = 44) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const x = c.getContext('2d');
    const m = MATERIALS[key];
    const col = (m && m.color) || base;
    const css = (k) => `rgb(${col.map((v) => Math.round(Math.min(1, v * k) * 255)).join(',')})`;
    const R = size / 2 - 2;
    const cx = size / 2;
    const cy = size / 2;
    x.fillStyle = '#d8dbe2';
    x.fillRect(0, 0, size, size);
    let g;
    if (!m) {
      g = x.createRadialGradient(cx - R * 0.3, cy - R * 0.3, 1, cx, cy, R);
      g.addColorStop(0, css(1.1));
      g.addColorStop(1, css(0.55));
    } else if (m.metal) {
      g = x.createLinearGradient(0, cy - R, 0, cy + R);
      g.addColorStop(0, css(1.1));
      g.addColorStop(0.45, css(0.95));
      g.addColorStop(0.52, css(0.28));
      g.addColorStop(0.6, css(0.5));
      g.addColorStop(1, css(0.9));
    } else if (m.glass) {
      g = x.createRadialGradient(cx - R * 0.2, cy - R * 0.2, 1, cx, cy, R);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(0.75, 'rgba(190,225,240,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0.9)');
    } else {
      g = x.createRadialGradient(cx - R * 0.3, cy - R * 0.3, 1, cx, cy, R);
      g.addColorStop(0, css(1.15));
      g.addColorStop(1, css(0.5));
    }
    x.fillStyle = g;
    x.beginPath();
    x.arc(cx, cy, R, 0, 7);
    x.fill();
    if (m && m.glow) {
      const gg = x.createRadialGradient(cx, cy, 1, cx, cy, R * 1.1);
      gg.addColorStop(0, 'rgba(255,255,255,0.9)');
      gg.addColorStop(0.5, css(1.2));
      gg.addColorStop(1, css(0.7));
      x.fillStyle = gg;
      x.beginPath();
      x.arc(cx, cy, R, 0, 7);
      x.fill();
    }
    if (m && (m.coat || (!m.metal && m.rough < 0.5))) {
      x.fillStyle = `rgba(255,255,255,${m.glass ? 0.8 : m.coat ? 0.85 : 0.6})`;
      x.beginPath();
      x.ellipse(cx - R * 0.32, cy - R * 0.38, R * 0.22, R * 0.12, -0.6, 0, 7);
      x.fill();
    }
    if (m && m.metal && m.rough < 0.3) {
      x.fillStyle = 'rgba(255,255,255,0.8)';
      x.beginPath();
      x.ellipse(cx - R * 0.3, cy - R * 0.42, R * 0.2, R * 0.08, -0.5, 0, 7);
      x.fill();
    }
    x.strokeStyle = 'rgba(0,0,0,0.35)';
    x.lineWidth = 1;
    x.beginPath();
    x.arc(cx, cy, R, 0, 7);
    x.stroke();
    return c;
  }
}

/* ============================================================================================
 * 6. ACTIONS
 * ========================================================================================== */

/** The visual styles that show the Studio look. */
const SHADED = new Set(['shaded', 'shadedEdges']);

/** What the STUDIO window, the viewport label menu and the commands do to the drawing. */
export class StudioActions {
  /** The Studio look is a shaded one: goes to a 3D view and a shaded visual style when the drawing is not in one yet. */
  static ensureShaded(app) {
    if (!app.v3 && app.solids().length) app.enter3D('swiso');
    if (!SHADED.has(app.settings.vstyle)) app.setVisualStyle('shaded');
  }

  /** Switches the scene. @returns {boolean} false for an unknown scene id */
  static setScene(app, id) {
    if (!SCENES[id]) return false;
    app.settings.scene = id;
    app.saveSettings();
    if (id !== 'none') StudioActions.ensureShaded(app);
    app.emit('view3d');
    app.emit('settings');
    app.changed();
    return true;
  }

  /** @returns {object[]} the solids a material goes to: the selected ones, or every visible solid when nothing is selected. */
  static materialTargets(app) {
    const sel = app.selectedEnts().filter((e) => e.type === 'solid3d');
    return sel.length ? sel : app.solids();
  }

  /**
   * Gives the targets a colour.
   * @param {string|null} hex '#rrggbb', or null to give the parts their own colour back
   * @returns {number} how many solids were changed
   */
  static applyPaint(app, hex) {
    const list = StudioActions.materialTargets(app);
    for (const e of list) {
      if (hex && HEX6.test(hex)) e.paint = hex.toLowerCase();
      else delete e.paint;
    }
    if (hex) StudioActions.ensureShaded(app);
    app.changed();
    return list.length;
  }

  /** @returns {Promise<number>} the size of a part: the diagonal of the box around it (0 when it cannot be meshed). */
  static async solidSize(e) {
    try {
      const K = await import('./kernel3d.js');
      const b = K.solidMesh(e).bounds;
      return Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]);
    } catch {
      return 0;
    }
  }

  /**
   * Gives the targets (the selected solids, or all of them) a look: a finish and a colour per
   * part, chosen by size and layer.
   * @param {object} app
   * @param {string} lookId a key of LOOKS
   * @param {Function} [sizeOf] async (entity) => size; replaced in tests
   * @returns {Promise<number>} how many solids were changed
   */
  static async applyLook(app, lookId, sizeOf = StudioActions.solidSize) {
    const list = StudioActions.materialTargets(app);
    if (!LOOKS[lookId] || !list.length) return 0;
    const items = [];
    for (const e of list) items.push({ id: e.id, size: await sizeOf(e), layer: e.layer });
    const plan = new Map(LookPlanner.plan(items, lookId).map((p) => [p.id, p]));
    for (const e of list) {
      const p = plan.get(e.id);
      if (!p) continue;
      e.mat = p.mat;
      if (p.paint) e.paint = p.paint;
      else delete e.paint;
    }
    StudioActions.ensureShaded(app);
    app.changed();
    return list.length;
  }

  /** Gives the targets a material (null removes it). @returns {number} how many solids were changed */
  static applyMaterial(app, key) {
    const list = StudioActions.materialTargets(app);
    for (const e of list) {
      if (key && MATERIALS[key]) e.mat = key;
      else delete e.mat;
    }
    if (key) StudioActions.ensureShaded(app);
    app.changed();
    return list.length;
  }
}

/* ============================================================================================
 * 7. SHORT-NAME EXPORTS
 * ========================================================================================== */
export const parseColor = ColorTools.parse;
export const paintOf = ColorTools.paintOf;
export const hexRgb = ColorTools.hexRgb;
export const planLook = LookPlanner.plan;
export const backdrop = ScenePictures.backdrop;
export const sceneThumb = ScenePictures.thumb;
export const materialSwatch = ScenePictures.swatch;
export const ensureShaded = StudioActions.ensureShaded;
export const setScene = StudioActions.setScene;
export const materialTargets = StudioActions.materialTargets;
export const applyPaint = StudioActions.applyPaint;
export const solidSize = StudioActions.solidSize;
export const applyLook = StudioActions.applyLook;
export const applyMaterial = StudioActions.applyMaterial;
