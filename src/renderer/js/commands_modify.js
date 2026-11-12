/**
 * @file commands_modify.js
 * @brief The Modify commands: ERASE, MOVE, COPY, ROTATE, SCALE, MIRROR, OFFSET, ARRAY, STRETCH,
 *        TRIM, EXTEND, BREAK, JOIN, FILLET, CHAMFER, EXPLODE, LENGTHEN, ALIGN, MATCHPROP, PEDIT,
 *        DRAWORDER and DDEDIT.
 *
 * The geometry itself is in ops.js; the commands here ask for the objects and points and apply it.
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import { def, COMMANDS } from './registry.js';
import * as G from './geom.js';
import * as E from './entities.js';
import * as O from './ops.js';
import { matchDimension } from './dimmatch.js';
const { dist, ang, add, sub, mul, norm, TAU } = G;
const isPt = (v) => v && typeof v === 'object' && 'x' in v;
const bp = (p, b = 0) => ({ x: p.x, y: p.y, b });

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** The Modify commands. Every command is a static method `(c) => Promise`; `register()` adds them all. */
export class ModifyCommands {
  // ------------------------------------------------------------------ ERASE / COPY / MOVE
  /** ERASE: deletes the selected objects. */
  static async erase(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    c.app.lastErased = { ents: ents.map((x) => E.clone(x)) };
    c.erase(ents);
    c.app.sel.clear();
  }

  /** MOVE: moves objects by a base point and a second point (or a displacement). */
  static async move(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const plane = ModifyCommands.sharedEntityPlane(ents);
    const point3d = c.app.v3
      ? { world3d: true, ...(plane ? { workPlane: { o: plane.o, n: plane.n } } : {}) }
      : {};
    // the objects stay visible while the base point is chosen; they are hidden only once the moving copy (preview) is shown
    const base = await c.point('Specify base point or [Displacement]', {
      kw: ['Displacement'],
      ...point3d,
    });
    if (!isPt(base)) {
      if (base === 'Displacement') {
        const d = await c.point('Specify displacement', point3d);
        if (isPt(d)) ents.forEach((e) => ModifyCommands.moveWithZ(e, d.x, d.y, d.z || 0, c.doc));
        c.bump();
      }
      return;
    }
    c.hide(ents);
    const p = await c.point('Specify second point or <use first point as displacement>', {
      base,
      ...point3d,
      preview: (q) =>
        ents.map((e) =>
          ModifyCommands.copyMoved(
            e,
            q.x - base.x,
            q.y - base.y,
            (q.z || 0) - (base.z || 0),
            c.doc,
          ),
        ),
    });
    if (!isPt(p)) {
      ents.forEach((e) => ModifyCommands.moveWithZ(e, base.x, base.y, base.z || 0, c.doc));
      c.bump();
      return;
    }
    ents.forEach((e) =>
      ModifyCommands.moveWithZ(e, p.x - base.x, p.y - base.y, (p.z || 0) - (base.z || 0), c.doc),
    );
    c.bump();
  }

  /** @private The common saved drawing plane of a planar selection, or null. */
  static sharedEntityPlane(ents) {
    if (!ents.length || ents.some((e) => !e.plane)) return null;
    const key = JSON.stringify(ents[0].plane);
    return ents.every((e) => JSON.stringify(e.plane) === key) ? ents[0].plane : null;
  }

  // 3D solids follow the Z difference of the picked points (snapping to a vertex on top of a box moves it in Z too); 2D objects stay on their plane
  /** @private Moves an object; 3D solids follow the Z difference of the picked points (snapping to a vertex on top of a box moves it in Z too), 2D objects stay on their plane. */
  static moveWithZ(e, dx, dy, dz, doc) {
    if (e.plane) {
      e.plane = {
        ...e.plane,
        o: [e.plane.o[0] + dx, e.plane.o[1] + dy, e.plane.o[2] + dz],
      };
      return;
    }
    if (dz && E.PLANEABLE?.has(e.type)) {
      E.translateEnt3d(e, dx, dy, dz, doc);
      return;
    }
    E.translateEnt(e, dx, dy, doc);
    if (dz && e.type === 'solid3d') (e.ops ||= []).push({ t: 'T', v: [0, 0, dz] });
  }

  /** @private A moved copy of an object (the preview of MOVE and COPY). */
  static copyMoved(e, dx, dy, dz, doc) {
    if (e.plane) {
      const k = E.clone(e);
      k.id = 0;
      k.plane = {
        ...k.plane,
        o: [k.plane.o[0] + dx, k.plane.o[1] + dy, k.plane.o[2] + dz],
      };
      return k;
    }
    if (dz && E.PLANEABLE?.has(e.type)) {
      const k = E.clone(e);
      k.id = 0;
      E.translateEnt3d(k, dx, dy, dz, doc);
      return k;
    }
    const k = E.copyXform(e, G.Mtranslate(dx, dy), doc);
    if (dz && k.type === 'solid3d') (k.ops ||= []).push({ t: 'T', v: [0, 0, dz] });
    return k;
  }

  /** COPY: copies objects, once or many times (modes Single / Multiple). */
  static async copy(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const ask = () =>
      c.point('Specify base point or [Displacement/mOde]', { kw: ['Displacement', 'mOde'] });
    let base = await ask();
    while (base === 'mOde') {
      // Single = one copy and the command ends, Multiple = copies until Enter (kept for the next COPY)
      const m = await c.keyword(
        'Enter a copy mode option [Single/Multiple]',
        ['Single', 'Multiple'],
        c.app.copyMode || 'Multiple',
      );
      if (m === null) return;
      c.app.copyMode = m;
      base = await ask();
    }
    if (base === 'Displacement') {
      const d = await c.point('Specify displacement');
      if (isPt(d))
        c.addAll(ents.map((e) => ModifyCommands.copyMoved(e, d.x, d.y, d.z || 0, c.doc)));
      return;
    }
    if (!isPt(base)) return;
    let n = 0;
    for (;;) {
      const p = await c.point('Specify second point or <use first point as displacement>', {
        base,
        kw: ['Exit', 'Undo'],
        preview: (q) =>
          ents.map((e) =>
            ModifyCommands.copyMoved(
              e,
              q.x - base.x,
              q.y - base.y,
              (q.z || 0) - (base.z || 0),
              c.doc,
            ),
          ),
      });
      if (p === null || p === 'Exit') break;
      if (p === 'Undo') continue;
      c.addAll(
        ents.map((e) =>
          ModifyCommands.copyMoved(
            e,
            p.x - base.x,
            p.y - base.y,
            (p.z || 0) - (base.z || 0),
            c.doc,
          ),
        ),
      );
      n += 1;
      if (c.app.copyMode === 'Single') break;
    }
    void n;
  }

  /** ROTATE: rotates objects about a base point (options Copy and Reference). */
  static async rotate(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const base = await c.point('Specify base point');
    if (!isPt(base)) return;
    c.hide(ents);
    let copy = false;
    for (;;) {
      const a = await c.angle('Specify rotation angle or [Copy/Reference]', {
        base,
        kw: ['Copy', 'Reference'],
        preview: (an) => ents.map((e) => E.copyXform(e, G.Mrotate(an, base), c.doc)),
      });
      if (a === 'Copy') {
        copy = true;
        c.echo('Rotating a copy of the selected objects.');
        continue;
      }
      let ang1 = a;
      if (a === 'Reference') {
        const r0 = await c.angle('Specify the reference angle', { base, def: 0 });
        if (typeof r0 !== 'number') return;
        const r1 = await c.angle('Specify the new angle', {
          base,
          preview: (an) => ents.map((e) => E.copyXform(e, G.Mrotate(an - r0, base), c.doc)),
        });
        if (typeof r1 !== 'number') return;
        ang1 = r1 - r0;
      }
      if (typeof ang1 !== 'number') return;
      if (copy) {
        c.app.hidden.clear();
        c.addAll(ents.map((e) => E.copyXform(e, G.Mrotate(ang1, base), c.doc)));
      } else {
        ents.forEach((e) => E.xformInPlace(e, G.Mrotate(ang1, base), c.doc));
        c.bump();
      }
      return;
    }
  }

  /** SCALE: scales objects about a base point (options Copy and Reference). */
  static async scale(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const base = await c.point('Specify base point');
    if (!isPt(base)) return;
    c.hide(ents);
    let copy = false;
    for (;;) {
      const f = await c.dist('Specify scale factor or [Copy/Reference]', {
        base,
        kw: ['Copy', 'Reference'],
        preview: (d) =>
          d > 1e-9 ? ents.map((e) => E.copyXform(e, G.Mscale(d, d, base), c.doc)) : [],
      });
      if (f === 'Copy') {
        copy = true;
        continue;
      }
      let s = f;
      if (f === 'Reference') {
        const l0 = await c.dist('Specify reference length', { base, def: 1 });
        if (typeof l0 !== 'number' || l0 <= 0) return;
        const l1 = await c.dist('Specify new length', {
          base,
          preview: (d) =>
            d > 1e-9 ? ents.map((e) => E.copyXform(e, G.Mscale(d / l0, d / l0, base), c.doc)) : [],
        });
        if (typeof l1 !== 'number' || l1 <= 0) return;
        s = l1 / l0;
      }
      if (typeof s !== 'number' || s <= 0) return;
      if (copy) {
        c.app.hidden.clear();
        c.addAll(ents.map((e) => E.copyXform(e, G.Mscale(s, s, base), c.doc)));
      } else {
        ents.forEach((e) => E.xformInPlace(e, G.Mscale(s, s, base), c.doc));
        c.bump();
      }
      return;
    }
  }

  /** MIRROR: mirrors objects about a line, optionally erasing the source. */
  static async mirror(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const p1 = await c.point('Specify first point of mirror line');
    if (!isPt(p1)) return;
    const p2 = await c.point('Specify second point of mirror line', {
      base: p1,
      preview: (q) =>
        dist(p1, q) > 1e-9 ? ents.map((e) => E.copyXform(e, G.Mmirror(p1, q), c.doc)) : [],
    });
    if (!isPt(p2)) return;
    const del = await c.keyword('Erase source objects? [Yes/No]', ['Yes', 'No'], 'No');
    const copies = ents.map((e) => E.copyXform(e, G.Mmirror(p1, p2), c.doc));
    if (del === 'Yes') c.erase(ents);
    c.addAll(copies);
  }

  /** OFFSET: parallel copies at a distance or through a point. */
  static async offset(c) {
    const st = c.app.offset || (c.app.offset = { d: 10, erase: false });
    const askD = () =>
      c.dist('Specify offset distance or [Through/Erase/Layer]', {
        def: st.d,
        kw: ['Through', 'Erase', 'Layer'],
      });
    let d = await askD();
    while (d === 'Erase' || d === 'Layer') {
      if (d === 'Erase') {
        const y = await c.keyword(
          'Erase source object after offsetting? [Yes/No]',
          ['Yes', 'No'],
          st.erase ? 'Yes' : 'No',
        );
        if (y === null) return;
        st.erase = y === 'Yes';
      } else {
        const l = await c.keyword(
          'Enter layer option for offset objects [Current/Source]',
          ['Current', 'Source'],
          st.cur ? 'Current' : 'Source',
        );
        if (l === null) return;
        st.cur = l === 'Current';
      }
      d = await askD();
    }
    let through = false;
    if (d === 'Through') through = true;
    else if (typeof d !== 'number') return;
    else st.d = d;
    for (;;) {
      const r = await c.pick('Select object to offset or <exit>', {
        filter: (e) => ['line', 'circle', 'arc', 'pline', 'xline', 'ray'].includes(e.type),
      });
      if (!r || !r.e) return;
      c.app.preSel = new Set([r.e.id]);
      c.app.redraw();
      const side = await c.point('Specify point on side to offset or [Exit/Multiple]', {
        kw: ['Exit', 'Multiple'],
        rubber: false,
        preview: (q) => {
          const dd = through ? ModifyCommands.distanceToCurve(r.e, q, c.doc) : st.d;
          const o = dd > 1e-9 ? O.offsetEnt(r.e, dd, q, c.doc) : null;
          return o ? [o] : [];
        },
      });
      if (!isPt(side)) {
        c.app.preSel = new Set();
        continue;
      }
      const dd = through ? ModifyCommands.distanceToCurve(r.e, side, c.doc) : st.d;
      const o = O.offsetEnt(r.e, dd, side, c.doc);
      if (!o) {
        c.echo('Offset failed: the result would be degenerate.');
        continue;
      }
      o.layer = st.cur ? c.doc.cur.layer : r.e.layer;
      c.add(o);
      if (st.erase) c.erase([r.e]);
      c.app.preSel = new Set();
    }
  }

  /** @private Distance from a point to an object. */
  static distanceToCurve(e, p, doc) {
    return E.distTo(e, p, doc);
  }

  /** ARRAY: rectangular or polar array of objects. */
  static async array(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const o = await c.ui.arrayDialog();
    if (!o) return;
    if (o.polar) {
      const ctr = await c.point('Specify center point of array');
      if (!isPt(ctr)) return;
      c.addAll(O.arrayPolar(ents, ctr, Math.max(2, o.count), G.rad(o.fill), o.rotate, c.doc));
    } else {
      const dx = o.cdist;
      const dy = o.rdist;
      c.addAll(
        O.arrayRect(ents, Math.max(1, o.rows), Math.max(1, o.cols), dy, dx, G.rad(o.angle), c.doc),
      );
    }
  }

  /** STRETCH: moves the vertices inside a crossing window; objects fully inside move as a whole. */
  static async stretch(c) {
    // drag a crossing window (right to left) or use C / CP; vertices inside the window move, objects fully inside move as a whole
    const ents = await c.select(
      'Select objects to stretch by crossing-window or crossing-polygon (click two corners or drag)',
      { pre: false, crossing: true },
    );
    if (!ents.length) return;
    let r = c.app.lastSelRect;
    if (!r) {
      // A click selection has no crossing boundary, so the old fallback used the entire object
      // bounding box and silently turned STRETCH into MOVE.  Ask for the vertex region instead.
      const a = await c.point('Specify first corner of stretch crossing window');
      if (!isPt(a)) return;
      const b = await c.point('Specify opposite corner of stretch crossing window', { base: a });
      if (!isPt(b)) return;
      r = {
        x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
        x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
      };
    }
    c.app.preSel = new Set(ents.map((e) => e.id));
    const inside = (p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
    const apply = (e, dx, dy) => {
      const b = E.bbox(e, c.doc);
      const full = b && b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1;
      if (
        full ||
        e.type === 'text' ||
        e.type === 'mtext' ||
        e.type === 'insert' ||
        e.type === 'point' ||
        e.type === 'hatch'
      ) {
        const g0 = E.grips(e, c.doc)[0];
        if (full || (g0 && inside(g0.p))) E.translateEnt(e, dx, dy, c.doc);
        return;
      }
      if (e.type === 'circle') {
        if (inside(e.c)) E.translateEnt(e, dx, dy, c.doc);
        return;
      }
      const gs = E.grips(e, c.doc).filter((g) => g.s && g.kind === 'v' && inside(g.p));
      for (const g of gs) E.setGrip(e, g, { x: g.p.x + dx, y: g.p.y + dy }, c.doc);
    };
    const base = await c.point('Specify base point or [Displacement]', { kw: ['Displacement'] });
    if (base === 'Displacement') {
      const d = await c.point('Specify displacement');
      if (isPt(d)) {
        ents.forEach((e) => apply(e, d.x, d.y));
        c.bump();
      }
      return;
    }
    if (!isPt(base)) return;
    const pv = (q) =>
      ents.map((e) => {
        const k = E.clone(e);
        apply(k, q.x - base.x, q.y - base.y);
        return k;
      });
    c.hide(ents);
    const q = await c.point('Specify second point or <use first point as displacement>', {
      base,
      preview: pv,
    });
    if (!isPt(q)) return;
    ents.forEach((e) => apply(e, q.x - base.x, q.y - base.y));
    c.bump();
  }

  // ------------------------------------------------------------------ TRIM / EXTEND / BREAK / JOIN
  /** @private The primitives of the cutting / boundary edges (all visible objects when none were chosen). */
  static edgePrimitives(c, edges) {
    const list = edges.length ? edges : c.app.curEnts().filter((e) => c.doc.visible(e));
    return list.filter((e) => O.EDGE_TYPES.has(e.type)).flatMap((e) => E.prims(e, c.doc));
  }

  // where each object is hit by a crossing window diagonal / fence path: the object is trimmed or extended at that point
  /** @private Where each object is hit by a crossing window diagonal or a fence path: the object is trimmed or extended at that point. */
  static sweepPoints(c, ents, path) {
    const out = [];
    for (const e of ents) {
      let best = null;
      for (const P of E.prims(e, c.doc))
        for (let i = 0; i + 1 < path.length; i += 1) {
          for (const h of G.intersectPrims(P, { k: 's', a: path[i], b: path[i + 1] })) {
            const d = G.dist(h, path[0]);
            if (!best || d < best.d) best = { p: h, d };
          }
        }
      if (!best) {
        for (const P of E.prims(e, c.doc)) {
          const n = G.nearestOnPrim(P, path[0]);
          if (!best || n.d < best.d) best = { p: n.p, d: n.d };
        }
      }
      if (best) out.push({ e, p: best.p });
    }
    return out;
  }

  // one TRIM / EXTEND object request: click = one object, drag or the Crossing / Fence options = many
  /** @private One TRIM / EXTEND object request: a click is one object, a drag or the Crossing / Fence options are many. */
  static async pickTargets(c, prompt, kws, filter) {
    const r = await c.pick(prompt, { kw: kws, filter, drag: true });
    if (r === null || r === 'Undo' || r === 'eRase') return r;
    if (r === 'Crossing') {
      const a = await c.point('Specify first crossing corner', { noOrtho: true });
      if (!isPt(a)) return [];
      const b = await c.point('Specify opposite corner', {
        base: a,
        noOrtho: true,
        rubber: false,
        preview: (q) => {
          const t = E.mk('pline', {
            pts: [
              { x: a.x, y: a.y, b: 0 },
              { x: q.x, y: a.y, b: 0 },
              { x: q.x, y: q.y, b: 0 },
              { x: a.x, y: q.y, b: 0 },
            ],
            closed: true,
          });
          t._dash = [4, 3];
          return [t];
        },
      });
      if (!isPt(b)) return [];
      const rect = {
        x0: Math.min(a.x, b.x),
        y0: Math.min(a.y, b.y),
        x1: Math.max(a.x, b.x),
        y1: Math.max(a.y, b.y),
      };
      return ModifyCommands.sweepPoints(
        c,
        c.app
          .curEnts()
          .filter(
            (e) => c.app.selectable(e) && (!filter || filter(e)) && E.inRect(e, rect, true, c.doc),
          ),
        [a, b],
      );
    }
    if (r === 'Fence') {
      const pts = [];
      for (;;) {
        const q = await c.point(
          pts.length ? 'Specify next fence point or [Undo]' : 'Specify first fence point',
          {
            base: pts[pts.length - 1],
            noOrtho: true,
            preview: (p) => {
              const t = E.mk('pline', {
                pts: [...pts, p].map((x) => ({ x: x.x, y: x.y, b: 0 })),
                closed: false,
              });
              t._dash = [4, 3];
              return [t];
            },
          },
        );
        if (!isPt(q)) break;
        pts.push({ x: q.x, y: q.y });
      }
      if (pts.length < 2) return [];
      return ModifyCommands.sweepPoints(
        c,
        c.app
          .curEnts()
          .filter(
            (e) => c.app.selectable(e) && (!filter || filter(e)) && E.crossFence(e, pts, c.doc),
          ),
        pts,
      );
    }
    if (r.drag) return ModifyCommands.sweepPoints(c, r.list, [r.a, r.b]);
    return r.e ? [{ e: r.e, p: r.p }] : [];
  }

  /** TRIM: cuts objects at the cutting edges (shift-select extends). */
  static async trim(c) {
    if(c.app.v3&&c.app.solids().length&&COMMANDS.SURFACETRIM)return COMMANDS.SURFACETRIM.fn(c);
    return ModifyCommands.trim2d(c);
  }

  /** The original 2D TRIM workflow, retained unchanged when the drawing is in a 2D view. */
  static async trim2d(c) {
    c.echo('Current settings: Projection=None, Edge=None');
    const edges = await c.select('Select cutting edges ... Select objects or <select all>', {
      pre: false,
      allowAll: true,
    });
    const hist = []; // drawing states before each trim, for the Undo option
    for (;;) {
      const hits = await ModifyCommands.pickTargets(
        c,
        'Select object to trim or shift-select to extend or drag a crossing window [Fence/Crossing/eRase/Undo]',
        ['Fence', 'Crossing', 'eRase', 'Undo'],
        (e) => O.TRIMMABLE.has(e.type) || c.app.keys.shift,
      );
      if (hits === null) break;
      if (hits === 'Undo') {
        if (hist.length) {
          c.doc.restore(hist.pop());
          c.bump();
        } else c.echo('Nothing to undo.');
        continue;
      }
      if (hits === 'eRase') {
        hist.push(c.doc.snapshot());
        const del = await c.select('Select objects to erase or <exit>', { pre: false });
        if (del.length) c.erase(del);
        else hist.pop();
        continue;
      }
      hist.push(c.doc.snapshot());
      let miss = 0;
      for (const { e, p } of hits) {
        const prims = ModifyCommands.edgePrimitives(c, edges);
        if (c.app.keys.shift) {
          if (O.extend(e, p, prims, c.doc)) c.bump();
          else miss += 1;
          continue;
        }
        const out = O.trim(e, p, prims, c.doc);
        if (out === null) {
          miss += 1;
          continue;
        }
        c.replace(e, out);
        c.app.hover = null;
      }
      if (miss)
        c.echo(
          miss === 1 && hits.length === 1
            ? 'Object does not intersect an edge.'
            : `${miss} object(s) do not intersect an edge.`,
        );
    }
  }

  /** EXTEND: extends objects to the boundary edges (shift-select trims). */
  static async extend(c) {
    if(c.app.v3&&c.app.solids().length&&COMMANDS.SURFACEEXTEND)return COMMANDS.SURFACEEXTEND.fn(c);
    return ModifyCommands.extend2d(c);
  }

  /** The original 2D EXTEND workflow, retained unchanged when the drawing is in a 2D view. */
  static async extend2d(c) {
    c.echo('Current settings: Projection=None, Edge=None');
    const edges = await c.select('Select boundary edges ... Select objects or <select all>', {
      pre: false,
    });
    const hist = [];
    for (;;) {
      const hits = await ModifyCommands.pickTargets(
        c,
        'Select object to extend or shift-select to trim or drag a crossing window [Fence/Crossing/Undo]',
        ['Fence', 'Crossing', 'Undo'],
      );
      if (hits === null) break;
      if (hits === 'Undo') {
        if (hist.length) {
          c.doc.restore(hist.pop());
          c.bump();
        } else c.echo('Nothing to undo.');
        continue;
      }
      hist.push(c.doc.snapshot());
      let miss = 0;
      for (const { e, p } of hits) {
        const prims = ModifyCommands.edgePrimitives(c, edges);
        if (c.app.keys.shift && O.TRIMMABLE.has(e.type)) {
          const out = O.trim(e, p, prims, c.doc);
          if (out) c.replace(e, out);
          continue;
        }
        if (O.extend(e, p, prims, c.doc)) c.bump();
        else miss += 1;
      }
      if (miss)
        c.echo(
          miss === 1 && hits.length === 1
            ? 'Object cannot be extended.'
            : `${miss} object(s) cannot be extended.`,
        );
    }
  }

  /** BREAK: removes the part of an object between two points. */
  static async breakObject(c) {
    const r = await c.pick('Select object', {
      filter: (e) => ['line', 'arc', 'circle', 'pline'].includes(e.type),
    });
    if (!r || !r.e) return;
    c.app.lastPoint = { ...r.p };
    let p1 = r.p;
    let p2 = await c.point('Specify second break point or [First point]', { kw: ['First point'] });
    if (p2 === 'First point') {
      p1 = await c.point('Specify first break point');
      if (!isPt(p1)) return;
      p2 = await c.point('Specify second break point');
    }
    if (!isPt(p2)) return;
    const out = O.breakEnt(r.e, p1, p2, c.doc);
    if (out === null) return c.fail('Cannot break this object.');
    c.replace(r.e, out);
  }

  /** BREAKATPOINT: splits an object at a point. */
  static async breakAtPoint(c) {
    const r = await c.pick('Select object', {
      filter: (e) => ['line', 'arc', 'pline'].includes(e.type),
    });
    if (!r || !r.e) return;
    const p = await c.point('Specify break point');
    if (!isPt(p)) return;
    const out = O.breakEnt(r.e, p, p, c.doc);
    if (out) c.replace(r.e, out);
  }

  /** JOIN: joins lines, arcs and polylines that touch. */
  static async join(c) {
    const ents = await c.select('Select objects to join', {
      filter: (e) => ['line', 'arc', 'pline'].includes(e.type),
    });
    if (ents.length < 2) return;
    const out = O.joinEnts(ents);
    if (!out.length) return c.fail('Nothing to join.');
    c.erase(ents);
    c.addAll(out);
    c.echo(`${ents.length} objects joined into ${out.length}.`);
  }

  // ------------------------------------------------------------------ FILLET / CHAMFER
  /** FILLET: rounds the corner between two objects (3D solids go to FILLETEDGE). */
  static async fillet(c) {
    const st = c.app.filletOpts || (c.app.filletOpts = { r: 0, multi: false, trim: true });
    for (;;) {
      c.echo(
        `Current settings: Mode = ${st.trim === false ? 'NOTRIM' : 'TRIM'}, Radius = ${c.fmt(st.r)}`,
      );
      const a = await c.pick('Select first object or [Polyline/Radius/Trim/Multiple]', {
        kw: ['Polyline', 'Radius', 'Trim', 'Multiple'],
        filter: (e) => ['line', 'arc', 'circle', 'pline', 'solid3d'].includes(e.type),
      });
      if (a && a.e && a.e.type === 'solid3d') {
        c.echo('3D solid: select the edges to round.');
        setTimeout(() => c.app.exec('FILLETEDGE'), 0);
        return;
      } // same F shortcut for solids
      if (a === 'Radius') {
        const r = await c.dist('Specify fillet radius', { def: st.r });
        if (typeof r === 'number') st.r = r;
        continue;
      }
      if (a === 'Multiple') {
        st.multi = !st.multi;
        c.echo(`Multiple ${st.multi ? 'on' : 'off'}`);
        continue;
      }
      if (a === 'Trim') {
        const t = await c.keyword(
          'Enter Trim mode option [Trim/No trim]',
          ['Trim', 'No trim'],
          st.trim === false ? 'No trim' : 'Trim',
        );
        if (t !== null) st.trim = t === 'Trim';
        continue;
      }
      if (a === 'Polyline') {
        const r = await c.pick('Select 2D polyline', { filter: (e) => e.type === 'pline' });
        if (!r || !r.e) return;
        r.e.pts = O.plineCorners(r.e, st.r);
        c.bump();
        return;
      }
      if (!a || !a.e) return;
      if (a.e.type === 'pline') {
        const b = await c.pick('Select second object', {
          filter: (e) => e.type === 'pline' || e.type === 'line',
        });
        if (!b || !b.e) return;
        if (b.e === a.e) {
          ModifyCommands.roundPolyline(c, a.e, st.r);
          if (!st.multi) return;
          continue;
        }
        c.fail('Fillet between a polyline and another object is not supported.');
        return;
      }
      const b = await c.pick('Select second object or shift-select to apply corner', {
        filter: (e) => ['line', 'arc', 'circle'].includes(e.type),
      });
      if (!b || !b.e) return;
      const res = O.filletTwo(a.e, a.p, b.e, b.p, c.app.keys.shift ? 0 : st.r, st.trim !== false);
      if (res.error) {
        c.echo(res.error);
        if (!st.multi) return;
        continue;
      }
      if (res.arc) c.add(res.arc);
      c.bump();
      if (!st.multi) return;
    }
  }

  /** @private Rounds all corners of one polyline. */
  static roundPolyline(c, e, r) {
    e.pts = O.plineCorners(e, r);
    c.bump();
  }

  /** CHAMFER: bevels the corner between two lines (3D solids go to CHAMFEREDGE). */
  static async chamfer(c) {
    const st =
      c.app.chamOpts ||
      (c.app.chamOpts = { d1: 0, d2: 0, angle: 30, method: 'Distance', trim: true, multi: false });
    const d2of = () =>
      st.method === 'Angle' ? st.d1 * Math.tan((st.angle * Math.PI) / 180) : st.d2; // by angle: the second distance follows from the length and the angle
    for (;;) {
      c.echo(
        `(${st.trim === false ? 'NO TRIM' : 'TRIM'} mode) Current chamfer ${st.method === 'Angle' ? `Length = ${c.fmt(st.d1)}, Angle = ${st.angle}` : `Dist1 = ${c.fmt(st.d1)}, Dist2 = ${c.fmt(st.d2)}`}`,
      );
      const a = await c.pick(
        'Select first line or [Polyline/Distance/Angle/Trim/mEthod/Multiple]',
        {
          kw: ['Polyline', 'Distance', 'Angle', 'Trim', 'mEthod', 'Multiple'],
          filter: (e) => e.type === 'line' || e.type === 'pline' || e.type === 'solid3d',
        },
      );
      if (a && a.e && a.e.type === 'solid3d') {
        c.echo('3D solid: select the edges to chamfer.');
        setTimeout(() => c.app.exec('CHAMFEREDGE'), 0);
        return;
      } // same CHA shortcut for solids
      if (a === 'Distance') {
        const d1 = await c.dist('Specify first chamfer distance', { def: st.d1 });
        if (typeof d1 !== 'number') return;
        const d2 = await c.dist('Specify second chamfer distance', { def: d1 });
        if (typeof d2 !== 'number') return;
        st.d1 = d1;
        st.d2 = d2;
        st.method = 'Distance';
        continue;
      }
      if (a === 'Angle') {
        const d1 = await c.dist('Specify chamfer length on the first line', { def: st.d1 });
        if (typeof d1 !== 'number') return;
        const an = await c.number('Specify chamfer angle from the first line', { def: st.angle });
        if (typeof an !== 'number') return;
        if (!(an > 0 && an < 90)) {
          c.echo('The angle must be between 0 and 90 degrees.');
          continue;
        }
        st.d1 = d1;
        st.angle = an;
        st.method = 'Angle';
        continue;
      }
      if (a === 'mEthod') {
        const m = await c.keyword(
          'Enter trim method [Distance/Angle]',
          ['Distance', 'Angle'],
          st.method,
        );
        if (m !== null) st.method = m;
        continue;
      }
      if (a === 'Trim') {
        const t = await c.keyword(
          'Enter Trim mode option [Trim/No trim]',
          ['Trim', 'No trim'],
          st.trim === false ? 'No trim' : 'Trim',
        );
        if (t !== null) st.trim = t === 'Trim';
        continue;
      }
      if (a === 'Multiple') {
        st.multi = !st.multi;
        c.echo(`Multiple ${st.multi ? 'on' : 'off'}`);
        continue;
      }
      if (a === 'Polyline') {
        const r = await c.pick('Select 2D polyline', { filter: (e) => e.type === 'pline' });
        if (!r || !r.e) return;
        r.e.pts = O.plineCorners(r.e, st.d1, true, d2of());
        c.bump();
        return;
      }
      if (!a || !a.e) return;
      const b = await c.pick('Select second line', { filter: (e) => e.type === 'line' });
      if (!b || !b.e) return;
      const res = O.chamferTwo(a.e, a.p, b.e, b.p, st.d1, d2of(), st.trim !== false);
      if (res.error) {
        c.fail(res.error);
        if (!st.multi) return;
        continue;
      }
      if (res.line) c.add(res.line);
      c.bump();
      if (!st.multi) return;
    }
  }

  // ------------------------------------------------------------------ EXPLODE / LENGTHEN / ALIGN / MATCHPROP / PEDIT
  /** EXPLODE: breaks objects (blocks, polylines, dimensions, ...) into simpler parts. */
  static async explode(c) {
    const ents = await c.select('Select objects', { filter: (e) => E.explode(e, c.doc) !== null });
    if (!ents.length) return;
    let n = 0;
    const made = {};
    for (const e of ents) {
      const parts = E.explode(e, c.doc);
      if (!parts) {
        c.echo(`${E.typeName(e)} cannot be exploded.`);
        continue;
      }
      if (e.type === 'dim')
        for (const k of parts) {
          const key =
            k.type === 'hatch'
              ? 'solid arrowhead(s)'
              : k.type === 'line'
                ? 'line(s)'
                : k.type === 'arc'
                  ? 'arc(s)'
                  : 'text(s)';
          made[key] = (made[key] || 0) + 1;
        }
      c.replace(e, parts);
      n += 1;
    }
    c.echo(
      `${n} object(s) exploded.${
        Object.keys(made).length
          ? ` A dimension becomes ${Object.entries(made)
              .map(([k, v]) => `${v} ${k}`)
              .join(', ')}; it is no longer associative.`
          : ''
      }`,
    );
  }

  // LENGTHEN DYnamic: move the end of a line / arc that is nearer to `click` to the point q (along the line / around the arc centre); the other end stays
  /** @private LENGTHEN DYnamic: moves the end of a line / arc that is nearer to `click` to the point q (along the line / around the arc centre); the other end stays. */
  static lengthenTo(e, click, q) {
    if (e.type === 'line') {
      const d = norm(sub(e.p2, e.p1));
      const atEnd = dist(click, e.p2) < dist(click, e.p1);
      const from = atEnd ? e.p1 : e.p2;
      const t = G.dot(sub(q, from), atEnd ? d : mul(d, -1));
      if (t <= 1e-9) return false;
      if (atEnd) e.p2 = add(from, mul(d, t));
      else e.p1 = add(from, mul(d, -t));
      return true;
    }
    if (e.type === 'arc') {
      const na = ang(e.c, q);
      const atEnd = G.sweep(e.a0, ang(e.c, click)) > G.sweep(e.a0, e.a1) / 2;
      if (atEnd) e.a1 = e.a0 + G.sweep(e.a0, na);
      else e.a0 = e.a1 - G.sweep(na, e.a1);
      return true;
    }
    return false;
  }

  /** LENGTHEN: changes the length of lines and arcs. */
  static async lengthen(c) {
    const st = c.app.lenOpts || (c.app.lenOpts = { mode: 'delta', v: 10 });
    for (;;) {
      const r = await c.pick('Select an object or [DElta/Percent/Total/DYnamic]', {
        kw: ['DElta', 'Percent', 'Total', 'DYnamic'],
        filter: (e) => ['line', 'arc'].includes(e.type),
      });
      if (r === 'DYnamic') {
        st.mode = 'dynamic';
        continue;
      }
      if (r === 'DElta') {
        const v = await c.dist('Enter delta length', { def: st.v });
        if (typeof v === 'number') {
          st.mode = 'delta';
          st.v = v;
        }
        continue;
      }
      if (r === 'Percent') {
        const v = await c.number('Enter percentage length', { def: 100 });
        if (typeof v === 'number') {
          st.mode = 'percent';
          st.v = v;
        }
        continue;
      }
      if (r === 'Total') {
        const v = await c.dist('Specify total length', { def: 100 });
        if (typeof v === 'number') {
          st.mode = 'total';
          st.v = v;
        }
        continue;
      }
      if (!r || !r.e) return;
      c.echo(`Current length: ${c.fmt(E.entLength(r.e))}`);
      if (st.mode === 'dynamic') {
        // the end that is nearer to the pick follows the point you give
        const q = await c.point('Specify new end point', {});
        if (!isPt(q)) continue;
        if (!ModifyCommands.lengthenTo(r.e, r.p, q)) c.echo('Cannot lengthen that way.');
        c.bump();
        continue;
      }
      if (!O.lengthen(r.e, st.mode, st.v, r.p)) c.echo('Cannot lengthen that way.');
      c.bump();
    }
  }

  /** ALIGN: moves, rotates and optionally scales objects onto destination points. */
  static async align(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const s1 = await c.point('Specify first source point');
    if (!isPt(s1)) return;
    const d1 = await c.point('Specify first destination point', { base: s1 });
    if (!isPt(d1)) return;
    const s2 = await c.point('Specify second source point', { base: s1 });
    if (!isPt(s2)) {
      ents.forEach((e) => E.translateEnt(e, d1.x - s1.x, d1.y - s1.y, c.doc));
      return c.bump();
    }
    const d2 = await c.point('Specify second destination point', { base: d1 });
    if (!isPt(d2)) return;
    const sc = await c.keyword(
      'Scale objects based on alignment points? [Yes/No]',
      ['Yes', 'No'],
      'No',
    );
    const a = ang(d1, d2) - ang(s1, s2);
    const s = sc === 'Yes' ? dist(d1, d2) / (dist(s1, s2) || 1) : 1;
    const M = G.Mmul(
      G.Mtranslate(d1.x, d1.y),
      G.Mmul(G.Mrotate(a), G.Mmul(G.Mscale(s), G.Mtranslate(-s1.x, -s1.y))),
    );
    ents.forEach((e) => E.xformInPlace(e, M, c.doc));
    c.bump();
  }

  /** MATCHPROP: copies layer, colour, linetype and text properties from one object to others. */
  static async matchProperties(c) {
    const r = await c.pick('Select source object');
    if (!r || !r.e) return;
    const s = r.e;
    c.echo('Current active settings = Color Layer Linetype Lineweight Linetype scale');
    for (;;) {
      const d = await c.pick('Select destination object(s)');
      if (!d || !d.e) return;
      d.e.layer = s.layer;
      d.e.color = s.color;
      d.e.ltype = s.ltype;
      d.e.lw = s.lw;
      d.e.ltscale = s.ltscale;
      if (s.type === d.e.type && (s.type === 'text' || s.type === 'mtext')) {
        d.e.h = s.h;
        d.e.style = s.style;
      }
      if (s.type === 'dim' && d.e.type === 'dim')
        c.echo(
          matchDimension(s, d.e)
            ? 'Dimension style copied and dimension line aligned.'
            : 'Dimension style copied (dimension lines are not parallel, so the position is unchanged).',
        );
      c.bump();
    }
  }

  /** PEDIT: edits a polyline (close / open, join, spline, decurve, reverse). */
  static async polyEdit(c) {
    const r = await c.pick('Select polyline or [Multiple]', { kw: ['Multiple'] });
    if (!r || !r.e) return;
    let e = r.e;
    if (e.type === 'line' || e.type === 'arc') {
      const y = await c.keyword(
        'Object selected is not a polyline\nDo you want to turn it into one? [Yes/No]',
        ['Yes', 'No'],
        'Yes',
      );
      if (y !== 'Yes') return;
      const p = e.type === 'line' ? O.lineToPline(e) : O.arcToPline(e);
      c.replace(e, [p]);
      e =
        c.app
          .curEnts()
          .find(
            (x) => x.type === 'pline' && x.pts[0].x === p.pts[0].x && x.pts[0].y === p.pts[0].y,
          ) || p;
    }
    if (e.type !== 'pline' && e.type !== 'spline')
      return c.fail('Object is not editable by PEDIT.');
    for (;;) {
      const kws = [e.closed ? 'Open' : 'Close', 'Join', 'Spline', 'Decurve', 'Reverse', 'Undo'];
      const o = await c.keyword(`Enter an option [${kws.join('/')}]`, kws, null);
      if (o === null) return;
      if (o === 'Close') {
        e.closed = true;
        c.bump();
      } else if (o === 'Open') {
        e.closed = false;
        c.bump();
      } else if (o === 'Reverse') {
        if (e.type === 'pline') O.reversePline(e);
        else e.pts.reverse();
        c.bump();
      } else if (o === 'Spline') {
        if (e.type === 'pline') {
          const verts = E.closedLoop(
            E.mk('pline', { pts: e.pts.map((p) => ({ ...p, b: 0 })), closed: true }),
          );
          void verts;
          const sp = c.mk('spline', {
            pts: e.pts.map((p) => ({ x: p.x, y: p.y })),
            closed: e.closed,
          });
          sp.layer = e.layer;
          sp.color = e.color;
          c.replace(e, [sp]);
          return;
        }
      } else if (o === 'Decurve') {
        if (e.type === 'spline') {
          const pl = c.mk('pline', { pts: E.splinePts(e).map((p) => bp(p)), closed: e.closed });
          pl.layer = e.layer;
          c.replace(e, [pl]);
          return;
        }
      } else if (o === 'Join') {
        const more = await c.select('Select objects to join to polyline', {
          pre: false,
          filter: (x) => ['line', 'arc', 'pline'].includes(x.type) && x !== e,
        });
        if (!more.length) continue;
        const out = O.joinEnts([e, ...more]);
        c.erase([e, ...more]);
        c.addAll(out);
        return;
      } else if (o === 'Undo') c.echo('Use UNDO to revert.');
    }
  }

  /** DRAWORDER: moves objects to the front / back or above / under another object. */
  static async drawOrder(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const o = await c.keyword(
      'Enter object ordering option [Above objects/Under objects/Front/Back]',
      ['Front', 'Back', 'Above objects', 'Under objects'],
      'Back',
    );
    const arr = c.doc.spaceList(c.space);
    const set = new Set(ents.map((e) => e.id));
    if (o === 'Front') {
      const rest = arr.filter((e) => !set.has(e.id));
      arr.splice(0, arr.length, ...rest, ...ents);
    } else if (o === 'Back') {
      const rest = arr.filter((e) => !set.has(e.id));
      arr.splice(0, arr.length, ...ents, ...rest);
    } else {
      const ref = await c.pick('Select reference object');
      if (!ref || !ref.e) return;
      const rest = arr.filter((e) => !set.has(e.id));
      const i = rest.indexOf(ref.e);
      rest.splice(o === 'Above objects' ? i + 1 : i, 0, ...ents);
      arr.splice(0, arr.length, ...rest);
    }
    c.bump();
  }

  /** DDEDIT: edits text, multiline text, dimension text and leaders. */
  static async editTextCommand(c) {
    for (;;) {
      const r = await c.pick('Select an annotation object', {
        filter: (e) => ['text', 'mtext', 'dim', 'leader'].includes(e.type),
      });
      if (!r || !r.e) return;
      await ModifyCommands.editText(c, r.e);
    }
  }

  /** Edits the text of one annotation object (in place for single-line text, in the editor for multiline text). */
  static async editText(c, e) {
    if (e.type === 'text') {
      let s;
      if (c.ui.editInPlace) {
        c.hide([e]);
        s = await c.ui.editInPlace(e);
        c.hide([]);
      } // edit box on the text itself
      if (s === undefined) s = await c.string('Enter new text', { def: e.str });
      if (s !== null && s !== undefined) e.str = s;
    } else if (e.type === 'mtext' || e.type === 'leader') {
      const r = await c.ui.mtextEditor({ str: e.str, h: e.h });
      if (r) {
        e.str = r.str;
        e.h = r.h;
      }
    } else if (e.type === 'dim') {
      const s = await c.string('Enter dimension text (<> = measured value)', {
        def: e.text || '<>',
      });
      if (s !== null) e.text = s === '<>' ? null : s;
    }
    c.bump();
  }

  /** Registers the commands of this file in their original order (a later definition of a name wins). */
  static register() {
    def('ERASE E DEL', ModifyCommands.erase);
    def('MOVE M', ModifyCommands.move);
    def('COPY CO CP', ModifyCommands.copy);
    def('ROTATE RO', ModifyCommands.rotate);
    def('SCALE SC', ModifyCommands.scale);
    def('MIRROR MI', ModifyCommands.mirror);
    def('OFFSET O', ModifyCommands.offset);
    def('ARRAY AR', ModifyCommands.array);
    def('STRETCH S STR', ModifyCommands.stretch);
    def('TRIM TR', ModifyCommands.trim);
    def('EXTEND EX', ModifyCommands.extend);
    def('BREAK BR', ModifyCommands.breakObject);
    def('BREAKATPOINT', ModifyCommands.breakAtPoint);
    def('JOIN J', ModifyCommands.join);
    def('FILLET F', ModifyCommands.fillet);
    def('CHAMFER CHA', ModifyCommands.chamfer);
    def('EXPLODE X', ModifyCommands.explode);
    def('LENGTHEN LEN', ModifyCommands.lengthen);
    def('ALIGN AL', ModifyCommands.align);
    def('MATCHPROP MA PAINTER', ModifyCommands.matchProperties);
    def('PEDIT PE', ModifyCommands.polyEdit);
    def('DRAWORDER DR', ModifyCommands.drawOrder);
    def('DDEDIT ED', ModifyCommands.editTextCommand);
  }
}

ModifyCommands.register();

export const editText = ModifyCommands.editText;
