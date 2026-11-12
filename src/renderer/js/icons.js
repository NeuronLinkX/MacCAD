/**
 * @file icons.js
 * @brief Toolbar and menu icons (24x24 viewBox, drawn inline so no image assets are needed).
 *
 * `ICONS` maps an icon name to an SVG string; `icon(name)` returns '' for an unknown name. Colours
 * come from the small palette below. The groups in `ICONS` follow the toolbars: standard, draw,
 * modify, dimension, layers and tools; the 3D (solid) icons are added from `SOLID_ICONS` at the end.
 */

/* ============================================================================================
 * 1. PALETTE AND DRAWING HELPERS
 * ========================================================================================== */
const K = '#1c1c1c';
const B = '#1f58c8';
const R = '#d12a2a';
const Y = '#e0a400';
const Gn = '#2c9a3a';
const Gy = '#8d8d8d';
const W = '#ffffff';
const LB = '#9ec3ff';
/** Wraps drawing commands in the common <svg> element (outline colour K, 1.3 px strokes). */
const svg = (inner, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${K}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
/** A small white grip square centred at (x, y). */
const sq = (x, y, s = 3) =>
  `<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" fill="${W}" stroke="${K}" stroke-width="1"/>`;
/** An arrow head at (x, y) pointing along (dx, dy). */
const arrowHead = (x, y, dx, dy, col = K) => {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const px = -uy;
  const py = ux;
  return `<path d="M${x} ${y} L${x - ux * 4 + px * 2} ${y - uy * 4 + py * 2} L${x - ux * 4 - px * 2} ${y - uy * 4 - py * 2}Z" fill="${col}" stroke="none"/>`;
};
/** The sheet-of-paper outline shared by several file icons. */
const page = `<path d="M6 3h8l4 4v14H6z" fill="${W}"/><path d="M14 3v4h4"/>`;

/* ============================================================================================
 * 2. ICON TABLE
 * ========================================================================================== */

/** Icon name -> SVG markup. */
export const ICONS = {
  // ---- standard toolbar: file, clipboard, undo, view
  new: svg(`${page}`),
  open: svg(
    `<path d="M3 7h6l2 2h9v10H3z" fill="#f2cf63"/><path d="M3 19l3-8h16l-3 8z" fill="#ffe493"/>`,
  ),
  save: svg(
    `<rect x="4" y="4" width="16" height="16" rx="1" fill="#3d6fd1"/><rect x="7" y="4" width="10" height="6" fill="${W}"/><rect x="8" y="14" width="8" height="6" fill="#d9d9d9"/>`,
  ),
  plot: svg(
    `<rect x="3" y="9" width="18" height="8" fill="#d6d6d6"/><rect x="7" y="4" width="10" height="5" fill="${W}"/><rect x="7" y="14" width="10" height="6" fill="${W}"/>`,
  ),
  preview: svg(`${page}<circle cx="15" cy="15" r="4" fill="${LB}"/><path d="M18 18l3 3"/>`),
  cut: svg(
    `<circle cx="7" cy="18" r="2.5"/><circle cx="17" cy="18" r="2.5"/><path d="M8.5 16L16 4M15.5 16L8 4" stroke="${R}"/>`,
  ),
  copyclip: svg(
    `<rect x="3" y="3" width="11" height="14" fill="${W}"/><rect x="9" y="7" width="11" height="14" fill="${W}"/>`,
  ),
  paste: svg(
    `<rect x="4" y="5" width="13" height="16" fill="#e7c98a"/><rect x="8" y="3" width="5" height="4" fill="#9a9a9a"/><rect x="10" y="10" width="10" height="11" fill="${W}"/>`,
  ),
  matchprop: svg(
    `<path d="M4 20l9-9" stroke="${Y}" stroke-width="3"/><rect x="12" y="4" width="8" height="8" rx="1" fill="${LB}" transform="rotate(45 16 8)"/>`,
  ),
  undo: svg(
    `<path d="M9 7L4 12l5 5" stroke="${B}" stroke-width="2"/><path d="M4 12h10a6 6 0 0 1 0 8h-3" stroke="${B}" stroke-width="2"/>`,
  ),
  redo: svg(
    `<path d="M15 7l5 5-5 5" stroke="${B}" stroke-width="2"/><path d="M20 12H10a6 6 0 0 0 0 8h3" stroke="${B}" stroke-width="2"/>`,
  ),
  pan: svg(
    `<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9a1.5 1.5 0 0 1 3 0v6c0 4-3 6-6 6s-5-1-7-4l-2-3a1.5 1.5 0 0 1 2.5-1.5L8 14" fill="#f4dcb3"/>`,
  ),
  zoomrt: svg(
    `<circle cx="10" cy="10" r="6" fill="${LB}"/><path d="M14.5 14.5L21 21" stroke-width="2"/><path d="M7 10h6M10 7v6" stroke="${B}"/>`,
  ),
  zoomwin: svg(
    `<circle cx="10" cy="10" r="6" fill="${LB}"/><path d="M14.5 14.5L21 21" stroke-width="2"/><rect x="7" y="7" width="6" height="6" stroke="${R}" stroke-dasharray="2 1"/>`,
  ),
  zoomprev: svg(
    `<circle cx="10" cy="10" r="6" fill="${LB}"/><path d="M14.5 14.5L21 21" stroke-width="2"/><path d="M12 10H7m2-2l-2 2 2 2" stroke="${B}"/>`,
  ),
  zoomext: svg(
    `<circle cx="10" cy="10" r="6" fill="${LB}"/><path d="M14.5 14.5L21 21" stroke-width="2"/><path d="M6 6l8 8M14 6l-8 8" stroke="${B}"/>`,
  ),
  props: svg(
    `<rect x="3" y="3" width="18" height="18" fill="${W}"/><path d="M6 8h5M6 12h5M6 16h5" stroke="${Gy}"/><path d="M13 8h5M13 12h5M13 16h5" stroke="${B}"/>`,
  ),
  help: svg(
    `<circle cx="12" cy="12" r="9" fill="${LB}"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7M12 17v.5" stroke="${B}" stroke-width="2"/>`,
  ),

  // draw
  // ---- draw toolbar
  line: svg(`<path d="M4 20L20 4" stroke="${B}" stroke-width="1.6"/>${sq(4, 20)}${sq(20, 4)}`),
  xline: svg(
    `<path d="M3 21L21 3" stroke="${B}" stroke-width="1.6"/>${arrowHead(21, 3, 1, -1, B)}${arrowHead(3, 21, -1, 1, B)}`,
  ),
  pline: svg(
    `<path d="M4 18l6-9 5 6 5-10" stroke="${B}" stroke-width="1.6"/>${sq(4, 18)}${sq(10, 9)}${sq(15, 15)}${sq(20, 5)}`,
  ),
  polygon: svg(
    `<path d="M12 3l8 5v8l-8 5-8-5V8z" stroke="${B}" stroke-width="1.6" fill="#e5eeff"/>`,
  ),
  rect: svg(
    `<rect x="4" y="6" width="16" height="12" stroke="${B}" stroke-width="1.6" fill="#e5eeff"/>`,
  ),
  arc: svg(
    `<path d="M4 20A16 16 0 0 1 20 4" stroke="${B}" stroke-width="1.6"/>${sq(4, 20)}${sq(20, 4)}`,
  ),
  circle: svg(
    `<circle cx="12" cy="12" r="8" stroke="${B}" stroke-width="1.6" fill="#e5eeff"/><circle cx="12" cy="12" r="1" fill="${K}"/>`,
  ),
  revcloud: svg(
    `<path d="M5 16a3 3 0 0 1 1-5.5 4 4 0 0 1 7-2 4 4 0 0 1 6 3 3 3 0 0 1 0 4.5z" stroke="${B}" stroke-width="1.5" fill="#e5eeff"/>`,
  ),
  spline: svg(
    `<path d="M3 17C7 3 11 21 15 11s4-3 6-6" stroke="${B}" stroke-width="1.6"/>${sq(3, 17)}${sq(21, 5)}`,
  ),
  ellipse: svg(
    `<ellipse cx="12" cy="12" rx="9" ry="5.5" stroke="${B}" stroke-width="1.6" fill="#e5eeff"/>`,
  ),
  ellipsearc: svg(`<path d="M3 13a9 5.5 0 0 1 18 0" stroke="${B}" stroke-width="1.6"/>`),
  insert: svg(
    `<rect x="3" y="9" width="11" height="11" fill="#fff0c7"/><path d="M14 5l6 0 0 6M20 5l-7 7" stroke="${B}" stroke-width="1.5"/>`,
  ),
  block: svg(
    `<rect x="4" y="8" width="13" height="13" fill="#fff0c7"/><path d="M17 8V3H8" stroke="${B}"/><path d="M4 8l4-5" stroke="${B}"/>`,
  ),
  point: svg(
    `<circle cx="12" cy="12" r="2" fill="${K}"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4" stroke="${Gy}"/>`,
  ),
  hatch: svg(
    `<rect x="4" y="4" width="16" height="16" fill="${W}"/><path d="M4 12L12 4M4 18L18 4M8 20L20 8M14 20L20 14" stroke="${R}"/>`,
  ),
  table: svg(
    `<rect x="3" y="4" width="18" height="16" fill="${W}"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/><rect x="3" y="4" width="18" height="5" fill="${LB}" stroke="none"/>`,
  ),
  mtext: svg(
    `<path d="M5 18L11 4l6 14M7.5 13h7" stroke="${B}" stroke-width="1.8"/><path d="M19 8h2M19 12h2M19 16h2" stroke="${Gy}"/>`,
  ),
  text: svg(`<path d="M5 18L11 4l6 14M7.5 13h7" stroke="${B}" stroke-width="1.8"/>`),
  donut: svg(`<circle cx="12" cy="12" r="7" stroke="${B}" stroke-width="4"/>`),
  ray: svg(
    `<path d="M4 20L20 4" stroke="${B}" stroke-width="1.6"/>${arrowHead(20, 4, 1, -1, B)}${sq(4, 20)}`,
  ),

  // modify
  // ---- modify toolbar
  erase: svg(
    `<path d="M5 15l8-8 6 6-6 6H8z" fill="#f6a5b5"/><path d="M9 11l6 6" /><path d="M8 19h12" stroke="${Gy}"/>`,
  ),
  copy: svg(
    `<rect x="3" y="3" width="11" height="11" fill="#e5eeff" stroke="${B}"/><rect x="9" y="9" width="11" height="11" fill="#e5eeff" stroke="${B}"/>${arrowHead(20, 20, 1, 1, R)}`,
  ),
  mirror: svg(
    `<path d="M12 2v20" stroke="${R}" stroke-dasharray="2 2"/><path d="M3 18V7l7 11z" fill="#e5eeff" stroke="${B}"/><path d="M21 18V7l-7 11z" fill="${W}" stroke="${B}" stroke-dasharray="2 1"/>`,
  ),
  offset: svg(
    `<path d="M3 18c4-9 9-9 18-12" stroke="${B}"/><path d="M3 22c5-10 11-10 18-13" stroke="${B}" stroke-dasharray="3 1.5"/>`,
  ),
  array: svg(
    `<rect x="3" y="3" width="6" height="6" fill="#e5eeff" stroke="${B}"/><rect x="14" y="3" width="6" height="6" fill="#e5eeff" stroke="${B}"/><rect x="3" y="14" width="6" height="6" fill="#e5eeff" stroke="${B}"/><rect x="14" y="14" width="6" height="6" fill="#e5eeff" stroke="${B}"/>`,
  ),
  move: svg(
    `<path d="M12 3v18M3 12h18" stroke="${B}" stroke-width="1.5"/>${arrowHead(12, 3, 0, -1, B)}${arrowHead(12, 21, 0, 1, B)}${arrowHead(3, 12, -1, 0, B)}${arrowHead(21, 12, 1, 0, B)}`,
  ),
  rotate: svg(
    `<path d="M19 12a7 7 0 1 1-3-5.7" stroke="${B}" stroke-width="1.8"/>${arrowHead(16.5, 5.5, 1, 0.3, B)}<rect x="9" y="9" width="6" height="6" fill="#e5eeff" stroke="${K}"/>`,
  ),
  scale: svg(
    `<rect x="3" y="12" width="9" height="9" fill="#e5eeff" stroke="${B}"/><rect x="8" y="3" width="13" height="13" fill="none" stroke="${B}" stroke-dasharray="2 1.5"/><path d="M12 12l8-8" stroke="${R}"/>`,
  ),
  stretch: svg(
    `<rect x="3" y="8" width="10" height="9" fill="#e5eeff" stroke="${B}"/><path d="M13 12h8" stroke="${R}" stroke-width="1.6"/>${arrowHead(21, 12, 1, 0, R)}<path d="M3 4h12v16H3z" stroke="${Gy}" stroke-dasharray="2 2"/>`,
  ),
  lengthen: svg(
    `<path d="M3 12h14" stroke="${B}" stroke-width="1.6"/><path d="M17 12h4" stroke="${R}" stroke-width="1.6"/>${arrowHead(21, 12, 1, 0, R)}`,
  ),
  trim: svg(
    `<path d="M3 12h18" stroke="${B}" stroke-width="1.6"/><path d="M12 3v18" stroke="${K}"/><path d="M12 12h9" stroke="${Gy}" stroke-width="3" opacity=".25"/><path d="M5 5l6 6M11 5l-6 6" stroke="${R}"/>`,
  ),
  extend: svg(
    `<path d="M3 12h11" stroke="${B}" stroke-width="1.6"/><path d="M14 12h5" stroke="${R}" stroke-dasharray="2 1.5"/><path d="M20 3v18" stroke="${K}" stroke-width="1.6"/>`,
  ),
  breakpt: svg(
    `<path d="M3 12h7M14 12h7" stroke="${B}" stroke-width="1.6"/><path d="M12 7v10" stroke="${R}" stroke-dasharray="2 1.5"/>`,
  ),
  break: svg(
    `<path d="M3 12h6M15 12h6" stroke="${B}" stroke-width="1.6"/><path d="M9 8l-2 8M15 8l-2 8" stroke="${R}"/>`,
  ),
  join: svg(
    `<path d="M3 15l6-6M15 9l6 6" stroke="${B}" stroke-width="1.6"/><path d="M9 9h6" stroke="${R}" stroke-width="1.6"/>`,
  ),
  chamfer: svg(
    `<path d="M4 4v9l7 7h9" stroke="${B}" stroke-width="1.6"/><path d="M4 13l7 7" stroke="${R}" stroke-dasharray="2 1.5"/>`,
  ),
  fillet: svg(
    `<path d="M4 4v10a6 6 0 0 0 6 6h10" stroke="${B}" stroke-width="1.6"/><path d="M4 20h2M4 20v-2" stroke="${R}"/>`,
  ),
  explode: svg(
    `<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.5 5.5L8 8M16 16l2.5 2.5M18.5 5.5L16 8M8 16l-2.5 2.5" stroke="${Y}" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="${R}" stroke="none"/>`,
  ),

  // dimension
  // ---- dimension toolbar
  dimlinear: svg(
    `<path d="M4 6v13M20 6v13M4 16h16" stroke="${K}"/>${arrowHead(4, 16, -1, 0)}${arrowHead(20, 16, 1, 0)}<path d="M9 11h6" stroke="${B}" stroke-width="2"/>`,
  ),
  dimaligned: svg(
    `<path d="M4 18L18 4M4 18l3.5 3.5M18 4l3.5 3.5M5 21L21 5" stroke="${K}"/>${arrowHead(5.5, 19.5, -1, 1)}${arrowHead(19.5, 5.5, 1, -1)}`,
  ),
  dimradius: svg(
    `<circle cx="12" cy="12" r="8" stroke="${Gy}"/><path d="M12 12L19 7" stroke="${K}"/>${arrowHead(19, 7, 1.4, -1)}<path d="M4 4l3 0" stroke="${B}" stroke-width="2"/>`,
  ),
  dimdiameter: svg(
    `<circle cx="12" cy="12" r="8" stroke="${Gy}"/><path d="M5 17L19 7" stroke="${K}"/>${arrowHead(19, 7, 1.4, -1)}${arrowHead(5, 17, -1.4, 1)}`,
  ),
  dimangular: svg(
    `<path d="M4 20L20 20M4 20L18 6" stroke="${Gy}"/><path d="M14 20a10 10 0 0 0-7.4-10" stroke="${K}"/>${arrowHead(6.6, 10, -1, -1)}`,
  ),
  dimbaseline: svg(`<path d="M5 3v18M12 8v13M19 14v7M5 8h7M5 14h14" stroke="${K}"/>`),
  dimcontinue: svg(
    `<path d="M3 5v16M11 5v16M20 5v16M3 12h8M11 12h9" stroke="${K}"/><path d="M5 9h4M13 9h5" stroke="${B}"/>`,
  ),
  leader: svg(
    `<path d="M4 20L12 8h8" stroke="${K}" stroke-width="1.4"/>${arrowHead(4, 20, -1, 1.5)}<path d="M13 5h7" stroke="${B}" stroke-width="2"/>`,
  ),
  dimstyle: svg(
    `<path d="M3 18h18M3 14v8M21 14v8" stroke="${K}"/><rect x="7" y="3" width="10" height="7" fill="${W}"/><path d="M9 6h6" stroke="${B}"/>`,
  ),

  // layers
  // ---- layers
  layers: svg(
    `<path d="M12 4l9 4.5-9 4.5-9-4.5z" fill="${LB}"/><path d="M3 12l9 4.5 9-4.5M3 16l9 4.5 9-4.5" stroke="${K}"/>`,
  ),
  bulb: svg(
    `<circle cx="12" cy="10" r="6" fill="#ffe36b"/><rect x="9.5" y="16" width="5" height="4" fill="#bbb"/>`,
    16,
  ),
  bulboff: svg(
    `<circle cx="12" cy="10" r="6" fill="#999"/><rect x="9.5" y="16" width="5" height="4" fill="#bbb"/>`,
    16,
  ),
  sun: svg(
    `<circle cx="12" cy="12" r="4.5" fill="#ffd23c"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke="${Y}" stroke-width="1.6"/>`,
    16,
  ),
  snow: svg(
    `<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7" stroke="#4aa3ff" stroke-width="1.6"/>`,
    16,
  ),
  lock: svg(
    `<rect x="5" y="11" width="14" height="10" rx="1" fill="#f0c04a"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="${K}" stroke-width="1.6"/>`,
    16,
  ),
  unlock: svg(
    `<rect x="5" y="11" width="14" height="10" rx="1" fill="#f0c04a"/><path d="M8 11V8a4 4 0 0 1 7.5-2" stroke="${K}" stroke-width="1.6"/>`,
    16,
  ),
  layermgr: svg(
    `<path d="M12 3l9 4.5-9 4.5-9-4.5z" fill="${LB}"/><path d="M3 11.5l9 4.5 9-4.5" stroke="${K}"/><path d="M3 15.5l9 4.5 9-4.5" stroke="${K}"/><circle cx="18" cy="17" r="4" fill="${Y}" stroke="${K}"/>`,
  ),
  layeriso: svg(
    `<path d="M12 3l9 4.5-9 4.5-9-4.5z" fill="${LB}"/><path d="M3 12l9 4.5 9-4.5" stroke="${Gy}"/>`,
  ),
  // ---- tools and queries
  grid: svg(`<path d="M4 4h16v16H4zM4 12h16M12 4v16" stroke="${Gy}"/>`),
  delete: svg(`<path d="M6 7l12 12M18 7L6 19" stroke="${R}" stroke-width="2.2"/>`),
  selall: svg(
    `<rect x="4" y="4" width="16" height="16" stroke="${B}" stroke-dasharray="3 2"/><path d="M8 12l3 3 5-6" stroke="${Gn}" stroke-width="1.8"/>`,
  ),
  find: svg(
    `<circle cx="10" cy="10" r="6" fill="${LB}"/><path d="M14.5 14.5L21 21" stroke-width="2"/>`,
  ),
  dist: svg(`<path d="M3 17L21 7" stroke="${K}"/><path d="M5 20l2-6M19 10l2-6" stroke="${B}"/>`),
  area: svg(`<path d="M5 18l3-11 11 3-3 10z" fill="#e5eeff" stroke="${B}"/>`),
  list: svg(
    `<rect x="4" y="3" width="16" height="18" fill="${W}"/><path d="M7 8h10M7 12h10M7 16h6" stroke="${B}"/>`,
  ),
  units: svg(
    `<path d="M3 17h18M3 13v8M21 13v8M7 17v-3M11 17v-3M15 17v-3M19 17v-3" stroke="${K}"/>`,
  ),
  style: svg(
    `<path d="M5 19L11 5l6 14M7.5 14h7" stroke="${B}" stroke-width="1.8"/><path d="M19 4l2 2-6 6-3 1 1-3z" fill="${Y}" stroke="${K}" stroke-width="1"/>`,
  ),
  options: svg(
    `<circle cx="12" cy="12" r="3.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>`,
  ),
  acad: `<svg viewBox="0 0 24 24" width="18" height="18"><defs><linearGradient id="mcg" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="#ffc545"/><stop offset=".55" stop-color="#ff8f0a"/><stop offset="1" stop-color="#b53f0b"/></linearGradient></defs><rect x="1" y="1" width="22" height="22" rx="5.2" fill="url(#mcg)"/><path d="M12 3.6v2.6" stroke="#fff4e2" stroke-width="1.8" stroke-linecap="round"/><path d="M12 6.8L8.6 17.4M12 6.8l3.4 10.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="6.8" r="1.6" fill="#fff"/><path d="M8.6 17.4l-.4 1.8M15.4 17.4l.5 1.8" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/><path d="M7 20.2q5 1.8 10 0" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1" stroke-dasharray=".1 1.7" stroke-linecap="round"/></svg>`,
};

// ---- 3D solid modelling icons (isometric style)
/* ============================================================================================
 * 3. SOLID (3D) ICONS
 * ========================================================================================== */

/** The three visible faces of a cube (top, left, right colours; `o` = outline width, 0 = none). */
const cubeFaces = (top = '#dfe8f8', l = '#a9bde6', r = '#7f98d0', o = 0) =>
  `<path d="M12 ${3 + o}l8 4.5-8 4.5-8-4.5z" fill="${top}"/><path d="M4 ${7.5 + o}l8 4.5v9l-8-4.5z" fill="${l}"/><path d="M20 ${7.5 + o}l-8 4.5v9l8-4.5z" fill="${r}"/>`;
/** Solid modelling, 3D editing and visual style icons. */
const SOLID_ICONS = {
  box: svg(cubeFaces()),
  cylinder: svg(
    `<path d="M5 7v10c0 2 3 3.5 7 3.5s7-1.5 7-3.5V7" fill="#a9bde6"/><ellipse cx="12" cy="7" rx="7" ry="3.5" fill="#dfe8f8"/>`,
  ),
  cone: svg(
    `<path d="M12 3L5 17c0 2 3 3.5 7 3.5s7-1.5 7-3.5z" fill="#a9bde6"/><ellipse cx="12" cy="17" rx="7" ry="3.2" fill="#7f98d0" opacity=".55"/>`,
  ),
  sphere: svg(
    `<circle cx="12" cy="12" r="8.5" fill="#a9bde6"/><ellipse cx="12" cy="12" rx="8.5" ry="3" stroke="${B}" stroke-width=".9"/><path d="M12 3.5c-3 3-3 14 0 17" stroke="${B}" stroke-width=".9"/>`,
  ),
  torus: svg(
    `<ellipse cx="12" cy="12" rx="9" ry="6" fill="#a9bde6"/><ellipse cx="12" cy="12" rx="4" ry="2" fill="${W}"/>`,
  ),
  wedge: svg(
    `<path d="M4 7.5L12 3l8 13.5-8 4.5z" fill="#dfe8f8"/><path d="M4 7.5L12 21 4 16.5z" fill="#7f98d0"/><path d="M4 7.5L12 3l8 13.5-8 4.5-8-4.5z"/><path d="M12 3L12 21" stroke="none"/>`,
  ),
  pyramid: svg(
    `<path d="M12 3L4 16.5l8 4.5z" fill="#a9bde6"/><path d="M12 3l8 13.5-8 4.5z" fill="#7f98d0"/>`,
  ),
  extrude: svg(
    `<path d="M2 17.6l5.2-2.8 5.2 2.8-5.2 2.8z" fill="#cfdcf6" stroke="${B}" stroke-width="1.5"/><path d="M16 3l6 3.2-6 3.2-6-3.2z" fill="#eef3fd"/><path d="M10 6.2l6 3.2v7.2l-6-3.2z" fill="#a9bde6"/><path d="M22 6.2l-6 3.2v7.2l6-3.2z" fill="#7f98d0"/><path d="M5.5 13.2C5.5 9.8 7.2 8.2 9.4 8" fill="none" stroke="${R}" stroke-width="1.9"/><path d="M8.6 5.6l3.2 2.4-3.4 2.1z" fill="${R}" stroke="none"/>`,
  ),
  sweep: svg(
    `<path d="M4 18l4-2.2 4 2.2-4 2.2z" fill="#dfe8f8" stroke="${B}"/><path d="M13.5 7.5l3-1.7 3 1.7-3 1.7z" fill="#eef3fd" stroke="${B}"/><path d="M8 15.8C8.8 10 11.8 6.6 16.5 7.5" fill="none" stroke="${R}" stroke-width="2"/><path d="M6.2 17.2C7.2 11 11.1 7.1 16.5 7.5L19 12c-4.5-.6-7 1.5-7 6z" fill="#a9bde6" fill-opacity=".8" stroke="${B}"/>`,
  ),
  loft: svg(
    `<ellipse cx="12" cy="19" rx="7.5" ry="2.4" fill="#7f98d0"/><ellipse cx="12" cy="11.5" rx="5.2" ry="1.8" fill="#a9bde6"/><ellipse cx="12" cy="4.5" rx="2.8" ry="1.2" fill="#eef3fd"/><path d="M4.5 19L9.2 4.5M19.5 19L14.8 4.5" stroke="${B}"/><path d="M4.5 19Q12 21.4 19.5 19L14.8 4.5Q12 5.7 9.2 4.5z" fill="#a9bde6" fill-opacity=".55" stroke="none"/>`,
  ),
  revolve: svg(
    `<path d="M12 6.2H8.6L5.4 10.4l1.2 5.6 2.2 3.4H12z" fill="#a9bde6" stroke="${K}" stroke-width="1.5"/><path d="M12 6.2h3.4l3.2 4.2-1.2 5.6-2.2 3.4H12" fill="#f4f7fd" stroke="${Gy}" stroke-width="1.3" stroke-dasharray="2 1.5"/><path d="M12 2.5V21.5" stroke="${K}" stroke-width="1" stroke-dasharray="1.6 1.4"/><path d="M4.5 4.2Q12 -0.6 19.5 4.2" fill="none" stroke="${R}" stroke-width="2"/><path d="M21 6.2l-4.4-.6 2.6-3.4z" fill="${R}" stroke="none"/>`,
  ),
  slice: svg(
    `<path d="M12 3l8 4.5-8 4.5-8-4.5z" fill="#eef3fd"/><path d="M4 7.5l8 4.5v9l-8-4.5z" fill="#cfdcf6"/><path d="M20 7.5l-8 4.5v9l8-4.5z" fill="#b6c7ec"/><path d="M1 12.4L12 7l11 5.4L12 18z" fill="${R}" fill-opacity=".32" stroke="${R}" stroke-width="1.7"/>`,
  ),
  union: svg(
    `<path d="M3 11l5-2.5 5 2.5v6l-5 2.5-5-2.5z" fill="#a9bde6"/><path d="M11 7l5-2.5L21 7v6l-5 2.5-5-2.5z" fill="#7f98d0" opacity=".85"/>`,
  ),
  subtract: svg(
    `<path d="M3 11l5-2.5 5 2.5v6l-5 2.5-5-2.5z" fill="#a9bde6"/><path d="M11 7l5-2.5L21 7v6l-5 2.5-5-2.5z" fill="${W}" stroke="${R}" stroke-dasharray="2 1.5"/>`,
  ),
  intersect: svg(
    `<clipPath id="icx1"><path d="M9 7l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z"/></clipPath><path d="M3 12.5l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z" fill="#dfe8f8" stroke="${Gy}"/><path d="M9 7l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z" fill="#dfe8f8" stroke="${Gy}"/><path d="M3 12.5l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z" fill="${R}" stroke="none" clip-path="url(#icx1)"/><path d="M3 12.5l5-2.8 5 2.8v5.6l-5 2.8-5-2.8zM9 7l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z" fill="none" stroke="${K}" stroke-width="1.2"/>`,
  ),
  filletedge: svg(
    `<path d="M4 4v10a5 5 0 0 0 5 5h11V4z" fill="#dfe8f8" stroke="none"/><path d="M4 4v10a5 5 0 0 0 5 5h11" fill="none"/><path d="M4 14a5 5 0 0 0 5 5" fill="none" stroke="${R}" stroke-width="2.4"/><path d="M4 4h16v15" fill="none" stroke="${Gy}" stroke-dasharray="1.6 1.6"/>`,
  ),
  chamferedge: svg(
    `<path d="M4 4v10l5 5h11V4z" fill="#dfe8f8" stroke="none"/><path d="M4 4v10M9 19h11" fill="none"/><path d="M4 14l5 5" fill="none" stroke="${R}" stroke-width="2.4"/><path d="M4 4h16v15" fill="none" stroke="${Gy}" stroke-dasharray="1.6 1.6"/>`,
  ),
  presspull: svg(
    `${cubeFaces('#dfe8f8', '#a9bde6', '#7f98d0')}<path d="M12 3l8 4.5-8 4.5-8-4.5z" fill="#f5b1b1" stroke="${R}" stroke-width="1.4"/><path d="M12 8V1.5" stroke="${R}" stroke-width="1.8"/>${arrowHead(12, 1, 0, -1, R)}<path d="M12 13v7" stroke="${B}" stroke-width="1.4" stroke-dasharray="2 1.5"/>${arrowHead(12, 21, 0, 1, B)}`,
  ),
  shellsolid: svg(
    `<path d="M12 3l8 4.5-8 4.5-8-4.5z" fill="#dfe8f8"/><path d="M4 7.5l8 4.5v9l-8-4.5z" fill="#a9bde6"/><path d="M20 7.5l-8 4.5v9l8-4.5z" fill="#7f98d0"/><path d="M12 6l4 2.2-4 2.2-4-2.2z" fill="${W}" stroke="${R}"/><path d="M8 8.2v4.2M16 8.2v4.2" stroke="${R}" stroke-dasharray="1.5 1"/>`,
  ),
  hole: svg(
    `${cubeFaces()}<ellipse cx="12" cy="7.5" rx="3.2" ry="1.7" fill="${W}" stroke="${R}" stroke-width="1.4"/><path d="M8.8 7.5v6c0 1 1.4 1.8 3.2 1.8s3.2-.8 3.2-1.8v-6" fill="none" stroke="${R}" stroke-dasharray="1.5 1"/>`,
  ),
  imprint: svg(
    `${cubeFaces()}<path d="M5 8l14 8M8 5.5l12 7" stroke="${R}" stroke-width="1.6"/><circle cx="12" cy="11.5" r="1.5" fill="${Y}" stroke="none"/>`,
  ),
  move3d: svg(
    `${cubeFaces('#dfe8f8', '#a9bde6', '#7f98d0', 3)}<path d="M12 1v5M9.5 3.5L12 1l2.5 2.5" stroke="${Gn}" stroke-width="1.5"/>`,
  ),
  rotate3d: svg(
    `${cubeFaces('#dfe8f8', '#a9bde6', '#7f98d0', 2)}<path d="M3 5a9 5 0 0 1 18 0" stroke="${B}" stroke-width="1.6"/><path d="M21 5l-.5-3.2M21 5l-3-1" stroke="${B}" stroke-width="1.4"/>`,
  ),
  mirror3d: svg(
    `<path d="M3 8l6-3v10l-6 3z" fill="#a9bde6"/><path d="M21 8l-6-3v10l6 3z" fill="#7f98d0" opacity=".6"/><path d="M12 2v20" stroke="${R}" stroke-dasharray="2 2"/>`,
  ),
  orbit: svg(
    `<circle cx="12" cy="12" r="8" fill="#e8f0ff"/><ellipse cx="12" cy="12" rx="8" ry="3.2" stroke="${Gn}" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="3.2" ry="8" stroke="${Gn}" stroke-width="1.5"/>`,
  ),
  ucsface: svg(`<path d="M4 17l7-10 9 3-7 10z" fill="#cfe0ff" stroke="${B}"/><path d="M11 13l7-5M11 13l-4-4M11 13v8" stroke="${R}" stroke-width="1.5"/>`),
  ucsview: svg(`<rect x="3" y="5" width="18" height="14" rx="2" fill="#e7eefb" stroke="${B}"/><path d="M12 12h7M12 12V5M12 12l-5 5" stroke="${Gn}" stroke-width="1.5"/>`),
  massprop: svg(`${cubeFaces()}<path d="M2 21h6" stroke="${B}"/>`),
  interfere: svg(
    `<clipPath id="icx2"><path d="M9 7l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z"/></clipPath><path d="M3 12.5l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z" fill="#a9bde6"/><path d="M9 7l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z" fill="#e6b4b4"/><path d="M3 12.5l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z" fill="${R}" stroke="none" clip-path="url(#icx2)"/><path d="M3 12.5l5-2.8 5 2.8v5.6l-5 2.8-5-2.8zM9 7l5-2.8 5 2.8v5.6l-5 2.8-5-2.8z" fill="none" stroke="${K}" stroke-width="1.2"/><path d="M20 17.2v2.4M20 21.2v.5" stroke="${R}" stroke-width="1.9"/>`,
  ),
  // Surface Create: each symbol shows the geometry produced by that command.
  surfplanar: svg(
    `<path d="M3 16l7-9 11 2-7 9z" fill="#dce8ff" stroke="${B}" stroke-width="1.5"/><path d="M6 12.2l11 2M8.2 9.3l7 7" stroke="${Gy}" stroke-width=".8"/>${sq(3, 16, 2.4)}${sq(21, 9, 2.4)}`,
  ),
  surfnetwork: svg(
    `<path d="M3 18C6 5 10 5 13 17S18 19 21 5M4 7c5 4 11 4 16 1M3.5 13c5 3 11 3 17 .5" stroke="${B}" stroke-width="1.25"/><circle cx="12" cy="11" r="1.5" fill="${R}" stroke="none"/>`,
  ),
  surfpatch: svg(
    `<path d="M4 17C5 8 8 5 12 6c4-3 7 1 8 10-5 3-11 3-16 1z" fill="#cfe0ff" stroke="${B}" stroke-width="1.5"/><path d="M6 14c4-2 8-2 12 0M12 6v11" stroke="${Gy}" stroke-width=".8"/><circle cx="12" cy="12" r="1.6" fill="${R}" stroke="none"/>`,
  ),
  surfbridge: svg(
    `<path d="M3 18C5 12 6 8 9 5M15 19c2-4 3-8 6-12" stroke="${B}" stroke-width="1.8"/><path d="M5 14C9 11 13 12 18 10M7 8c4-2 7-1 12 1" stroke="${R}" stroke-width="1.1"/><path d="M5 14L7 8c4-2 7-1 12 1l-1 1c-5 2-9 1-13 4z" fill="#bcd2fa" fill-opacity=".8" stroke="none"/>`,
  ),
  surffill: svg(
    `<path d="M4 15l3-9 8-2 5 7-3 8-9 1z" fill="#cfe0ff" stroke="${B}" stroke-width="1.5"/><path d="M7 6l10 13M4 15l16-4" stroke="${Gy}" stroke-width=".75"/>${sq(4, 15, 2.2)}${sq(15, 4, 2.2)}${sq(17, 19, 2.2)}`,
  ),
  surfextrude: svg(
    `<path d="M3 18l6-3 6 3-6 3z" fill="#dce8ff" stroke="${B}" stroke-width="1.4"/><path d="M9 15V6l6-3v15" fill="#a9c3ef" fill-opacity=".7" stroke="${B}"/><path d="M18 15V6" stroke="${R}" stroke-width="1.7"/>${arrowHead(18, 4, 0, -1, R)}`,
  ),
  surfrevolve: svg(
    `<path d="M11 5H8l-3 5 2 7 4 2z" fill="#bcd2fa" stroke="${B}" stroke-width="1.4"/><path d="M12 3v18" stroke="${K}" stroke-dasharray="2 1.5"/><path d="M5 5c4-4 10-4 14 0" stroke="${R}" stroke-width="1.8"/>${arrowHead(19, 5, 1, .4, R)}<path d="M13 5c4 2 5 10 0 14" stroke="${Gy}" stroke-dasharray="2 1"/>`,
  ),
  surfthrough: svg(
    `<path d="M4 18Q12 22 20 18M6 12q6 3 12 0M9 5q3 1.8 6 0" stroke="${B}" stroke-width="1.45"/><path d="M4 18Q7 9 9 5M20 18q-3-9-5-13" stroke="${Gy}"/><path d="M4 18q8 4 16 0L15 5q-3 2-6 0z" fill="#bcd2fa" fill-opacity=".45" stroke="none"/>`,
  ),
  surfsweep: svg(
    `<path d="M3 18l4-2 4 2-4 2z" fill="#dce8ff" stroke="${B}" stroke-width="1.3"/><path d="M7 16C8 8 12 5 19 6" stroke="${R}" stroke-width="1.8"/><path d="M7 16c2-5 6-7 11-6l2 5c-5-2-8 0-9 4z" fill="#a9c3ef" stroke="${B}"/><path d="M17 6l2-3 2 4" stroke="${R}"/>`,
  ),
  // Surface Edit & Topology: sheets are blue, seams/cutters and direction cues are red.
  extractface: svg(
    `${cubeFaces('#edf3ff', '#b7caec', '#8fa9da')}<path d="M12 12l8-4.5v9L12 21z" fill="${W}" stroke="${Gy}" stroke-dasharray="2 1"/><path d="M16 11l5-2.5v6L16 17z" fill="#f4b7b7" stroke="${R}"/><path d="M17 7l3-3" stroke="${R}"/>${arrowHead(21, 3, 1, -1, R)}`,
  ),
  bodycopy: svg(
    `${cubeFaces('#edf3ff', '#b7caec', '#8fa9da')}<path d="M11 8l5-2.8L21 8v5.5l-5 2.8-5-2.8z" fill="#d7e3fa" stroke="${B}"/><path d="M8 4l7-2" stroke="${R}"/>${arrowHead(17, 2, 1, 0, R)}`,
  ),
  unsew: svg(
    `<path d="M3 6l8 3v11l-8-3z" fill="#b7caec" stroke="${B}"/><path d="M14 8l7-3v11l-7 3z" fill="#dce8ff" stroke="${B}"/><path d="M12.5 8.5v10" stroke="${R}" stroke-width="1.6" stroke-dasharray="1.5 2"/><path d="M10 5L7 3M15 5l3-3" stroke="${R}"/>${arrowHead(6, 2, -1, -1, R)}${arrowHead(19, 1, 1, -1, R)}`,
  ),
  deleteface: svg(
    `<path d="M12 3l8 4.5-8 4.5-8-4.5z" fill="#dce8ff"/><path d="M4 7.5l8 4.5v9l-8-4.5z" fill="#b7caec"/><path d="M20 7.5l-8 4.5v9" fill="none" stroke="${Gy}" stroke-dasharray="2 1"/><path d="M15 12l6 6M21 12l-6 6" stroke="${R}" stroke-width="2"/>`,
  ),
  sew: svg(
    `<path d="M3 6l8 3v11l-8-3zM13 9l8-3v11l-8 3z" fill="#c8daf7" stroke="${B}"/><path d="M12 8.5v12" stroke="${R}" stroke-width="1.5" stroke-dasharray="1 2"/><path d="M9 11h6M9 15h6M9 19h6" stroke="${K}" stroke-width=".9"/>`,
  ),
  checkbody: svg(
    `${cubeFaces('#edf3ff', '#b7caec', '#8fa9da')}<circle cx="17" cy="17" r="5" fill="${W}" stroke="${Gn}" stroke-width="1.5"/><path d="M14.5 17l1.7 1.8 3.4-4" stroke="${Gn}" stroke-width="2" fill="none"/>`,
  ),
  mergefaces: svg(
    `<path d="M3 16l7-9 11 2-7 9z" fill="#dce8ff" stroke="${B}" stroke-width="1.5"/><path d="M12 7.4l-1.5 9.5" stroke="${Gy}" stroke-dasharray="1.5 1.5"/><path d="M7 4h8" stroke="${R}" stroke-width="1.6"/>${arrowHead(16,4,1,0,R)}<path d="M9 12l2 2 4-5" stroke="${Gn}" stroke-width="1.8"/>`,
  ),
  splitbody: svg(
    `${cubeFaces('#edf3ff', '#b7caec', '#8fa9da')}<path d="M2 12l10-5 10 5-10 5z" fill="#f5a0a0" fill-opacity=".48" stroke="${R}" stroke-width="1.5"/><path d="M4 20l-2 2M20 20l2 2" stroke="${B}"/>`,
  ),
  trimbody: svg(
    `${cubeFaces('#edf3ff', '#b7caec', '#8fa9da')}<path d="M12 2l8 4.5v9L12 20l-8-4.5v-9z" fill="#efb2b2" fill-opacity=".45" stroke="none"/><path d="M5 20L19 4" stroke="${R}" stroke-width="2"/><path d="M3 5l4 4M7 5L3 9" stroke="${R}" stroke-width="1.4"/>`,
  ),
  trimface: svg(
    `<path d="M3 18L7 5l14 3-4 12z" fill="#dce8ff" stroke="${B}"/><path d="M4 14l15 3" stroke="${R}" stroke-width="1.8"/><path d="M4 14l-1 4 14 2 2-3z" fill="#efb2b2" opacity=".6" stroke="${R}" stroke-dasharray="2 1"/>`,
  ),
  trimedge: svg(
    `<path d="M4 18L6 5l15 3-3 12z" fill="#dce8ff" stroke="${B}"/><path d="M8 5l9 15" stroke="${R}" stroke-width="1.7"/><path d="M4 18l4-13 3 5z" fill="#efb2b2" opacity=".7"/><path d="M3 6l4 4M7 6l-4 4" stroke="${R}"/>`,
  ),
  untrimface: svg(
    `<path d="M6 7h12v11H6z" fill="#dce8ff" stroke="${B}"/><path d="M3 4h18v17H3z" stroke="${Gy}" stroke-dasharray="2 1"/><path d="M8 3C4 4 3 7 4 10" stroke="${R}" stroke-width="1.6"/>${arrowHead(4, 11, 0, 1, R)}`,
  ),
  extendsheet: svg(
    `<path d="M3 7l10 2v10L3 17z" fill="#c8daf7" stroke="${B}"/><path d="M13 9l8 1.6v10L13 19z" fill="#edf3ff" stroke="${R}" stroke-dasharray="2 1"/><path d="M14 5h6" stroke="${R}" stroke-width="1.5"/>${arrowHead(21, 5, 1, 0, R)}`,
  ),
  trimextend: svg(
    `<path d="M3 6l8 4v10l-8-4zM21 6l-8 4v10l8-4z" fill="#dce8ff" stroke="${B}"/><path d="M12 3v19" stroke="${K}" stroke-width="1.5"/><path d="M9 8h6" stroke="${R}" stroke-dasharray="2 1"/><path d="M8 5l3 3-3 3M16 5l-3 3 3 3" stroke="${R}"/>`,
  ),
  replaceface: svg(
    `<path d="M4 8l8 4v9l-8-4z" fill="#b7caec" stroke="${B}"/><path d="M12 12l8-4v9l-8 4z" fill="${W}" stroke="${Gy}" stroke-dasharray="2 1"/><path d="M13 12c3-5 6-4 8-5v9c-3-1-5 2-8 4z" fill="#f2b6b6" stroke="${R}"/><path d="M12 5h6" stroke="${R}"/>${arrowHead(19, 5, 1, 0, R)}`,
  ),
  divideface: svg(
    `<path d="M3 16l7-10 11 3-7 10z" fill="#dce8ff" stroke="${B}"/><path d="M7 10l10 5" stroke="${R}" stroke-width="2"/><circle cx="7" cy="10" r="1.2" fill="${K}"/><circle cx="17" cy="15" r="1.2" fill="${K}"/>`,
  ),
  thickensheet: svg(
    `<path d="M3 13l9-5 9 5-9 5z" fill="#dce8ff" stroke="${B}"/><path d="M3 17l9-5 9 5-9 5z" fill="#9fb9e7" fill-opacity=".7" stroke="${B}"/><path d="M5 11V7M19 11V7" stroke="${R}"/>${arrowHead(5, 6, 0, -1, R)}${arrowHead(19, 6, 0, -1, R)}`,
  ),
  editfeature: svg(
    `${cubeFaces('#edf3ff', '#b7caec', '#8fa9da')}<path d="M3 4h8M15 4h6M7 2v4M3 9h4M11 9h10M9 7v4" stroke="${R}" stroke-width="1.4"/><circle cx="7" cy="4" r="1.6" fill="${W}"/><circle cx="9" cy="9" r="1.6" fill="${W}"/>`,
  ),
  // Facet / Mesh: triangle wirework distinguishes polygon operations from B-Rep surfaces.
  stlimport: svg(
    `<path d="M3 7h7l2 2h9v11H3z" fill="#f5d36f" stroke="${K}"/><path d="M8 17l4-7 4 7z" fill="#c8daf7" stroke="${B}"/><path d="M12 10v7M8 17h8" stroke="${Gy}" stroke-width=".7"/>`,
  ),
  tomesh: svg(
    `${cubeFaces('#edf3ff', '#b7caec', '#8fa9da')}<path d="M4 7.5l8 13M12 12l8 4.5M12 3v9M4 16.5l8-4.5 8-4.5" stroke="${B}" stroke-width=".8"/><path d="M2 3h5" stroke="${R}"/>${arrowHead(8, 3, 1, 0, R)}`,
  ),
  facetboolean: svg(
    `<path d="M3 13l6-4 6 4-6 4zM10 8l5-3 6 4-6 4z" fill="#c8daf7" stroke="${B}"/><path d="M9 9l6 4-5 3" stroke="${Gy}"/><path d="M10 10l5-2 3 2-4 2.5z" fill="${R}" fill-opacity=".75" stroke="none"/>`,
  ),
  fillholemesh: svg(
    `<path d="M3 18l3-12 6-3 9 5-2 11-8 2z" fill="#dce8ff" stroke="${B}"/><path d="M6 6l5 15M12 3l7 16M3 18L21 8" stroke="${Gy}" stroke-width=".8"/><path d="M8 10l5-3 4 5-5 3z" fill="${R}" fill-opacity=".65" stroke="${R}"/>`,
  ),
  splitfacet: svg(
    `${cubeFaces('#edf3ff', '#b7caec', '#8fa9da')}<path d="M4 7.5l8 13M12 12l8 4.5M12 3v9" stroke="${B}" stroke-width=".7"/><path d="M2 12l10-5 10 5-10 5z" fill="#f5a0a0" fill-opacity=".45" stroke="${R}" stroke-width="1.4"/>`,
  ),
  trimfacet: svg(
    `<path d="M3 18L6 5l15 3-3 12z" fill="#dce8ff" stroke="${B}"/><path d="M6 5l12 15M3 18L21 8M12 6l-2 13" stroke="${Gy}" stroke-width=".75"/><path d="M5 13l15 3" stroke="${R}" stroke-width="1.7"/><path d="M4 14l-1 4 7 1z" fill="${R}" fill-opacity=".5"/>`,
  ),
  remesh: svg(
    `<path d="M4 18l2-12 7-3 7 6-2 10z" fill="#dce8ff" stroke="${B}"/><path d="M6 6l12 13M13 3L4 18M20 9L4 18M6 6l14 3" stroke="${Gy}" stroke-width=".75"/><path d="M3 9C3 4 7 2 10 2" stroke="${R}"/>${arrowHead(11, 2, 1, 0, R)}`,
  ),
  decimatemesh: svg(
    `<path d="M3 18l2-12 7-3 9 6-3 11z" fill="#dce8ff" stroke="${B}"/><path d="M5 6l13 14M12 3L3 18M21 9L3 18" stroke="${Gy}" stroke-width=".8"/><path d="M7 12h9" stroke="${R}" stroke-width="1.8"/>${arrowHead(17, 12, 1, 0, R)}`,
  ),
  fitplane: svg(
    `<circle cx="5" cy="7" r="1" fill="${K}"/><circle cx="9" cy="16" r="1" fill="${K}"/><circle cx="13" cy="6" r="1" fill="${K}"/><circle cx="18" cy="15" r="1" fill="${K}"/><circle cx="20" cy="8" r="1" fill="${K}"/><path d="M3 14l7-7 11 3-7 8z" fill="#bcd2fa" fill-opacity=".65" stroke="${B}" stroke-width="1.5"/><path d="M6 12l11 3" stroke="${R}"/>`,
  ),
  vs2d: svg(
    `<rect x="4" y="4" width="16" height="16" stroke="${Gy}"/><path d="M4 4l16 16M20 4L4 20" stroke="${Gy}"/>`,
  ),
  vswire: svg(
    `<path d="M4 7.5l8-4.5 8 4.5v9l-8 4.5-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9" stroke="${K}"/>`,
  ),
  vshidden: svg(
    `<path d="M4 7.5l8-4.5 8 4.5v9l-8 4.5-8-4.5z" fill="${W}"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="${K}"/>`,
  ),
  vsconcept: svg(
    `<path d="M12 3l8 4.5-8 4.5-8-4.5z" fill="#f4d9a8"/><path d="M4 7.5l8 4.5v9l-8-4.5z" fill="#7b8fc4"/><path d="M20 7.5l-8 4.5v9l8-4.5z" fill="#bfc7e6"/>`,
  ),
  vsshaded: svg(
    `<path d="M12 3l8 4.5-8 4.5-8-4.5z" fill="#cfd3dc"/><path d="M4 7.5l8 4.5v9l-8-4.5z" fill="#9096a6"/><path d="M20 7.5l-8 4.5v9l8-4.5z" fill="#6c7284"/>`,
  ),
  vsxray: svg(
    `<path d="M4 7.5l8-4.5 8 4.5v9l-8 4.5-8-4.5z" fill="#9ec3ff" opacity=".35"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="${B}"/>`,
  ),
};
/* ============================================================================================
 * 4. LATE ADDITIONS AND LOOKUP
 * ========================================================================================== */

// the Model History panel button
SOLID_ICONS.history = svg(
  `<path d="M4 6h9M4 11h6M4 16h6" stroke="${Gy}" stroke-width="1.6"/><circle cx="16" cy="14" r="5.5" fill="#e8f0ff" stroke="${B}"/><path d="M16 11v3l2 1.5" stroke="${B}"/>`,
);
Object.assign(ICONS, SOLID_ICONS);
/** @returns {string} the SVG markup of an icon, or '' when the name is unknown. */
export const icon = (name) => ICONS[name] || '';
