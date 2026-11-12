/**
 * @file lispcad.js
 * @brief The CAD bindings of the AutoLISP interpreter: user input (get*), entities (entget /
 *        entmod / entmake / ssget), `command`, system variables, tables, vlax-curve and a vla-
 *        property layer.
 *
 * `createLisp(app)` makes an interpreter for the application; `installCad(L, app)` adds the CAD
 * functions to an interpreter (the built-in language functions are in lisp.js).
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */

import * as G from './geom.js';
import * as E from './entities.js';
import * as O from './ops.js';
import {
  Lisp,
  Sym,
  Subr,
  Pair,
  EName,
  PickSet,
  LFile,
  LispError,
  R,
  T,
  sym,
  toStr,
  nv,
  isNum,
  parse,
} from './lisp.js';
import { buildSysvars } from './sysvars.js';
import { installDcl } from './dcl.js';
import { fmtLen, fmtAng, parseDist, parseAng } from './units.js';
import { COMMANDS, ALIASES } from './registry.js';
import { CANCEL, CmdError } from './registry.js';
import { findSnap } from './snap.js';
import * as K from './kernel3d.js';

/* ============================================================================================
 * 2. SMALL HELPERS
 * ========================================================================================== */

/** @returns T for true, nil for false. */
const toBool = (b) => (b ? T : null);

/** A point {x, y, z} as a LISP point (x y z). */
const P3 = (p) => [R(p.x), R(p.y), R(p.z || 0)];

/** A point {x, y} as a LISP point (x y). */
const P2 = (p) => [R(p.x), R(p.y)];

/**
 * A LISP point (x y [z]) as {x, y, z}.
 * @throws {LispError} when the argument is not a point
 */
const pt = (a) => {
  if (!Array.isArray(a)) throw new LispError('bad argument type: 2D/3D point: ' + toStr(a, true));
  return { x: nv(a[0]), y: nv(a[1]), z: a.length > 2 ? nv(a[2]) : 0 };
};

/** The DXF layer flags of a layer: 1 frozen, 4 locked. */
const dxfLayerFlags = (l) => (l.frozen ? 1 : 0) | (l.locked ? 4 : 0);

/* ============================================================================================
 * 3. THE CAD FUNCTIONS
 * ========================================================================================== */

/**
 * The CAD functions of AutoLISP, installed in groups: host connection, input functions
 * (getpoint, getint, initget, ...), entity access (entget, entmod, entmake, ...), 3D solid
 * modelling, selection sets, symbol tables, `command`, miscellaneous functions, file I/O,
 * vlax-curve functions and vla- property access.
 */
export class CadLispLibrary {
  /** @param {object} L the interpreter @param {object} app the application */
  constructor(L, app) {
    this.L = L;
    this.app = app;
  }

  /**
   * Installs all groups of functions in order (a later definition of a name wins).
   * @returns {object} the interpreter
   */
  build() {
    this.setup();
    this.connectHost();
    this.inputFunctions();
    this.entityFunctions();
    this.solidFunctions();
    this.selectionFunctions();
    this.symbolTables();
    this.commandFunction();
    this.miscFunctions();
    this.fileIo();
    this.curveFunctions();
    this.vlaFunctions();
    this.editorHelpers();
    return this.L;
  }

  /** @private The function definer `D`, the system variable table and the links between interpreter and application. */
  setup() {
    const { L, app } = this;

    const D = (n, f) => L.def(n, f);
    this.D = D;

    const sv = buildSysvars(app);
    this.sv = sv;

    app.lisp = L;

    L.sysvars = sv;
  }

  /** @private Host connection: how the interpreter echoes, reads units, runs user commands and handles *error*. */
  connectHost() {
    const { L, app } = this;

    L.host.echo = (l) => app.echo(l);

    L.host.units = () => app.doc.units;

    L.host.fmtLen = (v, u) => fmtLen(v, u);

    L.host.parseDist = parseDist;

    L.host.parseAng = parseAng;

    L.host.textscr = (on) => app.ui && app.ui.showTextWindow && app.ui.showTextWindow(on);

    L.host.alert = (m) => app.ui.alert(m);

    L.host.getenv = (n) => {
      try {
        const v = localStorage.getItem('maccad.env.' + n);
        return v === null ? null : v;
      } catch {
        return null;
      }
    };

    L.host.setenv = (n, v) => {
      try {
        localStorage.setItem('maccad.env.' + n, String(v));
      } catch {
        /* ignore */
      }
    };

    L.host.registerCommand = (name, fn) => {
      const up = name.toUpperCase();
      if (COMMANDS[up] && !COMMANDS[up].lisp) {
        app.echo(
          `Note: ${up} is a built-in command; your C:${up} can be called as (c:${up.toLowerCase()}).`,
        );
        return;
      }
      COMMANDS[up] = {
        name: up,
        lisp: true,
        fn: async () => {
          await L.runUser(fn);
        },
      };
      ALIASES[up.toLowerCase()] = up;
    };

    L.host.loadFile = async (name) => {
      const text = await app.fs.readLisp(name);
      if (text === null) throw new LispError(`can't open file "${name}"`);
      L.loaded.push(name);
      await L.evalStringOrThrow(text, name);
      return sym('T') === null ? null : (L.lastLoadValue ?? null);
    };

    // Evaluate a source text and let errors propagate (used by LOAD)
    L.evalStringOrThrow = async (src, source) => {
      const forms = parse(src);
      let last = null;
      for (const f of forms) last = await L.evalForm(f);
      L.lastLoadValue = last;
      void source;
      return last;
    };

    // Run a c: command function with error handling (honours *error*)
    L.runUser = async (fn) => {
      try {
        await L.apply(fn, []);
      } catch (e) {
        if (e === CANCEL) {
          await L.handleError(new LispError('Function cancelled'));
        } else await L.handleError(e);
      } finally {
        L.flush();
      }
    };

    const wrapCancel = async (p) => {
      try {
        return await p;
      } catch (e) {
        if (e === CANCEL) throw new LispError('Function cancelled');
        if (e instanceof CmdError) throw new LispError(e.message);
        throw e;
      }
    };
    this.wrapCancel = wrapCancel;

    L.resolveMissing = (name) => this.resolveMissing(name);
  }

  /** @private initget and the get* functions (getpoint, getdist, getangle, getint, getreal, getstring, getkword ...). */
  inputFunctions() {
    const { app, sv, D, wrapCancel } = this;

    let init = { bits: 0, kws: [] };

    D('initget', (a, b) => {
      let bits = 0;
      let kw = '';
      if (typeof a === 'number') {
        bits = a;
        kw = typeof b === 'string' ? b : '';
      } else if (typeof a === 'string') kw = a;
      init = {
        bits,
        kws: kw
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((k) => k.replace(/^.*_/, '')),
      };
      return null;
    });

    const takeInit = () => {
      const i = init;
      init = { bits: 0, kws: [] };
      return i;
    };
    this.takeInit = takeInit;

    const promptText = (p) =>
      String(p ?? '')
        .replace(/^\n+/, '')
        .replace(/[:\s]+$/, '');
    this.promptText = promptText;

    const kwOpts = (i, extra = {}) => ({ kw: i.kws, ...extra });
    this.kwOpts = kwOpts;

    const handleNull = (i, name) => {
      if (i.bits & 1) throw new LispError('requires non-null input');
      void name;
      return null;
    };
    this.handleNull = handleNull;

    D('getpoint', async (a, b) => {
      const i = takeInit();
      const base = Array.isArray(a) ? pt(a) : null;
      const prompt = promptText(Array.isArray(a) ? b : a) || 'Specify point';
      const r = await wrapCancel(
        app.point(prompt, kwOpts(i, { base: base || undefined, rubber: !!base })),
      );
      if (r === null) return handleNull(i);
      if (typeof r === 'string') return r;
      return P3(r);
    });

    D('getcorner', async (a, b) => {
      const i = takeInit();
      const base = pt(a);
      const prompt = promptText(b) || 'Specify other corner';
      const rect = (q) => {
        const t = E.mk('pline', {
          pts: [base, { x: q.x, y: base.y }, q, { x: base.x, y: q.y }].map((p) => ({
            x: p.x,
            y: p.y,
            b: 0,
          })),
          closed: true,
        });
        t._dash = [4, 4];
        return [t];
      };
      const r = await wrapCancel(
        app.point(prompt, kwOpts(i, { base, rubber: false, preview: rect })),
      );
      if (r === null) return handleNull(i);
      if (typeof r === 'string') return r;
      return P3(r);
    });

    D('getdist', async (a, b) => {
      const i = takeInit();
      const base = Array.isArray(a) ? pt(a) : null;
      const prompt = promptText(Array.isArray(a) ? b : a) || 'Specify distance';
      const r = await wrapCancel(app.dist(prompt, kwOpts(i, { base: base || undefined })));
      if (r === null) return handleNull(i);
      if (typeof r === 'string') return r;
      return R(r);
    });

    const angleFn = async (a, b) => {
      const i = takeInit();
      const base = Array.isArray(a) ? pt(a) : null;
      const prompt = promptText(Array.isArray(a) ? b : a) || 'Specify angle';
      const r = await wrapCancel(app.angle(prompt, kwOpts(i, { base: base || undefined })));
      if (r === null) return handleNull(i);
      if (typeof r === 'string') return r;
      return R(((r % G.TAU) + G.TAU) % G.TAU);
    };

    D('getangle', angleFn);

    D('getorient', angleFn);

    D('getint', async (p) => {
      const i = takeInit();
      for (;;) {
        const r = await wrapCancel(
          app.string(promptText(p) || 'Enter an integer', { kw: i.kws, def: '' }),
        );
        if (r === null || r === '') return handleNull(i);
        if (i.kws.some((k) => k.toLowerCase().startsWith(String(r).toLowerCase())))
          return i.kws.find((k) => k.toLowerCase().startsWith(String(r).toLowerCase()));
        if (/^[+-]?\d+$/.test(r.trim())) {
          const v = parseInt(r, 10);
          if (i.bits & 2 && v === 0) {
            app.echo('Value must be nonzero.');
            continue;
          }
          if (i.bits & 4 && v < 0) {
            app.echo('Value must be positive.');
            continue;
          }
          return v;
        }
        app.echo('Requires an integer value.');
      }
    });

    D('getreal', async (p) => {
      const i = takeInit();
      for (;;) {
        const r = await wrapCancel(
          app.string(promptText(p) || 'Enter a number', { kw: i.kws, def: '' }),
        );
        if (r === null || r === '') return handleNull(i);
        if (i.kws.some((k) => k.toLowerCase().startsWith(String(r).toLowerCase())))
          return i.kws.find((k) => k.toLowerCase().startsWith(String(r).toLowerCase()));
        const v = parseDist(r);
        if (!Number.isNaN(v)) {
          if (i.bits & 2 && v === 0) {
            app.echo('Value must be nonzero.');
            continue;
          }
          if (i.bits & 4 && v < 0) {
            app.echo('Value must be positive.');
            continue;
          }
          return R(v);
        }
        app.echo('Requires numeric value.');
      }
    });

    D('getstring', async (a, b) => {
      takeInit();
      let cr = false;
      let p = a;
      if (b !== undefined) {
        cr = a !== null;
        p = b;
      }
      const r = await wrapCancel(
        app.string(promptText(p) || 'Enter string', { def: '', showDef: false }),
      );
      void cr;
      return r === null ? '' : r;
    });

    D('getkword', async (p) => {
      const i = takeInit();
      if (!i.kws.length) return null;
      for (;;) {
        const r = await wrapCancel(
          app.string(promptText(p) + ` [${i.kws.join('/')}]`, { def: '', showDef: false }),
        );
        if (r === '' || r === null) {
          if (i.bits & 1) {
            app.echo('Enter an option keyword.');
            continue;
          }
          return null;
        }
        const k =
          i.kws.find((x) => x.toLowerCase() === r.toLowerCase()) ||
          i.kws.find((x) => x.toLowerCase().startsWith(r.toLowerCase()));
        if (k) return k;
        app.echo('Invalid option keyword.');
      }
    });

    D('grread', async () => {
      throw new LispError('grread is not supported');
    });

    D('getvar', (n) => {
      const v = sv[String(n).toUpperCase()];
      if (!v) return null;
      const x = v.get();
      return Array.isArray(x)
        ? x.map((y) => R(y))
        : typeof x === 'number'
          ? Number.isInteger(x)
            ? x
            : R(x)
          : x;
    });

    D('setvar', (n, val) => {
      const v = sv[String(n).toUpperCase()];
      if (!v) throw new LispError(`AutoCAD variable setting rejected: "${n}"`);
      if (!v.set) throw new LispError(`AutoCAD variable setting rejected: "${n}"`);
      v.set(Array.isArray(val) ? val.map(nv) : isNum(val) ? nv(val) : val);
      app.emit('doc');
      app.redraw();
      return val;
    });

    D('osnap', (p, mode) => {
      const modes = new Set(
        String(mode)
          .split(',')
          .map(
            (m) =>
              ({
                end: 'end',
                mid: 'mid',
                cen: 'cen',
                int: 'int',
                per: 'per',
                tan: 'tan',
                nea: 'nea',
                qua: 'qua',
                nod: 'nod',
                ins: 'ins',
              })[m.trim().slice(0, 3).toLowerCase()],
          )
          .filter(Boolean),
      );
      const q = pt(p);
      const v = app.activeView();
      const hit = findSnap(app.snapEnts(), app.doc, q, app.settings.aperture / v.zoom, modes, null);
      return hit ? P3(hit.p) : null;
    });
  }

  /** @private Entities: entget, entmod, entmake, entdel, entlast, entnext, handent, dictionaries ... */
  entityFunctions() {
    const { app, D } = this;

    const spaceOf = () => app.targetSpace();
    this.spaceOf = spaceOf;

    const findEnt = (en) => {
      if (!(en instanceof EName))
        throw new LispError('bad argument type: lentityp: ' + toStr(en, true));
      for (const sp of ['model', ...Object.keys(app.doc.layouts)]) {
        const e = app.doc.spaceList(sp).find((x) => x.id === en.id);
        if (e) return { e, space: sp };
      }
      return null;
    };
    this.findEnt = findEnt;

    const enameOf = (e, sp) => new EName(e.id, sp || spaceOf());
    this.enameOf = enameOf;

    const colorOut = (c) => (c == null ? 256 : c === 'bb' ? 0 : typeof c === 'number' ? c : 7);
    this.colorOut = colorOut;

    const lwOut = (w) => (w == null ? -1 : w === 'bb' ? -2 : Math.round(w * 100));
    this.lwOut = lwOut;

    const pr = (code, v) => new Pair(code, v);
    this.pr = pr;

    function toAlist(e, space) {
      const A = [];
      A.push(
        pr(-1, enameOf(e, space)),
        pr(
          0,
          {
            pline: 'LWPOLYLINE',
            insert: 'INSERT',
            hatch: 'HATCH',
            dim: 'DIMENSION',
            leader: 'LEADER',
            viewport: 'VIEWPORT',
            mtext: 'MTEXT',
            donut: 'DONUT',
            xline: 'XLINE',
            ray: 'RAY',
            ellipse: 'ELLIPSE',
            spline: 'SPLINE',
            point: 'POINT',
            text: 'TEXT',
          }[e.type] || e.type.toUpperCase(),
        ),
        pr(5, e.id.toString(16).toUpperCase()),
        pr(100, 'AcDbEntity'),
      );
      if (space && space !== 'model') A.push(pr(67, 1));
      A.push(pr(8, e.layer));
      if (e.ltype) A.push(pr(6, e.ltype === 'bb' ? 'BYBLOCK' : e.ltype));
      if (e.color != null) A.push(pr(62, colorOut(e.color)));
      if (e.lw != null) A.push(pr(370, lwOut(e.lw)));
      if (e.ltscale !== 1 && e.ltscale != null) A.push(pr(48, R(e.ltscale)));
      switch (e.type) {
        case 'line':
          A.push(
            pr(100, 'AcDbLine'),
            [10, ...P3(e.p1)],
            [11, ...P3(e.p2)],
            [210, R(0), R(0), R(1)],
          );
          break;
        case 'circle':
          A.push(pr(100, 'AcDbCircle'), [10, ...P3(e.c)], pr(40, R(e.r)), [210, R(0), R(0), R(1)]);
          break;
        case 'arc':
          A.push(
            pr(100, 'AcDbCircle'),
            [10, ...P3(e.c)],
            pr(40, R(e.r)),
            [210, R(0), R(0), R(1)],
            pr(100, 'AcDbArc'),
            pr(50, R(G.normAng(e.a0))),
            pr(51, R(G.normAng(e.a1))),
          );
          break;
        case 'point':
          A.push(pr(100, 'AcDbPoint'), [10, ...P3(e.p)]);
          break;
        case 'text':
          A.push(
            pr(100, 'AcDbText'),
            [10, ...P3(e.p)],
            pr(40, R(e.h)),
            pr(1, e.str),
            pr(50, R(e.rot || 0)),
            pr(41, R(e.wf ?? 1)),
            pr(51, R(G.rad(e.obl || 0))),
            pr(7, e.style || 'Standard'),
            pr(72, e.al || 0),
            [11, ...P3(e.p)],
            [210, R(0), R(0), R(1)],
            pr(100, 'AcDbText'),
          );
          break;
        case 'mtext':
          A.push(
            pr(100, 'AcDbMText'),
            [10, ...P3(e.p)],
            pr(40, R(e.h)),
            pr(41, R(e.w || 0)),
            pr(71, e.att || 1),
            pr(1, e.str.replace(/\n/g, '\\P')),
            pr(7, e.style || 'Standard'),
            pr(50, R(e.rot || 0)),
          );
          break;
        case 'pline':
          A.push(
            pr(100, 'AcDbPolyline'),
            pr(90, e.pts.length),
            pr(70, e.closed ? 1 : 0),
            pr(43, R(0)),
          );
          for (const v of e.pts) {
            A.push([10, R(v.x), R(v.y)]);
            if (v.b) A.push(pr(42, R(v.b)));
          }
          A.push([210, R(0), R(0), R(1)]);
          break;
        case 'insert':
          A.push(
            pr(100, 'AcDbBlockReference'),
            pr(2, e.name),
            [10, ...P3(e.p)],
            pr(41, R(e.sx ?? 1)),
            pr(42, R(e.sy ?? e.sx ?? 1)),
            pr(43, R(e.sx ?? 1)),
            pr(50, R(e.rot || 0)),
            [210, R(0), R(0), R(1)],
          );
          break;
        case 'ellipse':
          A.push(
            pr(100, 'AcDbEllipse'),
            [10, ...P3(e.c)],
            [11, ...P3(E.ellipseAxes(e).major)],
            [210, R(0), R(0), R(1)],
            pr(40, R(E.ellipseAxes(e).b / E.ellipseAxes(e).a)),
            pr(41, R(e.a0)),
            pr(42, R(e.a1)),
          );
          break;
        case 'spline':
          A.push(pr(100, 'AcDbSpline'), pr(70, e.closed ? 1 : 0), pr(73, e.pts.length));
          for (const p of e.pts) A.push([11, ...P3(p)]);
          break;
        case 'xline':
        case 'ray':
          A.push(
            pr(100, e.type === 'xline' ? 'AcDbXline' : 'AcDbRay'),
            [10, ...P3(e.p)],
            [11, ...P3(e.dir)],
          );
          break;
        case 'hatch':
          A.push(
            pr(100, 'AcDbHatch'),
            pr(2, e.pattern),
            pr(70, e.pattern === 'SOLID' ? 1 : 0),
            pr(41, R(e.scale || 1)),
            pr(52, R(e.angle || 0)),
            pr(91, e.loops.length),
          );
          break;
        case 'dim':
          A.push(
            pr(100, 'AcDbDimension'),
            pr(3, e.style || 'Standard'),
            pr(1, e.text || ''),
            pr(70, { lin: 0, ali: 1, ang: 2, dia: 3, rad: 4 }[e.kind] ?? 0),
            pr(42, R(E.dimMeasure(e))),
          );
          if (e.p1) A.push([13, ...P3(e.p1)]);
          if (e.p2) A.push([14, ...P3(e.p2)]);
          if (e.dp) A.push([10, ...P3(e.dp)]);
          break;
        case 'donut':
          A.push([10, ...P3(e.c)], pr(40, R(e.rin)), pr(41, R(e.rout)));
          break;
        case 'leader':
          A.push(pr(76, e.pts.length));
          for (const p of e.pts) A.push([10, ...P3(p)]);
          if (e.str) A.push(pr(1, e.str));
          break;
        case 'viewport':
          A.push(
            [10, ...P3(G.mid(e.p1, e.p2))],
            pr(40, R(e.p2.x - e.p1.x)),
            pr(41, R(e.p2.y - e.p1.y)),
            [12, ...P3({ x: e.cx, y: e.cy })],
            pr(45, R((e.p2.y - e.p1.y) / (e.scale || 1))),
          );
          break;
        default:
          break;
      }
      return A.map((x) => (Array.isArray(x) ? x : x));
    }
    this.toAlist = toAlist;

    // a (code . value) pair or (code x y z) list -> [code, value]
    const codeOf = (x) =>
      x instanceof Pair
        ? [x.car, x.cdr]
        : Array.isArray(x)
          ? [x[0], x.length === 2 ? x[1] : x.slice(1)]
          : [null, null];
    this.codeOf = codeOf;

    const ptOf = (v) => (Array.isArray(v) ? { x: nv(v[0]), y: nv(v[1]) } : null);
    this.ptOf = ptOf;

    D('entget', (en) => {
      const f = findEnt(en);
      return f ? toAlist(f.e, f.space) : null;
    });

    D('entlast', () => {
      const l = app.doc.spaceList(spaceOf()).filter((e) => e.type !== 'viewport');
      return l.length ? enameOf(l[l.length - 1]) : null;
    });

    D('entnext', (en) => {
      const l = app.doc.spaceList(spaceOf()).filter((e) => e.type !== 'viewport');
      if (en === undefined || en === null) return l.length ? enameOf(l[0]) : null;
      const i = l.findIndex((e) => e.id === en.id);
      return i >= 0 && i + 1 < l.length ? enameOf(l[i + 1]) : null;
    });

    D('handent', (h) => {
      const id = parseInt(String(h), 16);
      const f = findEnt(new EName(id));
      return f ? enameOf(f.e, f.space) : null;
    });

    D('entdel', (en) => {
      const f = findEnt(en);
      if (!f) return null;
      app.doc.remove([f.e.id], f.space);
      app.changed();
      return en;
    });

    D('entupd', (en) => {
      E.bump();
      app.redraw();
      return en;
    });
  }

  /** @private 3D solids: modelling from LISP (also what AI-written code uses). */
  solidFunctions() {
    const { app, D, spaceOf, enameOf, findEnt, codeOf, ptOf } = this;

    const kernel3 = async () => {
      if (!K.kernelReady()) {
        app.echo('Loading the 3D solid kernel (OpenCascade)...');
        try {
          await K.initKernel();
        } catch (err) {
          throw new LispError(`the 3D kernel could not be loaded: ${err.message}`);
        }
      }
    };

    const nn = (v) => {
      const x = nv(v);
      if (Number.isNaN(x)) throw new LispError('bad argument type: numberp: ' + toStr(v, true));
      return x;
    };

    const point3 = (v) => {
      if (!Array.isArray(v) || v.length < 2)
        throw new LispError('bad argument type: point: ' + toStr(v, true));
      return { x: nn(v[0]), y: nn(v[1]), z: v.length > 2 ? nn(v[2]) : 0 };
    };

    const pos = (v, what) => {
      const x = nn(v);
      if (!(x > 0)) throw new LispError(`${what} must be greater than zero`);
      return x;
    };

    const bb3 = (s) => {
      const b = s.boundingBox.bounds;
      return { x0: b[0][0], y0: b[0][1], z0: b[0][2], x1: b[1][0], y1: b[1][1], z1: b[1][2] };
    };

    const newSolid = (shape, like, src) => {
      const e = app.doc.stamp(
        E.mk('solid3d', { ...K.solidProps(shape), bb: bb3(shape), ...(src ? { src } : {}) }),
      );
      if (like) {
        e.layer = like.layer;
        e.color = like.color;
        e.ltype = like.ltype;
        e.lw = like.lw;
      }
      app.doc.add(e, spaceOf());
      E.bump();
      app.emit('doc');
      app.redraw();
      return enameOf(e);
    };

    const solidArg = (en) => {
      const f = findEnt(en);
      if (!f) throw new LispError('entity not found');
      if (f.e.type !== 'solid3d')
        throw new LispError('bad argument type: 3D solid: ' + toStr(en, true));
      return f;
    };

    const consume = (...fs) => {
      for (const f of fs) app.doc.remove([f.e.id], f.space);
    };

    const occ = (what, fn) => {
      try {
        return fn();
      } catch (err) {
        throw new LispError(
          `${what}: ${err.message || 'the operation failed (is the value too large for this solid?)'}`,
        );
      }
    };

    D('box3d', async (p, w, d, h) => {
      await kernel3();
      const o = point3(p);
      const W = pos(w, 'width');
      const Dd = pos(d, 'depth');
      const H = pos(h, 'height');
      const loop = [
        { x: o.x, y: o.y, b: 0 },
        { x: o.x + W, y: o.y, b: 0 },
        { x: o.x + W, y: o.y + Dd, b: 0 },
        { x: o.x, y: o.y + Dd, b: 0 },
      ];
      return newSolid(K.makeBox(W, Dd, H, o.x, o.y, o.z), null, {
        kind: 'prism',
        loops: [loop],
        z0: o.z,
        h: H,
        taper: 0,
      });
    });

    D('cylinder3d', async (p, r, h) => {
      await kernel3();
      const o = point3(p);
      return newSolid(K.makeCylinder(pos(r, 'radius'), pos(h, 'height'), o.x, o.y, o.z));
    });

    D('sphere3d', async (p, r) => {
      await kernel3();
      const o = point3(p);
      return newSolid(K.makeSphere(pos(r, 'radius'), o.x, o.y, o.z));
    });

    D('cone3d', async (p, r1, r2, h) => {
      await kernel3();
      const o = point3(p);
      const a = nn(r1);
      const b = nn(r2);
      if (a < 0 || b < 0 || a + b <= 0) throw new LispError('radius must not be negative');
      return newSolid(K.makeCone(a, b, pos(h, 'height'), o.x, o.y, o.z));
    });

    D('torus3d', async (p, R1, r) => {
      await kernel3();
      const o = point3(p);
      const a = pos(R1, 'radius');
      const b = pos(r, 'tube radius');
      if (b >= a) throw new LispError('tube radius must be smaller than the torus radius');
      return newSolid(K.makeTorus(a, b, o.x, o.y, o.z));
    });

    D('extrude3d', async (en, h, taper) => {
      // closed 2D object -> solid (the 2D object is consumed, like EXTRUDE)
      await kernel3();
      const f = findEnt(en);
      if (!f) throw new LispError('entity not found');
      const e = f.e;
      const H = nn(h);
      let pts;
      if (e.type === 'circle')
        pts = [
          { x: e.c.x - e.r, y: e.c.y, b: 1 },
          { x: e.c.x + e.r, y: e.c.y, b: 1 },
        ];
      else if (e.type === 'pline' && e.closed)
        pts = e.pts.map((q) => ({ x: q.x, y: q.y, b: q.b || 0 }));
      else {
        const loop = E.isClosed(e) && E.closedLoop(e);
        if (!loop)
          throw new LispError(
            'extrude3d needs a closed object (circle, closed polyline, rectangle, ...)',
          );
        pts = loop.map((q) => ({ x: q.x, y: q.y, b: 0 }));
      }
      const tp = taper === undefined || taper === null ? 0 : nn(taper);
      const z0 = H < 0 ? H : 0;
      const sh = occ('extrude3d', () => {
        let s = K.extrudeSketch(K.profileToSketch([pts], 0), Math.abs(H), tp);
        if (H < 0) s = s.translate(0, 0, H);
        return s;
      });
      const res = newSolid(sh, e, { kind: 'prism', loops: [pts], z0, h: Math.abs(H), taper: tp });
      consume(f);
      return res;
    });

    const dressAll = (what, fnName) => async (en, v) => {
      await kernel3();
      const f = solidArg(en);
      const val = pos(v, what);
      const sh = occ(fnName + '3d', () =>
        K.dressEdges(
          f.e,
          fnName,
          val,
          E.solidEdges(f.e).map((x) => x.id),
          true,
        ),
      );
      const res = newSolid(sh, f.e);
      consume(f);
      return res;
    };

    D('round3d', dressAll('radius', 'fillet'));
    // rounds ALL edges, returns the new entity name
    D('chamfer3d', dressAll('distance', 'chamfer'));
    // chamfers ALL edges
    const boolean = (name, fn) =>
      D(name, async (...ens) => {
        await kernel3();
        if (ens.length < 2) throw new LispError(`${name} needs at least two solids`);
        const fs = ens.map(solidArg);
        const sh = occ(name, () =>
          fs.slice(1).reduce((acc, f) => fn(acc, K.bakedShape(f.e)), K.bakedShape(fs[0].e)),
        );
        const res = newSolid(sh, fs[0].e);
        consume(...fs);
        return res;
      });

    boolean('union3d', (a, b) => K.fuse(a, b));

    boolean('subtract3d', (a, b) => K.cut(a, b));

    boolean('intersect3d', (a, b) => K.common(a, b));

    D('move3d', async (en, dx, dy, dz) => {
      const f = solidArg(en);
      (f.e.ops ||= []).push({ t: 'T', v: [nn(dx), nn(dy), nn(dz)] });
      f.e._edgesKey = null;
      E.bump();
      app.emit('doc');
      app.redraw();
      return en;
    });

    D('volume3d', async (en) => {
      await kernel3();
      return R(K.volume(K.bakedShape(solidArg(en).e)));
    });

    D('draft3d', async (en, deg) => {
      // taper every side face of a box / extrusion by deg degrees (positive = inward toward the top)
      await kernel3();
      const f = solidArg(en);
      const s = f.e.src;
      if (!s || s.kind !== 'prism')
        throw new LispError('draft3d works on solids made by box3d / extrude3d');
      const ang = nn(deg);
      const res = newSolid(
        occ('draft3d', () => K.draftPrism(s.loops, s.z0, s.h, ang)),
        f.e,
        { ...s, taper: ang, angles: s.loops.map((l) => l.map(() => ang)) },
      );
      const nf = findEnt(res);
      nf.e.ops = JSON.parse(JSON.stringify(f.e.ops || []));
      consume(f);
      return res;
    });

    function applyCodes(e, items) {
      const layoutPts = [];
      for (const it of items) {
        const [c, v] = codeOf(it);
        switch (c) {
          case 8:
            e.layer = String(v);
            if (!app.doc.hasLayer(e.layer)) app.doc.addLayer(e.layer);
            break;
          case 62:
            e.color = v === 256 ? null : v === 0 ? 'bb' : v < 0 ? Math.abs(v) : v;
            break;
          case 6:
            e.ltype = /^bylayer$/i.test(v) ? null : /^byblock$/i.test(v) ? 'bb' : String(v);
            break;
          case 370:
            e.lw = v === -1 ? null : v === -2 ? 'bb' : v === -3 ? 0.25 : v / 100;
            break;
          case 48:
            e.ltscale = nv(v);
            break;
          default:
            break;
        }
        void layoutPts;
      }
      const get = (c) => {
        const f = items.find((it) => codeOf(it)[0] === c);
        return f ? codeOf(f)[1] : undefined;
      };
      const all = (c) => items.filter((it) => codeOf(it)[0] === c).map((it) => codeOf(it)[1]);
      switch (e.type) {
        case 'line':
          if (get(10)) e.p1 = ptOf(get(10));
          if (get(11)) e.p2 = ptOf(get(11));
          break;
        case 'circle':
          if (get(10)) e.c = ptOf(get(10));
          if (get(40) !== undefined) e.r = nv(get(40));
          break;
        case 'arc':
          if (get(10)) e.c = ptOf(get(10));
          if (get(40) !== undefined) e.r = nv(get(40));
          if (get(50) !== undefined) e.a0 = nv(get(50));
          if (get(51) !== undefined) e.a1 = nv(get(51));
          break;
        case 'point':
          if (get(10)) e.p = ptOf(get(10));
          break;
        case 'text':
          if (get(10)) e.p = ptOf(get(10));
          if (get(40) !== undefined) e.h = nv(get(40));
          if (get(1) !== undefined) e.str = String(get(1));
          if (get(50) !== undefined) e.rot = nv(get(50));
          if (get(7)) e.style = get(7);
          if (get(72) !== undefined)
            e.al = get(72) === 1 || get(72) === 4 ? 1 : get(72) === 2 ? 2 : 0;
          if (get(41) !== undefined) e.wf = nv(get(41));
          if (get(51) !== undefined) e.obl = G.deg(nv(get(51)));
          break;
        case 'mtext':
          if (get(10)) e.p = ptOf(get(10));
          if (get(40) !== undefined) e.h = nv(get(40));
          if (get(41) !== undefined) e.w = nv(get(41));
          if (get(1) !== undefined) e.str = String(get(1)).replace(/\\P/g, '\n');
          if (get(50) !== undefined) e.rot = nv(get(50));
          if (get(71)) e.att = get(71);
          if (get(7)) e.style = get(7);
          break;
        case 'insert':
          if (get(2)) e.name = get(2);
          if (get(10)) e.p = ptOf(get(10));
          if (get(41) !== undefined) e.sx = nv(get(41));
          if (get(42) !== undefined) e.sy = nv(get(42));
          if (get(50) !== undefined) e.rot = nv(get(50));
          break;
        case 'pline': {
          const pts = [];
          let last = null;
          for (const it of items) {
            const [c, v] = codeOf(it);
            if (c === 10) {
              last = { x: nv(v[0]), y: nv(v[1]), b: 0 };
              pts.push(last);
            } else if (c === 42 && last) last.b = nv(v);
          }
          if (pts.length) e.pts = pts;
          if (get(70) !== undefined) e.closed = !!(get(70) & 1);
          break;
        }
        case 'ellipse':
          if (get(10)) {
            e.c = ptOf(get(10));
          }
          if (get(11)) {
            const u = ptOf(get(11));
            const ratio =
              get(40) !== undefined ? nv(get(40)) : E.ellipseAxes(e).b / E.ellipseAxes(e).a;
            e.u = u;
            e.v = G.mul(G.perp(u), ratio);
          }
          if (get(41) !== undefined) e.a0 = nv(get(41));
          if (get(42) !== undefined) e.a1 = nv(get(42));
          break;
        case 'xline':
        case 'ray':
          if (get(10)) e.p = ptOf(get(10));
          if (get(11)) e.dir = G.norm(ptOf(get(11)));
          break;
        case 'spline': {
          const f = all(11);
          if (f.length) e.pts = f.map(ptOf);
          break;
        }
        case 'hatch':
          if (get(2)) e.pattern = get(2);
          if (get(41) !== undefined) e.scale = nv(get(41));
          if (get(52) !== undefined) e.angle = nv(get(52));
          break;
        default:
          break;
      }
    }

    D('entmod', (alist) => {
      const items = Array.isArray(alist) ? alist : [];
      const nm = items.map(codeOf).find(([c]) => c === -1);
      if (!nm) return null;
      const f = findEnt(nm[1]);
      if (!f) return null;
      applyCodes(f.e, items);
      app.changed();
      return alist;
    });

    const MAKE = {
      LINE: 'line',
      CIRCLE: 'circle',
      ARC: 'arc',
      POINT: 'point',
      TEXT: 'text',
      MTEXT: 'mtext',
      LWPOLYLINE: 'pline',
      INSERT: 'insert',
      ELLIPSE: 'ellipse',
      XLINE: 'xline',
      RAY: 'ray',
      SPLINE: 'spline',
      HATCH: 'hatch',
    };

    let blockDef = null;

    D('entmake', (alist) => {
      const items = Array.isArray(alist) ? alist : [];
      const cs = items.map(codeOf);
      const t0 = cs.find(([c]) => c === 0);
      if (!t0) return null;
      const type = String(t0[1]).toUpperCase();
      const g = (c) => {
        const f = cs.find(([k]) => k === c);
        return f ? f[1] : undefined;
      };
      if (type === 'LAYER') {
        const n = g(2);
        if (!n) return null;
        app.doc.addLayer(n, {
          color: Math.abs(g(62) ?? 7),
          ltype: g(6) || 'Continuous',
          frozen: !!((g(70) ?? 0) & 1),
          locked: !!((g(70) ?? 0) & 4),
        });
        app.emit('doc');
        return alist;
      }
      if (type === 'STYLE') {
        const n = g(2);
        if (n) {
          app.doc.textStyles[n] = {
            font: g(3) || 'Arial',
            wf: g(41) ? nv(g(41)) : 1,
            obl: g(50) ? nv(g(50)) : 0,
            h: g(40) ? nv(g(40)) : 0,
          };
          app.emit('doc');
          return alist;
        }
        return null;
      }
      if (type === 'BLOCK') {
        blockDef = { name: g(2), base: ptOf(g(10)) || { x: 0, y: 0 }, ents: [] };
        return alist;
      }
      if (type === 'ENDBLK') {
        if (!blockDef) return null;
        app.doc.defineBlock(blockDef.name, blockDef.base, blockDef.ents);
        blockDef = null;
        return alist;
      }
      const kind = MAKE[type];
      if (!kind) return null;
      const defaults = {
        line: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } },
        circle: { c: { x: 0, y: 0 }, r: 1 },
        arc: { c: { x: 0, y: 0 }, r: 1, a0: 0, a1: Math.PI },
        point: { p: { x: 0, y: 0 } },
        text: { p: { x: 0, y: 0 }, h: 2.5, str: '', rot: 0, style: app.doc.curTextStyle, al: 0 },
        mtext: {
          p: { x: 0, y: 0 },
          h: 2.5,
          str: '',
          rot: 0,
          w: 0,
          style: app.doc.curTextStyle,
          al: 0,
        },
        pline: { pts: [], closed: false },
        insert: { name: '', p: { x: 0, y: 0 }, rot: 0, sx: 1, sy: 1 },
        ellipse: { c: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, a0: 0, a1: G.TAU },
        xline: { p: { x: 0, y: 0 }, dir: { x: 1, y: 0 } },
        ray: { p: { x: 0, y: 0 }, dir: { x: 1, y: 0 } },
        spline: { pts: [], closed: false },
        hatch: { loops: [], pattern: 'SOLID', scale: 1, angle: 0 },
      };
      const e = app.doc.stamp(E.mk(kind, JSON.parse(JSON.stringify(defaults[kind]))));
      if (kind === 'text' || kind === 'mtext') e.style = app.doc.curTextStyle;
      applyCodes(e, items);
      if (kind === 'pline' && e.pts.length < 2) return null;
      if (blockDef) blockDef.ents.push(e);
      else {
        app.doc.add(e, spaceOf());
        app.changed();
      }
      return alist;
    });
  }

  /** @private Selection: entsel, nentsel, ssget, ssadd, ssdel, sslength, ssname, ssmemb, ... */
  selectionFunctions() {
    const {
      L,
      app,
      D,
      takeInit,
      promptText,
      wrapCancel,
      kwOpts,
      handleNull,
      spaceOf,
      enameOf,
      findEnt,
      toAlist,
      codeOf,
      ptOf,
    } = this;

    D('entsel', async (p) => {
      const i = takeInit();
      const r = await wrapCancel(app.pick(promptText(p) || 'Select object', kwOpts(i)));
      if (r === null) return handleNull(i);
      if (typeof r === 'string') return r;
      return [enameOf(r.e), P3(r.p)];
    });

    L.set('NENTSEL', L.get('ENTSEL'));

    D('nentsel', async (p) => L.get('ENTSEL').fn(p));

    D('nentselp', async (p) => L.get('ENTSEL').fn(p));

    const entMatch = (e, filter, space) => {
      const al = toAlist(e, space).map(codeOf);
      const test = (pairs) => {
        // pairs: list of [code, value]; handles -4 operators <or <and <not <xor and relational
        const stack = [{ op: 'and', items: [] }];
        let rel = '=';
        for (const [c, v] of pairs) {
          if (c === -4) {
            const s = String(v).toLowerCase();
            if (s === '<or' || s === '<and' || s === '<not' || s === '<xor')
              stack.push({ op: s.slice(1), items: [] });
            else if (s === 'or>' || s === 'and>' || s === 'not>' || s === 'xor>') {
              const grp = stack.pop();
              const r =
                grp.op === 'or'
                  ? grp.items.some(Boolean)
                  : grp.op === 'and'
                    ? grp.items.every(Boolean)
                    : grp.op === 'not'
                      ? !grp.items.every(Boolean)
                      : grp.items.filter(Boolean).length % 2 === 1;
              stack[stack.length - 1].items.push(r);
            } else rel = s;
            continue;
          }
          const hits = al.filter(([k]) => k === c);
          let ok = false;
          for (const [, val] of hits) {
            if (typeof v === 'string') {
              ok = wc(String(val), v);
            } else if (isNum(v)) {
              const a = nv(val);
              const b = nv(v);
              ok =
                rel === '=' || rel === '=='
                  ? Math.abs(a - b) < 1e-9
                  : rel === '>'
                    ? a > b
                    : rel === '<'
                      ? a < b
                      : rel === '>='
                        ? a >= b
                        : rel === '<='
                          ? a <= b
                          : rel === '/=' || rel === '!='
                            ? a !== b
                            : false;
            } else if (Array.isArray(v)) {
              ok =
                Array.isArray(val) &&
                val.every((x, ix) => ix >= v.length || Math.abs(nv(x) - nv(v[ix])) < 1e-6);
            }
            if (ok) break;
          }
          if (!hits.length && c === 62 && v === 256) ok = true;
          stack[stack.length - 1].items.push(ok);
          rel = '=';
        }
        return stack[0].items.every(Boolean);
      };
      return test(filter);
    };

    const wc = (s, pat) => {
      const r = L.get('WCMATCH');
      void r;
      return pat.split(',').some((p) => {
        let neg = false;
        if (p[0] === '~') {
          neg = true;
          p = p.slice(1);
        }
        const re = new RegExp(
          '^' +
            p
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.')
              .replace(/#/g, '\\d')
              .replace(/@/g, '[A-Za-z]') +
            '$',
          'i',
        );
        const m = re.test(s);
        return neg ? !m : m;
      });
    };

    const filterPairs = (f) => (Array.isArray(f) ? f.map(codeOf) : []);

    const inPoly = (poly, p) => G.pointInPoly(p, poly);

    const polySel = (poly, crossing, space) =>
      app.doc.spaceList(space).filter((e) => {
        if (!app.selectable(e)) return false;
        const b = E.bbox(e, app.doc);
        if (!b) return false;
        const corners = [
          { x: b.x0, y: b.y0 },
          { x: b.x1, y: b.y0 },
          { x: b.x1, y: b.y1 },
          { x: b.x0, y: b.y1 },
        ];
        if (!crossing) return corners.every((c) => inPoly(poly, c));
        if (corners.some((c) => inPoly(poly, c))) return true;
        if (poly.some((p) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1)) return true;
        for (const P of E.prims(e, app.doc))
          if (P.k === 's')
            for (let i = 0; i < poly.length; i += 1) {
              const h = G.lineLine(P.a, P.b, poly[i], poly[(i + 1) % poly.length]);
              if (h && h.t >= 0 && h.t <= 1 && h.u >= 0 && h.u <= 1) return true;
            }
        return false;
      });

    D('ssget', async (a, b, c, d) => {
      const filter = (x) => {
        if (x === undefined || x === null) return [];
        return filterPairs(x);
      };
      let mode = typeof a === 'string' ? a.toUpperCase() : null;
      const space = spaceOf();
      let ents = null;
      let flt = [];
      const ok = (e) =>
        app.selectable(e) && !E.TYPE_NAMES.__no && (!flt.length || entMatch(e, flt, space));
      if (mode === null) {
        // interactive
        flt = filter(typeof a === 'string' || a === null || a === undefined ? b : a);
        const prompt = typeof b === 'string' ? b : 'Select objects';
        const sel = await wrapCancel(app.select(prompt, { pre: false, filter: (e) => ok(e) }));
        return sel.length
          ? new PickSet(
              sel.map((e) => e.id),
              space,
            )
          : null;
      }
      mode = mode.replace(/^_/, '');
      if (mode === 'X') {
        flt = filter(b);
        ents = app.doc.spaceList(space).filter(ok);
      } else if (mode === 'W' || mode === 'C') {
        flt = filter(d);
        const p1 = ptOf(b);
        const p2 = ptOf(c);
        ents = app.inRect(p1, p2, mode === 'C').filter(ok);
      } else if (mode === 'WP' || mode === 'CP') {
        flt = filter(d || c);
        const poly = (Array.isArray(b) ? b : []).map(ptOf);
        ents = polySel(poly, mode === 'CP', space).filter(ok);
      } else if (mode === 'F') {
        flt = filter(d || c);
        const poly = (Array.isArray(b) ? b : []).map(ptOf);
        ents = app.doc.spaceList(space).filter(
          (e) =>
            app.selectable(e) &&
            ok(e) &&
            E.prims(e, app.doc).some(
              (P) =>
                P.k === 's' &&
                poly.slice(0, -1).some((p, i) => {
                  const h = G.lineLine(P.a, P.b, p, poly[i + 1]);
                  return h && h.t >= 0 && h.t <= 1 && h.u >= 0 && h.u <= 1;
                }),
            ),
        );
      } else if (mode === 'L') {
        const l = app.doc.spaceList(space).filter((e) => app.selectable(e));
        ents = l.length ? [l[l.length - 1]] : [];
      } else if (mode === 'P') {
        const ids = new Set(app.prevSel.map((e) => e.id));
        ents = app.doc.spaceList(space).filter((e) => ids.has(e.id));
      } else if (mode === 'I') {
        ents = app.selectedEnts();
      } else if (mode === ':S' || mode === ':E' || mode === ':L') {
        const prompt = typeof b === 'string' ? b : 'Select object';
        const r = await wrapCancel(app.pick(prompt, {}));
        ents = r && r.e ? [r.e] : [];
      } else if (mode === '') {
        ents = [];
      } else return null;
      return ents && ents.length
        ? new PickSet(
            ents.map((e) => e.id),
            space,
          )
        : null;
    });

    D('ssadd', (en, ss) => {
      const base = ss instanceof PickSet ? ss : new PickSet([], spaceOf());
      if (en instanceof EName && findEnt(en) && !base.ids.includes(en.id)) base.ids.push(en.id);
      return base;
    });

    D('ssdel', (en, ss) => {
      if (!(ss instanceof PickSet)) return null;
      const i = ss.ids.indexOf(en.id);
      if (i < 0) return null;
      ss.ids.splice(i, 1);
      return ss;
    });

    D('sslength', (ss) => (ss instanceof PickSet ? ss.ids.length : 0));

    D('ssname', (ss, i) =>
      ss instanceof PickSet && i >= 0 && i < ss.ids.length ? new EName(ss.ids[i], ss.space) : null,
    );

    D('ssmemb', (en, ss) => (ss instanceof PickSet && ss.ids.includes(en.id) ? en : null));

    D('sssetfirst', (g, ss) => {
      if (ss instanceof PickSet) {
        app.setSel(app.curEnts().filter((e) => ss.ids.includes(e.id)));
      }
      return ss || null;
    });

    D('ssgetfirst', () => (app.sel.size ? [null, new PickSet([...app.sel], spaceOf())] : null));

    D('ssnamex', () => null);

    D('ssfree', () => null);
  }

  /** @private Symbol tables: tblsearch, tblnext, tblobjname and the layer / style / block tables. */
  symbolTables() {
    const { app, D, pr } = this;

    const table = (name) => {
      const n = String(name).toUpperCase();
      const d = app.doc;
      if (n === 'LAYER')
        return d.layers.map((l) => [
          pr(0, 'LAYER'),
          pr(2, l.name),
          pr(70, dxfLayerFlags(l)),
          pr(62, l.on ? l.color : -Math.abs(l.color)),
          pr(6, l.ltype),
        ]);
      if (n === 'LTYPE')
        return Object.keys(d.ltypes).map((k) => [
          pr(0, 'LTYPE'),
          pr(2, k),
          pr(70, 0),
          pr(3, k),
          pr(73, d.ltypes[k].length),
        ]);
      if (n === 'STYLE')
        return Object.entries(d.textStyles).map(([k, s]) => [
          pr(0, 'STYLE'),
          pr(2, k),
          pr(70, 0),
          pr(40, R(s.h || 0)),
          pr(41, R(s.wf || 1)),
          pr(50, R(G.rad(s.obl || 0))),
          pr(3, s.font),
        ]);
      if (n === 'BLOCK')
        return Object.keys(d.blocks).map((k) => [
          pr(0, 'BLOCK'),
          pr(2, k),
          pr(70, 0),
          [10, ...P3(d.blocks[k].base)],
        ]);
      if (n === 'DIMSTYLE')
        return Object.keys(d.dimStyles).map((k) => [pr(0, 'DIMSTYLE'), pr(2, k), pr(70, 0)]);
      if (n === 'VIEW' || n === 'UCS' || n === 'VPORT' || n === 'APPID') return [];
      return null;
    };

    const tblIter = {};

    D('tblsearch', (t, name) => {
      const rows = table(t);
      if (!rows) return null;
      return (
        rows.find((r) => String(r[1].cdr).toLowerCase() === String(name).toLowerCase()) || null
      );
    });

    D('tblnext', (t, first) => {
      const rows = table(t);
      if (!rows) return null;
      const k = String(t).toUpperCase();
      if (first !== undefined && first !== null) tblIter[k] = 0;
      const i = tblIter[k] ?? 0;
      tblIter[k] = i + 1;
      return rows[i] || null;
    });

    D('tblobjname', (t, name) => null && t && name);

    D('namedobjdict', () => null);

    D('dictsearch', () => null);

    D('dictnext', () => null);

    D('xdroom', () => 16000);

    D('xdsize', () => 0);
  }

  /** @private The `command` function: feeds arguments to a running command. */
  commandFunction() {
    const { app, D, findEnt } = this;

    const fmtNum = (v) => String(+nv(v).toPrecision(15));

    const feed = async (a) => {
      const r = app.req;
      if (typeof a === 'string') {
        if (a === '\\') {
          await app.waitSettled(true);
          return;
        }
        app.handleTyped(a);
        return;
      }
      if (isNum(a)) {
        app.handleTyped(fmtNum(a));
        return;
      }
      if (a === null) {
        app.handleTyped('');
        return;
      }
      if (Array.isArray(a)) {
        const p = pt(a);
        if (r && r.type === 'select') {
          const e = app.pickAt({ x: p.x, y: p.y });
          if (e) app.addToSel([e]);
          else app.echo('No object found at that point.');
          return;
        }
        if (r && r.type === 'pick') {
          const e = app.pickAt({ x: p.x, y: p.y }, undefined, r.opts.filter);
          if (e) app.finish({ e, p: { x: p.x, y: p.y } });
          else app.echo('No object found at that point.');
          return;
        }
        app.handleTyped(a.length > 2 ? `${p.x},${p.y},${p.z}` : `${p.x},${p.y}`);
        return;
      }
      if (a instanceof EName) {
        const f = findEnt(a);
        if (!f) throw new LispError('invalid entity name');
        if (r && r.type === 'select') {
          app.addToSel([f.e]);
          return;
        }
        if (r && r.type === 'pick') {
          const b = E.bbox(f.e, app.doc);
          app.finish({
            e: f.e,
            p: b ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } : { x: 0, y: 0 },
          });
          return;
        }
        throw new LispError('entity name is not valid input here');
      }
      if (a instanceof PickSet) {
        if (r && r.type === 'select') {
          app.addToSel(app.curEnts().filter((e) => a.ids.includes(e.id)));
          return;
        }
        throw new LispError('selection set is not valid input here');
      }
      throw new LispError('bad argument type for command: ' + toStr(a, true));
    };

    const commandFn = async (...args) => {
      if (!args.length) return null;
      let nested = null;
      const norm = (s) => s.replace(/^[._]+/, '').toUpperCase();
      for (const a of args) {
        if (typeof a === 'string' && (!nested || nested.done) && a !== '' && a !== '\\') {
          const raw = norm(a);
          const name = ALIASES[raw.toLowerCase()] || raw;
          if (!COMMANDS[name] && !COMMANDS[raw])
            throw new LispError(`Unknown command "${a.toUpperCase()}"`);
          nested = app.runNested(COMMANDS[name] ? name : raw);
          await app.waitSettled();
          continue;
        }
        if (!nested || nested.done) {
          if (a === '' || a === null) continue;
          throw new LispError('no active command to receive input');
        }
        await feed(a);
        await app.waitSettled();
        if (nested.cancelled) throw new LispError('Function cancelled');
      }
      if (nested && nested.cancelled) throw new LispError('Function cancelled');
      return null;
    };

    D('command', commandFn);

    D('command-s', commandFn);

    D('vl-cmdf', async (...a) => {
      await commandFn(...a);
      return T;
    });

    D('princ-dummy', () => null);
  }

  /** @private Miscellaneous CAD functions (redraw, getvar, setvar, osnap, trans, ...). */
  miscFunctions() {
    const { app, D } = this;

    D('redraw', () => {
      app.temp = [];
      app.lispOverlay = [];
      app.redraw();
      return null;
    });

    D('grdraw', (a, b, col) => {
      (app.lispOverlay ||= []).push({ a: pt(a), b: pt(b), col });
      app.redraw();
      return null;
    });

    D('grtext', () => null);

    D('grvecs', () => null);

    D('menucmd', () => null);

    D('menugroup', () => null);

    D('getfiled', async (title, def, ext, flags) => {
      const save = (flags & 1) !== 0;
      if (!app.api) return null;
      const r = save
        ? await app.api.saveFile({
            path: null,
            defaultName: def || 'file',
            data: null,
            filters: [{ name: ext || 'all', extensions: [ext || '*'] }],
            dryRun: true,
          })
        : await app.api.openFile({
            filters: [{ name: title || 'File', extensions: [ext || '*'] }],
          });
      return r && (r.path || r) ? r.path || r : null;
    });

    D('findfile', async (n) => {
      const r = await app.fs.find(String(n));
      return r;
    });

    D('acad_colordlg', async (c) => {
      const r = await app.ui.colorDialog(typeof c === 'number' ? c : 7);
      return r === undefined || r === null ? null : typeof r === 'number' ? r : 0;
    });

    D('acad_truecolordlg', async () => null);

    D('acad_helpdlg', () => null);

    D('setview', () => null);

    D('viewres', () => null);

    D('regapp', () => 1);

    D('tablet', () => null);

    D('vports', () => null);

    D('princ-to-bb', () => null);

    D('dumpallproperties', () => null);
  }

  /** @private File I/O: open, close, read-line, write-line, findfile, getfiled ... */
  fileIo() {
    const { L, app, D } = this;

    // file I/O
    D('open', async (name, mode) => {
      const m = String(mode).toLowerCase();
      const text = m === 'r' || m === 'a' ? await app.fs.readText(String(name)) : '';
      if (m === 'r' && text === null) return null;
      const f = new LFile(String(name), m, text || '');
      return f;
    });

    D('close', async (f) => {
      if (f instanceof LFile && !f.closed) {
        f.closed = true;
        if (f.mode !== 'r') await app.fs.writeText(f.name, f.text);
      }
      return null;
    });

    D('read-line', (f) => {
      if (!(f instanceof LFile) || f.pos >= f.text.length) return null;
      let k = f.text.indexOf('\n', f.pos);
      if (k < 0) k = f.text.length;
      const line = f.text.slice(f.pos, k).replace(/\r$/, '');
      f.pos = k + 1;
      return line;
    });

    D('read-char', (f) => {
      if (!(f instanceof LFile) || f.pos >= f.text.length) return null;
      return f.text.charCodeAt(f.pos++);
    });

    const baseWriteLine = L.get('WRITE-LINE').fn;
    const baseWriteChar = L.get('WRITE-CHAR').fn;
    const basePrinc = L.get('PRINC').fn;
    const basePrin1 = L.get('PRIN1').fn;
    const basePrint = L.get('PRINT').fn;

    D('write-line', (s, f) => {
      if (f instanceof LFile) {
        f.text += toStr(s) + '\n';
        return s;
      }
      return baseWriteLine(s);
    });

    D('write-char', (c, f) => {
      if (f instanceof LFile) {
        f.text += String.fromCharCode(c);
        return c;
      }
      return baseWriteChar(c);
    });

    D('princ', (x, f) => {
      if (f instanceof LFile) {
        f.text += toStr(x);
        return x;
      }
      return basePrinc(x);
    });

    D('prin1', (x, f) => {
      if (f instanceof LFile) {
        f.text += toStr(x, true);
        return x;
      }
      return basePrin1(x);
    });

    D('print', (x, f) => {
      if (f instanceof LFile) {
        f.text += '\n' + toStr(x, true) + ' ';
        return x;
      }
      return basePrint(x);
    });

    D('vl-file-delete', async (n) => toBool(await app.fs.remove(String(n))));

    D('vl-file-size', async (n) => {
      const t = await app.fs.readText(String(n));
      return t === null ? null : t.length;
    });

    D('vl-mkdir', () => null);

    D('vl-directory-files', async () => null);

    D('vl-file-directory-p', () => null);
  }

  /** @private vlax-curve functions: length, point at distance, closest point, ... */
  curveFunctions() {
    const { app, D, findEnt } = this;

    const curvePrims = (en) => {
      const f = findEnt(en);
      if (!f) throw new LispError('invalid entity name');
      return { e: f.e, prims: E.prims(f.e, app.doc) };
    };

    const lens = (ps) => ps.map(O.primLength);

    const atDist = (ps, d) => {
      let acc = 0;
      for (const P of ps) {
        const l = O.primLength(P);
        if (d <= acc + l + 1e-9) {
          const f = l ? Math.max(0, Math.min(1, (d - acc) / l)) : 0;
          if (P.k === 's') return G.lerp(P.a, P.b, f);
          const sw = G.sweep(P.a0, P.a1) || G.TAU;
          return G.polar(P.c, P.rev ? P.a1 - sw * f : P.a0 + sw * f, P.r);
        }
        acc += l;
      }
      const last = ps[ps.length - 1];
      return G.primEnd(last);
    };

    const distAtPoint = (ps, p) => {
      let best = null;
      let acc = 0;
      for (const P of ps) {
        const q = G.nearestOnPrim(P, p);
        const f = O.primParam(P, q.p);
        const l = O.primLength(P);
        const d = acc + Math.max(0, Math.min(1, f)) * l;
        if (!best || q.d < best.dd) best = { dd: q.d, d, p: q.p };
        acc += l;
      }
      return best;
    };

    D('vlax-curve-getstartpoint', (en) => {
      const { prims } = curvePrims(en);
      return P3(G.primStart(prims[0]));
    });

    D('vlax-curve-getendpoint', (en) => {
      const { prims } = curvePrims(en);
      return P3(G.primEnd(prims[prims.length - 1]));
    });

    D('vlax-curve-getclosestpointto', (en, p) => {
      const { prims } = curvePrims(en);
      return P3(distAtPoint(prims, pt(p)).p);
    });

    D('vlax-curve-getdistatpoint', (en, p) => {
      const { prims } = curvePrims(en);
      return R(distAtPoint(prims, pt(p)).d);
    });

    D('vlax-curve-getpointatdist', (en, d) => {
      const { prims } = curvePrims(en);
      return P3(atDist(prims, nv(d)));
    });

    D('vlax-curve-getparamatpoint', (en, p) => {
      const { prims } = curvePrims(en);
      return R(distAtPoint(prims, pt(p)).d);
    });

    D('vlax-curve-getpointatparam', (en, d) => {
      const { prims } = curvePrims(en);
      return P3(atDist(prims, nv(d)));
    });

    D('vlax-curve-getdistatparam', (en, d) => R(nv(d)));

    D('vlax-curve-getstartparam', () => R(0));

    D('vlax-curve-getendparam', (en) => {
      const { prims } = curvePrims(en);
      return R(lens(prims).reduce((a, b) => a + b, 0));
    });

    D('vlax-curve-isclosed', (en) => toBool(E.isClosed(curvePrims(en).e)));

    D('vlax-curve-getarea', (en) => R(E.entArea(curvePrims(en).e)));
  }

  /** @private vla- / vlax- property access on entity proxies (layers, objects, curves). */
  vlaFunctions() {
    const { L, app, D, spaceOf, colorOut, lwOut, findEnt } = this;

    class Vla {
      constructor(en) {
        this.en = en;
      }
    }

    D('vlax-ename->vla-object', (en) => new Vla(en));

    D('vlax-vla-object->ename', (o) => (o instanceof Vla ? o.en : null));

    D('vlax-get-acad-object', () => new Vla('acad'));

    D('vla-get-activedocument', () => new Vla('doc'));

    D('vla-get-modelspace', () => new Vla('modelspace'));

    D('vlax-release-object', () => null);

    D('vlax-object-released-p', () => null);

    D('vlax-erased-p', (o) => {
      try {
        return toBool(!findEnt(o.en));
      } catch {
        return T;
      }
    });

    D('vlax-property-available-p', () => T);

    D('vlax-method-applicable-p', () => T);

    D('vlax-make-variant', (v) => v);

    D('vlax-variant-value', (v) => v);

    D('vlax-variant-type', () => 8);

    D('vlax-safearray->list', (v) => v);

    D('vlax-make-safearray', () => null);

    D('vlax-3d-point', (...a) => (a.length === 1 ? a[0] : a.map(R)));

    D('vlax-list->safearray', (l) => l);

    D('vlax-safearray-fill', (a, l) => l);

    D('vlax-dump-object', () => null);

    const PROPS = {
      LAYER: [
        (e) => e.layer,
        (e, v) => {
          e.layer = String(v);
          if (!app.doc.hasLayer(e.layer)) app.doc.addLayer(e.layer);
        },
      ],
      COLOR: [
        (e) => colorOut(e.color),
        (e, v) => {
          e.color = v === 256 ? null : v === 0 ? 'bb' : v;
        },
      ],
      LINETYPE: [
        (e) => e.ltype || 'ByLayer',
        (e, v) => {
          e.ltype = /^bylayer$/i.test(v) ? null : String(v);
        },
      ],
      LINEWEIGHT: [
        (e) => lwOut(e.lw),
        (e, v) => {
          e.lw = v === -1 ? null : v / 100;
        },
      ],
      LINETYPESCALE: [
        (e) => R(e.ltscale || 1),
        (e, v) => {
          e.ltscale = nv(v);
        },
      ],
      OBJECTNAME: [
        (e) =>
          'AcDb' +
          ({
            line: 'Line',
            circle: 'Circle',
            arc: 'Arc',
            pline: 'Polyline',
            text: 'Text',
            mtext: 'MText',
            insert: 'BlockReference',
            ellipse: 'Ellipse',
            spline: 'Spline',
            point: 'Point',
            hatch: 'Hatch',
            dim: 'Dimension',
          }[e.type] || e.type),
      ],
      HANDLE: [(e) => e.id.toString(16).toUpperCase()],
      LENGTH: [(e) => R(E.entLength(e))],
      AREA: [(e) => R(E.entArea(e))],
      RADIUS: [
        (e) => R(e.r),
        (e, v) => {
          e.r = nv(v);
        },
      ],
      DIAMETER: [
        (e) => R(e.r * 2),
        (e, v) => {
          e.r = nv(v) / 2;
        },
      ],
      CENTER: [
        (e) => P3(e.c || e.p || { x: 0, y: 0 }),
        (e, v) => {
          const p = pt(v);
          if (e.c) e.c = { x: p.x, y: p.y };
          else if (e.p) e.p = { x: p.x, y: p.y };
        },
      ],
      STARTPOINT: [
        (e) => P3(e.type === 'line' ? e.p1 : G.primStart(E.prims(e, app.doc)[0])),
        (e, v) => {
          if (e.type === 'line') e.p1 = { x: pt(v).x, y: pt(v).y };
        },
      ],
      ENDPOINT: [
        (e) => {
          const ps = E.prims(e, app.doc);
          return P3(e.type === 'line' ? e.p2 : G.primEnd(ps[ps.length - 1]));
        },
        (e, v) => {
          if (e.type === 'line') e.p2 = { x: pt(v).x, y: pt(v).y };
        },
      ],
      STARTANGLE: [
        (e) => R(e.a0),
        (e, v) => {
          e.a0 = nv(v);
        },
      ],
      ENDANGLE: [
        (e) => R(e.a1),
        (e, v) => {
          e.a1 = nv(v);
        },
      ],
      TEXTSTRING: [
        (e) => e.str ?? e.text ?? '',
        (e, v) => {
          if (e.type === 'dim') e.text = String(v);
          else e.str = String(v);
        },
      ],
      HEIGHT: [
        (e) => R(e.h),
        (e, v) => {
          e.h = nv(v);
        },
      ],
      ROTATION: [
        (e) => R(e.rot || 0),
        (e, v) => {
          e.rot = nv(v);
        },
      ],
      INSERTIONPOINT: [
        (e) => P3(e.p),
        (e, v) => {
          const p = pt(v);
          e.p = { x: p.x, y: p.y };
        },
      ],
      NAME: [(e) => e.name],
      XSCALEFACTOR: [
        (e) => R(e.sx ?? 1),
        (e, v) => {
          e.sx = nv(v);
        },
      ],
      YSCALEFACTOR: [
        (e) => R(e.sy ?? 1),
        (e, v) => {
          e.sy = nv(v);
        },
      ],
      CLOSED: [
        (e) => toBool(!!e.closed),
        (e, v) => {
          e.closed = v !== null && v !== 0;
        },
      ],
      COORDINATES: [(e) => (e.pts ? e.pts.flatMap((p) => [R(p.x), R(p.y)]) : null)],
      VISIBLE: [(e) => T],
      NORMAL: [() => [R(0), R(0), R(1)]],
      THICKNESS: [() => R(0)],
      MEASUREMENT: [(e) => R(E.dimMeasure(e))],
      STYLENAME: [(e) => e.style || 'Standard'],
      PATTERNNAME: [(e) => e.pattern],
      PATTERNSCALE: [
        (e) => R(e.scale),
        (e, v) => {
          e.scale = nv(v);
        },
      ],
    };

    const propName = (s) => s.replace(/-/g, '').toUpperCase();

    const getProp = (o, name) => {
      const k = propName(name);
      if (!(o instanceof Vla)) throw new LispError('bad argument type: VLA-OBJECT');
      const f = findEnt(o.en);
      if (!f) throw new LispError('object has been erased');
      const p = PROPS[k];
      if (!p) throw new LispError(`unsupported property: ${name}`);
      return p[0](f.e);
    };

    const putProp = (o, name, v) => {
      const k = propName(name);
      const f = findEnt(o.en);
      if (!f) throw new LispError('object has been erased');
      const p = PROPS[k];
      if (!p || !p[1]) throw new LispError(`property cannot be set: ${name}`);
      p[1](f.e, v);
      app.changed();
      return null;
    };

    D('vlax-get-property', (o, n) => getProp(o, String(n instanceof Sym ? n.name : n)));

    D('vlax-get', (o, n) => getProp(o, String(n instanceof Sym ? n.name : n)));

    D('vlax-put-property', (o, n, v) => putProp(o, String(n instanceof Sym ? n.name : n), v));

    D('vlax-put', (o, n, v) => putProp(o, String(n instanceof Sym ? n.name : n), v));

    D('vla-delete', (o) => {
      const f = findEnt(o.en);
      if (f) app.doc.remove([f.e.id], f.space);
      app.changed();
      return null;
    });

    D('vla-move', (o, a, b) => {
      const f = findEnt(o.en);
      const p = pt(a);
      const q = pt(b);
      E.translateEnt(f.e, q.x - p.x, q.y - p.y, app.doc);
      app.changed();
      return null;
    });

    D('vla-copy', (o) => {
      const f = findEnt(o.en);
      const k = E.clone(f.e);
      app.doc.add(k, f.space);
      app.changed();
      return new Vla(new EName(k.id, f.space));
    });

    D('vla-rotate', (o, b, a) => {
      const f = findEnt(o.en);
      E.xformInPlace(f.e, G.Mrotate(nv(a), pt(b)), app.doc);
      app.changed();
      return null;
    });

    D('vla-scaleentity', (o, b, s) => {
      const f = findEnt(o.en);
      E.xformInPlace(f.e, G.Mscale(nv(s), nv(s), pt(b)), app.doc);
      app.changed();
      return null;
    });

    D('vla-update', () => {
      app.redraw();
      return null;
    });

    D('vla-regen', () => {
      E.bump();
      app.redraw();
      return null;
    });

    D('vla-put-layer', (o, v) => putProp(o, 'Layer', v));

    const addCurve = (type, props) => {
      const e = app.doc.stamp(E.mk(type, props));
      app.doc.add(e, spaceOf());
      app.changed();
      return new Vla(new EName(e.id, spaceOf()));
    };

    D('vla-addline', (ms, a, b) => addCurve('line', { p1: pt(a), p2: pt(b) }));

    D('vla-addcircle', (ms, c, r) => addCurve('circle', { c: pt(c), r: nv(r) }));

    D('vla-addarc', (ms, c, r, a0, a1) =>
      addCurve('arc', { c: pt(c), r: nv(r), a0: nv(a0), a1: nv(a1) }),
    );

    D('vla-addpoint', (ms, p) => addCurve('point', { p: pt(p) }));

    D('vla-addtext', (ms, s, p, h) =>
      addCurve('text', {
        p: pt(p),
        h: nv(h),
        str: String(s),
        rot: 0,
        style: app.doc.curTextStyle,
        al: 0,
      }),
    );

    D('vla-addlightweightpolyline', (ms, flat) => {
      const a = (Array.isArray(flat) ? flat : []).map(nv);
      const pts = [];
      for (let i = 0; i + 1 < a.length; i += 2) pts.push({ x: a[i], y: a[i + 1], b: 0 });
      return addCurve('pline', { pts, closed: false });
    });

    function resolveMissing(name) {
      const m = /^VLA-(GET|PUT)-(.+)$/.exec(name);
      if (m) {
        const pn = m[2];
        return m[1] === 'GET'
          ? new Subr(name, (o) => getProp(o, pn))
          : new Subr(name, (o, v) => putProp(o, pn, v));
      }
      return null;
    }
    this.resolveMissing = resolveMissing;

    installDcl(L, app);
  }

  /** @private LISP-visible helpers for the editor. */
  editorHelpers() {
    const { L } = this;

    L.defineSource = async (src) => L.evalString(src);
  }
}

/* ============================================================================================
 * 4. ENTRY POINTS
 * ========================================================================================== */

/**
 * Adds the CAD functions to an interpreter.
 * @param {object} L the AutoLISP interpreter
 * @param {object} app the application
 */
export function installCad(L, app) {
  return new CadLispLibrary(L, app).build();
}

/**
 * Makes an AutoLISP interpreter with the CAD functions for an application.
 * @param {object} app
 * @returns {Lisp}
 */
export function createLisp(app) {
  const L = new Lisp({});
  installCad(L, app);
  return L;
}
export const _fmtAng = fmtAng;
