/**
 * @file commands_more.js
 * @brief More commands: MLINE, SOLID, BOUNDARY, REGION and 2D booleans, SPLINEDIT, attributes, text
 *        tools, OVERKILL, CHPROP, CHANGE, array variants, groups, inquiry (MASSPROP, MEASUREGEOM,
 *        CAL, QUICKCALC), dimension extras (DIMCENTER, DIMORDINATE, QDIM, ...) and PDFIMPORT.
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import { def, alias } from './registry.js';
import * as G from './geom.js';
import * as E from './entities.js';
import * as O from './ops.js';
import { ARC_PICK, arcOfPick } from './dimmatch.js';
import { evaluate, fmtResult } from './calc.js';
import { fmtLen, fmtAng } from './units.js';
const { dist, ang, add, sub, mul, norm, perp, TAU } = G;
const isPt = (v) => v && typeof v === 'object' && 'x' in v;
const bp = (p, b = 0) => ({ x: p.x, y: p.y, b });
const closedFilter = (e) => E.isClosed(e);
const TOL_SYMBOLS = [
  ['⏤', 'Straightness'],
  ['⏥', 'Flatness'],
  ['○', 'Circularity'],
  ['⌭', 'Cylindricity'],
  ['⌓', 'Profile of a line'],
  ['⌒', 'Profile of a surface'],
  ['∠', 'Angularity'],
  ['⊥', 'Perpendicularity'],
  ['∥', 'Parallelism'],
  ['⌖', 'Position'],
  ['◎', 'Concentricity'],
  ['⌯', 'Symmetry'],
  ['↗', 'Circular runout'],
  ['⌰', 'Total runout'],
];
// ------------------------------------------------------------------ dimension extras
const dimFilter = (e) => e.type === 'dim';
// DIMCENTER (DCE): centre marks / centre lines for circles and arcs, also for small holes.
//   Lines: two centre lines through the centre that stick out 1 arrow size past the circle. They sit on layer CENTER with the CENTER linetype, and the pattern
//          is fitted to each line (long dash, gap, short dash, gap, long dash ...) so even a 4 mm hole shows real dashes instead of a solid line.
//   Mark:  a small plain cross (continuous) of the arrow size, the classic centre mark.
const CENTER_PERIOD = 50.8;
const CENTER_LONG = 31.75; // the CENTER linetype: 31.75 dash, 6.35 gap, 6.35 dash, 6.35 gap
const hasCenterLines = (c, g) =>
  c.app
    .curEnts()
    .some(
      (e) =>
        e.type === 'line' &&
        e.layer === 'CENTER' &&
        G.segDist(g.c, e.p1, e.p2) < 1e-6 * Math.max(1, g.r),
    );

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** More drawing, editing and inquiry commands. Every command is a static method `(c) => Promise`; `register()` adds them all. */
export class MoreCommands {
  /** @private Copies layer, colour, linetype and lineweight from one object to another. */
  static keepProps(src, dst) {
    dst.layer = src.layer;
    dst.color = src.color;
    dst.ltype = src.ltype;
    dst.lw = src.lw;
    return dst;
  }

  // ------------------------------------------------------------------ MLINE
  /** MLINE: a set of parallel lines. */
  static async mline(c) {
    const st = c.app.mline || (c.app.mline = { scale: 1, just: 'Top' });
    let p0;
    for (;;) {
      p0 = await c.point(
        `Current settings: Justification = ${st.just}, Scale = ${st.scale}, Style = STANDARD\nSpecify start point or [Justification/Scale/STyle]`,
        { kw: ['Justification', 'Scale', 'STyle'] },
      );
      if (p0 === 'Justification') {
        const j = await c.keyword(
          'Enter justification type [Top/Zero/Bottom]',
          ['Top', 'Zero', 'Bottom'],
          st.just,
        );
        if (j) st.just = j;
        continue;
      }
      if (p0 === 'Scale') {
        const s = await c.number('Enter mline scale', { def: st.scale });
        if (typeof s === 'number' && s > 0) st.scale = s;
        continue;
      }
      if (p0 === 'STyle') {
        c.echo('Only the STANDARD multiline style is available.');
        continue;
      }
      break;
    }
    if (!isPt(p0)) return;
    const pts = [p0];
    let closed = false;
    const build = (list, cls) => {
      if (list.length < 2) return [];
      const pl = E.mk('pline', { pts: list.map((p) => bp(p)), closed: cls });
      const half = st.scale / 2;
      const shift = st.just === 'Top' ? -half : st.just === 'Bottom' ? half : 0;
      const out = [];
      for (const d of [half + shift, -half + shift]) {
        const o = Math.abs(d) < 1e-12 ? E.clone(pl) : O.offsetSigned(pl, d, c.doc);
        if (o) out.push(c.stamp(o));
      }
      if (!cls && out.length === 2) {
        const a1 = out[0].pts[0];
        const a2 = out[1].pts[0];
        const b1 = out[0].pts[out[0].pts.length - 1];
        const b2 = out[1].pts[out[1].pts.length - 1];
        out.push(
          c.stamp(E.mk('line', { p1: bp(a1), p2: bp(a2) })),
          c.stamp(E.mk('line', { p1: bp(b1), p2: bp(b2) })),
        );
      }
      return out;
    };
    for (;;) {
      const kws = pts.length > 2 ? ['Close', 'Undo'] : pts.length > 1 ? ['Undo'] : [];
      const p = await c.point('Specify next point', {
        base: pts[pts.length - 1],
        kw: kws,
        rubber: false,
        preview: (q) => build([...pts, q], false),
      });
      if (p === null) break;
      if (p === 'Undo') {
        if (pts.length > 1) pts.pop();
        continue;
      }
      if (p === 'Close') {
        closed = true;
        break;
      }
      pts.push(p);
    }
    c.addAll(build(pts, closed));
  }

  // ------------------------------------------------------------------ SOLID / TRACE
  /** SOLID: a filled 3- or 4-sided area. */
  static async solid2d(c) {
    let p1 = await c.point('Specify first point');
    if (!isPt(p1)) return;
    let p2 = await c.point('Specify second point', { base: p1 });
    if (!isPt(p2)) return;
    const mkSolid = (loop) =>
      c.mk('hatch', {
        loops: [loop.map((p) => ({ x: p.x, y: p.y }))],
        pattern: 'SOLID',
        scale: 1,
        angle: 0,
      });
    for (;;) {
      const p3 = await c.point('Specify third point', {
        base: p2,
        rubber: false,
        preview: (q) => [mkSolid([p1, p2, q])],
      });
      if (!isPt(p3)) return;
      const p4 = await c.point('Specify fourth point or <exit>', {
        base: p3,
        rubber: false,
        preview: (q) => [mkSolid([p1, p2, q, p3])],
      });
      if (!isPt(p4)) {
        c.add(mkSolid([p1, p2, p3]));
        return;
      }
      c.add(mkSolid([p1, p2, p4, p3]));
      p1 = p3;
      p2 = p4;
    }
  }

  /** TRACE: a filled band of a given width. */
  static async trace(c) {
    const w = await c.dist('Specify trace width', { def: c.app.traceW || 1 });
    if (typeof w !== 'number' || w <= 0) return;
    c.app.traceW = w;
    let a = await c.point('Specify start point');
    if (!isPt(a)) return;
    const quad = (p, q) => {
      const n = mul(perp(norm(sub(q, p))), w / 2);
      return c.mk('hatch', {
        loops: [[add(p, n), add(q, n), sub(q, n), sub(p, n)]],
        pattern: 'SOLID',
        scale: 1,
        angle: 0,
      });
    };
    for (;;) {
      const b = await c.point('Specify next point', {
        base: a,
        rubber: false,
        preview: (q) => [quad(a, q)],
      });
      if (!isPt(b)) return;
      c.add(quad(a, b));
      a = b;
    }
  }

  // ------------------------------------------------------------------ BOUNDARY / REGION / booleans
  /** BOUNDARY: a polyline around the area enclosed by objects. */
  static async boundary(c) {
    for (;;) {
      const p = await c.point('Specify internal point', {
        rubber: false,
        noOrtho: true,
        noSnap: true,
      });
      if (!isPt(p)) return;
      const loops = O.findBoundary(
        c.app.curEnts().filter((e) => c.doc.visible(e)),
        c.doc,
        p,
      );
      if (!loops) {
        c.echo('Valid boundary not found.');
        continue;
      }
      for (const l of loops) c.add(c.mk('pline', { pts: l.map((q) => bp(q)), closed: true }));
      c.echo(`BOUNDARY created ${loops.length} polyline${loops.length > 1 ? 's' : ''}`);
    }
  }

  /** @private Loads the polygon clipping library (once). */
  static pcLib() {
    const p = typeof window !== 'undefined' ? window.polygonClipping : globalThis.polygonClipping;
    if (!p) throw new Error('polygon library not loaded');
    return p;
  }

  /** @private A closed object as a ring of points for the polygon clipping. */
  static ringOf(e) {
    const loop = E.closedLoop(e);
    return loop ? [...loop.map((p) => [p.x, p.y]), [loop[0].x, loop[0].y]] : null;
  }

  /** @private Turns rings of points back into closed polylines. */
  static ringsToEnts(c, polys, like) {
    const out = [];
    for (const poly of polys)
      for (const ring of poly) {
        const pts = ring.slice(0, -1).map(([x, y]) => bp({ x, y }));
        if (pts.length >= 3)
          out.push(MoreCommands.keepProps(like, c.mk('pline', { pts, closed: true })));
      }
    return out;
  }

  /** REGION: turns closed objects into regions. */
  static async region(c) {
    const ents = await c.select('Select objects', { filter: closedFilter });
    if (!ents.length) return;
    const out = ents.map((e) =>
      MoreCommands.keepProps(
        e,
        c.mk('pline', { pts: E.closedLoop(e).map((p) => bp(p)), closed: true }),
      ),
    );
    c.erase(ents);
    c.addAll(out);
    c.echo(`${out.length} region(s) created (as closed polylines).`);
  }

  /** Union of closed 2D shapes. @returns the polylines of the result */
  static async union2d(c, ents) {
    const pc = MoreCommands.pcLib();
    const rings = ents.map(MoreCommands.ringOf).filter(Boolean);
    const res = pc.union(...rings.map((r) => [[r]]));
    c.erase(ents);
    c.addAll(MoreCommands.ringsToEnts(c, res, ents[0]));
  }

  /** Subtracts closed 2D shapes from others. @returns the polylines of the result */
  static async subtract2d(c, a, b) {
    const pc = MoreCommands.pcLib();
    const A = a
      .map(MoreCommands.ringOf)
      .filter(Boolean)
      .map((r) => [[r]]);
    const B = b
      .map(MoreCommands.ringOf)
      .filter(Boolean)
      .map((r) => [[r]]);
    const res = pc.difference(pc.union(...A), ...B);
    c.erase([...a, ...b]);
    c.addAll(MoreCommands.ringsToEnts(c, res, a[0]));
  }

  /** Intersection of closed 2D shapes. @returns the polylines of the result */
  static async intersect2d(c, ents) {
    const pc = MoreCommands.pcLib();
    const res = pc.intersection(
      ...ents
        .map(MoreCommands.ringOf)
        .filter(Boolean)
        .map((r) => [[r]]),
    );
    c.erase(ents);
    c.addAll(MoreCommands.ringsToEnts(c, res, ents[0]));
  }

  /** UNION: unites 2D regions or 3D solids. */
  static async union(c) {
    const ents = await c.select('Select objects', { filter: closedFilter });
    if (ents.length < 2) return c.fail('Select at least two closed objects.');
    return MoreCommands.union2d(c, ents);
  }

  /** SUBTRACT: subtracts 2D regions or 3D solids. */
  static async subtract(c) {
    const a = await c.select('Select solids and regions to subtract from', {
      filter: closedFilter,
      pre: false,
    });
    if (!a.length) return;
    const b = await c.select('Select solids and regions to subtract', {
      filter: closedFilter,
      pre: false,
    });
    if (!b.length) return;
    return MoreCommands.subtract2d(c, a, b);
  }

  /** INTERSECT: keeps the common part of 2D regions or 3D solids. */
  static async intersect(c) {
    const ents = await c.select('Select objects', { filter: closedFilter });
    if (ents.length < 2) return c.fail('Select at least two closed objects.');
    return MoreCommands.intersect2d(c, ents);
  }

  // ------------------------------------------------------------------ SPLINEDIT / REVERSE / FLATTEN
  /** SPLINEDIT: closes, opens, fits or reverses a spline. */
  static async splineEdit(c) {
    const r = await c.pick('Select spline', { filter: (e) => e.type === 'spline' });
    if (!r || !r.e) return;
    const e = r.e;
    for (;;) {
      const o = await c.keyword(
        `Enter an option [${e.closed ? 'Open' : 'Close'}/Reverse/Refine/Polyline/eXit]`,
        [e.closed ? 'Open' : 'Close', 'Reverse', 'Refine', 'Polyline', 'eXit'],
        'eXit',
      );
      if (o === 'Close') {
        e.closed = true;
        c.bump();
      } else if (o === 'Open') {
        e.closed = false;
        c.bump();
      } else if (o === 'Reverse') {
        e.pts.reverse();
        c.bump();
      } else if (o === 'Refine') {
        const n = [];
        for (let i = 0; i < e.pts.length; i += 1) {
          n.push(e.pts[i]);
          const nx = e.pts[i + 1] || (e.closed ? e.pts[0] : null);
          if (nx) n.push(G.mid(e.pts[i], nx));
        }
        e.pts = n.map((p) => ({ x: p.x, y: p.y }));
        c.bump();
      } else if (o === 'Polyline') {
        const pl = MoreCommands.keepProps(
          e,
          c.mk('pline', { pts: E.splinePts(e).map((p) => bp(p)), closed: e.closed }),
        );
        c.replace(e, [pl]);
        return;
      } else return;
    }
  }

  /** REVERSE: reverses the direction of lines, polylines, splines and arcs. */
  static async reverse(c) {
    const ents = await c.select('Select objects', {
      filter: (e) => ['line', 'pline', 'spline', 'arc'].includes(e.type),
    });
    for (const e of ents) {
      if (e.type === 'line') [e.p1, e.p2] = [e.p2, e.p1];
      else if (e.type === 'pline') O.reversePline(e);
      else if (e.type === 'spline') e.pts.reverse();
      else if (e.type === 'arc') {
        /* direction is implicit */
      }
    }
    c.bump();
  }

  /** FLATTEN: puts all objects on one plane. */
  static async flatten(c) {
    c.echo('All objects in this drawing are already two-dimensional.');
  }

  // ------------------------------------------------------------------ attributes
  /** ATTDEF: defines a block attribute. */
  static async attDef(c) {
    const o = await c.ui.dialog({
      title: 'Attribute Definition',
      body: (() => {
        const d = document.createElement('div');
        d.style.width = '360px';
        d.innerHTML =
          '<div class="frow"><label>Tag:</label><input type="text" name="tag"></div><div class="frow"><label>Prompt:</label><input type="text" name="prompt"></div><div class="frow"><label>Default value:</label><input type="text" name="def"></div><div class="frow"><label>Text height:</label><input type="number" name="h" value="2.5" step="any"></div>';
        return d;
      })(),
      collect: (el) => ({
        tag: el.querySelector('[name=tag]').value.trim().replace(/\s+/g, '_').toUpperCase(),
        prompt: el.querySelector('[name=prompt]').value,
        def: el.querySelector('[name=def]').value,
        h: +el.querySelector('[name=h]').value || 2.5,
      }),
    });
    if (!o || !o.tag) return;
    const p = await c.point('Specify start point', {
      preview: (q) => [c.mk('text', { p: q, h: o.h, str: o.tag, rot: 0, al: 0 })],
    });
    if (!isPt(p)) return;
    const t = c.add(c.mk('text', { p, h: o.h, str: o.tag, rot: 0, al: 0 }));
    t.attdef = { tag: o.tag, prompt: o.prompt || o.tag, def: o.def };
  }

  /** Asks for the attribute values of a block insertion. */
  static async askAttribs(c, blockName) {
    const def = c.doc.blocks[blockName];
    if (!def) return {};
    const vals = {};
    for (const e of def.ents)
      if (e.attdef) {
        const v = await c.string(`${e.attdef.prompt}`, {
          def: e.attdef.def,
          defText: e.attdef.def,
        });
        vals[e.attdef.tag] = v === null ? e.attdef.def : v;
      }
    return vals;
  }

  /** ATTEDIT: edits the attribute values of block insertions. */
  static async attEdit(c) {
    const r = await c.pick('Select block reference', { filter: (e) => e.type === 'insert' });
    if (!r || !r.e) return;
    const def = c.doc.blocks[r.e.name];
    const tags = def ? def.ents.filter((e) => e.attdef) : [];
    if (!tags.length) return c.fail('That block has no attributes.');
    r.e.attribs ||= {};
    for (const t of tags) {
      const cur = r.e.attribs[t.attdef.tag] ?? t.attdef.def;
      const v = await c.string(`${t.attdef.tag}`, { def: cur, defText: cur });
      if (v !== null) r.e.attribs[t.attdef.tag] = v;
    }
    c.bump();
  }

  // ------------------------------------------------------------------ WIPEOUT / TOLERANCE / text tools
  /** WIPEOUT: a masking area that hides what is behind it. */
  static async wipeout(c) {
    const o = await c.point('Specify first point or [Frames/Polyline] <Polyline>', {
      kw: ['Frames', 'Polyline'],
    });
    if (!isPt(o)) {
      return;
    }
    const pts = [o];
    for (;;) {
      const q = await c.point('Specify next point or [Close/Undo]', {
        base: pts[pts.length - 1],
        kw: ['Close', 'Undo'],
        preview: (r) => [c.mk('pline', { pts: [...pts, r].map((p) => bp(p)), closed: false })],
      });
      if (q === null || q === 'Close') break;
      if (q === 'Undo') {
        if (pts.length > 1) pts.pop();
        continue;
      }
      pts.push(q);
    }
    if (pts.length >= 3)
      c.add(
        c.mk('hatch', {
          loops: [pts.map((p) => ({ x: p.x, y: p.y }))],
          pattern: 'WIPE',
          scale: 1,
          angle: 0,
        }),
      );
  }

  /** TOLERANCE: a geometric tolerance frame. */
  static async tolerance(c) {
    const body = document.createElement('div');
    body.style.width = '400px';
    body.innerHTML = `<div class="frow"><label>Symbol:</label><select name="sym">${TOL_SYMBOLS.map(([s, n]) => `<option value="${s}">${s}  ${n}</option>`).join('')}</select></div><div class="frow"><label>Tolerance 1:</label><input type="text" name="t1" value="0.05"><label style="min-width:0"><input type="checkbox" name="dia"> ⌀</label></div><div class="frow"><label>Tolerance 2:</label><input type="text" name="t2"></div><div class="frow"><label>Datum 1:</label><input type="text" name="d1" style="width:50px"><label style="min-width:50px">Datum 2:</label><input type="text" name="d2" style="width:50px"><label style="min-width:50px">Datum 3:</label><input type="text" name="d3" style="width:50px"></div>`;
    const o = await c.ui.dialog({
      title: 'Geometric Tolerance',
      body,
      collect: (el) => {
        const g = (n) => el.querySelector(`[name=${n}]`);
        return {
          sym: g('sym').value,
          t1: (g('dia').checked ? '⌀' : '') + g('t1').value,
          t2: g('t2').value,
          d: [g('d1').value, g('d2').value, g('d3').value].filter(Boolean),
        };
      },
    });
    if (!o) return;
    const ds = E.dimStyleOf({ style: c.doc.curDimStyle }, c.doc);
    const h = ds.h;
    const cells = [o.sym, o.t1, ...(o.t2 ? [o.t2] : []), ...o.d];
    const p = await c.point('Enter tolerance location', { preview: () => [] });
    if (!isPt(p)) return;
    let x = p.x;
    const hh = h * 2;
    const y0 = p.y - hh / 2;
    cells.forEach((s, i) => {
      const w = Math.max(hh, E.measure(s, h, null) + h);
      const x1 = x + w;
      c.add(c.mk('line', { p1: { x, y: y0 }, p2: { x: x1, y: y0 } }));
      c.add(c.mk('line', { p1: { x, y: y0 + hh }, p2: { x: x1, y: y0 + hh } }));
      c.add(c.mk('line', { p1: { x, y: y0 }, p2: { x, y: y0 + hh } }));
      if (i === cells.length - 1)
        c.add(c.mk('line', { p1: { x: x1, y: y0 }, p2: { x: x1, y: y0 + hh } }));
      c.add(c.mk('text', { p: { x: x + w / 2, y: y0 + (hh - h) / 2 }, h, str: s, rot: 0, al: 1 }));
      x = x1;
    });
  }

  /** SCALETEXT: scales text objects in place. */
  static async scaleText(c) {
    const ents = await c.select('Select objects', {
      filter: (e) => e.type === 'text' || e.type === 'mtext',
    });
    if (!ents.length) return;
    const f = await c.number('Specify scale factor', { def: 2 });
    if (typeof f !== 'number' || f <= 0) return;
    for (const e of ents) {
      e.h *= f;
      if (e.w) e.w *= f;
    }
    c.bump();
  }

  /** JUSTIFYTEXT: changes the justification of text objects. */
  static async justifyText(c) {
    const ents = await c.select('Select objects', { filter: (e) => e.type === 'text' });
    if (!ents.length) return;
    const o = await c.keyword(
      'Enter a justification option [Left/Center/Right]',
      ['Left', 'Center', 'Right'],
      'Left',
    );
    const al = o === 'Center' ? 1 : o === 'Right' ? 2 : 0;
    for (const e of ents) {
      const L0 = E.textLayout(e, c.doc);
      const left = add(e.p, G.rotate({ x: L0.box.x0, y: 0 }, e.rot || 0));
      e.al = al;
      const L1 = E.textLayout(e, c.doc);
      e.p = sub(left, G.rotate({ x: L1.box.x0, y: 0 }, e.rot || 0));
    }
    c.bump();
  }

  // ------------------------------------------------------------------ OVERKILL
  /** OVERKILL: removes duplicate and overlapping objects. */
  static async overkill(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const key = (e) =>
      JSON.stringify([
        e.type,
        e.layer,
        e.color,
        e.ltype,
        e.type === 'line'
          ? [e.p1.x.toFixed(6), e.p1.y.toFixed(6), e.p2.x.toFixed(6), e.p2.y.toFixed(6)].join()
          : null,
      ]);
    const seen = new Set();
    const dups = [];
    for (const e of ents) {
      let k;
      if (e.type === 'line') {
        const a = e.p1;
        const b = e.p2;
        const swap = a.x > b.x || (a.x === b.x && a.y > b.y);
        const L = swap ? { ...e, p1: b, p2: a } : e;
        k = key(L);
      } else if (['circle', 'arc', 'point', 'text'].includes(e.type)) {
        const { id, ...rest } = E.clone(e);
        k = JSON.stringify([id && 0, rest]);
      } else k = 'u' + e.id;
      if (seen.has(k)) dups.push(e);
      else seen.add(k);
    }
    c.erase(dups);
    // merge collinear overlapping lines
    const lines = ents.filter((e) => e.type === 'line' && !dups.includes(e));
    const used = new Set();
    let merged = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (used.has(i)) continue;
      const cur = lines[i];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (used.has(j)) continue;
        const o = lines[j];
        if (o.layer !== cur.layer || o.color !== cur.color || o.ltype !== cur.ltype) continue;
        const d = norm(sub(cur.p2, cur.p1));
        if (
          Math.abs(G.cross(d, sub(o.p1, cur.p1))) > 1e-7 ||
          Math.abs(G.cross(d, sub(o.p2, cur.p1))) > 1e-7
        )
          continue;
        const t = [cur.p1, cur.p2, o.p1, o.p2].map((q) => G.dot(sub(q, cur.p1), d));
        const a0 = Math.min(t[0], t[1]);
        const a1 = Math.max(t[0], t[1]);
        const b0 = Math.min(t[2], t[3]);
        const b1 = Math.max(t[2], t[3]);
        if (b0 > a1 + 1e-7 || b1 < a0 - 1e-7) continue;
        const lo = Math.min(a0, b0);
        const hi = Math.max(a1, b1);
        cur.p1 = add(cur.p1, mul(d, lo));
        cur.p2 = add(lines[i].p1, mul(d, hi));
        used.add(j);
        c.erase([o]);
        merged += 1;
      }
    }
    c.echo(`${dups.length} duplicate(s) deleted; ${merged} overlapping object(s) combined.`);
  }

  // ------------------------------------------------------------------ CHPROP / CHANGE
  /** CHPROP: changes colour, layer, linetype or lineweight of objects. */
  static async chprop(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    for (;;) {
      const o = await c.keyword(
        'Enter property to change [Color/LAyer/LType/ltScale/LWeight/Thickness]',
        ['Color', 'LAyer', 'LType', 'ltScale', 'LWeight', 'Thickness'],
        null,
      );
      if (!o) return;
      if (o === 'LAyer') {
        const n = await c.string('Enter new layer name', { def: c.doc.cur.layer });
        if (n) {
          if (!c.doc.hasLayer(n)) c.doc.addLayer(n);
          ents.forEach((e) => {
            e.layer = c.doc.layer(n).name;
          });
        }
      } else if (o === 'Color') {
        const v = await c.string('Enter new color [Truecolor/COlorbook] <BYLAYER>', {
          def: 'BYLAYER',
        });
        if (v !== null) {
          const u = String(v).toUpperCase();
          ents.forEach((e) => {
            e.color =
              u === 'BYLAYER'
                ? null
                : u === 'BYBLOCK'
                  ? 'bb'
                  : /^#/.test(v)
                    ? v
                    : parseInt(u, 10) || null;
          });
        }
      } else if (o === 'LType') {
        const v = await c.string('Enter new linetype name', { def: 'BYLAYER' });
        if (v !== null)
          ents.forEach((e) => {
            e.ltype = /^bylayer$/i.test(v) ? null : v;
          });
      } else if (o === 'ltScale') {
        const v = await c.number('Specify new linetype scale', { def: 1 });
        if (typeof v === 'number' && v > 0)
          ents.forEach((e) => {
            e.ltscale = v;
          });
      } else if (o === 'LWeight') {
        const v = await c.number('Enter new lineweight in mm', { def: 0.25 });
        if (typeof v === 'number')
          ents.forEach((e) => {
            e.lw = v;
          });
      } else c.echo('Thickness is not used in 2D drawings.');
      c.bump();
    }
  }

  /** CHANGE: changes points or properties of objects. */
  static async change(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const p = await c.point('Specify change point or [Properties]', { kw: ['Properties'] });
    if (p === 'Properties') {
      c.app.sel = new Set(ents.map((e) => e.id));
      c.app.exec('CHPROP');
      return;
    }
    if (!isPt(p)) return;
    for (const e of ents) {
      if (e.type === 'line') {
        if (dist(e.p1, p) < dist(e.p2, p)) e.p1 = { ...p };
        else e.p2 = { ...p };
      } else if (e.type === 'circle') e.r = dist(e.c, p);
      else if (e.type === 'text' || e.type === 'mtext' || e.type === 'insert' || e.type === 'point')
        e.p = { ...p };
    }
    c.bump();
  }

  // ------------------------------------------------------------------ array variants
  /** ARRAYRECT: a rectangular array. */
  static async arrayRect(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const cols = await c.number('Enter the number of columns', { def: 4 });
    if (typeof cols !== 'number') return;
    const rows = await c.number('Enter the number of rows', { def: 3 });
    if (typeof rows !== 'number') return;
    const dx = await c.dist('Specify the distance between columns', { def: 10 });
    if (typeof dx !== 'number') return;
    const dy = await c.dist('Specify the distance between rows', { def: 10 });
    if (typeof dy !== 'number') return;
    c.addAll(
      O.arrayRect(
        ents,
        Math.max(1, Math.round(rows)),
        Math.max(1, Math.round(cols)),
        dy,
        dx,
        0,
        c.doc,
      ),
    );
  }

  /** ARRAYPOLAR: a polar array. */
  static async arrayPolar(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const ctr = await c.point('Specify center point of array');
    if (!isPt(ctr)) return;
    const n = await c.number('Enter number of items', { def: 6 });
    if (typeof n !== 'number') return;
    const fill = await c.angle('Specify the angle to fill (+=ccw, -=cw)', { def: TAU });
    if (typeof fill !== 'number') return;
    const rot = await c.keyword('Rotate arrayed items? [Yes/No]', ['Yes', 'No'], 'Yes');
    c.addAll(O.arrayPolar(ents, ctr, Math.max(2, Math.round(n)), fill, rot !== 'No', c.doc));
  }

  /** The point and direction at a distance along an object. */
  static tangentAtDist(prims, d) {
    const eps = 1e-3;
    const at = (x) => {
      let acc = 0;
      for (const P of prims) {
        const l = O.primLength(P);
        if (x <= acc + l + 1e-9 || P === prims[prims.length - 1]) {
          const f = l ? Math.max(0, Math.min(1, (x - acc) / l)) : 0;
          if (P.k === 's') return G.lerp(P.a, P.b, f);
          const sw = G.sweep(P.a0, P.a1) || TAU;
          return G.polar(P.c, P.rev ? P.a1 - sw * f : P.a0 + sw * f, P.r);
        }
        acc += l;
      }
      return null;
    };
    const a = at(Math.max(0, d - eps));
    const b = at(d + eps);
    return a && b ? ang(a, b) : 0;
  }

  /** ARRAYPATH: copies along a path. */
  static async arrayPath(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const r = await c.pick('Select path curve', {
      filter: (e) => ['line', 'arc', 'circle', 'pline', 'spline', 'ellipse'].includes(e.type),
    });
    if (!r || !r.e) return;
    const n = await c.number('Enter number of items or [Method]', { def: 6 });
    if (typeof n !== 'number' || n < 2) return;
    const prims = E.prims(r.e, c.doc);
    const total = prims.reduce((s, P) => s + O.primLength(P), 0);
    const align = await c.keyword('Align items to path? [Yes/No]', ['Yes', 'No'], 'Yes');
    const b0 = E.bbox(ents[0], c.doc);
    const base = b0 ? { x: (b0.x0 + b0.x1) / 2, y: (b0.y0 + b0.y1) / 2 } : { x: 0, y: 0 };
    const step = total / (E.isClosed(r.e) ? n : n - 1);
    const p0 = G.primStart(prims[0]);
    const t0 = MoreCommands.tangentAtDist(prims, 0);
    const out = [];
    for (let i = 1; i < n; i += 1) {
      const d = step * i;
      let acc = 0;
      let pt = null;
      for (const P of prims) {
        const l = O.primLength(P);
        if (d <= acc + l + 1e-9 || P === prims[prims.length - 1]) {
          const f = l ? Math.max(0, Math.min(1, (d - acc) / l)) : 0;
          pt =
            P.k === 's'
              ? G.lerp(P.a, P.b, f)
              : (() => {
                  const sw = G.sweep(P.a0, P.a1) || TAU;
                  return G.polar(P.c, P.rev ? P.a1 - sw * f : P.a0 + sw * f, P.r);
                })();
          break;
        }
        acc += l;
      }
      if (!pt) continue;
      const M =
        align === 'No'
          ? G.Mtranslate(pt.x - p0.x, pt.y - p0.y)
          : G.Mmul(
              G.Mtranslate(pt.x - base.x + (base.x - p0.x) * 0, pt.y - base.y),
              G.Mrotate(MoreCommands.tangentAtDist(prims, d) - t0, base),
            );
      for (const e of ents)
        out.push(
          E.copyXform(
            e,
            align === 'No'
              ? M
              : G.Mmul(
                  G.Mtranslate(pt.x - base.x, pt.y - base.y),
                  G.Mrotate(MoreCommands.tangentAtDist(prims, d) - t0, base),
                ),
            c.doc,
          ),
        );
    }
    c.addAll(out);
  }

  /** SELECTSIMILAR: selects objects like the selected ones. */
  static async selectSimilar(c) {
    let ents = c.app.selectedEnts();
    if (!ents.length) {
      const r = await c.pick('Select an object');
      if (!r || !r.e) return;
      ents = [r.e];
    }
    const ok = (e) => ents.some((s) => s.type === e.type && s.layer === e.layer);
    const out = c.app.curEnts().filter((e) => c.app.selectable(e) && ok(e));
    c.setSel(out);
    c.echo(`${out.length} found`);
  }

  /** OOPS: brings back the objects erased last. */
  static async oops(c) {
    const l = c.app.lastErased;
    if (!l || !l.ents.length) return c.fail('Nothing to restore.');
    c.addAll(
      l.ents.map((e) => {
        const k = E.clone(e);
        k.id = 0;
        return k;
      }),
    );
    c.echo(`${l.ents.length} object(s) restored.`);
  }

  // ------------------------------------------------------------------ BLEND / GROUP / HATCHEDIT
  /** @private The end point, direction and kind of the end of a line, arc or open polyline nearest to a pick. */
  static endInfo(e, click) {
    if (e.type === 'line') {
      const first = dist(e.p1, click) < dist(e.p2, click);
      return first ? { p: e.p1, t: norm(sub(e.p1, e.p2)) } : { p: e.p2, t: norm(sub(e.p2, e.p1)) };
    }
    if (e.type === 'arc') {
      const first = dist(G.arcPt(e, e.a0), click) < dist(G.arcPt(e, e.a1), click);
      return first
        ? { p: G.arcPt(e, e.a0), t: { x: Math.sin(e.a0), y: -Math.cos(e.a0) } }
        : { p: G.arcPt(e, e.a1), t: { x: -Math.sin(e.a1), y: Math.cos(e.a1) } };
    }
    if (e.type === 'spline' || e.type === 'pline') {
      const pts = e.type === 'pline' ? e.pts : e.pts;
      const first = dist(pts[0], click) < dist(pts[pts.length - 1], click);
      const a = first ? pts[0] : pts[pts.length - 1];
      const b = first ? pts[1] : pts[pts.length - 2];
      return { p: { x: a.x, y: a.y }, t: norm(sub(a, b)) };
    }
    return null;
  }

  /** BLEND: a spline that joins two open curves smoothly. */
  static async blend(c) {
    const r1 = await c.pick('Select first object', {
      filter: (e) => ['line', 'arc', 'spline', 'pline'].includes(e.type),
    });
    if (!r1 || !r1.e) return;
    const r2 = await c.pick('Select second point on second object', {
      filter: (e) => ['line', 'arc', 'spline', 'pline'].includes(e.type),
    });
    if (!r2 || !r2.e) return;
    const a = MoreCommands.endInfo(r1.e, r1.p);
    const b = MoreCommands.endInfo(r2.e, r2.p);
    if (!a || !b) return c.fail('Cannot blend those objects.');
    const d = dist(a.p, b.p) / 3;
    const c1 = add(a.p, mul(a.t, d));
    const c2 = add(b.p, mul(b.t, d));
    const pts = [];
    for (let i = 0; i <= 12; i += 1) {
      const t = i / 12;
      const u = 1 - t;
      pts.push({
        x: u ** 3 * a.p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.p.x,
        y: u ** 3 * a.p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.p.y,
      });
    }
    c.add(c.mk('spline', { pts, closed: false }));
  }

  /** GROUP: makes a named group of objects. */
  static async group(c) {
    const ents = await c.select('Select objects for grouping');
    if (ents.length < 2) return;
    c.doc.groups ||= {};
    let n = 1;
    while (c.doc.groups[`*A${n}`]) n += 1;
    const nm = await c.string('Enter a group name', { def: `*A${n}`, defText: `*A${n}` });
    c.doc.groups[nm || `*A${n}`] = ents.map((e) => e.id);
    c.echo(`Group ${nm || `*A${n}`} created with ${ents.length} members.`);
  }

  /** UNGROUP: dissolves groups. */
  static async ungroup(c) {
    const r = await c.pick('Select a group');
    if (!r || !r.e) return;
    const g = Object.entries(c.doc.groups || {}).filter(([, ids]) => ids.includes(r.e.id));
    if (!g.length) return c.fail('The selected object is not in a group.');
    g.forEach(([k]) => delete c.doc.groups[k]);
    c.echo(`${g.length} group(s) dissolved.`);
  }

  /** HATCHEDIT: changes pattern, scale and angle of a hatch. */
  static async hatchEdit(c) {
    const r = await c.pick('Select hatch object', { filter: (e) => e.type === 'hatch' });
    if (!r || !r.e) return;
    const e = r.e;
    const st = { pattern: e.pattern, scale: e.scale, angle: G.deg(e.angle || 0) };
    if (!(await c.ui.hatchDialog(st))) return;
    e.pattern = st.pattern;
    e.scale = st.scale;
    e.angle = G.rad(st.angle);
    if (st.color) e.color = st.color;
    c.bump();
  }

  // ------------------------------------------------------------------ inquiry: MASSPROP, TIME, MEASUREGEOM, CAL, QUICKCALC
  /** MASSPROP: area, perimeter and centroid of 2D regions, volume of 3D solids. */
  static async massProp(c) {
    const ents = await c.select('Select objects', {
      filter: (e) => E.isClosed(e) || e.type === 'hatch',
    });
    if (!ents.length) return;
    let A = 0;
    let P = 0;
    let cx = 0;
    let cy = 0;
    let b = null;
    for (const e of ents) {
      const loop = E.closedLoop(e) || (e.loops && e.loops[0]);
      if (!loop) continue;
      const a = Math.abs(G.polyArea(loop));
      let sx = 0;
      let sy = 0;
      const s2 = G.polyArea(loop);
      for (let i = 0; i < loop.length; i += 1) {
        const p = loop[i];
        const q = loop[(i + 1) % loop.length];
        const cr = p.x * q.y - q.x * p.y;
        sx += (p.x + q.x) * cr;
        sy += (p.y + q.y) * cr;
      }
      const cxe = sx / (6 * s2 || 1);
      const cye = sy / (6 * s2 || 1);
      A += a;
      cx += cxe * a;
      cy += cye * a;
      P += E.entLength(e) || loop.reduce((s, p, i) => s + dist(p, loop[(i + 1) % loop.length]), 0);
      b = E.bboxMerge(b, E.bbox(e, c.doc));
    }
    c.echo('---------------- REGIONS ----------------');
    c.echo(`Area:                 ${c.fmt(A)}`);
    c.echo(`Perimeter:            ${c.fmt(P)}`);
    c.echo(
      `Bounding box:         X: ${c.fmt(b.x0)} -- ${c.fmt(b.x1)}   Y: ${c.fmt(b.y0)} -- ${c.fmt(b.y1)}`,
    );
    c.echo(`Centroid:             X: ${c.fmt(cx / (A || 1))}   Y: ${c.fmt(cy / (A || 1))}`);
    c.app.lastArea = A;
    c.app.lastPerimeter = P;
    c.ui.showTextWindow(true);
  }

  /** TIME: the date and time. */
  static async time(c) {
    const now = new Date();
    const start = c.app.sessionStart || (c.app.sessionStart = new Date());
    const f = (d) => d.toLocaleString('en-GB');
    c.echo(`Current time:                 ${f(now)}`);
    c.echo(`Elapsed editing time:         ${Math.round((now - start) / 1000)} seconds`);
    c.ui.showTextWindow(true);
  }

  /** MEASUREGEOM: distance, radius, angle, area. */
  static async measureGeom(c) {
    const o = await c.keyword(
      'Enter an option [Distance/Radius/Angle/Area] <Distance>',
      ['Distance', 'Radius', 'Angle', 'Area'],
      'Distance',
    );
    if (o === 'Radius') {
      const r = await c.pick('Select arc, circle or rounded corner', { filter: ARC_PICK });
      const g = r && r.e && arcOfPick(c, r);
      if (g) {
        c.echo(`Radius = ${c.fmt(g.r)}`);
        c.echo(`Diameter = ${c.fmt(g.r * 2)}`);
      }
      return;
    }
    if (o === 'Angle') {
      const a = await c.point('Specify angle vertex');
      if (!isPt(a)) return;
      const b = await c.point('Specify first side', { base: a });
      if (!isPt(b)) return;
      const d = await c.point('Specify second side', { base: a });
      if (!isPt(d)) return;
      c.echo(`Angle = ${c.fmtA(Math.abs(G.sweep(ang(a, b), ang(a, d))))}`);
      return;
    }
    setTimeout(() => c.app.exec(o === 'Area' ? 'AREA' : 'DIST'), 0); // not awaited: exec() waits for the running command, which is this one
  }

  /** CAL: a calculator on the command line. */
  static async cal(c) {
    const expr = await c.string('>> Expression', { def: '' });
    if (!expr) return;
    try {
      const v = await evaluate(expr, {
        cur: async () => {
          const p = await c.point('Pick a point');
          return isPt(p) ? [p.x, p.y, 0] : null;
        },
      });
      c.echo(fmtResult(v));
      c.app.lastCalc = v;
    } catch (e) {
      c.echo(`Calc error: ${e.message}`);
    }
  }

  /** QUICKCALC: the calculator window. */
  static async quickCalc(c) {
    await c.ui.quickCalcDialog(c);
  }

  /** @private The centre mark lines of a circle or arc. */
  static centerMarks(c, g, mode) {
    const ds = E.dimStyleOf({ style: c.doc.curDimStyle }, c.doc);
    const ext = ds.asz;
    const doc = c.doc;
    if (!doc.hasLayer('CENTER')) doc.addLayer('CENTER', { color: 1, ltype: 'CENTER', lw: 0.18 });
    const layer = doc.layer('CENTER').name;
    const out = [];
    const half = mode === 'Mark' ? ext : g.r + ext;
    const L = 2 * half;
    let ltype = 'Continuous';
    let ltscale = 1;
    if (mode !== 'Mark') {
      // fit the dash pattern to the line: n whole periods + one long dash, at about the drawing's own scale
      const gs = doc.ltscale || 1;
      const n = Math.max(1, Math.round((L / gs - CENTER_LONG) / CENTER_PERIOD));
      ltype = 'CENTER';
      ltscale = L / (n * CENTER_PERIOD + CENTER_LONG) / gs;
    }
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ]) {
      const e = c.mk('line', {
        p1: { x: g.c.x - dx * half, y: g.c.y - dy * half },
        p2: { x: g.c.x + dx * half, y: g.c.y + dy * half },
      });
      e.layer = layer;
      e.color = null;
      e.lw = null;
      e.ltype = ltype;
      e.ltscale = +ltscale.toPrecision(5);
      out.push(c.add(e));
    }
    return out;
  }

  /** DIMCENTER: centre marks and centre lines of circles and arcs. */
  static async dimCenter(c) {
    let mode = c.app.centerMode || 'Lines';
    let done = 0;
    for (;;) {
      const r = await c.pick(`Select arc or circle [Lines/Mark/All] <${mode}>  (Enter to finish)`, {
        filter: ARC_PICK,
        kw: ['Lines', 'Mark', 'All'],
      });
      if (!r) break;
      if (typeof r === 'string') {
        if (r === 'Lines' || r === 'Mark') {
          mode = r;
          c.app.centerMode = r;
          c.echo(
            r === 'Lines'
              ? 'Lines: centre lines (CENTER layer, dashes fitted to each line).'
              : 'Mark: a small continuous cross.',
          );
          continue;
        }
        if (r === 'All') {
          // every circle and arc that has no centre line yet
          let n = 0;
          for (const e of c.app
            .curEnts()
            .filter(
              (x) =>
                (x.type === 'circle' || x.type === 'arc') && c.doc.visible(x) && !c.doc.locked(x),
            )) {
            const g = { c: e.c, r: e.r };
            if (hasCenterLines(c, g)) continue;
            MoreCommands.centerMarks(c, g, mode);
            n += 1;
          }
          c.echo(
            `${n} circle(s) and arc(s) got ${mode === 'Mark' ? 'centre marks' : 'centre lines'}.`,
          );
          done += n;
          continue;
        }
      }
      if (!r.e) continue;
      const g = arcOfPick(c, r);
      if (!g) {
        c.echo('There is no arc at that point.');
        continue;
      }
      MoreCommands.centerMarks(c, g, mode);
      done += 1;
    }
    if (done) c.echo(`${done} centre ${mode === 'Mark' ? 'mark(s)' : 'line set(s)'} created.`);
  }

  /** DIMORDINATE: X or Y coordinate dimensions. */
  static async dimOrdinate(c) {
    const f = await c.point('Specify feature location');
    if (!isPt(f)) return;
    const e = await c.point('Specify leader endpoint or [Xdatum/Ydatum]', {
      base: f,
      kw: ['Xdatum', 'Ydatum'],
    });
    if (!isPt(e)) return;
    const useX = Math.abs(e.y - f.y) >= Math.abs(e.x - f.x);
    const val = useX ? f.x : f.y;
    const ds = E.dimStyleOf({ style: c.doc.curDimStyle }, c.doc);
    const mid = useX ? { x: f.x, y: e.y } : { x: e.x, y: f.y };
    const t = fmtLen(val, c.doc.units);
    const tp = useX
      ? { x: e.x - E.measure(t, ds.h, null) / 2, y: e.y + ds.gap }
      : { x: e.x + ds.gap, y: e.y - ds.h / 2 };
    c.add(
      c.mk('leader', {
        pts: [f, mid, e],
        str: t,
        h: ds.h,
        tp,
        style: c.doc.curDimStyle,
        noArrow: true,
      }),
    );
  }

  /** DIMARC: the length of an arc. */
  static async dimArc(c) {
    const r = await c.pick('Select arc or polyline arc segment', { filter: ARC_PICK });
    if (!r || !r.e) return;
    const e = arcOfPick(c, r);
    if (!e) return c.fail('There is no arc at that point.');
    const mk = (loc) =>
      c.stamp(E.mk('dim', { kind: 'arcl', c: e.c, r: e.r, a0: e.a0, a1: e.a1, dp: loc }));
    const loc = await c.point('Specify arc length dimension location', {
      base: e.c,
      preview: (q) => [mk(q)],
    });
    if (!isPt(loc)) return;
    c.add(mk(loc));
  }

  /** DIMJOGGED: a jogged radius dimension. */
  static async dimJogged(c) {
    c.echo('DIMJOGGED: using a standard radius dimension (jog symbol is not drawn).');
    setTimeout(() => c.app.exec('DIMRADIUS'), 0);
  }

  /** DIMSPACE: evens out the spacing between parallel dimensions. */
  static async dimSpace(c) {
    const b = await c.pick('Select base dimension', { filter: dimFilter });
    if (!b || !b.e) return;
    const dims = await c.select('Select dimensions to space', { pre: false, filter: dimFilter });
    if (!dims.length) return;
    const sp = await c.dist('Enter value or select [Auto] <Auto>', { def: 0, defText: 'Auto' });
    const ds = E.dimStyleOf(b.e, c.doc);
    const step = sp > 0 ? sp : ds.h * 1.5 + ds.gap * 2.4;
    const u = b.e.kind === 'ali' ? ang(b.e.p1, b.e.p2) : b.e.rot || 0;
    const n = { x: -Math.sin(u), y: Math.cos(u) };
    const off0 = G.dot(sub(b.e.dp, b.e.p1), n);
    dims
      .filter((d) => d !== b.e)
      .sort((p, q) => Math.abs(G.dot(sub(p.dp, p.p1), n)) - Math.abs(G.dot(sub(q.dp, q.p1), n)))
      .forEach((d, i) => {
        d.dp = add(d.p1, mul(n, off0 + Math.sign(off0 || 1) * step * (i + 1)));
      });
    c.bump();
  }

  /** DIMEDIT: changes dimension text and extension lines. */
  static async dimEdit(c) {
    const o = await c.keyword(
      'Enter type of dimension editing [Home/New/Rotate/Oblique] <Home>',
      ['Home', 'New', 'Rotate', 'Oblique'],
      'Home',
    );
    const ents = await c.select('Select objects', { filter: dimFilter });
    if (!ents.length) return;
    if (o === 'New') {
      const t = await c.string('Enter new dimension text (<> = measured value)', { def: '<>' });
      if (t !== null)
        ents.forEach((e) => {
          e.text = t === '<>' ? null : t;
        });
    } else if (o === 'Home')
      ents.forEach((e) => {
        e.tp = null;
        e.text = null;
      });
    else c.echo('Only Home and New are supported.');
    c.bump();
  }

  /** DIMTEDIT: moves dimension text. */
  static async dimTextEdit(c) {
    const r = await c.pick('Select dimension', { filter: dimFilter });
    if (!r || !r.e) return;
    const p = await c.point('Specify new location for dimension text or [Left/Right/Center/Home]', {
      kw: ['Left', 'Right', 'Center', 'Home'],
    });
    if (p === 'Home') r.e.tp = null;
    else if (isPt(p)) r.e.tp = { ...p };
    else return;
    c.bump();
  }

  /** QDIM: quick dimensions for many objects. */
  static async qdim(c) {
    const ents = await c.select('Select geometry to dimension', {
      filter: (e) => ['line', 'arc', 'circle', 'pline'].includes(e.type),
    });
    if (!ents.length) return;
    const type = await c.keyword(
      'Specify dimension type [Continuous/Baseline/Radius/Diameter] <Continuous>',
      ['Continuous', 'Baseline', 'Radius', 'Diameter'],
      'Continuous',
    );
    if (type === 'Radius' || type === 'Diameter') {
      const loc = await c.point('Specify dimension line position');
      if (!isPt(loc)) return;
      for (const e of ents.filter((x) => x.type === 'circle' || x.type === 'arc'))
        c.add(
          c.stamp(
            E.mk('dim', {
              kind: type === 'Radius' ? 'rad' : 'dia',
              c: e.c,
              r: e.r,
              p: {
                x: e.c.x + e.r * Math.cos(ang(e.c, loc)),
                y: e.c.y + e.r * Math.sin(ang(e.c, loc)),
              },
            }),
          ),
        );
      return;
    }
    const pts = [];
    for (const e of ents) {
      if (e.type === 'line') pts.push(e.p1, e.p2);
      else if (e.type === 'pline') pts.push(...e.pts);
    }
    const loc = await c.point('Specify dimension line position');
    if (!isPt(loc)) return;
    const horiz =
      Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)) >=
      Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
    const key = (p) => (horiz ? p.x : p.y);
    const uniq = [...new Map(pts.map((p) => [key(p).toFixed(6), p])).values()].sort(
      (a, b) => key(a) - key(b),
    );
    const rot = horiz ? 0 : Math.PI / 2;
    const ds = E.dimStyleOf({ style: c.doc.curDimStyle }, c.doc);
    for (let i = 1; i < uniq.length; i += 1) {
      const a = type === 'Baseline' ? uniq[0] : uniq[i - 1];
      const off = type === 'Baseline' ? (i - 1) * (ds.h * 1.5 + ds.gap * 2.4) : 0;
      c.add(
        c.stamp(
          E.mk('dim', {
            kind: 'lin',
            p1: { x: a.x, y: a.y },
            p2: { x: uniq[i].x, y: uniq[i].y },
            dp: horiz ? { x: uniq[i].x, y: loc.y + off } : { x: loc.x + off, y: uniq[i].y },
            rot,
          }),
        ),
      );
    }
  }

  // ------------------------------------------------------------------ PDFIMPORT (vector PDF -> editable geometry)
  /** PDFIMPORT: draws the lines, curves and text of a PDF page. */
  static async pdfImport(c) {
    const app = c.app;
    let data = null;
    if (app.api && app.api.pdfImport) {
      c.echo('Reading PDF...');
      data = await app.api.pdfImport(
        typeof c.arg === 'string' && c.arg.endsWith('.pdf') ? c.arg : undefined,
      );
    } else if (window.__pdfData) data = window.__pdfData;
    else return c.fail('PDFIMPORT needs the desktop app (PDF reader runs in the main process).');
    if (!data) return;
    if (data.error) return c.fail(`Cannot read PDF: ${data.error}`);
    const ip = await c.point(
      `PDF page ${data.width.toFixed(1)} x ${data.height.toFixed(1)} mm  -  specify insertion point <0,0>`,
      {
        def: { x: 0, y: 0 },
        defText: '0,0',
        preview: (q) => [
          E.mk('pline', {
            pts: [
              q,
              { x: q.x + data.width, y: q.y },
              { x: q.x + data.width, y: q.y + data.height },
              { x: q.x, y: q.y + data.height },
            ].map((p) => bp(p)),
            closed: true,
          }),
        ],
      },
    );
    const p0 = isPt(ip) ? ip : { x: 0, y: 0 };
    const sc = await c.number('Specify scale factor <1>', { def: 1 });
    const k = typeof sc === 'number' && sc > 0 ? sc : 1;
    const doc = c.doc;
    const gL = doc.addLayer('PDF_Geometry');
    const fL = doc.addLayer('PDF_Solid Fills');
    const tL = doc.addLayer('PDF_Text');
    void gL;
    void fL;
    void tL;
    const col = (hex) =>
      !hex || /^#0{6}$/i.test(hex) || /NaN/.test(hex) ? null : hex.toLowerCase();
    const lwOf = (w) =>
      w < 0.12
        ? null
        : [0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 1, 1.2, 1.4, 2].reduce(
            (b, x) => (Math.abs(x - w) < Math.abs(b - w) ? x : b),
            0.25,
          );
    const out = [];
    for (const p of data.paths) {
      const pts = p.pts.map(([x, y]) => ({ x: p0.x + x * k, y: p0.y + y * k }));
      if (p.closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
      if (p.fill) {
        if (pts.length >= 3) {
          const e = E.mk('hatch', { loops: [pts], pattern: 'SOLID', scale: 1, angle: 0 });
          e.layer = 'PDF_Solid Fills';
          e.color = col(p.fill);
          out.push(e);
        }
        continue;
      }
      let e;
      if (pts.length === 2 && !p.closed) e = E.mk('line', { p1: pts[0], p2: pts[1] });
      else e = E.mk('pline', { pts: pts.map((q) => bp(q)), closed: !!p.closed });
      e.layer = 'PDF_Geometry';
      e.color = col(p.color);
      e.lw = lwOf(p.lw || 0);
      out.push(e);
    }
    for (const t of data.texts || []) {
      const e = E.mk('text', {
        p: { x: p0.x + t.x * k, y: p0.y + t.y * k },
        h: Math.max(t.h * k, 0.1),
        str: t.str,
        rot: t.rot,
        style: doc.curTextStyle,
        al: 0,
      });
      e.layer = 'PDF_Text';
      out.push(e);
    }
    c.addAll(out);
    c.echo(
      `PDFIMPORT: ${out.length} objects imported from ${data.name || 'PDF'} (${data.paths.length} paths, ${(data.texts || []).length} text items).`,
    );
    app.zoomExtents(false);
  }

  /** Registers the commands of this file in their original order (a later definition of a name wins). */
  static register() {
    def('MLINE ML', MoreCommands.mline);
    def('SOLID SO', MoreCommands.solid2d);
    def('TRACE', MoreCommands.trace);
    def('BOUNDARY BO', MoreCommands.boundary);
    def('REGION REG', MoreCommands.region);
    def('UNION UNI', MoreCommands.union);
    def('SUBTRACT SU', MoreCommands.subtract);
    def('INTERSECT IN', MoreCommands.intersect);
    def('SPLINEDIT SPE', MoreCommands.splineEdit);
    def('REVERSE', MoreCommands.reverse);
    def('FLATTEN', MoreCommands.flatten);
    def('ATTDEF ATT DDATTDEF', MoreCommands.attDef);
    def('ATTEDIT ATE ATTE EATTEDIT -ATTEDIT', MoreCommands.attEdit);
    def('ATTDISP', async (c) => c.echo('Attributes are always displayed (ATTDISP = On).'));
    def('WIPEOUT', MoreCommands.wipeout);
    def('TOLERANCE TOL', MoreCommands.tolerance);
    def('SCALETEXT', MoreCommands.scaleText);
    def('JUSTIFYTEXT', MoreCommands.justifyText);
    def('OVERKILL', MoreCommands.overkill);
    def('CHPROP CHP', MoreCommands.chprop);
    def('CHANGE -CH', MoreCommands.change);
    def('ARRAYRECT', MoreCommands.arrayRect);
    def('ARRAYPOLAR', MoreCommands.arrayPolar);
    def('ARRAYPATH', MoreCommands.arrayPath);
    alias('ARRAYCLASSIC', 'ARRAY');
    def('SELECTSIMILAR SELSIM', MoreCommands.selectSimilar);
    def('OOPS', MoreCommands.oops);
    def('BLEND', MoreCommands.blend);
    def('GROUP G', MoreCommands.group);
    def('UNGROUP UNG', MoreCommands.ungroup);
    def('HATCHEDIT HE', MoreCommands.hatchEdit);
    def('MASSPROP', MoreCommands.massProp);
    def('TIME', MoreCommands.time);
    def('MEASUREGEOM MEA', MoreCommands.measureGeom);
    def('CAL', MoreCommands.cal);
    def('QUICKCALC QC', MoreCommands.quickCalc);
    def('DIMCENTER DCE', MoreCommands.dimCenter);
    def('DIMORDINATE DOR', MoreCommands.dimOrdinate);
    def('DIMARC DAR', MoreCommands.dimArc);
    def('DIMJOGGED DJO DIMJOG', MoreCommands.dimJogged);
    def('DIMSPACE', MoreCommands.dimSpace);
    def('DIMEDIT DED', MoreCommands.dimEdit);
    def('DIMTEDIT DIMTED', MoreCommands.dimTextEdit);
    def('QDIM', MoreCommands.qdim);
    def('PDFIMPORT PDFIN', MoreCommands.pdfImport);
  }
}

MoreCommands.register();

export const union2D = MoreCommands.union2d;
export const subtract2D = MoreCommands.subtract2d;
export const intersect2D = MoreCommands.intersect2d;
export const askAttribs = MoreCommands.askAttribs;
export const tangentAtDist = MoreCommands.tangentAtDist;
